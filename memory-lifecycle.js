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
import { getCachedWorldInfo, buildUidMap, parseJsonFromLLM, invalidateWorldInfoCache } from './entry-manager.js';
import { loadWorldInfo, saveWorldInfo } from '../../../world-info.js';

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

function getChatId() {
    try {
        return getContext().chatId || null;
    } catch {
        return null;
    }
}

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

    const result = {
        entriesCompressed: 0,
        duplicatesFound: 0,
        errors: 0,
    };

    console.log('[TunnelVision] Memory lifecycle maintenance starting');

    try {
        for (const bookName of activeBooks) {
            if (getChatId() !== chatId) break;

            const bookData = await getCachedWorldInfo(bookName);
            if (!bookData?.entries) continue;

            // ── Step 1: Find near-duplicate entries and suggest consolidation ──
            if (settings.lifecycleConsolidate !== false) {
                const dupeResult = await findAndReportDuplicates(bookName, bookData, chatId);
                result.duplicatesFound += dupeResult.found;
                result.errors += dupeResult.errors;
            }

            if (getChatId() !== chatId) break;

            // ── Step 2: Compress verbose entries ──
            if (settings.lifecycleCompress !== false) {
                const compressResult = await compressVerboseEntries(bookName, bookData, chatId);
                result.entriesCompressed += compressResult.compressed;
                result.errors += compressResult.errors;
            }
        }

        setLifecycleState({
            lastRunMsgIdx: (getContext().chat?.length || 1) - 1,
            lastRunAt: Date.now(),
            lastResult: result,
        });

        const parts = [];
        if (result.entriesCompressed > 0) parts.push(`${result.entriesCompressed} compressed`);
        if (result.duplicatesFound > 0) parts.push(`${result.duplicatesFound} duplicate pairs flagged`);
        console.log(`[TunnelVision] Lifecycle maintenance complete: ${parts.length > 0 ? parts.join(', ') : 'no changes needed'}`);

        return result;
    } catch (e) {
        console.error('[TunnelVision] Lifecycle maintenance failed:', e);
        return null;
    } finally {
        _lifecycleRunning = false;
    }
}

// ── Step 1: Duplicate Detection ──────────────────────────────────

async function findAndReportDuplicates(bookName, bookData, chatId) {
    const result = { found: 0, errors: 0 };

    const entries = [];
    for (const key of Object.keys(bookData.entries)) {
        const entry = bookData.entries[key];
        if (entry.disable) continue;
        const title = (entry.comment || '').trim();
        if (!title) continue;
        entries.push({ uid: entry.uid, title, content: (entry.content || '').substring(0, 200) });
    }

    if (entries.length < 2) return result;

    // Build a compact list for the LLM to analyze
    const entryList = entries.slice(0, 80).map(e =>
        `- UID ${e.uid}: "${e.title}" — ${e.content.replace(/\n/g, ' ').substring(0, 100)}...`,
    ).join('\n');

    const quietPrompt = [
        'You are a lorebook maintenance assistant. Analyze these lorebook entry titles and previews.',
        'Identify pairs that appear to be about the SAME topic/entity and could be consolidated.',
        '',
        `[Entries in "${bookName}"]`,
        entryList,
        '',
        'Find entries that are duplicates or near-duplicates (same entity/topic, overlapping information).',
        'Respond with a JSON array of duplicate pairs. If no duplicates found, respond with [].',
        'Format: [{"uid_a": 123, "uid_b": 456, "reason": "brief reason they overlap"}]',
        '',
        'Only flag genuine duplicates — not entries that merely reference the same character in different contexts.',
        'Respond with ONLY the JSON array.',
    ].join('\n');

    try {
        const response = await generateQuietPrompt({ quietPrompt, skipWIAN: true });
        if (getChatId() !== chatId) return result;

        const pairs = parseJsonFromLLM(response, { type: 'array' });
        if (Array.isArray(pairs) && pairs.length > 0) {
            result.found = pairs.length;
            for (const pair of pairs.slice(0, 5)) {
                console.log(`[TunnelVision] Lifecycle: duplicate candidate in "${bookName}": UID ${pair.uid_a} ↔ ${pair.uid_b} (${pair.reason || 'similar content'})`);
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
            const response = await generateQuietPrompt({ quietPrompt, skipWIAN: true });
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

let _lastCountedChatLength = 0;

function onAiMessageReceived() {
    const settings = getSettings();
    if (!settings.lifecycleEnabled || settings.globalEnabled === false) return;

    // Skip tool recursion
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

    if (shouldRunLifecycle()) {
        runLifecycleMaintenance().catch(e => {
            console.error('[TunnelVision] Background lifecycle maintenance failed:', e);
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

export function isLifecycleRunning() {
    return _lifecycleRunning;
}
