/**
 * Shared utilities for TunnelVision agent workflow modules.
 * Eliminates duplicated helpers across world-state, post-turn-processor,
 * auto-summary, memory-lifecycle, and smart-context.
 */

import { getContext } from '../../../st-context.js';

/**
 * Safely get the current chat ID, returning null if unavailable.
 * @returns {string|null}
 */
export function getChatId() {
    try {
        return getContext().chatId || null;
    } catch {
        return null;
    }
}

/**
 * Format recent chat messages as a text excerpt for LLM consumption.
 * @param {Array} chat - The full chat array
 * @param {number} count - How many messages from the end to include
 * @returns {string} Formatted excerpt with role labels
 */
export function formatChatExcerpt(chat, count) {
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

/**
 * Get a display title for a lorebook entry. Tries comment, first key, then UID fallback.
 * @param {Object} entry - Lorebook entry object
 * @returns {string}
 */
export function getEntryTitle(entry) {
    return entry.comment || entry.key?.[0] || `#${entry.uid}`;
}

// ── Trigram Similarity ────────────────────────────────────────────

/**
 * Build a set of character trigrams from a string.
 * @param {string} s
 * @returns {Set<string>}
 */
function trigrams(s) {
    const norm = `  ${s.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()}  `;
    const set = new Set();
    for (let i = 0; i <= norm.length - 3; i++) {
        set.add(norm.substring(i, i + 3));
    }
    return set;
}

/**
 * Compute trigram similarity between two strings (0–1, 1 = identical).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function trigramSimilarity(a, b) {
    const setA = trigrams(a);
    const setB = trigrams(b);
    if (setA.size === 0 && setB.size === 0) return 1;
    if (setA.size === 0 || setB.size === 0) return 0;

    let intersection = 0;
    for (const tri of setA) {
        if (setB.has(tri)) intersection++;
    }
    return intersection / (setA.size + setB.size - intersection);
}

// ── Retry Logic ──────────────────────────────────────────────────

/**
 * Call an async function with retry on failure / empty results.
 * @param {Function} fn - Async function to call
 * @param {Object} [opts]
 * @param {number} [opts.maxRetries=2] - Max retry attempts
 * @param {number} [opts.backoff=2000] - Base backoff in ms (doubled each retry)
 * @param {string} [opts.label='LLM call'] - Label for logging
 * @returns {Promise<*>} Result of fn
 */
export async function callWithRetry(fn, { maxRetries = 2, backoff = 2000, label = 'LLM call' } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const result = await fn();
            if (result !== undefined && result !== null && result !== '') return result;
            if (attempt < maxRetries) {
                console.warn(`[TunnelVision] ${label}: empty response, retrying (${attempt + 1}/${maxRetries})`);
                await new Promise(r => setTimeout(r, backoff * (attempt + 1)));
                continue;
            }
            return result;
        } catch (e) {
            lastError = e;
            if (attempt < maxRetries) {
                console.warn(`[TunnelVision] ${label}: attempt ${attempt + 1} failed (${e.message}), retrying in ${backoff * (attempt + 1)}ms`);
                await new Promise(r => setTimeout(r, backoff * (attempt + 1)));
            }
        }
    }
    throw lastError;
}

/**
 * Check if the current AI message event should be skipped (tool recursion or regeneration).
 * Call this at the top of MESSAGE_RECEIVED handlers.
 * @param {{ lastChatLength: number }} ref - Mutable ref object tracking chat length.
 *   Updated in place when the message is accepted.
 * @returns {boolean} true if the event should be skipped
 */
export function shouldSkipAiMessage(ref) {
    try {
        const context = getContext();
        const lastMsg = context.chat?.[context.chat.length - 1];
        if (Array.isArray(lastMsg?.extra?.tool_invocations) && lastMsg.extra.tool_invocations.length > 0) {
            return true;
        }
    } catch { /* proceed */ }

    try {
        const chatLength = getContext().chat?.length || 0;
        if (chatLength > 0 && chatLength <= ref.lastChatLength) return true;
        ref.lastChatLength = chatLength;
    } catch { /* proceed */ }

    return false;
}
