/**
 * TunnelVision Post-Turn Processor
 *
 * An intelligent background agent that runs after each AI response to
 * maintain the lorebook automatically. Separates the "creative writing"
 * and "memory management" concerns — the AI writes its response, then
 * this processor analyzes what happened and takes action.
 *
 * Pipeline (each step is optional and configurable):
 *   1. Fact Extraction + Scene Detection — Identify new facts AND detect narrative
 *      transitions (scene changes, day changes, major shifts) in one LLM call
 *   2. Scene Archiving — When a scene change is detected, create a historical
 *      summary entry for the scene that just ended (replaces timer-based auto-summary)
 *   3. Tracker Updates — Find tracker entries for mentioned entities, update their state
 *
 * Runs via generateQuietPrompt after MESSAGE_RECEIVED, respecting a configurable
 * cooldown to avoid firing on every single message (default: every turn).
 *
 * Data: processing state in chat_metadata.tunnelvision_postturn
 */

import { eventSource, event_types, generateQuietPrompt } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { getSettings, getTrackerUids } from './tree-store.js';
import { getActiveTunnelVisionBooks, resolveTargetBook } from './tool-registry.js';
import { createEntry, updateEntry, getCachedWorldInfo, buildUidMap, parseJsonFromLLM } from './entry-manager.js';
import { markAutoSummaryComplete } from './auto-summary.js';
import { getWatermark, setWatermark, hideSummarizedMessages } from './tools/summarize.js';
import { getChatId, formatChatExcerpt as formatRecentExchange, shouldSkipAiMessage } from './agent-utils.js';
import { addBackgroundEvent, markBackgroundStart } from './activity-feed.js';

const METADATA_KEY = 'tunnelvision_postturn';

let _initialized = false;
let _processorRunning = false;
const _chatRef = { lastChatLength: 0 };
let _lastArchivedAt = 0;

// ── Persistence ──────────────────────────────────────────────────

function getProcessorState() {
    try {
        return getContext().chatMetadata?.[METADATA_KEY] || null;
    } catch {
        return null;
    }
}

function setProcessorState(state) {
    try {
        const context = getContext();
        if (!context.chatMetadata) return;
        context.chatMetadata[METADATA_KEY] = state;
        context.saveMetadataDebounced?.();
    } catch { /* metadata not available */ }
}

// (formatRecentExchange and getChatId imported from agent-utils.js)

// ── Decision Logic ───────────────────────────────────────────────

function shouldProcess() {
    const settings = getSettings();
    if (!settings.postTurnEnabled || settings.globalEnabled === false) return false;
    if (getActiveTunnelVisionBooks().length === 0) return false;

    const context = getContext();
    const chatLength = context.chat?.length || 0;
    if (chatLength < 4) return false;

    const state = getProcessorState();
    const lastIdx = state?.lastProcessedMsgIdx ?? -1;
    const cooldown = settings.postTurnCooldown || 1;

    return (chatLength - 1 - lastIdx) >= cooldown;
}

// ── Tracker Entry Loading ────────────────────────────────────────

async function loadTrackerEntries(activeBooks) {
    const booksWithTrackers = activeBooks
        .map(bookName => ({ bookName, uids: getTrackerUids(bookName) }))
        .filter(b => b.uids.length > 0);

    if (booksWithTrackers.length === 0) return [];

    const bookDataResults = await Promise.all(
        booksWithTrackers.map(b => getCachedWorldInfo(b.bookName)),
    );

    const trackers = [];
    for (let i = 0; i < booksWithTrackers.length; i++) {
        const { bookName, uids } = booksWithTrackers[i];
        const bookData = bookDataResults[i];
        if (!bookData?.entries) continue;

        const uidMap = buildUidMap(bookData.entries);
        for (const uid of uids) {
            const entry = uidMap.get(uid);
            if (!entry || entry.disable) continue;
            trackers.push({
                uid: entry.uid,
                book: bookName,
                title: entry.comment || `Entry #${uid}`,
                content: entry.content || '',
            });
        }
    }

    return trackers;
}

// ── Core Processing Pipeline ─────────────────────────────────────

/**
 * Run the post-turn processing pipeline.
 * @param {boolean} [force=false] - Skip cooldown check
 * @returns {Promise<Object|null>} Processing result summary, or null
 */
export async function runPostTurnProcessor(force = false) {
    if (_processorRunning) return null;
    if (!force && !shouldProcess()) return null;

    const settings = getSettings();
    if (!settings.postTurnEnabled || settings.globalEnabled === false) return null;

    const activeBooks = getActiveTunnelVisionBooks();
    if (activeBooks.length === 0) return null;

    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length < 4) return null;

    const chatId = getChatId();
    const { book: targetBook, error } = resolveTargetBook(activeBooks[0]);
    if (error || !targetBook) return null;

    _processorRunning = true;
    const endActivity = markBackgroundStart();

    const state = getProcessorState();
    const lastIdx = state?.lastProcessedMsgIdx ?? -1;
    const msgsSinceLastProcess = Math.max(chat.length - 1 - lastIdx, 0);
    const excerptCount = Math.min(msgsSinceLastProcess + 2, 10);
    const recentExcerpt = formatRecentExchange(chat, excerptCount);

    if (!recentExcerpt.trim()) {
        _processorRunning = false;
        endActivity();
        return null;
    }

    console.log(`[TunnelVision] Post-turn processor running (${msgsSinceLastProcess} new messages)`);

    const result = {
        factsCreated: 0,
        trackersUpdated: 0,
        sceneArchived: false,
        sceneTitle: null,
        errors: 0,
    };

    try {
        // Abort if chat changed
        if (getChatId() !== chatId) return null;

        // ── Step 1: Fact Extraction + Scene Detection ────────────
        // Single LLM call handles both to minimize API usage
        let sceneChange = null;
        if (settings.postTurnExtractFacts !== false) {
            const analysisResult = await analyzeExchange(targetBook, recentExcerpt, chatId);
            result.factsCreated = analysisResult.factsCreated;
            result.errors += analysisResult.errors;
            sceneChange = analysisResult.sceneChange;
        }

        if (getChatId() !== chatId) return null;

        // ── Step 2: Scene Archiving ──────────────────────────────
        // When a scene change is detected, create a historical summary
        if (sceneChange?.detected && settings.postTurnSceneArchive !== false) {
            const archiveResult = await archiveScene(targetBook, chat, sceneChange, chatId);
            result.sceneArchived = archiveResult.archived;
            result.sceneTitle = archiveResult.title;
            result.errors += archiveResult.errors;
            if (archiveResult.archived) _lastArchivedAt = Date.now();
        }

        if (getChatId() !== chatId) return null;

        // ── Step 3: Tracker Updates ──────────────────────────────
        if (settings.postTurnUpdateTrackers !== false) {
            const trackers = await loadTrackerEntries(activeBooks);
            if (trackers.length > 0) {
                const trackerResult = await updateTrackers(trackers, recentExcerpt, chatId);
                result.trackersUpdated = trackerResult.updated;
                result.errors += trackerResult.errors;
            }
        }

        // Record completion
        setProcessorState({
            lastProcessedMsgIdx: chat.length - 1,
            lastProcessedAt: Date.now(),
            lastResult: result,
        });

        const details = [];
        if (result.factsCreated > 0) details.push(`${result.factsCreated} fact(s)`);
        if (result.sceneArchived) {
            const archiveLabel = result.sceneTitle
                ? `scene archived: "${result.sceneTitle}"`
                : 'scene archived';
            details.push(archiveLabel);
        }
        if (result.trackersUpdated > 0) details.push(`${result.trackersUpdated} tracker(s)`);
        if (details.length > 0) {
            console.log(`[TunnelVision] Post-turn complete: ${details.join(', ')}`);
            addBackgroundEvent({
                icon: 'fa-brain',
                verb: 'Post-turn',
                color: '#6c5ce7',
                summary: details.join(', '),
                details,
            });
        } else {
            console.log('[TunnelVision] Post-turn complete: no changes needed');
        }

        return result;
    } catch (e) {
        console.error('[TunnelVision] Post-turn processor failed:', e);
        addBackgroundEvent({
            icon: 'fa-triangle-exclamation',
            verb: 'Post-turn failed',
            color: '#d63031',
            summary: e.message || 'Unknown error',
        });
        return null;
    } finally {
        _processorRunning = false;
        endActivity();
    }
}

// ── Step 1: Combined Analysis (Facts + Scene Detection) ──────────

/**
 * Single LLM call that extracts facts AND detects scene changes.
 * Returns facts created count and scene change info.
 */
async function analyzeExchange(targetBook, recentExcerpt, chatId) {
    const result = { factsCreated: 0, errors: 0, sceneChange: null };

    const quietPrompt = [
        'You are an analysis assistant for a roleplay lorebook. Perform TWO tasks on this exchange:',
        '',
        'TASK 1 — FACT EXTRACTION:',
        'Extract any NEW, important facts that emerged. Only genuinely new information — things revealed, decided, discovered, or changed. Skip:',
        '- Information already established earlier',
        '- Trivial dialogue or filler',
        '- OOC instructions or meta-commentary',
        '- Speculative or uncertain information',
        '',
        'TASK 2 — SCENE CHANGE DETECTION:',
        'Determine if a NARRATIVE TRANSITION just occurred. A scene change means:',
        '- Location change (characters moved to a new place)',
        '- Significant time skip (hours passed, next day, etc.)',
        '- Major narrative shift (new chapter, flashback, dream sequence)',
        '- Scene resolution (a confrontation ended, characters parted ways)',
        'Normal conversation flow within the same scene is NOT a scene change.',
        '',
        '[Recent Exchange]',
        recentExcerpt,
        '',
        'Respond with ONLY a JSON object:',
        '{',
        '  "facts": [{"title": "short title", "content": "third-person description", "keys": ["keyword1"]}],',
        '  "sceneChange": {',
        '    "detected": true/false,',
        '    "type": "location|time_skip|narrative_shift|resolution|null",',
        '    "description": "brief description of what changed (only if detected)"',
        '  }',
        '}',
        '',
        'If no facts, use empty array. If no scene change, set detected to false.',
        'Respond with ONLY the JSON. No commentary, no code fences.',
    ].join('\n');

    try {
        const response = await generateQuietPrompt({ quietPrompt, skipWIAN: true });

        if (getChatId() !== chatId) return result;

        const parsed = parseJsonFromLLM(response);
        if (!parsed || typeof parsed !== 'object') return result;

        // Process facts
        const facts = Array.isArray(parsed.facts) ? parsed.facts : [];
        for (const fact of facts) {
            if (!fact?.title || !fact?.content) continue;
            try {
                await createEntry(targetBook, {
                    content: String(fact.content).trim(),
                    comment: String(fact.title).trim(),
                    keys: Array.isArray(fact.keys) ? fact.keys.map(k => String(k).trim()).filter(Boolean) : [],
                    nodeId: null,
                    background: true,
                });
                result.factsCreated++;
            } catch (e) {
                console.warn(`[TunnelVision] Post-turn fact creation failed for "${fact.title}":`, e);
                result.errors++;
            }
        }

        // Extract scene change info
        if (parsed.sceneChange && parsed.sceneChange.detected === true) {
            result.sceneChange = {
                detected: true,
                type: parsed.sceneChange.type || 'unknown',
                description: parsed.sceneChange.description || '',
            };
            console.log(`[TunnelVision] Scene change detected: ${result.sceneChange.type} — ${result.sceneChange.description}`);
        }
    } catch (e) {
        console.error('[TunnelVision] Post-turn analysis LLM call failed:', e);
        result.errors++;
    }

    return result;
}

// ── Step 2: Scene Archiving ──────────────────────────────────────

/**
 * When a scene change is detected, create a historical summary entry
 * for the scene that just ended. Uses the existing runQuietSummarize pipeline.
 */
async function archiveScene(targetBook, chat, sceneChange, chatId) {
    const result = { archived: false, errors: 0, title: null };

    const watermark = getWatermark();

    // The scene change was detected in the LATEST message, meaning that message
    // is the start of the NEW scene. The OLD scene ends at chat.length - 3.
    // We only want to archive the old scene, so exclude the last 2 messages
    // (the user prompt that elicited the scene change + the AI's new-scene response).
    const sceneEndIdx = chat.length - 3;
    const oldSceneMessages = Math.max(sceneEndIdx - watermark, 0);

    if (oldSceneMessages < 4) return result;

    // Slice the chat to only include the old scene (exclude new scene messages)
    const oldSceneChat = chat.slice(0, sceneEndIdx + 1);
    const archiveCount = Math.min(oldSceneMessages, oldSceneChat.length, 50);

    try {
        const { runQuietSummarize } = await import('./commands.js');

        if (getChatId() !== chatId) return result;

        const titleHint = sceneChange.description || '';
        // skipAutoHide: we handle hiding ourselves with the correct range,
        // because runQuietSummarize's hideSummarizedMessages reads the full
        // chat from getContext() and would hide new-scene messages instead.
        const summaryResult = await runQuietSummarize(targetBook, oldSceneChat, archiveCount, titleHint, {
            background: true,
            skipAutoHide: true,
        });

        if (summaryResult?.title) {
            result.archived = true;
            result.title = summaryResult.title;

            // Hide old-scene messages and advance watermark with the correct
            // range (watermark+1 → sceneEndIdx), not the full-chat tail.
            try {
                await hideSummarizedMessages(undefined, { endIndex: sceneEndIdx });
            } catch (e) {
                console.warn('[TunnelVision] Scene archive hide failed:', e);
            }
            setWatermark(sceneEndIdx);

            console.log(`[TunnelVision] Scene archived: "${summaryResult.title}" (${sceneChange.type}), messages up to #${sceneEndIdx}`);
        }
    } catch (e) {
        console.warn('[TunnelVision] Scene archiving failed:', e);
        result.errors++;
    }

    return result;
}

// ── Step 2: Tracker Updates ──────────────────────────────────────

async function updateTrackers(trackers, recentExcerpt, chatId) {
    const result = { updated: 0, errors: 0 };

    const trackerSummaries = trackers.map(t =>
        `[UID ${t.uid} — "${t.title}" in "${t.book}"]\n${t.content}`,
    ).join('\n\n---\n\n');

    const quietPrompt = [
        'You are a state-tracking assistant for a roleplay lorebook.',
        'Below are TRACKER entries — structured documents tracking character states, inventory, relationships, etc.',
        'Analyze the recent conversation and determine if any trackers need updating based on what happened.',
        '',
        '[Current Tracker Entries]',
        trackerSummaries,
        '',
        '[Recent Exchange]',
        recentExcerpt,
        '',
        'For each tracker that needs updating, provide the COMPLETE updated content (preserving its schema/format) with only the changed values modified.',
        'If a tracker does not need changes, do NOT include it.',
        '',
        'Respond with a JSON array of updates. If no trackers need updating, respond with an empty array [].',
        'Format: [{"uid": 123, "book": "lorebook name", "content": "full updated tracker content"}]',
        '',
        'IMPORTANT: Preserve the tracker\'s existing format/structure. Only change values that actually changed based on the conversation.',
        'Respond with ONLY the JSON array. No commentary, no code fences.',
    ].join('\n');

    try {
        const response = await generateQuietPrompt({ quietPrompt, skipWIAN: true });

        if (getChatId() !== chatId) return result;

        const updates = parseJsonFromLLM(response, { type: 'array' });
        if (!Array.isArray(updates) || updates.length === 0) return result;

        const trackerMap = new Map(trackers.map(t => [t.uid, t]));

        for (const update of updates) {
            if (!update?.uid || !update?.content) continue;

            const tracker = trackerMap.get(Number(update.uid));
            if (!tracker) continue;

            if (tracker.content.trim() === String(update.content).trim()) continue;

            try {
                await updateEntry(tracker.book, Number(update.uid), {
                    content: String(update.content).trim(),
                });
                result.updated++;
                console.log(`[TunnelVision] Post-turn updated tracker "${tracker.title}" (UID ${tracker.uid})`);
            } catch (e) {
                console.warn(`[TunnelVision] Post-turn tracker update failed for UID ${update.uid}:`, e);
                result.errors++;
            }
        }
    } catch (e) {
        console.error('[TunnelVision] Post-turn tracker update LLM call failed:', e);
        result.errors++;
    }

    return result;
}

// ── Event Handlers ───────────────────────────────────────────────

function onAiMessageReceived() {
    const settings = getSettings();
    if (!settings.postTurnEnabled || settings.globalEnabled === false) return;
    if (shouldSkipAiMessage(_chatRef)) return;

    if (shouldProcess()) {
        runPostTurnProcessor().catch(e => {
            console.error('[TunnelVision] Background post-turn processor failed:', e);
        });
    }
}

function onChatChanged() {
    try {
        _chatRef.lastChatLength = getContext().chat?.length || 0;
    } catch {
        _chatRef.lastChatLength = 0;
    }
}

// ── Init ─────────────────────────────────────────────────────────

export function initPostTurnProcessor() {
    if (_initialized) return;
    _initialized = true;

    if (event_types.MESSAGE_RECEIVED) {
        eventSource.on(event_types.MESSAGE_RECEIVED, onAiMessageReceived);
    }
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    }

    console.log('[TunnelVision] Post-turn processor initialized');
}

// ── Public API ───────────────────────────────────────────────────

/** Get the last processing result, or null. */
export function getLastProcessingResult() {
    return getProcessorState()?.lastResult || null;
}

/** Get the message index of the last processing run. */
export function getLastProcessedIndex() {
    return getProcessorState()?.lastProcessedMsgIdx ?? -1;
}

/** Check if the processor is currently running. */
export function isProcessorRunning() {
    return _processorRunning;
}

/** Returns true if a scene was archived within the last 30 seconds. */
export function hasRecentArchive() {
    return _lastArchivedAt > 0 && (Date.now() - _lastArchivedAt) < 30_000;
}
