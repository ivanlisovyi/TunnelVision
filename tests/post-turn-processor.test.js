import { describe, it, expect, vi } from 'vitest';

// Mock transitive dependencies
vi.mock('../tree-store.js', () => ({
    getSettings: vi.fn(() => ({})),
    getTrackerUids: vi.fn(() => new Map()),
    isTrackerTitle: vi.fn((t) => t?.startsWith('[Tracker]')),
    isSummaryTitle: vi.fn((t) => t?.includes('[Summary]') || t?.includes('[Scene Summary]')),
}));
vi.mock('../tool-registry.js', () => ({
    getActiveTunnelVisionBooks: vi.fn(() => []),
    resolveTargetBook: vi.fn(() => 'test'),
}));
vi.mock('../entry-manager.js', () => ({
    createEntry: vi.fn(),
    updateEntry: vi.fn(),
    forgetEntry: vi.fn(),
    getCachedWorldInfo: vi.fn(),
    buildUidMap: vi.fn(() => new Map()),
    parseJsonFromLLM: vi.fn(() => []),
    recordEntryTemporal: vi.fn(),
    KEYWORD_RULES: 'KEYWORD RULES (test stub)',
}));
vi.mock('../auto-summary.js', () => ({
    markAutoSummaryComplete: vi.fn(),
}));
vi.mock('../tools/summarize.js', () => ({
    getWatermark: vi.fn(() => 0),
    setWatermark: vi.fn(),
    hideSummarizedMessages: vi.fn(),
}));
vi.mock('../agent-utils.js', () => ({
    getChatId: vi.fn(() => 'test-chat'),
    formatChatExcerpt: vi.fn(() => ''),
    trigramSimilarity: vi.fn(() => 0),
    trigrams: vi.fn(() => new Set()),
    callWithRetry: vi.fn(),
    generateAnalytical: vi.fn(),
    getStoryContext: vi.fn(() => ''),
}));
vi.mock('../background-events.js', () => ({
    addBackgroundEvent: vi.fn(),
    registerBackgroundTask: vi.fn(() => ({ cancelled: false, end: vi.fn(), fail: vi.fn() })),
    getTrackerSuggestionNames: vi.fn(() => []),
}));
vi.mock('../world-state.js', () => ({
    requestPriorityUpdate: vi.fn(),
    getWorldStateText: vi.fn(() => ''),
}));
vi.mock('../arc-tracker.js', () => ({
    processArcUpdates: vi.fn(() => ({ created: 0, updated: 0, resolved: 0 })),
    buildArcsContextBlock: vi.fn(() => ''),
}));
vi.mock('../smart-context.js', () => ({
    getFeedbackMap: vi.fn(() => ({})),
}));

import { contentHash, computeChangeFraction } from '../post-turn-processor.js';

// ── contentHash ─────────────────────────────────────────────────

describe('contentHash', () => {
    it('returns a number', () => {
        expect(typeof contentHash('hello world')).toBe('number');
    });

    it('returns the same hash for identical strings', () => {
        expect(contentHash('test string')).toBe(contentHash('test string'));
    });

    it('returns different hashes for different strings', () => {
        expect(contentHash('hello')).not.toBe(contentHash('world'));
    });

    it('handles empty string', () => {
        expect(contentHash('')).toBe(0);
    });

    it('handles long strings', () => {
        const long = 'a'.repeat(10000);
        expect(typeof contentHash(long)).toBe('number');
    });

    it('is sensitive to small changes', () => {
        expect(contentHash('Location: forest')).not.toBe(contentHash('Location: camp'));
    });
});

// ── computeChangeFraction ───────────────────────────────────────

describe('computeChangeFraction', () => {
    it('returns 0 for identical texts', () => {
        const text = 'Mood: happy\nLocation: camp\nHealth: good';
        expect(computeChangeFraction(text, text)).toBe(0);
    });

    it('returns 1 for completely different texts', () => {
        const old = 'Line A\nLine B\nLine C';
        const now = 'Line X\nLine Y\nLine Z';
        expect(computeChangeFraction(old, now)).toBe(1);
    });

    it('returns 0 for both empty', () => {
        expect(computeChangeFraction('', '')).toBe(0);
    });

    it('returns 1 when old is empty and new has content', () => {
        expect(computeChangeFraction('', 'some\ncontent')).toBe(1);
    });

    it('returns 1 when new is empty and old has content', () => {
        expect(computeChangeFraction('some\ncontent', '')).toBe(1);
    });

    it('returns a low fraction for a single-line change in a multi-line tracker', () => {
        const old = 'Name: Elena\nMood: happy\nLocation: forest\nHealth: good\nInventory: sword, shield';
        const now = 'Name: Elena\nMood: sad\nLocation: forest\nHealth: good\nInventory: sword, shield';
        const fraction = computeChangeFraction(old, now);
        expect(fraction).toBeGreaterThan(0);
        expect(fraction).toBeLessThan(0.3);
    });

    it('returns a high fraction when most lines change', () => {
        const old = 'Name: Elena\nMood: happy\nLocation: forest\nHealth: good';
        const now = 'Name: John\nMood: angry\nLocation: cave\nHealth: injured';
        const fraction = computeChangeFraction(old, now);
        expect(fraction).toBeGreaterThan(0.6);
    });

    it('handles added lines', () => {
        const old = 'Line A\nLine B';
        const now = 'Line A\nLine B\nLine C\nLine D';
        const fraction = computeChangeFraction(old, now);
        expect(fraction).toBeGreaterThan(0);
        expect(fraction).toBeLessThan(1);
    });

    it('handles removed lines', () => {
        const old = 'Line A\nLine B\nLine C\nLine D';
        const now = 'Line A\nLine B';
        const fraction = computeChangeFraction(old, now);
        expect(fraction).toBeGreaterThan(0);
        expect(fraction).toBeLessThan(1);
    });

    it('ignores leading/trailing whitespace on lines', () => {
        const old = '  Mood: happy  \n  Location: camp  ';
        const now = 'Mood: happy\nLocation: camp';
        expect(computeChangeFraction(old, now)).toBe(0);
    });

    it('result is between 0 and 1 inclusive', () => {
        const cases = [
            ['a', 'b'],
            ['a\nb', 'a\nc'],
            ['x\ny\nz', 'x'],
            ['', 'new'],
        ];
        for (const [a, b] of cases) {
            const f = computeChangeFraction(a, b);
            expect(f).toBeGreaterThanOrEqual(0);
            expect(f).toBeLessThanOrEqual(1);
        }
    });
});
