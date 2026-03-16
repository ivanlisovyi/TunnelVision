/**
 * TunnelVision Entry Manager
 * Handles lorebook entry CRUD operations triggered by tool calls.
 * Lorebook CRUD operations shared by all TunnelVision memory tools.
 * Kept separate from tool-registry.js so entry logic is testable/reusable.
 *
 * Uses ST's native world-info API:
 *   createWorldInfoEntry(name, data) - creates entry, returns entry object
 *   saveWorldInfo(name, data, immediately) - persists to disk
 *   loadWorldInfo(name) - loads lorebook data with .entries
 */

import {
    loadWorldInfo,
    createWorldInfoEntry,
    saveWorldInfo,
} from '../../../world-info.js';
import { getContext } from '../../../st-context.js';
import {
    getTree,
    saveTree,
    findNodeById,
    findBestNodeForEntry,
    addEntryToNode,
    removeEntryFromTree,
    createTreeNode,
    isTrackerTitle,
    isTrackerUid,
    setTrackerUid,
} from './tree-store.js';
import { findOrCreateChildCategory } from './tree-categories.js';
import {
    MAX_ENTRY_CONTENT_LENGTH,
    MAX_ENTRIES_PER_TURN,
    MAX_VERSIONS_PER_ENTRY,
} from './constants.js';

/**
 * Unified keyword generation instructions, used across all entry creation prompts.
 * Single source of truth — imported by post-turn processor, remember tool, commands, ingest, etc.
 */
export const KEYWORD_RULES = [
    'KEYWORD RULES (apply to every "keys" array you produce):',
    '- 6-12 keywords per entry',
    '- Concrete and specific: character names, locations, objects, proper nouns, unique actions, repeated motifs',
    '- One concept per keyword — do NOT combine multiple ideas into one keyword',
    '- Each keyword should stand alone for retrieval — useful even if mentioned without full context',
    '- Always include full character names in canonical form ("Elena Blackwood" not "she" or just "Elena")',
    '- Include location/place names when the entry is tied to a specific setting',
].join('\n');

/**
 * Canonical fact extraction prompt — single source of truth used by ALL fact creation paths:
 * post-turn processor, TunnelVision_Remember tool, /tv-remember command.
 *
 * Callers inject:
 *   {existingFactsSection} — "Already Known Facts" block (or empty string)
 *   {temporalContext}      — "Current In-World Time" block (or empty string)
 *   {inputSection}         — the raw text to extract facts from (recent exchange, user hint, etc.)
 *
 * Returns a JSON array: [{ title, content, when, keys }]
 */
/**
 * Shared summarization style instructions — single source of truth for ALL summary generation paths:
 * runQuietSummarize (commands.js), act rollup, story rollup (summary-hierarchy.js).
 *
 * Focuses on concise narration beats: what happened, who was involved, what changed.
 * NOT a transcript — a distilled story record that replaces re-reading the scene.
 */
export const SUMMARY_STYLE_RULES = [
    'SUMMARY WRITING RULES (apply to every summary you produce):',
    '- Write in past tense, third person — like narration beats in a story outline',
    '- Be concise and precise: each sentence should carry narrative weight',
    '- Structure as short story beats, not a transcript or blow-by-blow recap',
    '- Capture: key actions, decisions, outcomes, emotional turning points, relationship shifts',
    '- Preserve specifics that matter for continuity: names, places, objects, promises, injuries, revelations',
    '- Include physical and intimate details faithfully — this is a private memory document, not a public text',
    '- Omit filler: greetings, small talk, repeated actions, and moment-to-moment reactions that don\'t advance the story',
    '- A good scene summary reads like a tight synopsis: 3-8 sentences for a typical scene, more only if genuinely dense with plot',
    '- Do NOT sanitize, censor, or editorialize — accuracy over comfort',
].join('\n');

export const FACT_EXTRACTION_PROMPT = [
    'You are a long-term memory assistant for a roleplay lorebook.',
    'Extract facts that are significant enough to matter for story continuity — things that, if forgotten, would create a continuity error or miss something meaningful.',
    'A fact is a PERSISTENT STATE CHANGE, not a moment-to-moment narrative beat.',
    '',
    'EXTRACT (lasting state changes worth storing):',
    '- Relationship shifts: confessions, betrayals, alliances formed or broken',
    '- Living situations or relocations: "A moved in with B", "they left the city"',
    '- Status or ability changes: "A lost her powers", "B was promoted", "C was injured"',
    '- Revelations: hidden identities, secrets exposed, true natures discovered',
    '- Consequential decisions: agreements made, deals accepted, refusals with lasting impact',
    '- World-state changes: places destroyed, wars declared, factions shifting',
    '- New character traits or backstory revealed for the first time',
    '',
    'SKIP (do not extract these):',
    '- Mundane conversational beats ("asked about X", "offered tea", "said hello")',
    '- Transient actions with no lasting impact ("sat down", "poured a drink")',
    '- Fleeting emotional reactions that do not shift a relationship ("felt nervous", "smiled")',
    '- Information already established or implied earlier',
    '- OOC instructions, meta-commentary, or speculative/uncertain information',
    '',
    'Quality over quantity. An empty array is the correct answer when nothing significant happened.',
    'Write each fact in third person, past tense, factual style.',
    '',
    'WHEN: Provide the approximate in-world time for each fact. Preserve the story day when available and include calendar date/time cues when available.',
    'Format preference: "Day X, Weekday D Month YYYY, around HH:MM-HH:MM" (example: "Day 6, Sunday 16 March 2025, around 13:10-13:20").',
    'If only some parts are known, keep what is known in this order: Day -> date -> time (examples: "Day 6, evening"; "Sunday 16 March 2025, morning").',
    'Use the Current In-World Time block below if available. Write "unknown" only if there are no time cues at all.',
    '',
    KEYWORD_RULES,
    '',
    '{existingFactsSection}',
    '{temporalContext}',
    '{inputSection}',
    '',
    'Respond with ONLY a JSON array — no commentary, no code fences:',
    '[{"title": "short title", "content": "third-person description", "when": "Day X, Weekday D Month YYYY, around HH:MM-HH:MM", "keys": ["keyword1", "keyword2"]}]',
    '',
    'If there is nothing worth extracting, respond with an empty array: []',
].join('\n');

// ── Turn-Scoped WorldInfo Cache ──────────────────────────────────

const _worldInfoCache = new Map();
const _dirtyBooks = new Set();

/**
 * Load world info with per-turn caching. Avoids redundant disk reads
 * when multiple tool actions reference the same lorebook in one generation.
 * @param {string} bookName
 * @returns {Promise<Object|null>}
 */
export async function getCachedWorldInfo(bookName) {
    if (_worldInfoCache.has(bookName)) return _worldInfoCache.get(bookName);
    const data = await loadWorldInfo(bookName);
    if (data) _worldInfoCache.set(bookName, data);
    return data;
}

/**
 * Synchronous cache-only access to world info. Returns null if not cached.
 * Use this when you need data synchronously (e.g. in GENERATION_STARTED sync section)
 * and can tolerate a cache miss on the first turn.
 * @param {string} bookName
 * @returns {Object|null}
 */
export function getCachedWorldInfoSync(bookName) {
    return _worldInfoCache.get(bookName) || null;
}

/**
 * Invalidate the world info cache for a specific book (after writes)
 * or all books (at turn boundaries / external changes).
 * @param {string} [bookName] - If omitted, clears entire cache and dirty set.
 */
export function invalidateWorldInfoCache(bookName) {
    if (bookName) {
        _worldInfoCache.delete(bookName);
        _dirtyBooks.add(bookName);
    } else {
        _worldInfoCache.clear();
        _dirtyBooks.clear();
    }
}

/**
 * Invalidate only books that were written to since the last full clear.
 * Call this at generation boundaries instead of a full clear so that
 * unmodified books stay cached across turns.
 */
export function invalidateDirtyWorldInfoCache() {
    for (const bookName of _dirtyBooks) {
        _worldInfoCache.delete(bookName);
    }
    _dirtyBooks.clear();
}

/**
 * Persist modified lorebook data and invalidate its cache entry.
 * @param {string} bookName
 * @param {Object} bookData
 * @returns {Promise<Object>}
 */
export async function persistWorldInfo(bookName, bookData) {
    await saveWorldInfo(bookName, bookData, true);
    invalidateWorldInfoCache(bookName);
    return bookData;
}

// ── Turn-Scoped Rate Limiter ─────────────────────────────────────

let _turnEntryCount = 0;

/** Reset entry creation counter. Call at start of each generation (non-recursive). */
export function resetTurnEntryCount() {
    _turnEntryCount = 0;
}

// ── UID Map Builder ──────────────────────────────────────────────

/**
 * Build a UID→entry lookup map from lorebook data.
 * Eliminates O(n²) iteration when resolving multiple UIDs.
 * @param {Object} entries - bookData.entries
 * @returns {Map<number, Object>}
 */
export function buildUidMap(entries) {
    const map = new Map();
    for (const key of Object.keys(entries)) {
        map.set(entries[key].uid, entries[key]);
    }
    return map;
}

// ── Cross-Book Keyword Search ────────────────────────────────────

/**
 * Search lorebook entries by keyword across multiple books.
 * Shared by tools/search.js and commands.js.
 * @param {string} query - Space-separated search terms (all must match)
 * @param {string[]} activeBooks - Book names to search
 * @param {Object} [options]
 * @param {number} [options.maxResults=10]
 * @param {number} [options.previewLength=200]
 * @returns {Promise<Array<{uid: number, title: string, book: string, keys: string[], preview: string}>>}
 */
export async function searchEntriesAcrossBooks(query, activeBooks, { maxResults = 10, previewLength = 200 } = {}) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const results = [];

    for (const bookName of activeBooks) {
        const bookData = await getCachedWorldInfo(bookName);
        if (!bookData?.entries) continue;

        for (const key of Object.keys(bookData.entries)) {
            const entry = bookData.entries[key];
            if (entry.disable) continue;

            const title = (entry.comment || '').toLowerCase();
            const keys = (entry.key || []).join(' ').toLowerCase();
            const content = (entry.content || '').toLowerCase();
            if (!terms.every(t => `${title} ${keys} ${content}`.includes(t))) continue;

            results.push({
                uid: entry.uid,
                title: entry.comment || entry.key?.[0] || `#${entry.uid}`,
                book: bookName,
                keys: (entry.key || []).slice(0, 5),
                preview: (entry.content || '').substring(0, previewLength).replace(/\n/g, ' '),
            });
            if (results.length >= maxResults) return results;
        }
    }
    return results;
}

// ── Robust JSON Parser ───────────────────────────────────────────

/**
 * Parse JSON from LLM responses with multiple fallback strategies:
 * 1. Direct JSON.parse on cleaned text
 * 2. Balanced-brace extraction (handles surrounding commentary)
 * 3. Greedy regex fallback
 * @param {string} text - Raw LLM response
 * @param {Object} [options]
 * @param {'object'|'array'} [options.type='object'] - Expected top-level JSON type
 * @returns {Object|Array}
 */
export function parseJsonFromLLM(text, { type = 'object' } = {}) {
    const empty = type === 'array' ? [] : {};
    if (!text) return empty;

    let cleaned = text.trim();
    // Strip common model wrapper tags
    cleaned = cleaned.replace(/<think[\s\S]*?<\/think>/gi, '').trim();
    cleaned = cleaned.replace(/<\/?(?:output|response|result|json|answer)>/gi, '').trim();
    // Strip markdown code fences
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

    try { return JSON.parse(cleaned); } catch { /* fall through */ }

    const opener = type === 'array' ? '[' : '{';
    const closer = type === 'array' ? ']' : '}';
    const startIdx = cleaned.indexOf(opener);
    if (startIdx < 0) return empty;

    // Balanced bracket extraction
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = startIdx; i < cleaned.length; i++) {
        const c = cleaned[i];
        if (escape) { escape = false; continue; }
        if (c === '\\' && inString) { escape = true; continue; }
        if (c === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (c === opener) depth++;
        if (c === closer) {
            depth--;
            if (depth === 0) {
                const candidate = cleaned.substring(startIdx, i + 1);
                try { return JSON.parse(candidate); } catch { /* try fixing trailing commas */ }
                try {
                    const fixed = candidate.replace(/,\s*([}\]])/g, '$1');
                    return JSON.parse(fixed);
                } catch { break; }
            }
        }
    }

    const pattern = type === 'array' ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/;
    const match = cleaned.match(pattern);
    if (match) {
        try { return JSON.parse(match[0]); } catch { /* fall through */ }
        try {
            const fixed = match[0].replace(/,\s*([}\]])/g, '$1');
            return JSON.parse(fixed);
        } catch { /* fall through */ }
    }

    return empty;
}

// ── HTML Escaping ────────────────────────────────────────────────

/** Shared HTML escaper for popup/confirmation UI across modules. */
export function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Entry Version History ─────────────────────────────────────────

const VERSION_METADATA_KEY = 'tunnelvision_entry_history';

/**
 * Record a version snapshot for an entry before it's mutated.
 * Stored in chat_metadata keyed by `bookName:uid`.
 * @param {string} bookName
 * @param {number} uid
 * @param {Object} opts
 * @param {string} opts.source - What triggered the change (e.g. 'tool', 'post-turn', 'lifecycle', 'merge', 'split')
 * @param {string} [opts.previousContent] - Content before the change
 * @param {string} [opts.previousTitle] - Title before the change
 */
export function recordEntryVersion(bookName, uid, { source, previousContent, previousTitle }) {
    try {
        const context = getContext();
        if (!context.chatMetadata) return;
        const store = context.chatMetadata[VERSION_METADATA_KEY] || {};
        const key = `${bookName}:${uid}`;
        const versions = store[key] || [];

        versions.push({
            timestamp: Date.now(),
            source,
            previousContent: previousContent ?? null,
            previousTitle: previousTitle ?? null,
        });

        // FIFO cap
        while (versions.length > MAX_VERSIONS_PER_ENTRY) {
            versions.shift();
        }

        store[key] = versions;
        context.chatMetadata[VERSION_METADATA_KEY] = store;
        context.saveMetadataDebounced?.();
    } catch { /* metadata not available */ }
}

/**
 * Retrieve version history for an entry.
 * @param {string} bookName
 * @param {number} uid
 * @returns {Array<{timestamp: number, source: string, previousContent: string|null, previousTitle: string|null}>}
 */
export function getEntryVersions(bookName, uid) {
    try {
        const context = getContext();
        const store = context.chatMetadata?.[VERSION_METADATA_KEY];
        if (!store) return [];
        return store[`${bookName}:${uid}`] || [];
    } catch {
        return [];
    }
}

// ── Temporal Fact Metadata ─────────────────────────────────────────

const TEMPORAL_METADATA_KEY = 'tunnelvision_entry_temporal';

/**
 * Record temporal metadata for a newly created entry.
 * Stores turn index, in-world time, and optional causal links.
 * @param {string} bookName
 * @param {number} uid
 * @param {Object} opts
 * @param {number} opts.turnIndex - Chat message index when the fact was extracted
 * @param {string} [opts.when] - In-world temporal label (e.g. "Day 3, evening")
 * @param {string} [opts.arcId] - Associated narrative arc ID
 */
export function recordEntryTemporal(bookName, uid, { turnIndex, when, arcId }) {
    try {
        const context = getContext();
        if (!context.chatMetadata) return;
        const store = context.chatMetadata[TEMPORAL_METADATA_KEY] || {};
        const key = `${bookName}:${uid}`;
        store[key] = {
            turnIndex,
            when: when || null,
            arcId: arcId || null,
            supersedes: null,
            createdAt: Date.now(),
        };
        context.chatMetadata[TEMPORAL_METADATA_KEY] = store;
        context.saveMetadataDebounced?.();
    } catch { /* metadata not available */ }
}

/**
 * Retrieve temporal metadata for an entry.
 * @param {string} bookName
 * @param {number} uid
 * @returns {{ turnIndex: number, when: string|null, arcId: string|null, supersedes: number|null, createdAt: number }|null}
 */
export function getEntryTemporal(bookName, uid) {
    try {
        const context = getContext();
        const store = context.chatMetadata?.[TEMPORAL_METADATA_KEY];
        if (!store) return null;
        return store[`${bookName}:${uid}`] || null;
    } catch {
        return null;
    }
}

/**
 * Mark that one entry supersedes (replaces) another, creating a causal chain.
 * Called during contradiction resolution to link the newer entry to the old one.
 * @param {string} bookName
 * @param {number} newerUid - The entry that supersedes the older one
 * @param {number} olderUid - The entry being superseded
 */
export function setEntrySupersedes(bookName, newerUid, olderUid) {
    try {
        const context = getContext();
        if (!context.chatMetadata) return;
        const store = context.chatMetadata[TEMPORAL_METADATA_KEY] || {};
        const key = `${bookName}:${newerUid}`;
        if (!store[key]) {
            store[key] = { turnIndex: 0, when: null, arcId: null, supersedes: olderUid, createdAt: Date.now() };
        } else {
            store[key].supersedes = olderUid;
        }
        context.chatMetadata[TEMPORAL_METADATA_KEY] = store;
        context.saveMetadataDebounced?.();
    } catch { /* metadata not available */ }
}

/**
 * Get the temporal turn index for an entry, or fall back to 0.
 * Useful for comparing which of two entries is narratively newer.
 * @param {string} bookName
 * @param {number} uid
 * @returns {number}
 */
export function getEntryTurnIndex(bookName, uid) {
    const temporal = getEntryTemporal(bookName, uid);
    return temporal?.turnIndex ?? 0;
}

/**
 * Create a new lorebook entry and assign it to a tree node.
 * @param {string} bookName - Lorebook name
 * @param {Object} params
 * @param {string} params.content - Entry content text
 * @param {string} params.comment - Entry title/comment
 * @param {string[]} [params.keys] - Primary trigger keys
 * @param {string} [params.nodeId] - Tree node to assign to (defaults to root)
 * @returns {Promise<{uid: number, comment: string, nodeLabel: string}>}
 */
export async function createEntry(bookName, { content, comment, keys, nodeId, _bookData, background = false }) {
    if (!content || !content.trim()) {
        throw new Error('Entry content cannot be empty.');
    }
    if (!comment || !comment.trim()) {
        throw new Error('Entry comment/title cannot be empty.');
    }
    if (content.length > MAX_ENTRY_CONTENT_LENGTH) {
        content = content.substring(0, MAX_ENTRY_CONTENT_LENGTH);
        console.warn(`[TunnelVision] Entry content truncated to ${MAX_ENTRY_CONTENT_LENGTH} chars for "${comment}"`);
    }
    if (!background && ++_turnEntryCount > MAX_ENTRIES_PER_TURN) {
        throw new Error(`Rate limit: maximum ${MAX_ENTRIES_PER_TURN} entries per turn exceeded. Wait for the next generation.`);
    }

    const bookData = _bookData || await getCachedWorldInfo(bookName);
    if (!bookData || !bookData.entries) {
        throw new Error(`Lorebook "${bookName}" not found or has no entry data.`);
    }

    // Create entry via ST API
    const newEntry = createWorldInfoEntry(bookName, bookData);
    if (!newEntry) {
        throw new Error('Failed to create new lorebook entry (ST returned undefined).');
    }

    // Populate fields
    newEntry.content = content.trim();
    newEntry.comment = comment.trim();
    if (Array.isArray(keys) && keys.length > 0) {
        newEntry.key = keys.map(k => String(k).trim()).filter(Boolean);
    }
    // TunnelVision-managed entries: disable keyword triggering since retrieval is tree-based
    newEntry.selective = false;
    newEntry.constant = false;
    newEntry.disable = false;

    // Persist to disk
    await saveWorldInfo(bookName, bookData, true);
    invalidateWorldInfoCache(bookName);

    // Assign to tree node
    let nodeLabel = 'Root';
    const tree = getTree(bookName);
    if (tree && tree.root) {
        let targetNode = tree.root;
        if (nodeId) {
            const found = findNodeById(tree.root, nodeId);
            if (found) {
                targetNode = found;
                nodeLabel = found.label;
            }
        } else {
            const match = findBestNodeForEntry(tree.root, comment, keys);
            if (match) {
                targetNode = match.node;
                nodeLabel = match.node.label;
                console.log(`[TunnelVision] Auto-classified "${comment}" → "${nodeLabel}" (score: ${match.score.toFixed(3)})`);
            }
        }
        addEntryToNode(targetNode, newEntry.uid);
        saveTree(bookName, tree);
    } else {
        nodeLabel = '(no tree)';
    }

    if (isTrackerTitle(newEntry.comment)) {
        setTrackerUid(bookName, newEntry.uid, true);
    }

    console.log(`[TunnelVision] Created entry "${comment}" (UID ${newEntry.uid}) in "${bookName}" → ${nodeLabel}`);
    return { uid: newEntry.uid, comment: newEntry.comment, nodeLabel };
}

/**
 * Update an existing lorebook entry's content and/or comment.
 * @param {string} bookName - Lorebook name
 * @param {number} uid - Entry UID to update
 * @param {Object} updates
 * @param {string} [updates.content] - New content (replaces entirely)
 * @param {string} [updates.comment] - New comment/title
 * @param {string[]} [updates.keys] - New primary keys
 * @returns {Promise<{uid: number, comment: string, updated: string[]}>}
 */
export async function updateEntry(bookName, uid, updates) {
    const bookData = await getCachedWorldInfo(bookName);
    if (!bookData || !bookData.entries) {
        throw new Error(`Lorebook "${bookName}" not found or has no entry data.`);
    }

    const entry = findEntryByUid(bookData.entries, uid);
    if (!entry) {
        throw new Error(`Entry UID ${uid} not found in lorebook "${bookName}".`);
    }

    // Snapshot before mutation
    recordEntryVersion(bookName, uid, {
        source: updates._source || 'tool',
        previousContent: entry.content || '',
        previousTitle: entry.comment || '',
    });

    const changed = [];

    if (updates.content !== undefined && updates.content.trim()) {
        let trimmed = updates.content.trim();
        if (trimmed.length > MAX_ENTRY_CONTENT_LENGTH) {
            trimmed = trimmed.substring(0, MAX_ENTRY_CONTENT_LENGTH);
            console.warn(`[TunnelVision] Updated content truncated to ${MAX_ENTRY_CONTENT_LENGTH} chars for UID ${uid}`);
        }
        entry.content = trimmed;
        changed.push('content');
    }
    if (updates.comment !== undefined && updates.comment.trim()) {
        entry.comment = updates.comment.trim();
        changed.push('comment');
    }
    if (Array.isArray(updates.keys)) {
        entry.key = updates.keys.map(k => String(k).trim()).filter(Boolean);
        changed.push('keys');
    }

    if (changed.length === 0) {
        throw new Error('No valid updates provided. Content and title must be non-empty strings if specified.');
    }

    await saveWorldInfo(bookName, bookData, true);
    invalidateWorldInfoCache(bookName);
    if (entry.disable) {
        setTrackerUid(bookName, uid, false);
    } else if (isTrackerTitle(entry.comment) || isTrackerUid(bookName, uid)) {
        setTrackerUid(bookName, uid, true);
    }

    console.log(`[TunnelVision] Updated entry "${entry.comment}" (UID ${uid}) in "${bookName}": ${changed.join(', ')}`);
    return { uid, comment: entry.comment, updated: changed };
}

/**
 * Remove orphaned metadata keys for a deleted/disabled entry.
 * Cleans tunnelvision_relevance, tunnelvision_feedback, and tunnelvision_entry_history.
 * @param {string} bookName
 * @param {number} uid
 */
export function cleanupEntryMetadata(bookName, uid) {
    try {
        const context = getContext();
        if (!context.chatMetadata) return;

        const relevance = context.chatMetadata['tunnelvision_relevance'];
        if (relevance) {
            delete relevance[uid];
            delete relevance[String(uid)];
        }

        const feedback = context.chatMetadata['tunnelvision_feedback'];
        if (feedback) {
            delete feedback[uid];
            delete feedback[String(uid)];
        }

        const history = context.chatMetadata[VERSION_METADATA_KEY];
        if (history) {
            delete history[`${bookName}:${uid}`];
        }

        const temporal = context.chatMetadata[TEMPORAL_METADATA_KEY];
        if (temporal) {
            delete temporal[`${bookName}:${uid}`];
        }

        context.saveMetadataDebounced?.();
    } catch { /* metadata not available */ }
}

/**
 * Disable (soft-delete) a lorebook entry and remove it from the tree.
 * @param {string} bookName - Lorebook name
 * @param {number} uid - Entry UID to disable
 * @param {boolean} [hardDelete=false] - If true, actually delete instead of disable
 * @returns {Promise<{uid: number, comment: string, action: string}>}
 */
export async function forgetEntry(bookName, uid, hardDelete = false) {
    const bookData = await getCachedWorldInfo(bookName);
    if (!bookData || !bookData.entries) {
        throw new Error(`Lorebook "${bookName}" not found or has no entry data.`);
    }

    const entry = findEntryByUid(bookData.entries, uid);
    if (!entry) {
        throw new Error(`Entry UID ${uid} not found in lorebook "${bookName}".`);
    }

    const comment = entry.comment || `Entry #${uid}`;
    let action;

    if (hardDelete) {
        for (const key of Object.keys(bookData.entries)) {
            if (bookData.entries[key].uid === uid) {
                delete bookData.entries[key];
                break;
            }
        }
        action = 'deleted';
    } else {
        entry.disable = true;
        action = 'disabled';
    }

    await saveWorldInfo(bookName, bookData, true);
    invalidateWorldInfoCache(bookName);

    // Remove from tree regardless
    const tree = getTree(bookName);
    if (tree && tree.root) {
        removeEntryFromTree(tree.root, uid);
        saveTree(bookName, tree);
    }
    setTrackerUid(bookName, uid, false);
    cleanupEntryMetadata(bookName, uid);

    console.log(`[TunnelVision] ${action} entry "${comment}" (UID ${uid}) in "${bookName}"`);
    return { uid, comment, action };
}

/**
 * Move an entry from one tree node to another.
 * @param {string} bookName - Lorebook name
 * @param {number} uid - Entry UID to move
 * @param {string} targetNodeId - Destination node ID
 * @returns {Promise<{uid: number, fromLabel: string, toLabel: string}>}
 */
export async function moveEntry(bookName, uid, targetNodeId) {
    const tree = getTree(bookName);
    if (!tree || !tree.root) {
        throw new Error(`No tree found for lorebook "${bookName}".`);
    }

    const targetNode = findNodeById(tree.root, targetNodeId);
    if (!targetNode) {
        throw new Error(`Target node "${targetNodeId}" not found in tree.`);
    }

    // Find current location
    const fromLabel = findNodeContainingUid(tree.root, uid)?.label || 'unknown';

    // Remove from all nodes, then add to target
    removeEntryFromTree(tree.root, uid);
    addEntryToNode(targetNode, uid);
    saveTree(bookName, tree);

    console.log(`[TunnelVision] Moved entry UID ${uid}: "${fromLabel}" → "${targetNode.label}"`);
    return { uid, fromLabel, toLabel: targetNode.label };
}

/**
 * Create a new category node in the tree.
 * @param {string} bookName - Lorebook name
 * @param {string} label - Category name
 * @param {string} [parentNodeId] - Parent node ID (defaults to root)
 * @returns {{ nodeId: string, label: string, parentLabel: string }}
 */
export function createCategory(bookName, label, parentNodeId) {
    const tree = getTree(bookName);
    if (!tree || !tree.root) {
        throw new Error(`No tree found for lorebook "${bookName}".`);
    }

    let parentNode = tree.root;
    if (parentNodeId) {
        const found = findNodeById(tree.root, parentNodeId);
        if (found) parentNode = found;
    }

    const { node, created } = findOrCreateChildCategory(parentNode, label, '');

    saveTree(bookName, tree);

    if (created) {
        console.log(`[TunnelVision] Created category "${node.label}" under "${parentNode.label}" in "${bookName}"`);
    } else {
        console.log(`[TunnelVision] Reused existing category "${node.label}" under "${parentNode.label}" in "${bookName}"`);
    }

    return {
        nodeId: node.id,
        label: node.label,
        parentLabel: parentNode.label,
        created,
    };
}

/**
 * Find an entry by UID across all entries in a lorebook's entry map.
 * @param {string} bookName
 * @param {number} uid
 * @returns {Promise<{entry: Object, bookName: string}|null>}
 */
export async function findEntry(bookName, uid) {
    const bookData = await getCachedWorldInfo(bookName);
    if (!bookData || !bookData.entries) return null;
    const entry = findEntryByUid(bookData.entries, uid);
    return entry ? { entry, bookName } : null;
}

/**
 * List entries in a specific tree node with their comments/titles.
 * Used by Reorganize tool to show what's in a node.
 * @param {string} bookName
 * @param {string} nodeId
 * @returns {Promise<Array<{uid: number, comment: string, contentPreview: string}>>}
 */
export async function listNodeEntries(bookName, nodeId) {
    const tree = getTree(bookName);
    if (!tree || !tree.root) return [];

    const node = findNodeById(tree.root, nodeId);
    if (!node) return [];

    const uids = node.entryUids || [];
    if (uids.length === 0) return [];

    const bookData = await getCachedWorldInfo(bookName);
    if (!bookData || !bookData.entries) return [];

    return uids.map(uid => {
        const entry = findEntryByUid(bookData.entries, uid);
        if (!entry) return null;
        return {
            uid,
            comment: entry.comment || `Entry #${uid}`,
            contentPreview: (entry.content || '').substring(0, 100),
        };
    }).filter(Boolean);
}

/**
 * Merge two entries into one. Keeps the first entry, appends the second's content,
 * then disables (or deletes) the second entry and removes it from the tree.
 * @param {string} bookName - Lorebook name
 * @param {number} keepUid - UID of the entry to keep (will receive merged content)
 * @param {number} removeUid - UID of the entry to absorb and disable
 * @param {Object} [opts]
 * @param {string} [opts.mergedContent] - Optional custom merged content (overrides auto-merge)
 * @param {string} [opts.mergedTitle] - Optional new title for the merged entry
 * @param {boolean} [opts.hardDelete=false] - Hard-delete the absorbed entry instead of disabling
 * @returns {Promise<{uid: number, comment: string, removedUid: number, removedComment: string}>}
 */
export async function mergeEntries(bookName, keepUid, removeUid, opts = {}) {
    if (keepUid === removeUid) {
        throw new Error('Cannot merge an entry with itself.');
    }

    const bookData = await getCachedWorldInfo(bookName);
    if (!bookData || !bookData.entries) {
        throw new Error(`Lorebook "${bookName}" not found or has no entry data.`);
    }

    const keepEntry = findEntryByUid(bookData.entries, keepUid);
    if (!keepEntry) {
        throw new Error(`Entry UID ${keepUid} (keep) not found in lorebook "${bookName}".`);
    }

    const removeEntry = findEntryByUid(bookData.entries, removeUid);
    if (!removeEntry) {
        throw new Error(`Entry UID ${removeUid} (remove) not found in lorebook "${bookName}".`);
    }

    const removedComment = removeEntry.comment || `Entry #${removeUid}`;

    // Snapshot both entries before mutation
    const mergeSource = opts._source || 'merge';
    recordEntryVersion(bookName, keepUid, {
        source: mergeSource,
        previousContent: keepEntry.content || '',
        previousTitle: keepEntry.comment || '',
    });
    recordEntryVersion(bookName, removeUid, {
        source: mergeSource,
        previousContent: removeEntry.content || '',
        previousTitle: removeEntry.comment || '',
    });

    // Merge content
    if (opts.mergedContent && opts.mergedContent.trim()) {
        keepEntry.content = opts.mergedContent.trim();
    } else {
        keepEntry.content = `${keepEntry.content}\n\n---\n\n${removeEntry.content}`;
    }

    // Merge title if provided
    if (opts.mergedTitle && opts.mergedTitle.trim()) {
        keepEntry.comment = opts.mergedTitle.trim();
    }

    // Merge keys (deduplicate)
    const existingKeys = new Set((keepEntry.key || []).map(k => String(k).toLowerCase()));
    for (const k of (removeEntry.key || [])) {
        if (!existingKeys.has(String(k).toLowerCase())) {
            keepEntry.key = keepEntry.key || [];
            keepEntry.key.push(k);
        }
    }

    // Disable or delete the absorbed entry
    if (opts.hardDelete) {
        for (const key of Object.keys(bookData.entries)) {
            if (bookData.entries[key].uid === removeUid) {
                delete bookData.entries[key];
                break;
            }
        }
    } else {
        removeEntry.disable = true;
    }

    await saveWorldInfo(bookName, bookData, true);
    invalidateWorldInfoCache(bookName);

    // Remove absorbed entry from tree
    const tree = getTree(bookName);
    if (tree && tree.root) {
        removeEntryFromTree(tree.root, removeUid);
        saveTree(bookName, tree);
    }

    const shouldTrackMergedEntry =
        isTrackerUid(bookName, keepUid) ||
        isTrackerUid(bookName, removeUid) ||
        isTrackerTitle(keepEntry.comment);
    setTrackerUid(bookName, keepUid, shouldTrackMergedEntry);
    setTrackerUid(bookName, removeUid, false);

    console.log(`[TunnelVision] Merged entry UID ${removeUid} ("${removedComment}") into UID ${keepUid} ("${keepEntry.comment}") in "${bookName}"`);
    return { uid: keepUid, comment: keepEntry.comment, removedUid: removeUid, removedComment };
}

/**
 * Split one entry into two. The original entry keeps part of the content,
 * and a new entry is created with the rest.
 * @param {string} bookName - Lorebook name
 * @param {number} uid - UID of the entry to split
 * @param {Object} params
 * @param {string} params.keepContent - Content that stays in the original entry
 * @param {string} params.keepTitle - Title for the original entry (can be unchanged)
 * @param {string} params.newContent - Content for the new split-off entry
 * @param {string} params.newTitle - Title for the new split-off entry
 * @param {string[]} [params.newKeys] - Optional keys for the new entry
 * @returns {Promise<{originalUid: number, originalTitle: string, newUid: number, newTitle: string, nodeLabel: string}>}
 */
export async function splitEntry(bookName, uid, { keepContent, keepTitle, newContent, newTitle, newKeys }) {
    if (!keepContent || !keepContent.trim()) {
        throw new Error('keepContent cannot be empty — the original entry needs content.');
    }
    if (!newContent || !newContent.trim()) {
        throw new Error('newContent cannot be empty — the new entry needs content.');
    }
    if (!newTitle || !newTitle.trim()) {
        throw new Error('newTitle cannot be empty — the new entry needs a title.');
    }

    const bookData = await getCachedWorldInfo(bookName);
    if (!bookData || !bookData.entries) {
        throw new Error(`Lorebook "${bookName}" not found or has no entry data.`);
    }

    const original = findEntryByUid(bookData.entries, uid);
    if (!original) {
        throw new Error(`Entry UID ${uid} not found in lorebook "${bookName}".`);
    }

    // Snapshot before mutation
    recordEntryVersion(bookName, uid, {
        source: 'split',
        previousContent: original.content || '',
        previousTitle: original.comment || '',
    });

    const wasTracker = isTrackerUid(bookName, uid) || isTrackerTitle(original.comment);

    const tree = getTree(bookName);
    let nodeId = null;
    if (tree && tree.root) {
        const containingNode = findNodeContainingUid(tree.root, uid);
        if (containingNode) nodeId = containingNode.id;
    }

    const newResult = await createEntry(bookName, {
        content: newContent,
        comment: newTitle,
        keys: newKeys || [],
        nodeId,
        _bookData: bookData,
    });

    original.content = keepContent.trim();
    if (keepTitle && keepTitle.trim()) {
        original.comment = keepTitle.trim();
    }
    await saveWorldInfo(bookName, bookData, true);
    invalidateWorldInfoCache(bookName);

    if (wasTracker) {
        setTrackerUid(bookName, uid, true);
        setTrackerUid(bookName, newResult.uid, true);
    }

    console.log(`[TunnelVision] Split entry UID ${uid} → kept "${original.comment}", created UID ${newResult.uid} "${newResult.comment}" in "${bookName}"`);
    return {
        originalUid: uid,
        originalTitle: original.comment,
        newUid: newResult.uid,
        newTitle: newResult.comment,
        nodeLabel: newResult.nodeLabel,
    };
}

// ── Entry Mutation Transactions ───────────────────────────────────

/**
 * @typedef {Object} EntrySnapshot
 * @property {number} uid
 * @property {string} content
 * @property {string} comment
 * @property {string[]} keys
 * @property {boolean} disable
 */

/**
 * Snapshot an entry's mutable fields for rollback.
 * @param {Object} entry
 * @returns {EntrySnapshot}
 */
function snapshotEntry(entry) {
    return {
        uid: entry.uid,
        content: entry.content || '',
        comment: entry.comment || '',
        keys: [...(entry.key || [])],
        disable: !!entry.disable,
    };
}

/**
 * Run an async operation as a transaction that rolls back on failure.
 * Captures the state of specified entries before execution, and restores
 * them if the operation throws.
 *
 * @param {string} bookName
 * @param {number[]} uids - Entry UIDs to snapshot before the operation
 * @param {(bookData: Object) => Promise<T>} operation - The mutation to perform
 * @returns {Promise<T>}
 * @template T
 */
export async function withEntryTransaction(bookName, uids, operation) {
    const bookData = await getCachedWorldInfo(bookName);
    if (!bookData?.entries) {
        throw new Error(`Lorebook "${bookName}" not found for transaction.`);
    }

    // Snapshot entries before mutation
    const snapshots = [];
    for (const uid of uids) {
        const entry = findEntryByUid(bookData.entries, uid);
        if (entry) snapshots.push(snapshotEntry(entry));
    }

    try {
        return await operation(bookData);
    } catch (err) {
        // Rollback: restore snapshotted entries
        console.warn(`[TunnelVision] Transaction failed, rolling back ${snapshots.length} entries:`, err.message);
        const rollbackData = await getCachedWorldInfo(bookName);
        if (rollbackData?.entries) {
            let restored = 0;
            for (const snap of snapshots) {
                const entry = findEntryByUid(rollbackData.entries, snap.uid);
                if (entry) {
                    entry.content = snap.content;
                    entry.comment = snap.comment;
                    entry.key = snap.keys;
                    entry.disable = snap.disable;
                    restored++;
                }
            }
            if (restored > 0) {
                await saveWorldInfo(bookName, rollbackData, true);
                invalidateWorldInfoCache(bookName);
                console.log(`[TunnelVision] Rolled back ${restored} entries in "${bookName}"`);
            }
        }
        throw err;
    }
}

// --- Shared helpers ---

/**
 * Find an entry by UID in an entries map.
 * Shared across entry-manager, tree-builder, and search.
 * @param {Object} entries - Lorebook entries map (key → entry object)
 * @param {number} uid
 * @returns {Object|null}
 */
export function findEntryByUid(entries, uid) {
    for (const key of Object.keys(entries)) {
        if (entries[key].uid === uid) return entries[key];
    }
    return null;
}

function findNodeContainingUid(node, uid) {
    if ((node.entryUids || []).includes(uid)) return node;
    for (const child of (node.children || [])) {
        const found = findNodeContainingUid(child, uid);
        if (found) return found;
    }
    return null;
}

/**
 * Build a rich keyword array for a summary entry.
 * Merges LLM-generated keys with participants, significance, arc, and time reference.
 * @param {Object} parsed - The parsed LLM response
 * @param {string[]} participants - Character names involved
 * @param {string} significance - Significance level
 * @returns {string[]}
 */
export function buildSummaryKeys(parsed, participants, significance) {
    if (!parsed || typeof parsed !== 'object') parsed = {};
    if (!Array.isArray(participants)) participants = [];

    const keySet = new Set();

    if (Array.isArray(parsed.keys)) {
        for (const k of parsed.keys) {
            if (k == null) continue;
            const trimmed = String(k).trim().toLowerCase();
            if (trimmed.length >= 2) keySet.add(trimmed);
        }
    }

    for (const p of participants) {
        const trimmed = String(p).trim();
        if (trimmed) keySet.add(trimmed.toLowerCase());
    }

    keySet.add(`summary:${significance || 'moderate'}`);

    if (parsed.arc && typeof parsed.arc === 'string' && parsed.arc.trim()) {
        keySet.add(parsed.arc.trim().toLowerCase());
    }

    if (typeof parsed.when === 'string' && parsed.when && parsed.when !== 'unspecified') {
        keySet.add(parsed.when.trim().toLowerCase());
    }

    return [...keySet];
}
