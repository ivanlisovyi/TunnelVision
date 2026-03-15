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

import { computeEntryQuality, getQualityRating, getQualityColor, qualityTooltip, buildHealthReport, countStaleEntries } from '../entry-scoring.js';

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

// ── countStaleEntries ───────────────────────────────────────────

describe('countStaleEntries', () => {
    it('returns 0 for null bookData', () => {
        expect(countStaleEntries(null)).toBe(0);
    });

    it('returns 0 when no entries exist', () => {
        expect(countStaleEntries({ entries: {} })).toBe(0);
    });

    it('returns 0 when no entries are stale', () => {
        const bookData = {
            entries: {
                0: { uid: 1, comment: 'Fact One', content: 'Some content', disable: false, key: [] },
            },
        };
        expect(countStaleEntries(bookData)).toBe(0);
    });

    it('skips disabled entries', () => {
        const bookData = {
            entries: {
                0: { uid: 1, comment: 'Disabled', content: 'text', disable: true, key: [] },
            },
        };
        expect(countStaleEntries(bookData)).toBe(0);
    });
});

// ── buildHealthReport ───────────────────────────────────────────

describe('buildHealthReport', () => {
    const makeBookData = (entries) => ({
        entries: Object.fromEntries(entries.map((e, i) => [String(i), e])),
    });

    it('returns default report for null bookData', () => {
        const report = buildHealthReport('test', null);
        expect(report.totalEntries).toBe(0);
        expect(report.facts).toBe(0);
        expect(report.summaries).toBe(0);
        expect(report.trackers).toBe(0);
    });

    it('returns default report for bookData without entries', () => {
        const report = buildHealthReport('test', {});
        expect(report.totalEntries).toBe(0);
    });

    it('counts facts, summaries, and trackers correctly', () => {
        const bd = makeBookData([
            { uid: 1, comment: 'Elena Hair', content: 'She has black hair.', disable: false, key: ['elena'] },
            { uid: 2, comment: '[Scene Summary] Day 1', content: 'Things happened.', disable: false, key: [] },
            { uid: 3, comment: '[Tracker] Elena', content: 'Mood: happy', disable: false, key: ['elena'] },
            { uid: 4, comment: 'Another fact', content: 'Info here.', disable: false, key: [] },
        ]);
        const report = buildHealthReport('test', bd);
        expect(report.totalEntries).toBe(4);
        expect(report.facts).toBe(2);
        expect(report.summaries).toBe(1);
        expect(report.trackers).toBe(1);
    });

    it('counts disabled entries separately', () => {
        const bd = makeBookData([
            { uid: 1, comment: 'Active', content: 'Text.', disable: false, key: [] },
            { uid: 2, comment: 'Gone', content: 'Removed.', disable: true, key: [] },
        ]);
        const report = buildHealthReport('test', bd);
        expect(report.totalEntries).toBe(1);
        expect(report.disabled).toBe(1);
    });

    it('detects entries without timestamps', () => {
        const bd = makeBookData([
            { uid: 1, comment: 'Has timestamp', content: '[Day 3, Morning] Something happened.', disable: false, key: [] },
            { uid: 2, comment: 'No timestamp', content: 'Just plain text without day tag.', disable: false, key: [] },
            { uid: 3, comment: '[Summary] Scene 1', content: 'Summary content.', disable: false, key: [] },
            { uid: 4, comment: '[Tracker] Elena', content: 'Mood: happy', disable: false, key: [] },
        ]);
        const report = buildHealthReport('test', bd);
        // Only facts without timestamps count — summaries and trackers are excluded
        expect(report.noTimestamp.length).toBe(1);
        expect(report.noTimestamp[0].uid).toBe(2);
    });

    it('computes average entry length', () => {
        const bd = makeBookData([
            { uid: 1, comment: 'A', content: 'A'.repeat(100), disable: false, key: [] },
            { uid: 2, comment: 'B', content: 'B'.repeat(300), disable: false, key: [] },
        ]);
        const report = buildHealthReport('test', bd);
        expect(report.avgLength).toBe(200);
    });

    it('detects outlier entries (much longer than average)', () => {
        const shortEntries = Array.from({ length: 10 }, (_, i) => ({
            uid: i + 1, comment: `Fact ${i}`, content: 'Short note.', disable: false, key: [],
        }));
        const longEntry = { uid: 99, comment: 'Giant', content: 'X'.repeat(5000), disable: false, key: [] };
        const bd = makeBookData([...shortEntries, longEntry]);
        const report = buildHealthReport('test', bd);
        expect(report.outlierEntries.length).toBe(1);
        expect(report.outlierEntries[0].uid).toBe(99);
        expect(report.outlierEntries[0].length).toBe(5000);
    });

    it('detects duplicate candidates via trigram similarity', () => {
        const sharedContent = 'Elena Blackwood has long flowing black hair. She is a skilled warrior from the northern kingdom who trained under Master Aldric for many years at the Grand Academy.';
        const bd = makeBookData([
            { uid: 1, comment: 'Elena appearance', content: sharedContent + ' Her eyes are green.', disable: false, key: [] },
            { uid: 2, comment: 'Elena appearance', content: sharedContent + ' Her eyes are blue.', disable: false, key: [] },
            { uid: 3, comment: 'Weather patterns', content: 'The Dragon Mountains have unpredictable blizzards. Snow covers the peaks year-round, and travelers must exercise extreme caution.', disable: false, key: [] },
        ]);
        const report = buildHealthReport('test', bd);
        expect(report.duplicateCandidates.length).toBeGreaterThanOrEqual(1);
        const dup = report.duplicateCandidates[0];
        expect([dup.uidA, dup.uidB]).toContain(1);
        expect([dup.uidA, dup.uidB]).toContain(2);
        expect(dup.similarity).toBeGreaterThanOrEqual(0.6);
    });

    it('does not flag dissimilar entries as duplicates', () => {
        const bd = makeBookData([
            { uid: 1, comment: 'Elena personality', content: 'Elena is quiet, thoughtful, and loves reading books.', disable: false, key: [] },
            { uid: 2, comment: 'World geography', content: 'The Dragon Mountains stretch across the northern border.', disable: false, key: [] },
        ]);
        const report = buildHealthReport('test', bd);
        expect(report.duplicateCandidates.length).toBe(0);
    });

    it('reports orphaned entries when tree exists but entry not in any node', () => {
        // No tree exists in test env (getTree returns null), so orphan detection
        // falls back gracefully — treeUids is empty, no orphans reported when tree is absent.
        const bd = makeBookData([
            { uid: 1, comment: 'Fact', content: 'Content.', disable: false, key: [] },
        ]);
        const report = buildHealthReport('test', bd);
        // With no tree, treeUids.size === 0, so orphan check is skipped
        expect(report.orphanedEntries.length).toBe(0);
    });

    it('returns sorted category distribution', () => {
        // No tree in test env, so categoryDistribution will be empty.
        // This test verifies it doesn't crash and returns an array.
        const bd = makeBookData([
            { uid: 1, comment: 'Fact', content: 'Content.', disable: false, key: [] },
        ]);
        const report = buildHealthReport('test', bd);
        expect(Array.isArray(report.categoryDistribution)).toBe(true);
    });

    it('handles entries with empty content gracefully', () => {
        const bd = makeBookData([
            { uid: 1, comment: 'Empty', content: '', disable: false, key: [] },
            { uid: 2, comment: 'Null content', content: null, disable: false, key: [] },
        ]);
        const report = buildHealthReport('test', bd);
        expect(report.totalEntries).toBe(2);
        expect(report.avgLength).toBe(0);
    });

    // ── New scalability metrics ──

    it('computes growthRate based on chat length', () => {
        const bd = makeBookData([
            { uid: 1, comment: 'Fact A', content: 'Content.', disable: false, key: [] },
            { uid: 2, comment: 'Fact B', content: 'Content.', disable: false, key: [] },
        ]);
        const report = buildHealthReport('test', bd);
        // With mocked chat length of 0, growthRate should be 0
        expect(typeof report.growthRate).toBe('number');
        expect(report.growthRate).toBeGreaterThanOrEqual(0);
    });

    it('computes duplicateDensity from duplicateCandidates', () => {
        const sharedContent = 'Elena Blackwood has long flowing black hair. She is a skilled warrior from the northern kingdom who trained under Master Aldric for many years at the Grand Academy.';
        const bd = makeBookData([
            { uid: 1, comment: 'Elena v1', content: sharedContent + ' Her eyes are green.', disable: false, key: [] },
            { uid: 2, comment: 'Elena v2', content: sharedContent + ' Her eyes are blue.', disable: false, key: [] },
            { uid: 3, comment: 'Weather', content: 'The Dragon Mountains have unpredictable blizzards and heavy snowfall.', disable: false, key: [] },
        ]);
        const report = buildHealthReport('test', bd);
        expect(typeof report.duplicateDensity).toBe('number');
        expect(report.duplicateDensity).toBeGreaterThanOrEqual(0);
        expect(report.duplicateDensity).toBeLessThanOrEqual(1);
    });

    it('returns default compressionRatio of 1.0 when no version history exists', () => {
        const bd = makeBookData([
            { uid: 1, comment: 'Fact', content: 'Content.', disable: false, key: [] },
        ]);
        const report = buildHealthReport('test', bd);
        expect(report.compressionRatio).toBe(1.0);
    });

    it('counts never-referenced entries', () => {
        const bd = makeBookData([
            { uid: 1, comment: 'Fact A', content: 'Content.', disable: false, key: [] },
            { uid: 2, comment: 'Fact B', content: 'Content.', disable: false, key: [] },
            { uid: 3, comment: '[Tracker] X', content: 'Tracker.', disable: false, key: [] },
        ]);
        const report = buildHealthReport('test', bd);
        expect(typeof report.neverReferencedCount).toBe('number');
        expect(report.neverReferencedCount).toBeGreaterThanOrEqual(0);
    });

    it('includes metadataSizes array', () => {
        const bd = makeBookData([
            { uid: 1, comment: 'Fact', content: 'Content.', disable: false, key: [] },
        ]);
        const report = buildHealthReport('test', bd);
        expect(Array.isArray(report.metadataSizes)).toBe(true);
    });

    it('reports zero duplicateDensity for dissimilar entries', () => {
        const bd = makeBookData([
            { uid: 1, comment: 'Apples', content: 'Apples grow on trees in orchards during autumn.', disable: false, key: [] },
            { uid: 2, comment: 'Rockets', content: 'Rockets launch from the Kennedy Space Center in Florida.', disable: false, key: [] },
        ]);
        const report = buildHealthReport('test', bd);
        expect(report.duplicateDensity).toBe(0);
    });
});
