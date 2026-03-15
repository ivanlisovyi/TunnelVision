import { describe, it, expect, vi } from 'vitest';

// Mock transitive dependencies pulled in via smart-context.js → tool-registry.js
vi.mock('../tool-registry.js', () => ({
    getActiveTunnelVisionBooks: vi.fn(() => []),
}));
vi.mock('../entry-manager.js', () => ({
    getCachedWorldInfoSync: vi.fn(() => null),
}));
vi.mock('../world-state.js', () => ({
    getWorldStateSections: vi.fn(() => ({})),
}));

import { computeEntryQuality, getQualityRating, getQualityColor, qualityTooltip } from '../entry-scoring.js';

// ── getQualityRating ─────────────────────────────────────────────

describe('getQualityRating', () => {
    it('returns "good" for score >= 70', () => {
        expect(getQualityRating(70)).toBe('good');
        expect(getQualityRating(100)).toBe('good');
        expect(getQualityRating({ total: 85 })).toBe('good');
    });

    it('returns "fair" for score 50-69', () => {
        expect(getQualityRating(50)).toBe('fair');
        expect(getQualityRating(69)).toBe('fair');
    });

    it('returns "stale" for score 30-49', () => {
        expect(getQualityRating(30)).toBe('stale');
        expect(getQualityRating(49)).toBe('stale');
    });

    it('returns "poor" for score < 30', () => {
        expect(getQualityRating(0)).toBe('poor');
        expect(getQualityRating(29)).toBe('poor');
    });

    it('accepts an object with a total property', () => {
        expect(getQualityRating({ total: 75 })).toBe('good');
        expect(getQualityRating({ total: 10 })).toBe('poor');
    });
});

// ── getQualityColor ──────────────────────────────────────────────

describe('getQualityColor', () => {
    it('maps known ratings to colors', () => {
        expect(getQualityColor('good')).toBe('#00b894');
        expect(getQualityColor('fair')).toBe('#fdcb6e');
        expect(getQualityColor('stale')).toBe('#e17055');
        expect(getQualityColor('poor')).toBe('#d63031');
    });

    it('returns gray for unknown ratings', () => {
        expect(getQualityColor('unknown')).toBe('#636e72');
    });
});

// ── qualityTooltip ───────────────────────────────────────────────

describe('qualityTooltip', () => {
    it('includes total and rating', () => {
        const q = { specificity: 20, freshness: 25, retrievalRate: 15, keyCoverage: 15, total: 75 };
        const tip = qualityTooltip(q);
        expect(tip).toContain('75/100');
        expect(tip).toContain('good');
    });

    it('includes all four dimension labels', () => {
        const q = { specificity: 5, freshness: 5, retrievalRate: 5, keyCoverage: 5, total: 20 };
        const tip = qualityTooltip(q);
        expect(tip).toContain('Specificity');
        expect(tip).toContain('Freshness');
        expect(tip).toContain('Retrieval');
        expect(tip).toContain('Key Coverage');
    });
});

// ── computeEntryQuality ──────────────────────────────────────────

describe('computeEntryQuality', () => {
    const makeEntry = (overrides = {}) => ({
        uid: 50,
        comment: 'Test Entry',
        content: 'Some content here.',
        key: ['test', 'entry'],
        disable: false,
        ...overrides,
    });

    it('returns zero scores for null entry', () => {
        const q = computeEntryQuality(null, 100, {}, 'anything');
        expect(q.total).toBe(0);
    });

    it('total equals sum of four components', () => {
        const q = computeEntryQuality(makeEntry(), 100, {}, 'test entry content');
        expect(q.total).toBe(q.specificity + q.freshness + q.retrievalRate + q.keyCoverage);
    });

    // ── Specificity ──

    it('gives low specificity for very short content', () => {
        const q = computeEntryQuality(makeEntry({ content: 'Hi.' }), 100, {}, '');
        expect(q.specificity).toBe(5);
    });

    it('gives medium specificity for moderate content', () => {
        const q = computeEntryQuality(makeEntry({ content: 'A'.repeat(200) }), 100, {}, '');
        expect(q.specificity).toBeGreaterThanOrEqual(15);
    });

    it('gives high specificity for long content with proper nouns', () => {
        const content = 'Elena Blackwood met John Wald at the Grand Cathedral on January 15th. ' +
            'They discussed the prophecy that had been foretold by the Oracle. ' +
            'The ancient artifact was hidden beneath the mountain fortress.';
        const q = computeEntryQuality(makeEntry({ content }), 100, {}, '');
        expect(q.specificity).toBeGreaterThanOrEqual(20);
    });

    // ── Freshness ──

    it('gives high freshness for entries near max UID', () => {
        const q = computeEntryQuality(makeEntry({ uid: 95 }), 100, {}, '');
        expect(q.freshness).toBe(25);
    });

    it('gives low freshness for entries with low UID ratio', () => {
        const q = computeEntryQuality(makeEntry({ uid: 10 }), 100, {}, '');
        expect(q.freshness).toBeLessThanOrEqual(10);
    });

    it('gives default freshness when maxUid is 0', () => {
        const q = computeEntryQuality(makeEntry(), 0, {}, '');
        expect(q.freshness).toBe(15);
    });

    // ── Retrieval Rate ──

    it('gives high retrieval score for well-referenced entries', () => {
        const fb = { 50: { injections: 10, references: 8, missStreak: 0, lastReferenced: Date.now() } };
        const q = computeEntryQuality(makeEntry(), 100, fb, '');
        expect(q.retrievalRate).toBe(25);
    });

    it('gives low retrieval score for entries injected but never referenced', () => {
        const fb = { 50: { injections: 5, references: 0, missStreak: 5, lastReferenced: 0 } };
        const q = computeEntryQuality(makeEntry(), 100, fb, '');
        expect(q.retrievalRate).toBe(5);
    });

    it('gives default retrieval score when no feedback data exists', () => {
        const q = computeEntryQuality(makeEntry(), 100, {}, '');
        expect(q.retrievalRate).toBe(10);
    });

    // ── Key Coverage ──

    it('gives high key coverage when multiple keys match recent chat', () => {
        const entry = makeEntry({ key: ['elena', 'sword', 'castle', 'magic'] });
        const q = computeEntryQuality(entry, 100, {}, 'elena took the sword from the castle');
        expect(q.keyCoverage).toBeGreaterThanOrEqual(20);
    });

    it('gives low key coverage when no keys match', () => {
        const entry = makeEntry({ key: ['dragon', 'fire'] });
        const q = computeEntryQuality(entry, 100, {}, 'the weather was pleasant');
        expect(q.keyCoverage).toBe(5);
    });

    it('gives default key coverage when recentText is empty', () => {
        const q = computeEntryQuality(makeEntry(), 100, {}, '');
        expect(q.keyCoverage).toBe(10);
    });

    // ── Combined ──

    it('produces a score in the 0-100 range', () => {
        const q = computeEntryQuality(makeEntry(), 100, {}, 'test entry words');
        expect(q.total).toBeGreaterThanOrEqual(0);
        expect(q.total).toBeLessThanOrEqual(100);
    });
});
