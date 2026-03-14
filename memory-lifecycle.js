/**
 * TunnelVision Memory Lifecycle Manager
 *
 * A periodic background process that maintains lorebook health over long
 * conversations. Runs every N turns (configurable) and performs:
 *
 *   1. Consolidation — Find entries about the same entity and merge them
 *   2. Compression — Condense verbose entries while preserving key facts
 *   3. Staleness flagging — Entries not accessed in many turns get reviewed
 *
 * Unlike the Post-Turn Processor (which runs after every exchange), the Lifecycle
 * Manager runs less frequently and makes bigger structural changes. Think of it
 * as a periodic "memory defragmentation."
 *
 * Trigger: every N post-turn processor runs (or manually via /tv-maintain).
 * Data: lifecycle state in chat_metadata.tunnelvision_lifecycle
 */

import { eventSource, event_types, generateQuietPrompt } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { getSettings } from './tree-store.js';
import { getActiveTunnelVisionBooks } from './tool-registry.js';
import { getCachedWorldInfo, buildUidMap, parseJsonFromLLM, invalidateWorldInfoCache, mergeEntries } from './entry-manager.js';
import { loadWorldInfo, saveWorldInfo } from '../../../world-info.js';
import { getChatId, shouldSkipAiMessage, callWithRetry } from './agent-utils.js';
import { addBackgroundEvent, registerBackgroundTask } from './activity-feed.js';

const METADATA_KEY = 'tunnelvision_lifecycle';

let _initialized = false;
let _lifecycleRunning = false;

// ── Persistence ──────────────────────────────────────────────────

function getLifecycleState() {
    try {
        return getContext().chatMetadata?.[METADATA_KEY] || null;
    } catch {
        return null;
    }
}

function setLifecycleState(state) {
    try {
        const context = getContext();
        if (!context.chatMetadata) return;
        context.chatMetadata[METADATA_KEY] = state;
        context.saveMetadataDebounced?.();
    } catch { /* metadata not available */ }
}

// (getChatId imported from agent-utils.js)

// ── Decision Logic ───────────────────────────────────────────────

function shouldRunLifecycle() {
    const settings = getSettings();
    if (!settings.lifecycleEnabled || settings.globalEnabled === false) return false;
    if (getActiveTunnelVisionBooks().length === 0) return false;

    const context = getContext();
    const chatLength = context.chat?.length || 0;
    if (chatLength < 20) return false;

    const state = getLifecycleState();
    const lastRunMsgIdx = state?.lastRunMsgIdx ?? -1;
    const interval = settings.lifecycleInterval || 30;

    return (chatLength - 1 - lastRunMsgIdx) >= interval;
}

// ── Core Lifecycle Pipeline ──────────────────────────────────────

/**
 * Run the memory lifecycle maintenance pipeline.
 * @param {boolean} [force=false] - Skip interval check
 * @returns {Promise<Object|null>} Results summary, or null
 */
export async function runLifecycleMaintenance(force = false) {
    if (_lifecycleRunning) return null;
    if (!force && !shouldRunLifecycle()) return null;

    const settings = getSettings();
    if (!settings.lifecycleEnabled || settings.globalEnabled === false) return null;

    const activeBooks = getActiveTunnelVisionBooks();
    if (activeBooks.length === 0) return null;

    const chatId = getChatId();
    _lifecycleRunning = true;
    const task = registerBackgroundTask({ label: 'Lifecycle', icon: 'fa-recycle', color: '#00cec9' });

    const result = {
        entriesCompressed: 0,
        duplicatesFound: 0,
        duplicatesMerged: 0,
        errors: 0,
    };

    console.log('[TunnelVision] Memory lifecycle maintenance starting');

    try {
        for (const bookName of activeBooks) {
            if (getChatId() !== chatId || task.cancelled) break;

            const bookData = await getCachedWorldInfo(bookName);
            if (!bookData?.entries) continue;

            // ── Step 1: Find and merge near-duplicate entries ──
            if (settings.lifecycleConsolidate !== false) {
                const dupeResult = await findAndMergeDuplicates(bookName, bookData, chatId);
                result.duplicatesFound += dupeResult.found;
                result.duplicatesMerged += dupeResult.merged;
                result.errors += dupeResult.errors;
            }

            if (getChatId() !== chatId || task.cancelled) break;

            // ── Step 2: Compress verbose entries ──
            if (settings.lifecycleCompress !== false) {
                const compressResult = await compressVerboseEntries(bookName, bookData, chatId);
                result.entriesCompressed += compressResult.compressed;
                result.errors += compressResult.errors;
            }
        }

        if (!task.cancelled) {
            setLifecycleState({
                lastRunMsgIdx: (getContext().chat?.length || 1) - 1,
                lastRunAt: Date.now(),
                lastResult: result,
            });
        }

        const details = [];
        if (result.entriesCompressed > 0) details.push(`${result.entriesCompressed} compressed`);
        if (result.duplicatesMerged > 0) details.push(`${result.duplicatesMerged} merged`);
        else if (result.duplicatesFound > 0) details.push(`${result.duplicatesFound} duplicate pairs`);
        console.log(`[TunnelVision] Lifecycle maintenance complete: ${details.length > 0 ? details.join(', ') : 'no changes needed'}`);

        if (details.length > 0) {
            addBackgroundEvent({
                icon: 'fa-recycle',
                verb: 'Lifecycle',
                color: '#00cec9',
                summary: details.join(', '),
                details,
            });
        }

        return result;
    } catch (e) {
        console.error('[TunnelVision] Lifecycle maintenance failed:', e);
        toastr.error(`Memory lifecycle maintenance failed: ${e.message || 'Unknown error'}`, 'TunnelVision');
        addBackgroundEvent({
            icon: 'fa-triangle-exclamation',
            verb: 'Lifecycle failed',
            color: '#d63031',
            summary: e.message || 'Unknown error',
        });
        return null;
    } finally {
        _lifecycleRunning = false;
        task.end();
    }
}

// ── Step 1: Duplicate Detection ──────────────────────────────────

async function findAndMergeDuplicates(bookName, bookData, chatId) {
    const result = { found: 0, merged: 0, errors: 0 };

    const entries = [];
    for (const key of Object.keys(bookData.entries)) {
        const entry = bookData.entries[key];
        if (entry.disable) continue;
        const title = (entry.comment || '').trim();
        if (!title) continue;
        // Skip trackers and summaries — they should not be auto-merged
        const lowerTitle = title.toLowerCase();
        if (lowerTitle.startsWith('[tracker') || lowerTitle.startsWith('[summary') || lowerTitle.startsWith('[scene summary')) continue;
        entries.push({ uid: entry.uid, title, content: (entry.content || '').substring(0, 200) });
    }

    if (entries.length < 2) return result;

    const entryList = entries.slice(0, 80).map(e =>
        `- UID ${e.uid}: "${e.title}" — ${e.content.replace(/\n/g, ' ').substring(0, 100)}...`,
    ).join('\n');

    const quietPrompt = [
        'You are a lorebook maintenance assistant. Analyze these lorebook entry titles and previews.',
        'Identify pairs that are genuinely about the SAME topic/entity and contain overlapping information that should be consolidated into one entry.',
        '',
        `[Entries in "${bookName}"]`,
        entryList,
        '',
        'Find entries that are duplicates or near-duplicates. For each pair, decide which entry to KEEP (the more complete one) and provide merged content that combines the best of both.',
        'Respond with a JSON array. If no duplicates found, respond with [].',
        'Format: [{"keep_uid": 123, "remove_uid": 456, "merged_title": "best title", "merged_content": "combined content preserving all unique facts", "reason": "brief reason"}]',
        '',
        'Only flag genuine duplicates — not entries that merely reference the same character in different contexts.',
        'Limit to at most 3 merge pairs per run.',
        'Respond with ONLY the JSON array.',
    ].join('\n');

    try {
        const response = await callWithRetry(
            () => generateQuietPrompt({ quietPrompt, skipWIAN: true }),
            { label: 'Lifecycle duplicates' },
        );
        if (getChatId() !== chatId) return result;

        const pairs = parseJsonFromLLM(response, { type: 'array' });
        if (!Array.isArray(pairs) || pairs.length === 0) return result;

        result.found = pairs.length;

        for (const pair of pairs.slice(0, 3)) {
            if (!pair?.keep_uid || !pair?.remove_uid) continue;
            if (getChatId() !== chatId) break;

            try {
                await mergeEntries(bookName, Number(pair.keep_uid), Number(pair.remove_uid), {
                    mergedContent: pair.merged_content || undefined,
                    mergedTitle: pair.merged_title || undefined,
                });
                result.merged++;
                console.log(`[TunnelVision] Lifecycle: merged UID ${pair.remove_uid} → ${pair.keep_uid} in "${bookName}" (${pair.reason || 'duplicate'})`);
            } catch (e) {
                console.warn(`[TunnelVision] Lifecycle: merge failed for ${pair.keep_uid} ↔ ${pair.remove_uid}:`, e);
                result.errors++;
            }
        }
    } catch (e) {
        console.warn('[TunnelVision] Lifecycle duplicate detection failed:', e);
        result.errors++;
    }

    return result;
}

// ── Step 2: Entry Compression ────────────────────────────────────

const COMPRESSION_THRESHOLD = 1500;

async function compressVerboseEntries(bookName, bookData, chatId) {
    const result = { compressed: 0, errors: 0 };

    // Find entries that are excessively long
    const verbose = [];
    for (const key of Object.keys(bookData.entries)) {
        const entry = bookData.entries[key];
        if (entry.disable) continue;
        if ((entry.content || '').length > COMPRESSION_THRESHOLD) {
            // Skip tracker entries and summaries — they have intentional structure
            const title = (entry.comment || '').toLowerCase();
            if (title.startsWith('[tracker') || title.startsWith('[summary')) continue;

            verbose.push({
                uid: entry.uid,
                title: entry.comment || `#${entry.uid}`,
                content: entry.content,
            });
        }
    }

    if (verbose.length === 0) return result;

    // Process up to 3 entries per cycle to limit API usage
    const batch = verbose.slice(0, 3);

    for (const entry of batch) {
        if (getChatId() !== chatId) break;

        const quietPrompt = [
            'You are a lorebook editor. This entry is too verbose and needs to be condensed.',
            'Preserve ALL key facts, names, relationships, and important details.',
            'Remove redundancy, filler, and excessive description. Aim for 40-60% of the original length.',
            '',
            `[Entry: "${entry.title}" (UID ${entry.uid})]`,
            entry.content,
            '',
            'Rewrite this entry in a more concise form. Preserve the same format/structure if it has one.',
            'Respond with ONLY the compressed content. No commentary, no code fences.',
        ].join('\n');

        try {
            const response = await callWithRetry(
                () => generateQuietPrompt({ quietPrompt, skipWIAN: true }),
                { label: 'Lifecycle compress', maxRetries: 1 },
            );
            if (getChatId() !== chatId) return result;

            const compressed = response?.trim();
            if (!compressed || compressed.length >= entry.content.length) continue;

            // Safety check: don't compress if the result is too short (model might have hallucinated)
            if (compressed.length < entry.content.length * 0.2) {
                console.warn(`[TunnelVision] Lifecycle: compression result suspiciously short for "${entry.title}", skipping`);
                continue;
            }

            // Apply the compression by loading fresh book data
            const freshBookData = await loadWorldInfo(bookName);
            if (!freshBookData?.entries) continue;

            const uidMap = buildUidMap(freshBookData.entries);
            const freshEntry = uidMap.get(entry.uid);
            if (!freshEntry) continue;

            freshEntry.content = compressed;
            await saveWorldInfo(bookName, freshBookData, true);
            invalidateWorldInfoCache(bookName);
            result.compressed++;

            console.log(`[TunnelVision] Lifecycle: compressed "${entry.title}" (${entry.content.length} → ${compressed.length} chars)`);
        } catch (e) {
            console.warn(`[TunnelVision] Lifecycle: compression failed for "${entry.title}":`, e);
            result.errors++;
        }
    }

    return result;
}

// ── Event Handlers ───────────────────────────────────────────────

const _chatRef = { lastChatLength: 0 };

function onAiMessageReceived() {
    const settings = getSettings();
    if (!settings.lifecycleEnabled || settings.globalEnabled === false) return;
    if (shouldSkipAiMessage(_chatRef)) return;

    if (shouldRunLifecycle()) {
        runLifecycleMaintenance().catch(e => {
            console.error('[TunnelVision] Background lifecycle maintenance failed:', e);
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

export function initMemoryLifecycle() {
    if (_initialized) return;
    _initialized = true;

    if (event_types.MESSAGE_RECEIVED) {
        eventSource.on(event_types.MESSAGE_RECEIVED, onAiMessageReceived);
    }
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    }

    console.log('[TunnelVision] Memory lifecycle manager initialized');
}

// ── Public API ───────────────────────────────────────────────────

export function getLastLifecycleResult() {
    return getLifecycleState()?.lastResult || null;
}

export function getLastLifecycleRunIndex() {
    return getLifecycleState()?.lastRunMsgIdx ?? -1;
}

/** @internal — not currently used externally but kept for future coordination */
function isLifecycleRunning() {
    return _lifecycleRunning;
}
