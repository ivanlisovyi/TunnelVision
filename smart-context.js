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

import { getContext } from '../../../st-context.js';
import { getSettings, getTrackerUids } from './tree-store.js';
import { getActiveTunnelVisionBooks } from './tool-registry.js';
import { getCachedWorldInfoSync } from './entry-manager.js';
import { getEntryTitle } from './agent-utils.js';

const RELEVANCE_KEY = 'tunnelvision_relevance';

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
function scoreEntry(entry, recentText) {
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

// ── Core Logic ───────────────────────────────────────────────────

/**
 * Build proactive context from lorebook entries matching recent chat mentions.
 * Called synchronously at GENERATION_STARTED — must be fast (no LLM calls, no awaits).
 * Uses cache-only data access; returns empty on the first turn before cache is warm.
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

    // Gather and score all active entries across books
    const candidates = [];
    const trackerUidSets = new Map();
    const relevanceMap = getRelevanceMap();

    // Find max UID for recency boost calculation
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
        trackerUidSets.set(bookName, trackerSet);

        for (const key of Object.keys(bookData.entries)) {
            const entry = bookData.entries[key];
            if (entry.disable) continue;
            if (!entry.content || !entry.content.trim()) continue;

            const isTracker = trackerSet.has(entry.uid);
            const lowerComment = (entry.comment || '').toLowerCase();
            const isSummary = lowerComment.startsWith('[summary]') || lowerComment.startsWith('[scene summary');
            let relevance = scoreEntry(entry, recentText);

            // Relevance decay bonus — recently relevant entries score higher
            relevance += relevanceDecay(entry.uid, relevanceMap);

            // Recency boost — higher UIDs are newer entries
            if (maxUid > 0 && entry.uid > maxUid * 0.9) relevance += 3;

            // Tracker entries for mentioned entities get a boost
            if (isTracker && relevance > 0) {
                candidates.push({
                    entry,
                    bookName,
                    score: relevance + 20,
                    isTracker: true,
                    isSummary: false,
                });
            } else if (isSummary && relevance >= 3) {
                // Lower threshold for summaries — they provide rich scene context
                candidates.push({
                    entry,
                    bookName,
                    score: relevance + 2,
                    isTracker: false,
                    isSummary: true,
                });
            } else if (relevance >= 5) {
                candidates.push({
                    entry,
                    bookName,
                    score: relevance,
                    isTracker,
                    isSummary,
                });
            }
        }
    }

    if (candidates.length === 0) return '';

    // Sort by score descending, take top N within budget
    candidates.sort((a, b) => b.score - a.score);

    const selected = [];
    const selectedUids = [];
    let totalChars = 0;

    for (const c of candidates) {
        if (selected.length >= maxEntries) break;
        const entryText = formatEntryForInjection(c.entry, c.bookName, c.isTracker, c.isSummary);
        if (totalChars + entryText.length > maxChars) continue;

        selected.push(entryText);
        selectedUids.push(c.entry.uid);
        totalChars += entryText.length;
    }

    if (selected.length === 0) return '';

    // Record which entries were selected for relevance decay tracking
    if (selectedUids.length > 0) touchRelevance(selectedUids);

    return [
        `[TunnelVision Smart Context — ${selected.length} relevant entries auto-retrieved based on current scene. This is supplemental memory; the AI can search for more with TunnelVision_Search if needed.]`,
        '',
        selected.join('\n\n---\n\n'),
    ].join('\n');
}

// ── Formatting ───────────────────────────────────────────────────

function formatEntryForInjection(entry, bookName, isTracker, isSummary = false) {
    const tag = isTracker ? ' [Tracker]' : isSummary ? ' [Summary]' : '';
    return `[${getEntryTitle(entry)}${tag} — ${bookName}, UID ${entry.uid}]\n${(entry.content || '').trim()}`;
}
