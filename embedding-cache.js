/**
 * TunnelVision Embedding Cache
 *
 * Caches entry-level text embeddings and provides cosine similarity scoring
 * for the smart context pipeline. Embeddings are computed lazily via the
 * sidecar transport and invalidated when entry content changes.
 *
 * Storage: in-memory Map keyed by "bookName:uid". Embeddings are not persisted
 * across page reloads — they rebuild on demand during pre-warming.
 */

import { isEmbeddingSupported, computeEmbeddings } from './llm-sidecar.js';

/** @type {Map<string, {embedding: number[], contentHash: number}>} */
const _cache = new Map();

const MAX_BATCH_SIZE = 20;
const MAX_TEXT_LENGTH = 500;

// ── Availability ─────────────────────────────────────────────────

/**
 * Check if embedding-based similarity is available (sidecar configured + supports embeddings).
 * @returns {boolean}
 */
export function isEmbeddingAvailable() {
    return isEmbeddingSupported();
}

// ── Hashing ──────────────────────────────────────────────────────

function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return hash;
}

// ── Cosine Similarity ────────────────────────────────────────────

function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
}

// ── Cache Operations ─────────────────────────────────────────────

function getCacheKey(bookName, uid) {
    return `${bookName}:${uid}`;
}

function getCachedEmbedding(bookName, uid, contentHash) {
    const key = getCacheKey(bookName, uid);
    const cached = _cache.get(key);
    if (cached && cached.contentHash === contentHash) return cached.embedding;
    return null;
}

function setCachedEmbedding(bookName, uid, contentHash, embedding) {
    const key = getCacheKey(bookName, uid);
    _cache.set(key, { embedding, contentHash });
}

/** Clear all cached embeddings. */
export function clearEmbeddingCache() {
    _cache.clear();
}

// ── Batch Embedding ──────────────────────────────────────────────

/**
 * Ensure embeddings are cached for a set of entries, computing any missing ones.
 * @param {Array<{entry: Object, bookName: string}>} candidates
 * @returns {Promise<void>}
 */
async function ensureEmbeddings(candidates) {
    const missing = [];

    for (const c of candidates) {
        const content = (c.entry.content || '').trim();
        const text = ((c.entry.comment || '') + ' ' + content).substring(0, MAX_TEXT_LENGTH);
        const hash = simpleHash(text);
        const existing = getCachedEmbedding(c.bookName, c.entry.uid, hash);
        if (!existing) {
            missing.push({ candidate: c, text, hash });
        }
    }

    if (missing.length === 0) return;

    // Batch in groups to avoid API limits
    for (let i = 0; i < missing.length; i += MAX_BATCH_SIZE) {
        const batch = missing.slice(i, i + MAX_BATCH_SIZE);
        try {
            const texts = batch.map(m => m.text);
            const embeddings = await computeEmbeddings(texts);
            for (let j = 0; j < batch.length; j++) {
                if (embeddings[j]) {
                    setCachedEmbedding(
                        batch[j].candidate.bookName,
                        batch[j].candidate.entry.uid,
                        batch[j].hash,
                        embeddings[j],
                    );
                }
            }
        } catch (e) {
            console.debug('[TunnelVision] Embedding batch failed:', e.message);
            break;
        }
    }
}

// ── Similarity Scoring ───────────────────────────────────────────

/**
 * Compute embedding similarity boosts for candidates against recent chat text.
 * Returns a Map of UID → bonus score (0–8 range).
 * @param {Array<{entry: Object, bookName: string, score: number}>} candidates
 * @param {string} recentText - Lowercased recent chat text
 * @returns {Promise<Map<number, number>>}
 */
export async function getEmbeddingSimilarityBoosts(candidates, recentText) {
    const boosts = new Map();

    if (candidates.length === 0 || !recentText) return boosts;

    // Ensure entry embeddings are cached
    await ensureEmbeddings(candidates);

    // Compute embedding for recent chat text
    let chatEmbedding;
    try {
        const chatSnippet = recentText.substring(0, MAX_TEXT_LENGTH);
        const embeddings = await computeEmbeddings([chatSnippet]);
        chatEmbedding = embeddings?.[0];
    } catch {
        return boosts;
    }
    if (!chatEmbedding) return boosts;

    // Score each candidate by cosine similarity
    for (const c of candidates) {
        const content = (c.entry.content || '').trim();
        const text = ((c.entry.comment || '') + ' ' + content).substring(0, MAX_TEXT_LENGTH);
        const hash = simpleHash(text);
        const entryEmbedding = getCachedEmbedding(c.bookName, c.entry.uid, hash);
        if (!entryEmbedding) continue;

        const similarity = cosineSimilarity(chatEmbedding, entryEmbedding);

        // Map similarity (0-1) to bonus score (0-8)
        if (similarity >= 0.8) boosts.set(c.entry.uid, 8);
        else if (similarity >= 0.6) boosts.set(c.entry.uid, 5);
        else if (similarity >= 0.4) boosts.set(c.entry.uid, 3);
        else if (similarity >= 0.3) boosts.set(c.entry.uid, 1);
    }

    return boosts;
}
