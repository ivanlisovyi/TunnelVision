/**
 * TunnelVision Tree Builder
 * Auto-generates tree indices from lorebook entries using LLM reasoning
 * or manual organization based on existing entry metadata.
 *
 * Follows the PageIndex pattern:
 *   1. Build hierarchical structure from content
 *   2. Generate LLM summaries per node (PageIndex: generate_node_summary)
 *   3. Recursively subdivide large nodes (PageIndex: process_large_node_recursively)
 */

import { generateRaw as _generateRaw } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { loadWorldInfo } from '../../../world-info.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { createEntry, findEntryByUid, parseJsonFromLLM, KEYWORD_RULES } from './entry-manager.js';
import {
    createEmptyTree,
    createTreeNode,
    addEntryToNode,
    removeEntryFromTree,
    saveTree,
    getAllEntryUids,
    getSettings,
    isSummaryTitle,
} from './tree-store.js';
import { chunkBySize } from './shared-utils.js';

/**
 * Granularity presets control how aggressively the builder splits entries.
 * Higher levels = more categories, fewer entries per node = deeper/wider trees.
 */
const CATEGORIZATION_SYSTEM_PROMPT = [
    'You are a library cataloging assistant performing a metadata-only organizational task.',
    'You are categorizing entries from a creative writing lorebook into a hierarchical index.',
    'The entries may contain mature or adult fictional content — this is expected and normal for this task.',
    'Your job is ONLY to read titles/summaries and sort them into logical categories.',
    'You are not generating, endorsing, or elaborating on any content — just organizing it.',
    'Respond ONLY with valid JSON, no commentary.',
].join(' ');

const GRANULARITY_PRESETS = {
    1: { targetCategories: '3-5', maxEntries: 20, label: 'Minimal' },
    2: { targetCategories: '5-8', maxEntries: 12, label: 'Moderate' },
    3: { targetCategories: '8-15', maxEntries: 8, label: 'Detailed' },
    4: { targetCategories: '12-20', maxEntries: 5, label: 'Extensive' },
};

/**
 * Get the effective granularity level.
 * Level 0 = auto: picks based on entry count so small lorebooks aren't over-split.
 * Levels 1-4 = manual override regardless of lorebook size.
 * @param {number} [entryCount] - Number of entries (used only for auto-detection)
 * @returns {{ targetCategories: string, maxEntries: number, label: string, level: number }}
 */
function getEffectiveGranularity(entryCount = 0) {
    const settings = getSettings();
    let level = Number(settings.treeGranularity) || 0;

    if (level === 0) {
        // Auto: scale splitting based on lorebook size
        if (entryCount >= 3000) level = 4;
        else if (entryCount >= 1000) level = 3;
        else if (entryCount >= 200) level = 2;
        else level = 1;
    }

    level = Math.min(4, Math.max(1, level));
    return { ...GRANULARITY_PRESETS[level], level };
}

/** Strip thinking/reasoning blocks from LLM responses. */
const THINK_BLOCK_RE = /<think[\s\S]*?<\/think>/gi;

/** Wrapper around generateRaw that strips thinking blocks from responses. */
async function generateRaw(opts) {
    const result = await _generateRaw(opts);
    return typeof result === 'string' ? result.replace(THINK_BLOCK_RE, '').trim() : result;
}

/**
 * Switch to the configured TV connection profile (if any), run the callback,
 * then restore the original profile. Falls back gracefully if Connection Manager
 * isn't installed or the /profile command isn't available.
 * @param {() => Promise<T>} fn Async function to run with the profile active
 * @returns {Promise<T>}
 * @template T
 */
async function withConnectionProfile(fn) {
    const settings = getSettings();
    const targetProfile = settings.connectionProfile;
    if (!targetProfile) {
        console.log('[TunnelVision] No connection profile configured, using current API.');
        return fn();
    }

    const profileCmd = SlashCommandParser?.commands?.['profile'];
    if (!profileCmd) {
        console.warn('[TunnelVision] /profile command not available (Connection Manager not loaded). Using current API.');
        return fn();
    }

    // Capture the current profile name to restore later
    const originalProfile = await profileCmd.callback({}, '');

    // Skip switching if already on the target profile
    if (originalProfile === targetProfile) {
        return fn();
    }

    try {
        console.log(`[TunnelVision] Switching to connection profile: "${targetProfile}"`);
        await profileCmd.callback({ await: 'true', timeout: '5000' }, targetProfile);
        return await fn();
    } finally {
        await profileCmd.callback({ await: 'true', timeout: '5000' }, originalProfile || '<None>');
    }
}

/**
 * Format a single lorebook entry for LLM prompts, respecting the detail level setting.
 * Used by categorization, subdivision, and summary generation for consistency.
 * @param {Object} entry - Lorebook entry object
 * @param {string} detail - 'full' | 'lite' | 'names'
 * @param {Object} [options]
 * @param {boolean} [options.includeUid=true] - Prefix with UID (needed for categorization, not for summaries)
 * @returns {string}
 */
function formatEntryForLLM(entry, detail, options = {}) {
    const { includeUid = true } = options;
    const label = entry.comment || entry.key?.[0] || `Entry #${entry.uid}`;

    let line = includeUid ? `UID ${entry.uid}: "${label}"` : `${label}`;

    if (detail !== 'names') {
        const keys = entry.key?.join(', ');
        if (keys) line += ` [keys: ${keys}]`;
        if (entry.group) line += ` (group: ${entry.group})`;
        if (entry.constant) line += ' [always active]';
        if (entry.keysecondary?.length > 0) line += ` [secondary: ${entry.keysecondary.join(', ')}]`;
    }

    if (detail === 'lite') {
        const preview = (entry.content || '').substring(0, 150);
        if (preview) line += `\n    Preview: ${preview}`;
    } else if (detail === 'full') {
        const content = entry.content || '';
        if (content) line += `\n    Content: ${content}`;
    }

    return line;
}

/**
 * Build a tree automatically from existing entry metadata (keys, comments, groups).
 * @param {string} lorebookName
 * @param {Object} [options]
 * @param {boolean} [options.generateSummaries=false] - Call LLM for node summaries
 * @returns {Promise<import('./tree-store.js').TreeIndex>}
 */
export async function buildTreeFromMetadata(lorebookName, options = {}) {
    const bookData = await loadWorldInfo(lorebookName);
    if (!bookData || !bookData.entries) {
        throw new Error(`Lorebook "${lorebookName}" not found or has no entries.`);
    }

    const tree = createEmptyTree(lorebookName);
    const entries = bookData.entries;
    const groupMap = new Map();
    const ungrouped = [];
    const summaryEntries = [];

    for (const key of Object.keys(entries)) {
        const entry = entries[key];
        if (entry.disable) continue;
        if (isSummaryTitle(entry.comment)) {
            summaryEntries.push(entry);
            continue;
        }
        const groupName = entry.group?.trim();
        if (groupName) {
            for (const g of groupName.split(',').map(s => s.trim()).filter(Boolean)) {
                if (!groupMap.has(g)) groupMap.set(g, []);
                groupMap.get(g).push(entry);
            }
        } else {
            ungrouped.push(entry);
        }
    }

    for (const [groupName, groupEntries] of groupMap) {
        const node = createTreeNode(groupName, `${groupEntries.length} entries from group "${groupName}"`);
        for (const entry of groupEntries) addEntryToNode(node, entry.uid);
        tree.root.children.push(node);
    }

    if (ungrouped.length > 0) {
        const keyMap = new Map();
        for (const entry of ungrouped) {
            const firstKey = entry.key?.[0]?.trim() || 'Uncategorized';
            if (!keyMap.has(firstKey)) keyMap.set(firstKey, []);
            keyMap.get(firstKey).push(entry);
        }
        if (keyMap.size <= 20) {
            for (const [keyName, keyEntries] of keyMap) {
                const node = createTreeNode(keyName, `Entries keyed on "${keyName}"`);
                for (const entry of keyEntries) addEntryToNode(node, entry.uid);
                tree.root.children.push(node);
            }
        } else {
            const generalNode = createTreeNode('General', `${ungrouped.length} ungrouped entries`);
            for (const entry of ungrouped) addEntryToNode(generalNode, entry.uid);
            tree.root.children.push(generalNode);
        }
    }

    if (options.generateSummaries) {
        await generateSummariesForTree(tree.root, lorebookName);
    }

    // Pin summary entries to the Summaries node
    if (summaryEntries.length > 0) {
        let summariesNode = tree.root.children.find(c => c.label === 'Summaries');
        if (!summariesNode) {
            summariesNode = createTreeNode('Summaries', 'Temporal scene summaries and event records created by the AI.');
            tree.root.children.push(summariesNode);
        }
        for (const entry of summaryEntries) {
            addEntryToNode(summariesNode, entry.uid);
        }
    }

    tree.lastBuilt = Date.now();
    saveTree(lorebookName, tree);
    return tree;
}

/**
 * Build a tree using LLM reasoning to categorize entries.
 * Large lorebooks are split into chunks (with overfill) and categorized in multiple passes.
 * After building: subdivide large nodes, then generate per-node summaries.
 * @param {string} lorebookName
 * @param {Object} [options]
 * @param {function(string, number): void} [options.onProgress] - Called with (message, percentage 0-100)
 * @param {function(string): void} [options.onDetail] - Called with detail/sub-status text
 * @returns {Promise<import('./tree-store.js').TreeIndex>}
 */
export async function buildTreeWithLLM(lorebookName, options = {}) {
    return withConnectionProfile(() => _buildTreeWithLLM(lorebookName, options));
}

/** Default max concurrent LLM calls during build phases. */
const BUILD_CONCURRENCY = 3;

/**
 * Run an array of async tasks with bounded concurrency.
 * @param {Array<() => Promise>} tasks - Factory functions that return promises
 * @param {number} limit - Max concurrent tasks
 * @returns {Promise<Array>} Results in order
 */
export async function runWithConcurrency(tasks, limit = BUILD_CONCURRENCY) {
    const results = new Array(tasks.length);
    let nextIdx = 0;

    async function worker() {
        while (nextIdx < tasks.length) {
            const idx = nextIdx++;
            try {
                results[idx] = await tasks[idx]();
            } catch (e) {
                results[idx] = e;
            }
        }
    }

    const workers = [];
    for (let i = 0; i < Math.min(limit, tasks.length); i++) {
        workers.push(worker());
    }
    await Promise.all(workers);
    return results;
}

export function splitEntriesForTree(bookData) {
    const activeEntries = [];
    const summaryEntries = [];
    for (const key of Object.keys(bookData.entries)) {
        const entry = bookData.entries[key];
        if (entry.disable) continue;
        if (isSummaryTitle(entry.comment)) {
            summaryEntries.push(entry);
        } else {
            activeEntries.push(entry);
        }
    }
    return { activeEntries, summaryEntries };
}

export function getTreeBuildSettings(settings) {
    return {
        detail: settings.llmBuildDetail || 'full',
        chunkLimit: settings.llmChunkTokens || 30000,
    };
}

export async function categorizeInitialChunk(lorebookName, chunks, activeEntries) {
    const firstPrompt = buildCategorizationPrompt(lorebookName, chunks[0], activeEntries.length);
    const firstResponse = await generateRaw({
        prompt: firstPrompt,
        systemPrompt: CATEGORIZATION_SYSTEM_PROMPT,
    });
    if (!firstResponse) throw new Error('LLM returned empty response for tree categorization.');

    const allUids = activeEntries.map(e => e.uid);
    const tree = await parseLLMTreeResponse(lorebookName, firstResponse, allUids);
    return { tree, allUids };
}

export async function categorizeContinuationChunks(lorebookName, chunks, tree, activeEntries, allUids, progress) {
    if (chunks.length <= 1) return;

    const existingCategories = extractCategoryLabels(tree.root);
    const chunkTasks = [];
    for (let i = 1; i < chunks.length; i++) {
        const chunkIdx = i;
        chunkTasks.push(() => {
            progress(`Categorizing chunks (${chunkIdx + 1}/${chunks.length})`, Math.round((chunkIdx / chunks.length) * 60));
            const contPrompt = buildContinuationPrompt(lorebookName, chunks[chunkIdx], existingCategories, activeEntries.length);
            return generateRaw({
                prompt: contPrompt,
                systemPrompt: CATEGORIZATION_SYSTEM_PROMPT,
            });
        });
    }

    const chunkResults = await runWithConcurrency(chunkTasks, BUILD_CONCURRENCY);
    for (let i = 0; i < chunkResults.length; i++) {
        const resp = chunkResults[i];
        if (resp && typeof resp === 'string') {
            mergeLLMResponse(tree, resp, allUids);
        } else if (resp instanceof Error) {
            console.warn(`[TunnelVision] Chunk ${i + 2}/${chunks.length} categorization failed:`, resp);
        }
    }
}

export function assignUnassignedEntries(tree, allUids) {
    const assigned = new Set(getAllEntryUids(tree.root));
    for (const uid of allUids) {
        if (!assigned.has(uid)) addEntryToNode(tree.root, uid);
    }
}

export function pinSummaryEntries(tree, summaryEntries) {
    if (summaryEntries.length === 0) return;

    let summariesNode = tree.root.children.find(c => c.label === 'Summaries');
    if (!summariesNode) {
        summariesNode = createTreeNode('Summaries', 'Temporal scene summaries and event records created by the AI.');
        tree.root.children.push(summariesNode);
    }
    for (const entry of summaryEntries) {
        removeEntryFromTree(tree.root, entry.uid);
        addEntryToNode(summariesNode, entry.uid);
    }
}

export async function _buildTreeWithLLM(lorebookName, options = {}) {
    const progress = options.onProgress || (() => {});
    const detail_ = options.onDetail || (() => {});
    const bookData = await loadWorldInfo(lorebookName);
    if (!bookData || !bookData.entries) {
        throw new Error(`Lorebook "${lorebookName}" not found or has no entries.`);
    }

    const { activeEntries, summaryEntries } = splitEntriesForTree(bookData);

    if (activeEntries.length === 0 && summaryEntries.length === 0) {
        throw new Error(`Lorebook "${lorebookName}" has no active entries to index.`);
    }

    const settings = getSettings();
    const { detail, chunkLimit } = getTreeBuildSettings(settings);

    const chunks = chunkEntries(activeEntries, detail, chunkLimit);
    const gran = getEffectiveGranularity(activeEntries.length);
    console.log(`[TunnelVision] Categorizing ${activeEntries.length} entries in ${chunks.length} chunk(s) (limit: ${chunkLimit} chars)${summaryEntries.length > 0 ? ` (${summaryEntries.length} summaries pinned)` : ''}`);
    console.log(`[TunnelVision] Using granularity level ${gran.level} (${gran.label}): ${gran.targetCategories} top-level categories, max ${gran.maxEntries} entries/node`);

    progress(`Categorizing chunk 1/${chunks.length}`, 0);
    detail_(`${activeEntries.length} entries across ${chunks.length} chunk(s)`);

    const { tree, allUids } = await categorizeInitialChunk(lorebookName, chunks, activeEntries);

    await categorizeContinuationChunks(lorebookName, chunks, tree, activeEntries, allUids, progress);

    assignUnassignedEntries(tree, allUids);

    tree.lastBuilt = Date.now();
    saveTree(lorebookName, tree);
    console.log('[TunnelVision] Chunked categorization complete, saved intermediate tree.');

    progress('Subdividing large nodes…', 65);
    detail_(`Splitting categories with ${gran.maxEntries}+ entries (granularity: ${gran.label})`);
    await subdivideLargeNodes(tree.root, bookData, activeEntries.length);
    saveTree(lorebookName, tree);

    progress('Generating summaries…', 80);
    detail_('LLM writing descriptions for each category');
    await _generateSummariesForTree(tree.root, lorebookName, true, bookData);

    pinSummaryEntries(tree, summaryEntries);

    saveTree(lorebookName, tree);
    return tree;
}

// ─── Chunking ────────────────────────────────────────────────────

/**
 * Split entries into chunks that fit within the character limit.
 * Uses overfill: if adding the next entry exceeds the limit, include it
 * anyway so entries are never split mid-way. Only starts a new chunk after.
 * @param {Object[]} entries - Lorebook entry objects
 * @param {string} detail - Detail level for formatting
 * @param {number} charLimit - Max characters per chunk
 * @returns {Object[][]} Array of entry chunks
 */
export function chunkEntries(entries, detail, charLimit) {
    return chunkBySize(entries, (entry) => formatEntryForLLM(entry, detail).length + 5, charLimit);
}

/**
 * Extract existing category labels from tree for continuation prompts.
 * @param {import('./tree-store.js').TreeNode} root
 * @returns {string[]}
 */
export function extractCategoryLabels(root) {
    const labels = [];
    for (const child of (root.children || [])) {
        labels.push(child.label);
        for (const sub of (child.children || [])) {
            labels.push(`${child.label} > ${sub.label}`);
        }
    }
    return labels;
}

/**
 * Build a continuation prompt for subsequent chunks that references existing categories.
 * @param {string} lorebookName
 * @param {Object[]} entries
 * @param {string[]} existingCategories
 * @returns {string}
 */
export function buildContinuationPrompt(lorebookName, entries, existingCategories, totalEntryCount = 0) {
    const detail = getSettings().llmBuildDetail || 'full';
    const entryList = entries.map(e => `  - ${formatEntryForLLM(e, detail)}`).join('\n');
    const catList = existingCategories.map(c => `  - ${c}`).join('\n');
    const gran = getEffectiveGranularity(totalEntryCount);
    const subCatHint = gran.level >= 3 ? ' Prefer creating new sub-categories over placing entries in broad existing ones.' : '';

    return `You are continuing to organize a lorebook called "${lorebookName}". Previous entries have already been categorized.

Existing categories:
${catList}

Here are the NEW entries to categorize:
${entryList}

Assign each entry to an existing category, or create new categories if none fit.${subCatHint} Every entry UID must appear exactly once.

Respond with ONLY valid JSON in this exact format:
{
  "categories": [
    {
      "label": "Existing or New Category Name",
      "summary": "Brief description",
      "entries": [uid1, uid2],
      "children": []
    }
  ]
}`;
}

/**
 * Merge a continuation LLM response into the existing tree.
 * Entries assigned to existing category labels go into those nodes;
 * new categories are added as new children of root.
 * @param {import('./tree-store.js').TreeIndex} tree
 * @param {string} response
 * @param {number[]} validUids
 */
function mergeLLMResponse(tree, response, validUids) {
    try {
        const parsed = parseJsonFromLLM(response);
        if (!parsed.categories || !Array.isArray(parsed.categories)) return;

        const validSet = new Set(validUids);
        const alreadyAssigned = new Set(getAllEntryUids(tree.root));

        // Build a label→node lookup for existing categories (case-insensitive)
        const labelMap = new Map();
        function indexNodes(node) {
            labelMap.set(node.label.toLowerCase(), node);
            for (const child of (node.children || [])) indexNodes(child);
        }
        for (const child of tree.root.children) indexNodes(child);

        for (const cat of parsed.categories) {
            const catLabel = (cat.label || 'Unnamed').toLowerCase();
            const existingNode = labelMap.get(catLabel);
            const targetNode = existingNode || createTreeNode(cat.label || 'Unnamed', cat.summary || '');

            if (Array.isArray(cat.entries)) {
                for (const uid of cat.entries) {
                    const n = Number(uid);
                    if (validSet.has(n) && !alreadyAssigned.has(n)) {
                        addEntryToNode(targetNode, n);
                        alreadyAssigned.add(n);
                    }
                }
            }

            // Handle children in the response
            if (Array.isArray(cat.children)) {
                for (const sub of cat.children) {
                    const subLabel = (sub.label || 'Unnamed').toLowerCase();
                    const existingSub = labelMap.get(subLabel);
                    const subNode = existingSub || createTreeNode(sub.label || 'Unnamed', sub.summary || '');
                    if (Array.isArray(sub.entries)) {
                        for (const uid of sub.entries) {
                            const n = Number(uid);
                            if (validSet.has(n) && !alreadyAssigned.has(n)) {
                                addEntryToNode(subNode, n);
                                alreadyAssigned.add(n);
                            }
                        }
                    }
                    if (!existingSub && subNode.entryUids.length > 0) {
                        targetNode.children.push(subNode);
                        labelMap.set(subLabel, subNode);
                    }
                }
            }

            if (!existingNode && (targetNode.entryUids.length > 0 || targetNode.children.length > 0)) {
                tree.root.children.push(targetNode);
                labelMap.set(catLabel, targetNode);
            }
        }
    } catch (e) {
        console.warn('[TunnelVision] Failed to merge continuation chunk:', e);
    }
}

/**
 * Generate LLM summaries for each node in the tree.
 * Mirrors PageIndex's generate_summaries_for_structure().
 * The summary describes what entries a node covers, enabling the retrieval
 * step to reason about relevance without reading full entry content.
 */
export async function generateSummariesForTree(node, lorebookName, _isRoot = true) {
    if (_isRoot) {
        return withConnectionProfile(() => _generateSummariesForTree(node, lorebookName, true, null));
    }
    return _generateSummariesForTree(node, lorebookName, _isRoot, null);
}

/**
 * Internal summary generator — batches nodes and runs in parallel.
 * @param {import('./tree-store.js').TreeNode} rootNode
 * @param {string} lorebookName
 * @param {boolean} _isRoot
 * @param {Object} [cachedBookData] - Pre-loaded book data to avoid redundant loads
 */
async function _generateSummariesForTree(rootNode, lorebookName, _isRoot = true, cachedBookData = null) {
    const bookData = cachedBookData || await loadWorldInfo(lorebookName);
    if (!bookData || !bookData.entries) return;

    const settings = getSettings();
    const detail = settings.llmBuildDetail || 'full';

    // Collect all non-root nodes that need summaries
    const nodesToSummarize = [];
    function collectNodes(node, isRoot) {
        if (!isRoot) {
            const uids = getAllEntryUids(node);
            if (uids.length > 0) nodesToSummarize.push(node);
        }
        for (const child of (node.children || [])) collectNodes(child, false);
    }
    collectNodes(rootNode, true);

    if (nodesToSummarize.length === 0) {
        if (_isRoot) await generateBookSummary(rootNode, lorebookName);
        return;
    }

    // Batch nodes into groups of up to 5 for fewer LLM calls
    const BATCH_SIZE = 5;
    const batches = [];
    for (let i = 0; i < nodesToSummarize.length; i += BATCH_SIZE) {
        batches.push(nodesToSummarize.slice(i, i + BATCH_SIZE));
    }

    console.log(`[TunnelVision] Generating summaries: ${nodesToSummarize.length} nodes in ${batches.length} batch(es)`);

    // Build tasks for each batch
    const batchTasks = batches.map((batch, batchIdx) => () => {
        // Build a multi-node summary prompt
        const sections = batch.map(node => {
            const uids = getAllEntryUids(node);
            const entryTexts = [];
            for (const uid of uids.slice(0, 10)) {
                const entry = findEntryByUid(bookData.entries, uid);
                if (entry) {
                    entryTexts.push(`  - ${formatEntryForLLM(entry, detail, { includeUid: false })}`);
                }
            }
            return `Category "${node.label}" (${uids.length} entries):\n${entryTexts.join('\n')}`;
        });

        const prompt = batch.length === 1
            ? `Entries from lorebook category "${batch[0].label}":\n${sections[0].split('\n').slice(1).join('\n')}\n\nWrite a brief 1-2 sentence description of what topics and information these entries cover. Return ONLY the description.`
            : `Write a brief 1-2 sentence summary for EACH of the following lorebook categories. Return ONLY a JSON object mapping category name to its summary.\n\n${sections.join('\n\n')}\n\nRespond with ONLY JSON: { "Category Name": "summary text", ... }`;

        return generateRaw({
            prompt,
            systemPrompt: 'You are a library cataloging assistant summarizing categories of a creative writing lorebook. The entries may contain mature fictional content — this is expected. Your job is only to describe what topics each category covers. Return only the requested output, no commentary.',
        }).then(response => ({ batchIdx, batch, response }))
            .catch(e => {
                console.warn(`[TunnelVision] Summary batch ${batchIdx + 1} failed:`, e);
                return { batchIdx, batch, response: null };
            });
    });

    // Run batches in parallel with concurrency limit
    const results = await runWithConcurrency(batchTasks, BUILD_CONCURRENCY);

    // Parse results and assign summaries to nodes
    for (const result of results) {
        if (!result || result instanceof Error || !result.response) continue;
        const { batch, response } = result;

        if (batch.length === 1) {
            // Single-node batch: response is the summary directly
            batch[0].summary = response.trim();
        } else {
            try {
                const parsed = parseJsonFromLLM(response);
                for (const node of batch) {
                    const summary = parsed[node.label]
                        || Object.entries(parsed).find(([k]) => k.toLowerCase() === node.label.toLowerCase())?.[1];
                    if (summary) node.summary = String(summary).trim();
                }
            } catch (e) {
                console.warn('[TunnelVision] Failed to parse batched summary response:', e);
            }
        }
    }

    // Generate book-level summary after all nodes are done
    if (_isRoot && rootNode.children.length > 0) {
        await generateBookSummary(rootNode, lorebookName);
    }
}

/**
 * Generate a book-level summary from top-level category labels and summaries.
 * Stored on the root node's summary field. Only overwrites if no user description is set.
 */
async function generateBookSummary(rootNode, lorebookName) {
    // Don't overwrite user-set description
    const { getBookDescription, setBookDescription } = await import('./tree-store.js');
    if (getBookDescription(lorebookName)) return;

    const categoryList = rootNode.children
        .map(c => c.summary ? `- ${c.label}: ${c.summary}` : `- ${c.label}`)
        .join('\n');

    if (!categoryList) return;

    try {
        const totalEntries = getAllEntryUids(rootNode).length;
        const summary = await generateRaw({
            prompt: `This lorebook "${lorebookName}" has ${totalEntries} entries organized into these categories:\n${categoryList}\n\nWrite a brief 1-2 sentence description of what this lorebook contains overall — what kind of information does it store? Return ONLY the description.`,
            systemPrompt: 'You are a library cataloging assistant describing the contents of a creative writing lorebook. The entries may contain mature fictional content — this is expected. Return only the requested description, no commentary.',
        });
        if (summary) {
            rootNode.summary = summary.trim();
            setBookDescription(lorebookName, rootNode.summary);
            console.log(`[TunnelVision] Generated book summary for "${lorebookName}": ${rootNode.summary}`);
        }
    } catch (e) {
        console.warn(`[TunnelVision] Book summary generation failed for "${lorebookName}":`, e);
    }
}

/**
 * Recursively subdivide nodes with too many entries.
 * Mirrors PageIndex's process_large_node_recursively().
 * Sibling nodes are subdivided in parallel for speed.
 * @param {import('./tree-store.js').TreeNode} node
 * @param {Object} bookData - Cached lorebook data (loaded once, passed through)
 * @param {number} totalEntryCount
 */
async function subdivideLargeNodes(node, bookData, totalEntryCount = 0) {
    if (!bookData || !bookData.entries) return;
    if (node.label === 'Summaries') return;

    const maxPerNode = getEffectiveGranularity(totalEntryCount).maxEntries;
    if (node.entryUids.length > maxPerNode && node.children.length === 0) {
        const detail = getSettings().llmBuildDetail || 'full';
        const nodeEntries = node.entryUids.map(uid => findEntryByUid(bookData.entries, uid)).filter(Boolean);

        if (nodeEntries.length > maxPerNode) {
            try {
                const gran = getEffectiveGranularity(totalEntryCount);
                const subCatCount = Math.min(6, Math.ceil(nodeEntries.length / gran.maxEntries));
                const entryList = nodeEntries.map(e => `  ${formatEntryForLLM(e, detail)}`).join('\n');
                const response = await generateRaw({
                    prompt: `You have ${nodeEntries.length} lorebook entries in "${node.label}". Split into 2-${subCatCount} sub-categories.\n\nEntries:\n${entryList}\n\nRespond ONLY with JSON: { "subcategories": [{ "label": "Name", "entries": [uid1, uid2] }] }`,
                    systemPrompt: CATEGORIZATION_SYSTEM_PROMPT,
                });
                if (response) {
                    const parsed = parseJsonFromLLM(response);
                    if (parsed.subcategories && Array.isArray(parsed.subcategories)) {
                        const assigned = new Set();
                        for (const sub of parsed.subcategories) {
                            const child = createTreeNode(sub.label || 'Unnamed', '');
                            if (Array.isArray(sub.entries)) {
                                for (const uid of sub.entries) {
                                    const n = Number(uid);
                                    if (node.entryUids.includes(n) && !assigned.has(n)) {
                                        addEntryToNode(child, n);
                                        assigned.add(n);
                                    }
                                }
                            }
                            if (child.entryUids.length > 0) node.children.push(child);
                        }
                        node.entryUids = node.entryUids.filter(uid => !assigned.has(uid));
                    }
                }
            } catch (e) {
                console.warn(`[TunnelVision] Subdivision failed for "${node.label}":`, e);
            }
        }
    }

    // Recurse into children in parallel — sibling nodes are independent
    if (node.children.length > 0) {
        const childTasks = node.children.map(child => () => subdivideLargeNodes(child, bookData, totalEntryCount));
        await runWithConcurrency(childTasks, BUILD_CONCURRENCY);
    }
}

function buildCategorizationPrompt(lorebookName, entries, totalEntryCount = 0) {
    const detail = getSettings().llmBuildDetail || 'full';
    const gran = getEffectiveGranularity(totalEntryCount);
    const entryList = entries.map(e => `  - ${formatEntryForLLM(e, detail)}`).join('\n');

    return `You are organizing a lorebook called "${lorebookName}" into a hierarchical tree for efficient retrieval.

Here are the entries:
${entryList}

Create a JSON hierarchy that groups these entries into logical categories. Use ${gran.targetCategories} top-level categories, each with sub-categories where natural. Aim for no more than ${gran.maxEntries} entries per leaf node. Every entry UID must appear exactly once.

Respond with ONLY valid JSON in this exact format:
{
  "categories": [
    {
      "label": "Category Name",
      "summary": "Brief description of what this category covers",
      "entries": [uid1, uid2],
      "children": [
        {
          "label": "Sub-category",
          "summary": "Description",
          "entries": [uid3],
          "children": []
        }
      ]
    }
  ]
}`;
}

async function parseLLMTreeResponse(lorebookName, response, entryUids) {
    try {
        const parsed = parseJsonFromLLM(response);
        if (!parsed.categories || !Array.isArray(parsed.categories)) throw new Error('Invalid structure');

        const tree = createEmptyTree(lorebookName);
        const allUids = new Set(entryUids);
        const assigned = new Set();

        function buildNodes(categories, parent) {
            for (const cat of categories) {
                const node = createTreeNode(cat.label || 'Unnamed', cat.summary || '');
                if (Array.isArray(cat.entries)) {
                    for (const uid of cat.entries) {
                        const n = Number(uid);
                        if (allUids.has(n) && !assigned.has(n)) { addEntryToNode(node, n); assigned.add(n); }
                    }
                }
                if (Array.isArray(cat.children) && cat.children.length > 0) buildNodes(cat.children, node);
                parent.children.push(node);
            }
        }

        buildNodes(parsed.categories, tree.root);
        for (const uid of allUids) { if (!assigned.has(uid)) addEntryToNode(tree.root, uid); }
        tree.lastBuilt = Date.now();
        return tree;
    } catch (err) {
        console.warn('[TunnelVision] LLM parse failed, falling back to metadata:', err);
        return await buildTreeFromMetadata(lorebookName);
    }
}

// findEntryByUid imported from entry-manager.js

// ── Chat Ingest ──────────────────────────────────────────────────

/**
 * Ingest chat messages into lorebook entries using LLM extraction.
 * Reads a range of chat messages, chunks them, sends each chunk to the LLM
 * to extract facts, then creates entries via createEntry.
 *
 * @param {string} lorebookName - Target lorebook
 * @param {Object} options
 * @param {number} options.from - Start message index (0-based)
 * @param {number} options.to - End message index (inclusive)
 * @param {function} [options.progress] - Progress callback (message, percent)
 * @param {function} [options.detail] - Detail callback (text)
 * @returns {Promise<{created: number, errors: number}>}
 */
export async function ingestChatMessages(lorebookName, options) {
    return withConnectionProfile(() => _ingestChatMessages(lorebookName, options));
}

async function _ingestChatMessages(lorebookName, { from, to, progress, detail }) {
    const context = getContext();
    if (!context.chat || context.chat.length === 0) {
        throw new Error('No chat is open. Open a chat before ingesting messages.');
    }
    if (!context.chatId) {
        throw new Error('No active chat ID. Please open a chat first.');
    }

    const chat = context.chat;
    const maxIdx = chat.length - 1;
    const start = Math.max(0, Math.min(from, maxIdx));
    const end = Math.max(start, Math.min(to, maxIdx));

    // Collect messages in range
    const messages = [];
    for (let i = start; i <= end; i++) {
        const msg = chat[i];
        if (!msg || msg.is_system) continue;
        const name = msg.name || (msg.is_user ? 'User' : 'Character');
        const text = (msg.mes || '').trim();
        if (!text) continue;
        messages.push({ index: i, name, text });
    }

    if (messages.length === 0) {
        throw new Error(`No messages found in range ${from}-${to}.`);
    }

    const report = (msg, pct) => { if (progress) progress(msg, pct); };
    const detail_ = (msg) => { if (detail) detail(msg); };

    report('Preparing messages...', 0);
    detail_(`${messages.length} messages in range ${start}-${end}`);

    // Chunk messages by character limit (reuse the same chunking strategy as tree building)
    const settings = getSettings();
    const charLimit = settings.llmChunkTokens || 30000;
    const chunks = chunkMessages(messages, charLimit);

    report(`Extracting facts from ${chunks.length} chunk(s)...`, 5);

    let totalCreated = 0;
    let totalErrors = 0;
    let chunksCompleted = 0;

    const extractionTasks = chunks.map((chunk, i) => () => {
        const formatted = chunk.map(m => `[${m.name}]: ${m.text}`).join('\n\n');
        return generateRaw({
            prompt: buildIngestPrompt(lorebookName, formatted),
            systemPrompt: 'You are a fact extraction assistant for a creative writing lorebook. You are reading roleplay chat logs that may contain mature fictional content — this is expected. Your job is only to extract and catalog factual information (characters, relationships, events, world details). Respond ONLY with valid JSON, no commentary.',
        }).then(response => {
            chunksCompleted++;
            const pct = 5 + Math.round((chunksCompleted / chunks.length) * 60);
            report(`Extracted ${chunksCompleted}/${chunks.length} chunks...`, pct);
            return { index: i, response };
        }).catch(e => {
            chunksCompleted++;
            console.error(`[TunnelVision] Ingest chunk ${i + 1} LLM call failed:`, e);
            return { index: i, response: null, error: e };
        });
    });

    const INGEST_CONCURRENCY = 3;
    const extractionResults = await runWithConcurrency(extractionTasks, INGEST_CONCURRENCY);

    report('Creating entries...', 70);

    for (const result of extractionResults) {
        if (result instanceof Error || result?.error) { totalErrors++; continue; }
        const { index: chunkIdx, response } = result;
        if (!response) continue;

        detail_(`Processing results from chunk ${chunkIdx + 1}`);

        let entries;
        try {
            const arrayResult = parseJsonFromLLM(response, { type: 'array' });
            if (Array.isArray(arrayResult) && arrayResult.length > 0) {
                entries = arrayResult;
            } else {
                const objResult = parseJsonFromLLM(response);
                entries = objResult.entries || [objResult];
            }
        } catch (e) {
            console.warn(`[TunnelVision] Ingest chunk ${chunkIdx + 1} JSON parse failed:`, e, response);
            totalErrors++;
            continue;
        }

        if (!Array.isArray(entries)) continue;

        for (const extracted of entries) {
            if (!extracted.title || !extracted.content) continue;
            try {
                await createEntry(lorebookName, {
                    content: String(extracted.content).trim(),
                    comment: String(extracted.title).trim(),
                    keys: Array.isArray(extracted.keys) ? extracted.keys : [],
                    nodeId: null,
                });
                totalCreated++;
            } catch (e) {
                console.warn(`[TunnelVision] Failed to create entry "${extracted.title}":`, e);
                totalErrors++;
            }
        }
    }

    report('Done', 100);
    detail_(`Created ${totalCreated} entries, ${totalErrors} errors`);
    return { created: totalCreated, errors: totalErrors };
}

function buildIngestPrompt(lorebookName, chatText) {
    return `Extract facts from this roleplay chat log for the lorebook "${lorebookName}".

Only extract facts significant enough for long-term story continuity — things that, if forgotten, would create a continuity error or miss something meaningful. Facts are persistent state changes, NOT a log of everything that happened.

Chat log:
${chatText}

Respond with ONLY a JSON array:
[
  {
    "title": "Short descriptive title",
    "content": "The factual information written in third person. Include names, places, details.",
    "keys": ["keyword1", "keyword2"]
  }
]

WORTH EXTRACTING (lasting state changes):
- Relationship shifts, alliances, betrayals
- Living situations, relocations
- Status/ability changes, injuries, promotions
- Revelations (secrets, true identities, hidden properties)
- Consequential decisions with lasting impact
- World-state changes (places destroyed, wars declared, rules established)
- New character traits or backstory revealed for the first time

NOT WORTH EXTRACTING (skip these):
- Mundane conversational beats and transient actions
- Fleeting emotional reactions that don't shift relationships
- Dialogue content without lasting consequences
- Generic or already-obvious information

Rules:
- Write content in third person, factual style
- Each entry should be a single, distinct piece of information
- Merge related facts into single entries when they belong together
- Fewer high-quality entries are better than many trivial ones

${KEYWORD_RULES}`;
}

/**
 * Chunk messages by character limit, keeping messages whole.
 * @param {Array<{index: number, name: string, text: string}>} messages
 * @param {number} charLimit
 * @returns {Array<Array>}
 */
function chunkMessages(messages, charLimit) {
    return chunkBySize(messages, (msg) => msg.name.length + msg.text.length + 10, charLimit);
}
