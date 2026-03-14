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

const METADATA_KEY = 'tunnelvision_postturn';

let _initialized = false;
let _processorRunning = false;
let _lastCountedChatLength = 0;

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

// ── Chat Excerpt ─────────────────────────────────────────────────

function formatRecentExchange(chat, count) {
    const start = Math.max(0, chat.length - count);
    const lines = [];
    for (let i = start; i < chat.length; i++) {
        const msg = chat[i];
        if (msg.is_system) continue;
        const role = msg.is_user ? 'User' : (msg.name || 'Character');
        const text = (msg.mes || '').trim();
        if (text) lines.push(`[${role}]: ${text}`);
    }
    return lines.join('\n\n');
}

// ── Decision Logic ───────────────────────────────────────────────

function getChatId() {
    try {
        return getContext().chatId || null;
    } catch {
        return null;
    }
}

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
    const trackers = [];

    for (const bookName of activeBooks) {
        const trackerUids = getTrackerUids(bookName);
        if (trackerUids.length === 0) continue;

        const bookData = await getCachedWorldInfo(bookName);
        if (!bookData?.entries) continue;

        const uidMap = buildUidMap(bookData.entries);

        for (const uid of trackerUids) {
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
    const { book: targetBook, error } = resolveTargetBook(
        activeBooks.length === 1 ? activeBooks[0] : activeBooks[0],
    );
    if (error || !targetBook) return null;

    _processorRunning = true;

    const state = getProcessorState();
    const lastIdx = state?.lastProcessedMsgIdx ?? -1;
    const msgsSinceLastProcess = Math.max(chat.length - 1 - lastIdx, 0);
    const excerptCount = Math.min(msgsSinceLastProcess + 2, 10);
    const recentExcerpt = formatRecentExchange(chat, excerptCount);

    if (!recentExcerpt.trim()) {
        _processorRunning = false;
        return null;
    }

    console.log(`[TunnelVision] Post-turn processor running (${msgsSinceLastProcess} new messages)`);

    const result = {
        factsCreated: 0,
        trackersUpdated: 0,
        sceneArchived: false,
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
            result.errors += archiveResult.errors;
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

        const parts = [];
        if (result.factsCreated > 0) parts.push(`${result.factsCreated} fact(s) saved`);
        if (result.sceneArchived) parts.push('scene archived');
        if (result.trackersUpdated > 0) parts.push(`${result.trackersUpdated} tracker(s) updated`);
        if (parts.length > 0) {
            console.log(`[TunnelVision] Post-turn complete: ${parts.join(', ')}`);
        } else {
            console.log('[TunnelVision] Post-turn complete: no changes needed');
        }

        return result;
    } catch (e) {
        console.error('[TunnelVision] Post-turn processor failed:', e);
        return null;
    } finally {
        _processorRunning = false;
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
    const result = { archived: false, errors: 0 };

    const state = getProcessorState();
    const lastProcessedIdx = state?.lastProcessedMsgIdx ?? -1;
    const messagesSinceLastArchive = Math.max(chat.length - 1 - lastProcessedIdx, 0);

    // Need at least a few messages to make a meaningful summary
    if (messagesSinceLastArchive < 3) return result;

    const archiveCount = Math.min(messagesSinceLastArchive + 2, chat.length, 40);

    try {
        const { runQuietSummarize } = await import('./commands.js');

        if (getChatId() !== chatId) return result;

        const titleHint = sceneChange.description || '';
        const summaryResult = await runQuietSummarize(targetBook, chat, archiveCount, titleHint);

        if (summaryResult?.title) {
            result.archived = true;
            console.log(`[TunnelVision] Scene archived: "${summaryResult.title}" (${sceneChange.type})`);
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

        for (const update of updates) {
            if (!update?.uid || !update?.content) continue;

            const tracker = trackers.find(t => t.uid === Number(update.uid));
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

    // Skip tool recursion passes
    try {
        const context = getContext();
        const lastMsg = context.chat?.[context.chat.length - 1];
        if (Array.isArray(lastMsg?.extra?.tool_invocations) && lastMsg.extra.tool_invocations.length > 0) return;
    } catch { /* proceed */ }

    // Skip regenerations
    try {
        const chatLength = getContext().chat?.length || 0;
        if (chatLength > 0 && chatLength <= _lastCountedChatLength) return;
        _lastCountedChatLength = chatLength;
    } catch { /* proceed */ }

    if (shouldProcess()) {
        runPostTurnProcessor().catch(e => {
            console.error('[TunnelVision] Background post-turn processor failed:', e);
        });
    }
}

function onChatChanged() {
    try {
        _lastCountedChatLength = getContext().chat?.length || 0;
    } catch {
        _lastCountedChatLength = 0;
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
