/**
 * TunnelVision Smart Context (Proactive Pre-fetch)
 *
 * Automatically injects the most relevant lorebook entries into context
 * BEFORE the AI generates, based on who/what was mentioned in recent messages.
 * This supplements (or replaces) the need for the AI to call TunnelVision_Search
 * every turn — the most obvious context is already provided.
 *
 * Strategy:
 *   1. Scan recent messages for entity names matching entry titles/keys
 *   2. Include tracker entries for mentioned characters
 *   3. Respect a configurable token budget
 *   4. Format and inject via setExtensionPrompt at GENERATION_STARTED
 *
 * This runs synchronously at GENERATION_STARTED (before prompt is built),
 * so it does NOT make LLM calls — only fast local matching.
 */

import { eventSource, event_types } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { getSettings, getTrackerUids } from './tree-store.js';
import { getActiveTunnelVisionBooks } from './tool-registry.js';
import { getCachedWorldInfoSync, getCachedWorldInfo } from './entry-manager.js';
import { getEntryTitle } from './agent-utils.js';
import { getWorldStateSections } from './world-state.js';

// ── Pre-Warming Cache ────────────────────────────────────────────

/** @type {Array|null} Pre-computed scored candidates from background pre-warm. */
let _preWarmedCandidates = null;
/** @type {string|null} Cache key for validating pre-warmed data freshness. */
let _preWarmCacheKey = null;

function buildPreWarmCacheKey() {
    try {
        const chatLen = getContext().chat?.length || 0;
        const books = getActiveTunnelVisionBooks().sort().join(',');
        return `${chatLen}:${books}`;
    } catch {
        return null;
    }
}

/** Invalidate the pre-warming cache when entries change or books are modified. */
export function invalidatePreWarmCache() {
    _preWarmedCandidates = null;
    _preWarmCacheKey = null;
}

const RELEVANCE_KEY = 'tunnelvision_relevance';
const FEEDBACK_KEY = 'tunnelvision_feedback';

/** Entries injected during the most recent GENERATION_STARTED. */
let _lastInjectedEntries = [];
let _scInitialized = false;

// ── Entity Extraction ────────────────────────────────────────────

/**
 * Extract candidate entity names from recent chat messages.
 * Uses entry titles and keys as the vocabulary to match against.
 * @param {Array} chat - Chat messages array
 * @param {number} lookback - How many messages to scan
 * @returns {string} Lowercased combined text from recent messages
 */
function extractMentionsFromChat(chat, lookback) {
    const start = Math.max(0, chat.length - lookback);
    const combinedText = [];

    for (let i = start; i < chat.length; i++) {
        const msg = chat[i];
        if (msg.is_system) continue;
        const text = (msg.mes || '').trim();
        if (text) combinedText.push(text);
    }

    return combinedText.join(' ').toLowerCase();
}

/**
 * Score an entry's relevance based on how well it matches the recent chat text.
 * @param {Object} entry - Lorebook entry
 * @param {string} recentText - Lowercased concatenated recent chat text
 * @returns {number} Relevance score (0 = no match, higher = more relevant)
 */
export function scoreEntry(entry, recentText) {
    if (!recentText) return 0;

    let score = 0;

    const title = (entry.comment || '').trim();
    if (title && recentText.includes(title.toLowerCase())) {
        score += 10;
    }

    const keys = entry.key || [];
    for (const key of keys) {
        const k = String(key).trim().toLowerCase();
        if (k.length >= 2 && recentText.includes(k)) {
            score += 3;
        }
    }

    return score;
}

// ── Relevance Tracking ───────────────────────────────────────────

function getRelevanceMap() {
    try {
        return getContext().chatMetadata?.[RELEVANCE_KEY] || {};
    } catch {
        return {};
    }
}

function touchRelevance(uids) {
    try {
        const context = getContext();
        if (!context.chatMetadata) return;
        const map = context.chatMetadata[RELEVANCE_KEY] || {};
        const now = Date.now();
        for (const uid of uids) map[uid] = now;
        context.chatMetadata[RELEVANCE_KEY] = map;
        context.saveMetadataDebounced?.();
    } catch { /* metadata not available */ }
}

function relevanceDecay(uid, relevanceMap) {
    const lastSeen = relevanceMap[uid];
    if (!lastSeen) return 0;
    const hoursAgo = (Date.now() - lastSeen) / (1000 * 60 * 60);
    if (hoursAgo < 0.5) return 5;
    if (hoursAgo < 2) return 3;
    if (hoursAgo < 8) return 1;
    return 0;
}

// ── Relevance Feedback ───────────────────────────────────────────

/**
 * Retrieve the per-entry feedback map from chat_metadata.
 * Each key is a stringified UID, value is { injections, references, missStreak, lastReferenced }.
 * @returns {Record<string, {injections:number, references:number, missStreak:number, lastReferenced:number}>}
 */
export function getFeedbackMap() {
    try {
        return getContext().chatMetadata?.[FEEDBACK_KEY] || {};
    } catch {
        return {};
    }
}

function saveFeedbackMap(map) {
    try {
        const context = getContext();
        if (!context.chatMetadata) return;
        context.chatMetadata[FEEDBACK_KEY] = map;
        context.saveMetadataDebounced?.();
    } catch { /* metadata not available */ }
}

/**
 * Score modifier based on whether an entry's past injections led to AI usage.
 * Positive for entries the AI actually references; negative for repeatedly-ignored entries.
 */
function feedbackBoost(uid) {
    const map = getFeedbackMap();
    const data = map[uid];
    if (!data) return 0;

    let boost = 0;

    if (data.lastReferenced) {
        const hoursAgo = (Date.now() - data.lastReferenced) / (1000 * 60 * 60);
        if (hoursAgo < 1) boost += 5;
        else if (hoursAgo < 4) boost += 3;
        else if (hoursAgo < 12) boost += 1;
    }

    if (data.injections >= 3 && data.references / data.injections > 0.5) {
        boost += 3;
    }

    if (data.missStreak >= 5) boost -= 4;
    else if (data.missStreak >= 3) boost -= 2;

    return boost;
}

/**
 * Check if the AI's response text references an injected entry.
 * Matches on title or on 2+ keys (or 1 substantial key of 4+ chars).
 */
function isEntryReferenced(entry, responseText) {
    const title = entry.title.toLowerCase();
    if (title.length >= 3 && responseText.includes(title)) return true;

    let keyHits = 0;
    let hasSubstantialHit = false;
    for (const key of entry.keys) {
        const k = key.toLowerCase();
        if (k.length >= 2 && responseText.includes(k)) {
            keyHits++;
            if (k.length >= 4) hasSubstantialHit = true;
            if (keyHits >= 2) return true;
        }
    }

    return keyHits >= 1 && hasSubstantialHit;
}

/**
 * After an AI response, scan it for references to entries that were injected
 * via smart context. Updates the per-entry feedback map in chat_metadata.
 */
export function processRelevanceFeedback() {
    if (_lastInjectedEntries.length === 0) return;

    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length < 2) return;

    const lastMsg = chat[chat.length - 1];
    if (!lastMsg || lastMsg.is_user) return;
    const responseText = (lastMsg.mes || '').toLowerCase();
    if (!responseText) return;

    const feedbackMap = getFeedbackMap();

    for (const entry of _lastInjectedEntries) {
        const uid = String(entry.uid);
        if (!feedbackMap[uid]) {
            feedbackMap[uid] = { injections: 0, references: 0, missStreak: 0, lastReferenced: 0 };
        }

        const data = feedbackMap[uid];
        data.injections++;

        if (isEntryReferenced(entry, responseText)) {
            data.references++;
            data.missStreak = 0;
            data.lastReferenced = Date.now();
        } else {
            data.missStreak++;
        }
    }

    saveFeedbackMap(feedbackMap);
    _lastInjectedEntries = [];
}

// ── World State Boost ────────────────────────────────────────────

const WS_BOLD_NAME_RE = /\*\*([^*]+)\*\*/g;

/**
 * Extract boost signals from the world state's parsed sections.
 * Returns lowercased sets of present character names and active thread keywords.
 * @returns {{ presentCharacters: Set<string>, threadKeywords: Set<string> } | null}
 */
function extractWorldStateBoostSignals() {
    const sections = getWorldStateSections();
    if (!sections) return null;

    const presentCharacters = new Set();
    const threadKeywords = new Set();

    // Current Scene → Present: line lists characters in the scene
    const sceneBody = sections['Current Scene'] || '';
    const presentMatch = sceneBody.match(/Present:\s*(.+)/i);
    if (presentMatch) {
        for (const name of presentMatch[1].split(/[,;&]+/)) {
            const trimmed = name.replace(/\*\*/g, '').trim().toLowerCase();
            if (trimmed.length >= 2) presentCharacters.add(trimmed);
        }
    }

    // Active Threads → extract bold names and significant words
    const threadsBody = sections['Active Threads'] || '';
    let m;
    WS_BOLD_NAME_RE.lastIndex = 0;
    while ((m = WS_BOLD_NAME_RE.exec(threadsBody)) !== null) {
        const keyword = m[1].trim().toLowerCase();
        if (keyword.length >= 2) threadKeywords.add(keyword);
    }

    if (presentCharacters.size === 0 && threadKeywords.size === 0) return null;
    return { presentCharacters, threadKeywords };
}

/**
 * Score an entry against world state signals (present characters, active threads).
 * @param {Object} entry - Lorebook entry
 * @param {{ presentCharacters: Set<string>, threadKeywords: Set<string> }} signals
 * @returns {number} Bonus score
 */
function worldStateBoost(entry, signals) {
    if (!signals) return 0;

    let boost = 0;
    const title = (entry.comment || '').toLowerCase();
    const keys = (entry.key || []).map(k => String(k).trim().toLowerCase());
    const searchable = [title, ...keys];

    // Boost entries whose title/keys mention a character currently in the scene
    for (const charName of signals.presentCharacters) {
        if (searchable.some(s => s.includes(charName))) {
            boost += 8;
            break;
        }
    }

    // Boost entries whose title/keys align with active thread topics
    for (const keyword of signals.threadKeywords) {
        if (searchable.some(s => s.includes(keyword))) {
            boost += 5;
            break;
        }
    }

    return boost;
}

// ── Scoring Pipeline ─────────────────────────────────────────────

/**
 * Score all active entries against recent chat text and sort by relevance.
 * This is the heavy computation that pre-warming moves off the critical path.
 * @param {string[]} activeBooks - Active TV-managed lorebook names
 * @param {string} recentText - Lowercased recent chat text
 * @returns {Array<{entry: Object, bookName: string, score: number, isTracker: boolean, isSummary: boolean}>}
 */
function scoreCandidates(activeBooks, recentText) {
    const candidates = [];
    const relevanceMap = getRelevanceMap();
    const wsSignals = extractWorldStateBoostSignals();

    let maxUid = 0;
    for (const bookName of activeBooks) {
        const bd = getCachedWorldInfoSync(bookName);
        if (!bd?.entries) continue;
        for (const key of Object.keys(bd.entries)) {
            if (bd.entries[key].uid > maxUid) maxUid = bd.entries[key].uid;
        }
    }

    for (const bookName of activeBooks) {
        const bookData = getCachedWorldInfoSync(bookName);
        if (!bookData?.entries) continue;

        const trackerSet = new Set(getTrackerUids(bookName));

        for (const key of Object.keys(bookData.entries)) {
            const entry = bookData.entries[key];
            if (entry.disable) continue;
            if (!entry.content || !entry.content.trim()) continue;

            const isTracker = trackerSet.has(entry.uid);
            const lowerComment = (entry.comment || '').toLowerCase();
            const isSummary = lowerComment.startsWith('[summary]') || lowerComment.startsWith('[scene summary');
            let relevance = scoreEntry(entry, recentText);

            relevance += relevanceDecay(entry.uid, relevanceMap);
            if (maxUid > 0 && entry.uid > maxUid * 0.9) relevance += 3;
            relevance += worldStateBoost(entry, wsSignals);
            relevance += feedbackBoost(entry.uid);

            if (isTracker && relevance > 0) {
                candidates.push({ entry, bookName, score: relevance + 20, isTracker: true, isSummary: false });
            } else if (isSummary && relevance >= 3) {
                candidates.push({ entry, bookName, score: relevance + 2, isTracker: false, isSummary: true });
            } else if (relevance >= 5) {
                candidates.push({ entry, bookName, score: relevance, isTracker, isSummary });
            }
        }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates;
}

// ── Core Logic ───────────────────────────────────────────────────

/**
 * Build proactive context from lorebook entries matching recent chat mentions.
 * Called synchronously at GENERATION_STARTED — must be fast (no LLM calls, no awaits).
 * Uses pre-warmed candidates if available; otherwise falls back to synchronous scoring.
 * @returns {string} Formatted context string for injection, or empty string
 */
export function buildSmartContextPrompt() {
    const settings = getSettings();
    if (!settings.smartContextEnabled || settings.globalEnabled === false) return '';

    const activeBooks = getActiveTunnelVisionBooks();
    if (activeBooks.length === 0) return '';

    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length < 2) return '';

    const lookback = settings.smartContextLookback || 6;
    const maxEntries = settings.smartContextMaxEntries || 8;
    const maxChars = settings.smartContextMaxChars || 4000;

    const recentText = extractMentionsFromChat(chat, lookback);
    if (!recentText) return '';

    // Use pre-warmed candidates if cache is fresh, otherwise score synchronously
    let candidates;
    const cacheKey = buildPreWarmCacheKey();
    if (_preWarmedCandidates && _preWarmCacheKey === cacheKey) {
        candidates = _preWarmedCandidates;
        _preWarmedCandidates = null;
        _preWarmCacheKey = null;
    } else {
        candidates = scoreCandidates(activeBooks, recentText);
    }

    if (candidates.length === 0) return '';

    const selected = [];
    const selectedUids = [];
    const selectedEntryInfo = [];
    let totalChars = 0;

    for (const c of candidates) {
        if (selected.length >= maxEntries) break;
        const entryText = formatEntryForInjection(c.entry, c.bookName, c.isTracker, c.isSummary);
        if (totalChars + entryText.length > maxChars) continue;

        selected.push(entryText);
        selectedUids.push(c.entry.uid);
        selectedEntryInfo.push({
            uid: c.entry.uid,
            title: (c.entry.comment || '').trim(),
            keys: (c.entry.key || []).map(k => String(k).trim()),
        });
        totalChars += entryText.length;
    }

    if (selected.length === 0) return '';

    _lastInjectedEntries = selectedEntryInfo;
    if (selectedUids.length > 0) touchRelevance(selectedUids);

    return [
        `[TunnelVision Smart Context — ${selected.length} relevant entries auto-retrieved based on current scene. This is supplemental memory; the AI can search for more with TunnelVision_Search if needed.]`,
        '',
        selected.join('\n\n---\n\n'),
    ].join('\n');
}

/**
 * Async background pre-computation of smart context scores.
 * Called after MESSAGE_RECEIVED so the scoring is ready for the next GENERATION_STARTED.
 * Ensures world info data is loaded (async) then runs the full scoring pipeline.
 */
async function preWarmSmartContext() {
    const settings = getSettings();
    if (!settings.smartContextEnabled || settings.globalEnabled === false) return;

    const activeBooks = getActiveTunnelVisionBooks();
    if (activeBooks.length === 0) return;

    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length < 2) return;

    const cacheKey = buildPreWarmCacheKey();
    if (!cacheKey) return;

    const lookback = settings.smartContextLookback || 6;
    const recentText = extractMentionsFromChat(chat, lookback);
    if (!recentText) return;

    // Ensure world info data is in cache (the async part that saves time later)
    await Promise.all(activeBooks.map(book => getCachedWorldInfo(book)));

    const candidates = scoreCandidates(activeBooks, recentText);

    _preWarmedCandidates = candidates;
    _preWarmCacheKey = cacheKey;
    console.debug(`[TunnelVision] Pre-warmed smart context: ${candidates.length} candidates scored`);
}

// ── Formatting ───────────────────────────────────────────────────

function formatEntryForInjection(entry, bookName, isTracker, isSummary = false) {
    const tag = isTracker ? ' [Tracker]' : isSummary ? ' [Summary]' : '';
    return `[${getEntryTitle(entry)}${tag} — ${bookName}, UID ${entry.uid}]\n${(entry.content || '').trim()}`;
}

// ── Init ─────────────────────────────────────────────────────────

function onMessageReceived() {
    try {
        const context = getContext();
        const lastMsg = context.chat?.[context.chat.length - 1];
        if (Array.isArray(lastMsg?.extra?.tool_invocations) && lastMsg.extra.tool_invocations.length > 0) return;
    } catch { return; }

    processRelevanceFeedback();

    // Pre-warm smart context scores in the background for the next generation
    preWarmSmartContext().catch(err => {
        console.debug('[TunnelVision] Pre-warm failed (non-critical):', err.message);
    });
}

/**
 * Register the MESSAGE_RECEIVED handler for relevance feedback + pre-warming.
 * Called once from index.js init.
 */
export function initSmartContext() {
    if (_scInitialized) return;
    _scInitialized = true;

    if (event_types.MESSAGE_RECEIVED) {
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    }

    // Invalidate pre-warm cache when lorebooks change
    if (event_types.WORLDINFO_UPDATED) {
        eventSource.on(event_types.WORLDINFO_UPDATED, invalidatePreWarmCache);
    }

    console.log('[TunnelVision] Smart context feedback loop + pre-warming initialized');
}
