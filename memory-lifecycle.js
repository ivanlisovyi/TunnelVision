/**
 * TunnelVision Memory Lifecycle Manager
 *
 * A periodic background process that maintains lorebook health over long
 * conversations. Runs every N turns (configurable) and performs:
 *
 *   1. Consolidation — Find entries about the same entity and merge them
 *   2. Compression — Condense verbose entries while preserving key facts
 *   3. Reorganization — Categorize orphaned entries into the tree index
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
import { getSettings, getTree, saveTree, createTreeNode, addEntryToNode, removeEntryFromTree, getAllEntryUids, isSummaryTitle, isTrackerTitle, getTrackerUids } from './tree-store.js';
import { getActiveTunnelVisionBooks } from './tool-registry.js';
import { getCachedWorldInfo, buildUidMap, parseJsonFromLLM, invalidateWorldInfoCache, mergeEntries, findEntryByUid, updateEntry, forgetEntry } from './entry-manager.js';
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
        contradictionsFound: 0,
        contradictionsResolved: 0,
        entriesReorganized: 0,
        errors: 0,
    };

    console.log('[TunnelVision] Memory lifecycle maintenance starting');

    try {
        for (const bookName of activeBooks) {
            if (getChatId() !== chatId || task.cancelled) break;

            const bookData = await getCachedWorldInfo(bookName);
            if (!bookData?.entries) continue;

            // Steps run sequentially: dedup and compress both do read-modify-write
            // on bookData via saveWorldInfo, and dedup also modifies the tree.
            // Parallelizing would cause lost-update races on shared mutable state.
            if (settings.lifecycleConsolidate !== false) {
                const dupeResult = await findAndMergeDuplicates(bookName, bookData, chatId);
                result.duplicatesFound += dupeResult.found;
                result.duplicatesMerged += dupeResult.merged;
                result.contradictionsFound += dupeResult.contradictionsFound;
                result.contradictionsResolved += dupeResult.contradictionsResolved;
                result.errors += dupeResult.errors;
            }

            if (getChatId() !== chatId || task.cancelled) break;

            if (settings.lifecycleCompress !== false) {
                const compressResult = await compressVerboseEntries(bookName, bookData, chatId);
                result.entriesCompressed += compressResult.compressed;
                result.errors += compressResult.errors;
            }

            if (getChatId() !== chatId || task.cancelled) break;

            if (settings.lifecycleReorganize !== false) {
                const reorgResult = await reorganizeTree(bookName, bookData, chatId);
                result.entriesReorganized += reorgResult.reorganized;
                result.errors += reorgResult.errors;
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
        if (result.contradictionsResolved > 0) details.push(`${result.contradictionsResolved} contradiction(s) resolved`);
        else if (result.contradictionsFound > 0) details.push(`${result.contradictionsFound} contradiction(s) found`);
        if (result.entriesReorganized > 0) details.push(`${result.entriesReorganized} reorganized`);
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
    const result = { found: 0, merged: 0, contradictionsFound: 0, contradictionsResolved: 0, errors: 0 };

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
        'Perform TWO checks:',
        '',
        '1. DUPLICATES: Identify pairs that are genuinely about the SAME topic/entity and contain overlapping information that should be consolidated.',
        '2. CONTRADICTIONS: Identify pairs where one fact directly contradicts another about the same subject (e.g. "Elena lives in Port Alara" vs "Elena moved to the capital"). The NEWER entry (higher UID) is assumed to have more recent/accurate info.',
        '',
        `[Entries in "${bookName}"]`,
        entryList,
        '',
        'For DUPLICATES: decide which entry to KEEP (more complete) and provide merged content combining the best of both.',
        'For CONTRADICTIONS: the entry with the HIGHER UID is newer and takes precedence. Provide resolved content that reflects the current truth. The older (lower UID) entry will be superseded.',
        '',
        'Respond with a JSON array. If nothing found, respond with [].',
        'Format: [{"type": "duplicate"|"contradiction", "keep_uid": 123, "remove_uid": 456, "merged_title": "best title", "merged_content": "resolved content", "reason": "brief reason"}]',
        '',
        'For contradictions: keep_uid = the NEWER entry (higher UID), remove_uid = the OLDER entry (lower UID).',
        'Only flag genuine duplicates or direct contradictions — not entries that merely reference the same character in different contexts.',
        'Different facts about the same character (e.g. "Elena is brave" and "Elena lives in Port Alara") are NOT contradictions.',
        'Limit to at most 3 duplicate pairs + 3 contradiction pairs per run.',
        'Respond with ONLY the JSON array.',
    ].join('\n');

    try {
        const response = await callWithRetry(
            () => generateQuietPrompt({ quietPrompt, skipWIAN: true }),
            { label: 'Lifecycle consolidation' },
        );
        if (getChatId() !== chatId) return result;

        const pairs = parseJsonFromLLM(response, { type: 'array' });
        if (!Array.isArray(pairs) || pairs.length === 0) return result;

        const duplicates = pairs.filter(p => p?.type !== 'contradiction').slice(0, 3);
        const contradictions = pairs.filter(p => p?.type === 'contradiction').slice(0, 3);

        result.found = duplicates.length;
        result.contradictionsFound = contradictions.length;

        // Process duplicates — merge as before
        for (const pair of duplicates) {
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

        // Process contradictions — update newer entry with resolved content, disable older
        for (const pair of contradictions) {
            if (!pair?.keep_uid || !pair?.remove_uid) continue;
            if (getChatId() !== chatId) break;

            try {
                const keepUid = Number(pair.keep_uid);
                const removeUid = Number(pair.remove_uid);

                // Update the newer entry with resolved content
                if (pair.merged_content) {
                    await updateEntry(bookName, keepUid, {
                        content: pair.merged_content,
                        ...(pair.merged_title ? { comment: pair.merged_title } : {}),
                    });
                }

                // Disable the older (superseded) entry
                await forgetEntry(bookName, removeUid, false);

                result.contradictionsResolved++;
                console.log(`[TunnelVision] Lifecycle: resolved contradiction — UID ${removeUid} superseded by UID ${keepUid} in "${bookName}" (${pair.reason || 'contradiction'})`);
            } catch (e) {
                console.warn(`[TunnelVision] Lifecycle: contradiction resolution failed for ${pair.keep_uid} ↔ ${pair.remove_uid}:`, e);
                result.errors++;
            }
        }
    } catch (e) {
        console.warn('[TunnelVision] Lifecycle consolidation failed:', e);
        result.errors++;
    }

    return result;
}

// ── Character Entry Detection ────────────────────────────────────

/**
 * Build a set of UIDs that belong to character-related tree subtrees.
 * A subtree is character-related if it contains at least one tracker entry
 * (trackers are per-character by definition). Also includes entries whose
 * keywords contain "character". This works regardless of category naming.
 */
function buildCharacterUidSet(bookName, bookData) {
    const characterUids = new Set();
    const trackerSet = new Set(getTrackerUids(bookName));

    const tree = getTree(bookName);
    if (tree?.root) {
        for (const child of (tree.root.children || [])) {
            const subtreeUids = getAllEntryUids(child);
            if (subtreeUids.some(uid => trackerSet.has(uid))) {
                for (const uid of subtreeUids) characterUids.add(uid);
            }
        }
    }

    if (bookData?.entries) {
        for (const key of Object.keys(bookData.entries)) {
            const entry = bookData.entries[key];
            if (entry.disable) continue;
            const keys = entry.key || [];
            if (keys.some(k => String(k).toLowerCase().includes('character'))) {
                characterUids.add(entry.uid);
            }
        }
    }

    return characterUids;
}

// ── Step 2: Entry Compression ────────────────────────────────────

const COMPRESSION_THRESHOLD = 1500;

async function compressVerboseEntries(bookName, bookData, chatId) {
    const result = { compressed: 0, errors: 0 };

    const characterUids = buildCharacterUidSet(bookName, bookData);

    // Find entries that are excessively long
    const verbose = [];
    for (const key of Object.keys(bookData.entries)) {
        const entry = bookData.entries[key];
        if (entry.disable) continue;
        if ((entry.content || '').length > COMPRESSION_THRESHOLD) {
            // Skip tracker entries and summaries — they have intentional structure
            const title = (entry.comment || '').toLowerCase();
            if (title.startsWith('[tracker') || title.startsWith('[summary')) continue;

            // Skip character entries — their detail is intentional
            if (characterUids.has(entry.uid)) continue;

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

// ── Step 3: Tree Reorganization ──────────────────────────────────

const REORGANIZE_BATCH_LIMIT = 30;

/**
 * Find entries that are orphaned (on root node or missing from the tree entirely)
 * and use an LLM call to assign them to existing tree categories.
 */
async function reorganizeTree(bookName, bookData, chatId) {
    const result = { reorganized: 0, errors: 0 };

    const tree = getTree(bookName);
    if (!tree?.root || tree.root.children.length === 0) return result;

    const assignedUids = new Set(getAllEntryUids(tree.root));
    const rootUidSet = new Set(tree.root.entryUids || []);

    // Collect orphaned entries: on root or not in tree at all
    const orphaned = [];
    for (const key of Object.keys(bookData.entries)) {
        const entry = bookData.entries[key];
        if (!entry || entry.disable) continue;
        if (isSummaryTitle(entry.comment) || isTrackerTitle(entry.comment)) continue;

        const onRoot = rootUidSet.has(entry.uid);
        const missing = !assignedUids.has(entry.uid);
        if (onRoot || missing) {
            orphaned.push(entry);
        }
    }

    if (orphaned.length === 0) return result;

    const batch = orphaned.slice(0, REORGANIZE_BATCH_LIMIT);

    // Collect existing category paths (excluding Summaries)
    const categories = [];
    function collectCategories(node, prefix) {
        for (const child of (node.children || [])) {
            if (child.label === 'Summaries') continue;
            const path = prefix ? `${prefix} > ${child.label}` : child.label;
            const desc = child.summary ? ` — ${child.summary}` : '';
            categories.push({ path, label: child.label, id: child.id, desc });
            collectCategories(child, path);
        }
    }
    collectCategories(tree.root, '');

    if (categories.length === 0) return result;

    const entryList = batch.map(e => {
        const label = e.comment || e.key?.[0] || `Entry #${e.uid}`;
        const preview = (e.content || '').substring(0, 150).replace(/\n/g, ' ');
        return `  UID ${e.uid}: "${label}" — ${preview}`;
    }).join('\n');

    const catList = categories.map(c => `  - "${c.path}"${c.desc}`).join('\n');

    const quietPrompt = [
        'You are a lorebook organization assistant. Assign each entry to the most appropriate existing category.',
        '',
        '[Existing Categories]',
        catList,
        '',
        '[Entries to Categorize]',
        entryList,
        '',
        'Assign each entry UID to the best matching category. Use the category name (last segment, not the full path).',
        'If an entry genuinely doesn\'t fit any category, use "new: Suggested Name" as the category.',
        'Respond with ONLY a JSON array: [{"uid": 123, "category": "Category Name"}]',
        'No commentary, no code fences.',
    ].join('\n');

    try {
        const response = await callWithRetry(
            () => generateQuietPrompt({ quietPrompt, skipWIAN: true }),
            { label: 'Lifecycle reorganize', maxRetries: 1 },
        );
        if (getChatId() !== chatId) return result;

        const assignments = parseJsonFromLLM(response, { type: 'array' });
        if (!Array.isArray(assignments) || assignments.length === 0) return result;

        // Build a label→node map (case-insensitive) for fast lookup
        const labelMap = new Map();
        function indexNodes(node) {
            labelMap.set(node.label.toLowerCase(), node);
            for (const child of (node.children || [])) indexNodes(child);
        }
        for (const child of tree.root.children) indexNodes(child);

        const batchUids = new Set(batch.map(e => e.uid));

        for (const assignment of assignments) {
            if (!assignment?.uid || !assignment?.category) continue;
            const uid = Number(assignment.uid);
            if (!batchUids.has(uid)) continue;

            let targetNode = null;
            const catStr = String(assignment.category).trim();

            if (catStr.toLowerCase().startsWith('new:')) {
                const newLabel = catStr.substring(4).trim();
                if (newLabel) {
                    targetNode = createTreeNode(newLabel, '');
                    tree.root.children.push(targetNode);
                    labelMap.set(newLabel.toLowerCase(), targetNode);
                }
            } else {
                const segments = catStr.split('>').map(s => s.trim());
                const lastSegment = segments[segments.length - 1].toLowerCase();
                targetNode = labelMap.get(lastSegment) || labelMap.get(catStr.toLowerCase());
            }

            if (targetNode) {
                removeEntryFromTree(tree.root, uid);
                addEntryToNode(targetNode, uid);
                result.reorganized++;
            }
        }

        if (result.reorganized > 0) {
            saveTree(bookName, tree);
            console.log(`[TunnelVision] Lifecycle: reorganized ${result.reorganized} entries into tree categories in "${bookName}"`);
        }
    } catch (e) {
        console.warn('[TunnelVision] Lifecycle tree reorganization failed:', e);
        result.errors++;
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
