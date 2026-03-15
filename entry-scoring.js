/**
 * TunnelVision Entry Quality Scoring
 *
 * Computes a quality/health score per lorebook entry based on heuristics:
 *   - Specificity: Content length and presence of concrete details
 *   - Freshness: How recently the entry was created (UID as proxy)
 *   - Retrieval rate: How often smart context selects and the AI references it
 *   - Key coverage: Whether the entry's keys appear in recent chat
 *
 * All computed locally from cached data — no LLM calls.
 * Surfaced as color-coded health dots in the tree editor.
 */

import { getFeedbackMap } from './smart-context.js';
import { getContext } from '../../../st-context.js';
import { isSummaryTitle, isTrackerTitle } from './tree-store.js';

const PROPER_NOUN_RE = /[A-Z][a-z]{2,}/g;
const NUMBER_RE = /\d+/g;

/**
 * Compute a quality score for a single lorebook entry.
 * @param {Object} entry - The lorebook entry object
 * @param {number} maxUid - Highest UID in the lorebook (for freshness calculation)
 * @param {Record<string, Object>|null} feedbackData - Feedback map from smart-context
 * @param {string} recentText - Lowercased recent chat text for key coverage
 * @returns {{ specificity: number, freshness: number, retrievalRate: number, keyCoverage: number, total: number }}
 */
export function computeEntryQuality(entry, maxUid, feedbackData, recentText) {
    const quality = { specificity: 0, freshness: 0, retrievalRate: 0, keyCoverage: 0, total: 0 };
    if (!entry) return quality;

    // ── Specificity (0-25) ──
    const content = (entry.content || '').trim();
    const contentLen = content.length;
    if (contentLen >= 500) quality.specificity = 20;
    else if (contentLen >= 150) quality.specificity = 15;
    else if (contentLen >= 50) quality.specificity = 10;
    else quality.specificity = 5;

    const properNouns = (content.match(PROPER_NOUN_RE) || []).length;
    const numbers = (content.match(NUMBER_RE) || []).length;
    if (properNouns >= 3 || numbers >= 2) {
        quality.specificity = Math.min(25, quality.specificity + 5);
    }

    // ── Freshness (0-25) ──
    if (maxUid > 0 && entry.uid != null) {
        const ratio = entry.uid / maxUid;
        if (ratio > 0.9) quality.freshness = 25;
        else if (ratio > 0.7) quality.freshness = 20;
        else if (ratio > 0.5) quality.freshness = 15;
        else if (ratio > 0.3) quality.freshness = 10;
        else quality.freshness = 5;
    } else {
        quality.freshness = 15;
    }

    // ── Retrieval Rate (0-25) ──
    const fb = feedbackData?.[entry.uid];
    if (fb && fb.injections > 0) {
        const ratio = fb.references / fb.injections;
        if (fb.injections >= 3 && ratio > 0.5) quality.retrievalRate = 25;
        else if (fb.references > 0) quality.retrievalRate = 20;
        else if (fb.injections >= 3 && fb.references === 0) quality.retrievalRate = 5;
        else quality.retrievalRate = 15;
    } else {
        quality.retrievalRate = 10;
    }

    // ── Key Coverage (0-25) ──
    if (recentText) {
        const keys = entry.key || [];
        let matches = 0;
        for (const key of keys) {
            const k = String(key).trim().toLowerCase();
            if (k.length >= 2 && recentText.includes(k)) matches++;
        }
        if (matches >= 3) quality.keyCoverage = 25;
        else if (matches >= 2) quality.keyCoverage = 20;
        else if (matches >= 1) quality.keyCoverage = 15;
        else quality.keyCoverage = 5;
    } else {
        quality.keyCoverage = 10;
    }

    quality.total = quality.specificity + quality.freshness + quality.retrievalRate + quality.keyCoverage;
    return quality;
}

/**
 * Map a total quality score to a categorical rating.
 * @param {number|{total:number}} quality
 * @returns {'good'|'fair'|'stale'|'poor'}
 */
export function getQualityRating(quality) {
    const total = typeof quality === 'number' ? quality : quality.total;
    if (total >= 70) return 'good';
    if (total >= 50) return 'fair';
    if (total >= 30) return 'stale';
    return 'poor';
}

/**
 * Get the CSS color for a quality rating.
 * @param {'good'|'fair'|'stale'|'poor'} rating
 * @returns {string}
 */
export function getQualityColor(rating) {
    switch (rating) {
        case 'good': return '#00b894';
        case 'fair': return '#fdcb6e';
        case 'stale': return '#e17055';
        case 'poor': return '#d63031';
        default: return '#636e72';
    }
}

/**
 * Build a human-readable tooltip from a quality breakdown.
 * @param {{ specificity: number, freshness: number, retrievalRate: number, keyCoverage: number, total: number }} q
 * @returns {string}
 */
export function qualityTooltip(q) {
    return [
        `Quality: ${q.total}/100 (${getQualityRating(q)})`,
        `  Specificity: ${q.specificity}/25`,
        `  Freshness: ${q.freshness}/25`,
        `  Retrieval: ${q.retrievalRate}/25`,
        `  Key Coverage: ${q.keyCoverage}/25`,
    ].join('\n');
}

/**
 * Pre-compute quality context for a lorebook: maxUid, feedbackMap, and recentText.
 * Call once per render pass, then pass the result to computeEntryQuality for each entry.
 * @param {Object} bookData - The lorebook's book data (with .entries)
 * @returns {{ maxUid: number, feedbackMap: Record<string, Object>, recentText: string }}
 */
export function buildQualityContext(bookData) {
    let maxUid = 0;
    if (bookData?.entries) {
        for (const key of Object.keys(bookData.entries)) {
            const uid = bookData.entries[key].uid;
            if (uid > maxUid) maxUid = uid;
        }
    }

    const feedbackMap = getFeedbackMap();

    let recentText = '';
    try {
        const chat = getContext().chat;
        if (chat && chat.length > 0) {
            const start = Math.max(0, chat.length - 10);
            const parts = [];
            for (let i = start; i < chat.length; i++) {
                if (!chat[i].is_system && chat[i].mes) parts.push(chat[i].mes);
            }
            recentText = parts.join(' ').toLowerCase();
        }
    } catch { /* no chat */ }

    return { maxUid, feedbackMap, recentText };
}

/**
 * Count stale entries across active lorebooks.
 * An entry is stale if it has been injected 3+ times without being referenced.
 * @param {Object} bookData - Lorebook data
 * @returns {number}
 */
export function countStaleEntries(bookData) {
    if (!bookData?.entries) return 0;
    const feedbackMap = getFeedbackMap();
    let stale = 0;

    for (const key of Object.keys(bookData.entries)) {
        const entry = bookData.entries[key];
        if (entry.disable) continue;
        const title = entry.comment || '';
        if (isSummaryTitle(title) || isTrackerTitle(title)) continue;

        const fb = feedbackMap[entry.uid];
        if (fb && fb.injections >= 3 && fb.references === 0) stale++;
    }

    return stale;
}
