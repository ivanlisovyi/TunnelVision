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
import { getSettings, getTrackerUids, isTrackerTitle, isSummaryTitle } from './tree-store.js';
import { getActiveTunnelVisionBooks, resolveTargetBook } from './tool-registry.js';
import { createEntry, updateEntry, forgetEntry, getCachedWorldInfo, buildUidMap, parseJsonFromLLM } from './entry-manager.js';
import { markAutoSummaryComplete } from './auto-summary.js';
import { getWatermark, setWatermark, hideSummarizedMessages } from './tools/summarize.js';
import { getChatId, formatChatExcerpt as formatRecentExchange, trigramSimilarity, callWithRetry } from './agent-utils.js';
import { addBackgroundEvent, registerBackgroundTask } from './background-events.js';
import { requestPriorityUpdate, getWorldStateText } from './world-state.js';
import { processArcUpdates, buildArcsContextBlock } from './arc-tracker.js';

const METADATA_KEY = 'tunnelvision_postturn';

let _initialized = false;
let _processorRunning = false;
let _currentTask = null;
let _swipePending = false;
const _chatRef = { lastChatLength: 0 };
let _lastArchivedAt = 0;
let _liveRollback = null;

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

function persistLiveRollback() {
    if (!_liveRollback) return;
    try {
        const state = getProcessorState() || {};
        setProcessorState({ ...state, rollback: { ..._liveRollback } });
    } catch (e) {
        console.warn('[TunnelVision] Failed to persist live rollback:', e);
    }
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
    const task = registerBackgroundTask({ label: 'Post-turn', icon: 'fa-brain', color: '#6c5ce7' });
    _currentTask = task;

    // Initialize live rollback immediately so cancellation at any point
    // can undo whatever was created so far
    _liveRollback = { createdUids: [], trackerReverts: [], book: targetBook };
    persistLiveRollback();

    const state = getProcessorState();
    const lastIdx = state?.lastProcessedMsgIdx ?? -1;
    const msgsSinceLastProcess = Math.max(chat.length - 1 - lastIdx, 0);
    const excerptCount = Math.min(msgsSinceLastProcess + 2, 10);
    const recentExcerpt = formatRecentExchange(chat, excerptCount);

    if (!recentExcerpt.trim()) {
        _liveRollback = null;
        _processorRunning = false;
        _currentTask = null;
        task.end();
        return null;
    }

    console.log(`[TunnelVision] Post-turn processor running (${msgsSinceLastProcess} new messages)`);

    const result = {
        factsCreated: 0,
        trackersUpdated: 0,
        sceneArchived: false,
        sceneTitle: null,
        arcsCreated: 0,
        arcsUpdated: 0,
        arcsResolved: 0,
        errors: 0,
    };

    try {
        // Abort if chat changed or user cancelled
        if (getChatId() !== chatId || task.cancelled) return null;

        // ── Steps 1 + 3 in parallel: Fact Extraction and Tracker Updates ──
        // These are independent LLM calls that don't depend on each other.
        // Scene archiving (Step 2) waits for fact extraction since it needs scene detection.
        const analysisPromise = settings.postTurnExtractFacts !== false
            ? analyzeExchange(targetBook, recentExcerpt, chatId)
            : Promise.resolve(null);

        const trackerPromise = settings.postTurnUpdateTrackers !== false
            ? loadTrackerEntries(activeBooks).then(trackers =>
                trackers.length > 0 ? updateTrackers(trackers, recentExcerpt, chatId) : null,
            )
            : Promise.resolve(null);

        const [analysisResult, trackerResult] = await Promise.all([analysisPromise, trackerPromise]);

        if (analysisResult) {
            result.factsCreated = analysisResult.factsCreated;
            result.arcsCreated = analysisResult.arcsCreated || 0;
            result.arcsUpdated = analysisResult.arcsUpdated || 0;
            result.arcsResolved = analysisResult.arcsResolved || 0;
            result.errors += analysisResult.errors;
        }

        if (trackerResult) {
            result.trackersUpdated = trackerResult.updated;
            result.errors += trackerResult.errors;
        }

        if (getChatId() !== chatId || task.cancelled) return null;

        // ── Step 2: Scene Archiving (depends on scene detection from Step 1) ──
        const sceneChange = analysisResult?.sceneChange;
        if (sceneChange?.detected && settings.postTurnSceneArchive !== false) {
            const archiveResult = await archiveScene(targetBook, chat, sceneChange, chatId);
            result.sceneArchived = archiveResult.archived;
            result.sceneTitle = archiveResult.title;
            result.errors += archiveResult.errors;
            if (archiveResult.archived) _lastArchivedAt = Date.now();
        }

        if (task.cancelled) return null;

        // Check if any character has enough facts to warrant a tracker suggestion
        if (result.factsCreated > 0) {
            await checkTrackerSuggestions(activeBooks);
        }

        // Trigger priority world state update on significant events
        if (result.sceneArchived || result.factsCreated >= 3) {
            requestPriorityUpdate({
                sceneArchived: result.sceneArchived,
                sceneTitle: result.sceneTitle,
                factsCreated: result.factsCreated,
                sceneChangeType: analysisResult?.sceneChange?.type || null,
            });
        }

        // Record completion + rollback data for swipe recovery
        setProcessorState({
            lastProcessedMsgIdx: chat.length - 1,
            lastProcessedAt: Date.now(),
            lastResult: result,
            rollback: _liveRollback ? { ..._liveRollback } : null,
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
        const arcTotal = result.arcsCreated + result.arcsUpdated;
        if (arcTotal > 0) {
            const arcParts = [];
            if (result.arcsCreated > 0) arcParts.push(`${result.arcsCreated} new`);
            if (result.arcsUpdated > 0) arcParts.push(`${result.arcsUpdated} updated`);
            if (result.arcsResolved > 0) arcParts.push(`${result.arcsResolved} resolved`);
            details.push(`arcs: ${arcParts.join(', ')}`);
        }
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
        toastr.error(`Post-turn memory processing failed: ${e.message || 'Unknown error'}`, 'TunnelVision');
        addBackgroundEvent({
            icon: 'fa-triangle-exclamation',
            verb: 'Post-turn failed',
            color: '#d63031',
            summary: e.message || 'Unknown error',
        });
        return null;
    } finally {
        _liveRollback = null;
        _processorRunning = false;
        _currentTask = null;
        task.end();

        if (_swipePending) {
            _swipePending = false;
            rollbackLastPostTurn().then(() => {
                runPostTurnProcessor().catch(e => {
                    console.error('[TunnelVision] Post-turn re-processor (deferred swipe) failed:', e);
                });
            });
        }
    }
}

// ── Step 1: Combined Analysis (Facts + Scene Detection) ──────────

/**
 * Single LLM call that extracts facts AND detects scene changes.
 * Returns facts created count and scene change info.
 */
async function analyzeExchange(targetBook, recentExcerpt, chatId) {
    const result = { factsCreated: 0, errors: 0, sceneChange: null, createdUids: [] };

    // Build compact list of existing fact titles so the LLM avoids re-extracting them
    let existingFactsSection = '';
    try {
        const preBookData = await getCachedWorldInfo(targetBook);
        if (preBookData?.entries) {
            const titles = [];
            for (const key of Object.keys(preBookData.entries)) {
                const e = preBookData.entries[key];
                if (e.disable) continue;
                const t = (e.comment || '').trim();
                if (t && !t.toLowerCase().startsWith('[tracker') && !t.toLowerCase().startsWith('[summary') && !t.toLowerCase().startsWith('[scene summary')) {
                    titles.push(t);
                }
            }
            if (titles.length > 0) {
                const recent = titles.slice(-30);
                existingFactsSection = '\n[Already Known Facts — do NOT re-extract these]\n' + recent.map(t => `- ${t}`).join('\n') + '\n';
            }
        }
    } catch { /* proceed without existing facts */ }

    // Extract temporal context from the world state's Current Scene if available
    let temporalContext = '';
    try {
        const wsText = getWorldStateText();
        if (wsText) {
            const sceneMatch = wsText.match(/## Current Scene[\s\S]*?(?=\n## |$)/);
            if (sceneMatch) {
                const dayMatch = sceneMatch[0].match(/Day:\s*(.+)/i);
                const dateMatch = sceneMatch[0].match(/Date:\s*(.+)/i);
                const timeMatch = sceneMatch[0].match(/Time:\s*(.+)/i);
                const parts = [dayMatch?.[1], dateMatch?.[1], timeMatch?.[1]].filter(Boolean);
                if (parts.length > 0) {
                    temporalContext = `\n[Current In-World Time — use this to timestamp facts]\n${parts.join(' | ')}\n`;
                }
            }
        }
    } catch { /* proceed without temporal context */ }

    // Build current arcs context for TASK 3
    const currentArcsSection = buildArcsContextBlock();

    const quietPrompt = [
        'You are an analysis assistant for a roleplay lorebook. Perform THREE tasks on this exchange:',
        '',
        'TASK 1 — FACT EXTRACTION:',
        'Extract ONLY facts significant enough to matter for long-term story continuity — things that, if forgotten, would create a continuity error or miss something meaningful. Facts are persistent state changes, NOT moment-to-moment narration.',
        '',
        'WORTH REMEMBERING (lasting state changes):',
        '- Relationship shifts: "A confessed feelings to B", "C and D became enemies"',
        '- Living situations, relocations: "A moved in with B"',
        '- Status/ability changes: "A lost her powers", "B was promoted"',
        '- Revelations: "A is secretly B\'s sister", "The artifact is cursed"',
        '- Consequential decisions: "A accepted the deal", "B refused to return home"',
        '- World-state changes: "The bridge was destroyed", "War was declared"',
        '- New character traits or backstory revealed for the first time',
        '',
        'NOT WORTH REMEMBERING (skip these):',
        '- Mundane conversational beats ("asked about a bathrobe", "offered tea")',
        '- Transient actions with no lasting impact ("poured a drink", "sat down")',
        '- Fleeting emotional reactions that don\'t shift relationships ("felt nervous")',
        '- Information already established earlier',
        '- OOC instructions or meta-commentary',
        '- Speculative or uncertain information',
        '',
        'When in doubt, do NOT extract. Fewer high-quality facts are better than many trivial ones. An empty facts array is perfectly fine.',
        '',
        'WHEN: For each fact, provide the approximate in-world time it occurred (e.g. "Day 3, evening", "Day 5, morning", "early January 2025"). Use the Current In-World Time provided above as reference. If the timing is unclear, use "unknown".',
        '',
        'KEYS: For each fact, provide 4-10 short keywords for cross-referencing. Always include the FULL name of every character involved — use the most complete name known (e.g. "Elena Blackwood" not just "Elena", "John Wald" not just "John"). Add location names when relevant, topic/theme words (e.g. "curse", "betrayal", "promotion"), and synonyms or related terms. Think: what would someone search to find this fact?',
        '',
        'TASK 2 — SCENE CHANGE DETECTION:',
        'Determine if a MAJOR NARRATIVE BOUNDARY just occurred. The bar is HIGH — a scene change means the story has moved to a fundamentally different context, not just a minor shift within the same ongoing situation.',
        '',
        'IS a scene change (archive-worthy):',
        '- Day/night transition or significant time skip (next morning, hours later, next day)',
        '- Major location change (left the building entirely, traveled to a new city/area)',
        '- Characters parted ways and the narrative follows a different group',
        '- A major event concluded and the story moved on (battle ended, ceremony finished)',
        '- Narrative device (flashback, dream sequence, time jump, chapter break)',
        '',
        'NOT a scene change (same scene continuing):',
        '- Moving between rooms in the same building or nearby areas',
        '- Characters walking to a different part of the same location (kitchen → bedroom, lobby → pool)',
        '- Conversation topic changing within the same setting',
        '- Brief pauses, silences, or small time gaps (minutes, not hours)',
        '- New character joining or leaving an ongoing scene',
        '',
        'When in doubt, it is NOT a scene change. Err on the side of keeping the scene going — premature archiving fragments coherent scenes into useless pieces.',
        '',
        'TASK 3 — NARRATIVE ARC TRACKING:',
        'Identify multi-scene story arcs that are being advanced, stalled, or resolved in this exchange.',
        'An arc is a storyline spanning multiple scenes (e.g., "The Search for the Lost Artifact", "Elena\'s Trust Issues").',
        'Only track arcs with real narrative weight — not individual facts or single-scene events.',
        '',
        'For each arc touched in this exchange:',
        '- id: Use the existing arc ID from the list below, or null for a new arc',
        '- title: Short descriptive name',
        '- status: "active" (advancing), "stalled" (mentioned but stuck), "resolved" (concluded), "abandoned" (dropped)',
        '- progression: One sentence describing how this arc changed',
        '',
        'If no arcs were touched, use an empty array. Do NOT invent arcs for minor events.',
        '',
        currentArcsSection,
        temporalContext,
        existingFactsSection,
        '[Recent Exchange]',
        recentExcerpt,
        '',
        'Respond with ONLY a JSON object:',
        '{',
        '  "facts": [{"title": "short title", "content": "third-person description", "when": "Day X, time", "keys": ["keyword1"]}],',
        '  "sceneChange": {',
        '    "detected": true/false,',
        '    "type": "location|time_skip|narrative_shift|resolution|null",',
        '    "description": "brief description of what changed (only if detected)"',
        '  },',
        '  "arcs": [{"id": "existing_id or null", "title": "Arc Title", "status": "active|stalled|resolved|abandoned", "progression": "what changed"}]',
        '}',
        '',
        'If no facts, use empty array. If no scene change, set detected to false. If no arcs, use empty array.',
        'Respond with ONLY the JSON. No commentary, no code fences.',
    ].join('\n');

    try {
        const response = await callWithRetry(
            () => generateQuietPrompt({ quietPrompt, skipWIAN: true }),
            { label: 'Post-turn analysis' },
        );

        if (getChatId() !== chatId) return result;

        const parsed = parseJsonFromLLM(response);
        if (!parsed || typeof parsed !== 'object') return result;

        // Build existing-entry text list for dedup
        const bookData = await getCachedWorldInfo(targetBook);
        const existingTexts = [];
        if (bookData?.entries) {
            for (const key of Object.keys(bookData.entries)) {
                const e = bookData.entries[key];
                if (e.disable) continue;
                existingTexts.push(`${e.comment || ''} ${e.content || ''}`);
            }
        }

        const DEDUP_THRESHOLD = 0.7;

        // Process facts
        const facts = Array.isArray(parsed.facts) ? parsed.facts : [];
        for (const fact of facts) {
            if (!fact?.title || !fact?.content) continue;

            const newText = `${String(fact.title).trim()} ${String(fact.content).trim()}`;
            const isDuplicate = existingTexts.some(et => trigramSimilarity(newText, et) >= DEDUP_THRESHOLD);
            if (isDuplicate) {
                console.log(`[TunnelVision] Post-turn skipped duplicate fact: "${fact.title}"`);
                continue;
            }

            try {
                let factContent = String(fact.content).trim();
                const when = fact.when ? String(fact.when).trim() : '';
                if (when && when.toLowerCase() !== 'unknown') {
                    factContent = `[${when}] ${factContent}`;
                }

                const entryResult = await createEntry(targetBook, {
                    content: factContent,
                    comment: String(fact.title).trim(),
                    keys: Array.isArray(fact.keys) ? fact.keys.map(k => String(k).trim()).filter(Boolean) : [],
                    nodeId: null,
                    background: true,
                });
                result.factsCreated++;
                result.createdUids.push(entryResult.uid);
                if (_liveRollback) {
                    _liveRollback.createdUids.push(entryResult.uid);
                    persistLiveRollback();
                }
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

        // Process narrative arcs
        if (Array.isArray(parsed.arcs) && parsed.arcs.length > 0) {
            const arcResult = processArcUpdates(parsed.arcs);
            result.arcsCreated = arcResult.created;
            result.arcsUpdated = arcResult.updated;
            result.arcsResolved = arcResult.resolved;

            const arcDetails = [];
            if (arcResult.created > 0) arcDetails.push(`${arcResult.created} new`);
            if (arcResult.updated > 0) arcDetails.push(`${arcResult.updated} updated`);
            if (arcResult.resolved > 0) arcDetails.push(`${arcResult.resolved} resolved`);
            if (arcDetails.length > 0) {
                console.log(`[TunnelVision] Arcs: ${arcDetails.join(', ')}`);
            }
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
    const result = { updated: 0, errors: 0, reverts: [] };

    const trackerSummaries = trackers.map(t =>
        `[UID ${t.uid} — "${t.title}" in "${t.book}"]\n${t.content}`,
    ).join('\n\n---\n\n');

    const quietPrompt = [
        'You are a state-tracking assistant for a roleplay lorebook.',
        'Below are TRACKER entries — structured documents tracking character states, inventory, relationships, etc.',
        'Analyze the recent conversation and determine if any trackers need updating.',
        '',
        'ONLY update a tracker when there is a clear, lasting state change — not momentary reactions:',
        '- Mood/emotion fields: update on significant emotional shifts (a breakdown, a betrayal, falling in love), NOT every smile, frown, or passing feeling',
        '- Inventory/items: update when items are acquired, lost, destroyed, or used up — NOT when merely mentioned or held briefly',
        '- Relationships: update when a relationship meaningfully changes (alliance formed, trust broken), NOT for routine interactions',
        '- Location: update when a character relocates or travels, NOT for moving within the same area',
        '- Status: update for injuries, power changes, role changes — NOT for trivial physical actions',
        '',
        'Most of the time, no trackers need updating. An empty array [] is the correct response unless something genuinely changed.',
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
        'IMPORTANT: Preserve the tracker\'s existing format/structure. Only change values that actually changed.',
        'Respond with ONLY the JSON array. No commentary, no code fences.',
    ].join('\n');

    try {
        const response = await callWithRetry(
            () => generateQuietPrompt({ quietPrompt, skipWIAN: true }),
            { label: 'Post-turn trackers' },
        );

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
                const previousContent = tracker.content;
                await updateEntry(tracker.book, Number(update.uid), {
                    content: String(update.content).trim(),
                });
                result.updated++;
                result.reverts.push({ uid: tracker.uid, book: tracker.book, previousContent });
                if (_liveRollback) {
                    _liveRollback.trackerReverts.push({ uid: tracker.uid, book: tracker.book, previousContent });
                    persistLiveRollback();
                }
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

// ── Name Variant Helpers ─────────────────────────────────────────

/**
 * Check if `shorter` is a name variant of `longer` — i.e. every word in
 * the shorter name appears as a complete word in the longer name.
 * "john" → "john wald" ✓,  "john" → "johnny" ✗
 */
function isNameVariant(shorter, longer) {
    if (shorter.length >= longer.length) return false;
    const longerWords = longer.split(/\s+/);
    const shorterWords = shorter.split(/\s+/);
    return shorterWords.every(sw => longerWords.includes(sw));
}

/**
 * Check if two names refer to the same character (exact match or one is a
 * word-level subset of the other).
 */
function namesOverlap(a, b) {
    return a === b || isNameVariant(a, b) || isNameVariant(b, a);
}

/**
 * Merge fact counts for name variants. "john" (3) + "john wald" (4) → "john wald" (7).
 * Keeps the longest (most specific) name as the canonical form.
 * @param {Map<string, number>} nameCountMap
 * @returns {Map<string, number>}
 */
function consolidateNameVariants(nameCountMap) {
    const names = [...nameCountMap.keys()].sort((a, b) => b.length - a.length);
    const merged = new Map();
    const consumed = new Set();

    for (const name of names) {
        if (consumed.has(name)) continue;
        let totalCount = nameCountMap.get(name);

        for (const other of names) {
            if (other === name || consumed.has(other)) continue;
            if (isNameVariant(other, name)) {
                totalCount += nameCountMap.get(other);
                consumed.add(other);
            }
        }

        merged.set(name, totalCount);
    }

    return merged;
}

// ── Tracker Suggestion ───────────────────────────────────────────

const TRACKER_SUGGESTION_THRESHOLD = 5;
const TRACKER_NAME_RE = /^\[tracker[:\s]*([^\]]+)\]/i;

/** Metadata key for tracking which characters we've already suggested trackers for. */
const TRACKER_SUGGESTIONS_KEY = 'tunnelvision_tracker_suggestions';

function getAlreadySuggested() {
    try {
        return new Set(getContext().chatMetadata?.[TRACKER_SUGGESTIONS_KEY] || []);
    } catch {
        return new Set();
    }
}

function markSuggested(characterName) {
    try {
        const context = getContext();
        if (!context.chatMetadata) return;
        const existing = context.chatMetadata[TRACKER_SUGGESTIONS_KEY] || [];
        if (!existing.includes(characterName)) {
            context.chatMetadata[TRACKER_SUGGESTIONS_KEY] = [...existing, characterName];
            context.saveMetadataDebounced?.();
        }
    } catch { /* metadata not available */ }
}

/**
 * After fact extraction, check if any character has accumulated enough facts
 * to warrant a tracker. Emits a feed notification as a nudge — no auto-creation.
 */
async function checkTrackerSuggestions(activeBooks) {
    try {
        const alreadySuggested = getAlreadySuggested();

        // Collect tracker character names and all fact keys across active books
        const trackerCharacters = new Set();
        /** @type {Map<string, number>} characterName → fact count */
        const characterFactCounts = new Map();

        for (const bookName of activeBooks) {
            const bookData = await getCachedWorldInfo(bookName);
            if (!bookData?.entries) continue;

            const trackerUidSet = new Set(getTrackerUids(bookName));

            for (const key of Object.keys(bookData.entries)) {
                const entry = bookData.entries[key];
                if (entry.disable) continue;
                const title = (entry.comment || '').trim();

                if (trackerUidSet.has(entry.uid) || isTrackerTitle(title)) {
                    const match = title.match(TRACKER_NAME_RE);
                    if (match) trackerCharacters.add(match[1].trim().toLowerCase());
                    continue;
                }

                if (isSummaryTitle(title)) continue;

                const keys = entry.key || [];
                for (const k of keys) {
                    const name = String(k).trim().toLowerCase();
                    if (name.length >= 2) {
                        characterFactCounts.set(name, (characterFactCounts.get(name) || 0) + 1);
                    }
                }
            }
        }

        // Merge counts for name variants: "john" + "john wald" → "john wald"
        const consolidated = consolidateNameVariants(characterFactCounts);

        for (const [name, count] of consolidated) {
            if (count < TRACKER_SUGGESTION_THRESHOLD) continue;

            // Check against existing trackers with variant awareness
            if ([...trackerCharacters].some(tc => namesOverlap(name, tc))) continue;

            // Check against already-suggested names with variant awareness
            if ([...alreadySuggested].some(s => namesOverlap(name, s))) continue;

            const displayName = name.replace(/\b\w/g, c => c.toUpperCase());

            addBackgroundEvent({
                icon: 'fa-address-card',
                verb: 'Tracker suggested',
                color: '#a29bfe',
                summary: `"${displayName}" has ${count} facts but no tracker — consider creating one`,
                details: [`${count} facts`, 'No tracker found'],
                action: { type: 'create-tracker', label: 'Create Tracker', icon: 'fa-address-card', characterName: displayName },
            });

            markSuggested(name);
            console.log(`[TunnelVision] Tracker suggestion: "${displayName}" has ${count} facts without a tracker`);
        }
    } catch (e) {
        console.warn('[TunnelVision] Tracker suggestion check failed:', e);
    }
}

// ── Tracker Creation from Suggestion ─────────────────────────────

/**
 * Create a tracker entry for a character by gathering existing facts and
 * synthesizing them into a structured document via LLM.
 * @param {string} characterName - Display name of the character
 * @returns {Promise<{uid: number, comment: string, nodeLabel: string, bookName: string}>}
 */
export async function createTrackerForCharacter(characterName) {
    const activeBooks = getActiveTunnelVisionBooks();
    if (activeBooks.length === 0) throw new Error('No active lorebooks');

    const { book: targetBook, error } = resolveTargetBook(activeBooks[0]);
    if (error || !targetBook) throw new Error(error || 'Could not resolve target lorebook');

    const nameLower = characterName.toLowerCase();
    const facts = [];
    for (const bookName of activeBooks) {
        const bookData = await getCachedWorldInfo(bookName);
        if (!bookData?.entries) continue;
        for (const key of Object.keys(bookData.entries)) {
            const entry = bookData.entries[key];
            if (entry.disable) continue;
            const title = (entry.comment || '').trim();
            if (isTrackerTitle(title) || isSummaryTitle(title)) continue;
            const keys = (entry.key || []).map(k => String(k).trim().toLowerCase());
            if (keys.some(k => namesOverlap(k, nameLower))) {
                facts.push((entry.content || title).trim());
            }
        }
    }

    let trackerContent;
    if (facts.length > 0) {
        const prompt = [
            'Create a character tracker entry for a roleplay lorebook.',
            `Character name: ${characterName}`,
            '',
            'Existing facts about this character:',
            ...facts.map((f, i) => `${i + 1}. ${f}`),
            '',
            'Synthesize ALL the facts above into a structured tracker document.',
            'Use clear sections with markdown headers (## Appearance, ## Personality, ## Relationships, ## Status, etc.).',
            'Use key: value pairs where appropriate.',
            'Include every piece of information from the facts — do not omit anything.',
            'Only include sections that have known information.',
            '',
            'Respond with ONLY the tracker content. No code fences, no preamble, no commentary.',
        ].join('\n');

        try {
            trackerContent = await callWithRetry(
                () => generateQuietPrompt(prompt, false, false),
                { label: 'Tracker creation', maxRetries: 1 },
            );
        } catch (e) {
            console.warn('[TunnelVision] Tracker creation LLM call failed, using fallback:', e);
        }
    }

    if (!trackerContent) {
        trackerContent = facts.length > 0
            ? `## Known Facts\n${facts.map(f => `- ${f}`).join('\n')}`
            : `## ${characterName}\n(No facts gathered yet — fill in details as the story progresses)`;
    }

    const title = `[Tracker: ${characterName}]`;
    const result = await createEntry(targetBook, {
        content: trackerContent,
        comment: title,
        keys: [nameLower],
        background: true,
    });

    return { ...result, bookName: targetBook };
}

// ── Swipe / Regeneration Rollback ────────────────────────────────

async function rollbackLastPostTurn() {
    // Prefer live rollback (accurate during mid-run cancellation) over persisted state
    const rb = _liveRollback || getProcessorState()?.rollback;
    if (!rb) return;

    const state = getProcessorState();
    let rolledBack = 0;

    // Delete fact entries created by the previous run
    if (Array.isArray(rb.createdUids) && rb.createdUids.length > 0 && rb.book) {
        for (const uid of rb.createdUids) {
            try {
                await forgetEntry(rb.book, uid, true);
                rolledBack++;
            } catch (e) {
                console.warn(`[TunnelVision] Rollback: failed to delete fact UID ${uid}:`, e);
            }
        }
    }

    // Revert tracker entries to their pre-update content
    if (Array.isArray(rb.trackerReverts)) {
        for (const { uid, book, previousContent } of rb.trackerReverts) {
            try {
                await updateEntry(book, uid, { content: previousContent });
                rolledBack++;
            } catch (e) {
                console.warn(`[TunnelVision] Rollback: failed to revert tracker UID ${uid}:`, e);
            }
        }
    }

    _liveRollback = null;

    // Reset processor state so the next run is allowed
    setProcessorState({
        lastProcessedMsgIdx: Math.max((state?.lastProcessedMsgIdx ?? 0) - 1, -1),
        lastProcessedAt: 0,
        lastResult: null,
        rollback: null,
    });

    if (rolledBack > 0) {
        console.log(`[TunnelVision] Rolled back ${rolledBack} post-turn artifact(s) after swipe/regeneration`);
        addBackgroundEvent({
            icon: 'fa-rotate-left',
            verb: 'Swipe detected',
            summary: `rolled back ${rolledBack} artifact(s), re-processing`,
            color: '#e17055',
        });
    }
}

// ── Event Handlers ───────────────────────────────────────────────

function onAiMessageReceived() {
    const settings = getSettings();
    if (!settings.postTurnEnabled || settings.globalEnabled === false) return;

    // Always skip tool-call recursion
    try {
        const context = getContext();
        const lastMsg = context.chat?.[context.chat.length - 1];
        if (Array.isArray(lastMsg?.extra?.tool_invocations) && lastMsg.extra.tool_invocations.length > 0) return;
    } catch { /* proceed */ }

    const chatLength = getContext().chat?.length || 0;
    const isSwipe = chatLength > 0 && chatLength <= _chatRef.lastChatLength;

    if (isSwipe) {
        _chatRef.lastChatLength = chatLength;
        if (_processorRunning) {
            _swipePending = true;
            if (_currentTask) _currentTask.cancelled = true;
        } else {
            rollbackLastPostTurn().then(() => {
                runPostTurnProcessor().catch(e => {
                    console.error('[TunnelVision] Post-turn re-processor (swipe) failed:', e);
                });
            });
        }
        return;
    }

    _chatRef.lastChatLength = chatLength;

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
