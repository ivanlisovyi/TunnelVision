import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared mock metadata store — tests can manipulate this directly
const mockMetadata = {};
const mockChat = [];

// Mock internal dependencies with complex transitive imports
vi.mock('../tool-registry.js', () => ({
    getActiveTunnelVisionBooks: vi.fn(() => []),
}));
vi.mock('../entry-manager.js', () => ({
    getCachedWorldInfoSync: vi.fn(() => null),
    getCachedWorldInfo: vi.fn(async () => null),
}));
vi.mock('../world-state.js', () => ({
    getWorldStateSections: vi.fn(() => ({})),
}));
vi.mock('../arc-tracker.js', () => ({
    getActiveArcs: vi.fn(() => []),
}));
// Override the st-context mock for this file so we can control chatMetadata
vi.mock('../../../st-context.js', () => ({
    getContext: () => ({
        chatId: 'test-chat',
        chat: mockChat,
        chatMetadata: mockMetadata,
        saveMetadataDebounced: vi.fn(),
    }),
}));

import { scoreEntry, getFeedbackMap, processRelevanceFeedback, invalidatePreWarmCache, computeEntryTier, TIER_HOT, TIER_WARM, TIER_COLD } from '../smart-context.js';

beforeEach(() => {
    // Reset state between tests
    for (const key of Object.keys(mockMetadata)) delete mockMetadata[key];
    mockChat.length = 0;
});

// ── scoreEntry ───────────────────────────────────────────────────

describe('scoreEntry', () => {
    it('returns 0 for empty recentText', () => {
        const entry = { comment: 'Elena', key: ['elena', 'hair'] };
        expect(scoreEntry(entry, '')).toBe(0);
    });

    it('returns 0 for null recentText', () => {
        const entry = { comment: 'Elena', key: ['elena'] };
        expect(scoreEntry(entry, null)).toBe(0);
    });

    it('scores +10 when entry title appears in recentText', () => {
        const entry = { comment: 'Elena', key: [] };
        expect(scoreEntry(entry, 'elena went to the market')).toBe(10);
    });

    it('scores +3 per matching key', () => {
        const entry = { comment: '', key: ['sword', 'shield'] };
        expect(scoreEntry(entry, 'she drew her sword and shield')).toBe(6);
    });

    it('combines title and key scores', () => {
        const entry = { comment: 'Elena', key: ['elena', 'magic'] };
        expect(scoreEntry(entry, 'elena used magic')).toBe(16);
    });

    it('ignores keys shorter than 2 characters', () => {
        const entry = { comment: '', key: ['a', 'x', 'bow'] };
        expect(scoreEntry(entry, 'a x bow and arrow')).toBe(3);
    });

    it('returns 0 when nothing matches', () => {
        const entry = { comment: 'Elena', key: ['sword'] };
        expect(scoreEntry(entry, 'the weather was nice')).toBe(0);
    });

    it('handles entry with no comment and no keys', () => {
        const entry = { comment: '', key: [] };
        expect(scoreEntry(entry, 'anything at all')).toBe(0);
    });

    it('handles entry with missing key array', () => {
        const entry = { comment: 'test' };
        expect(scoreEntry(entry, 'test entry')).toBe(10);
    });

    // ── 1A: Semantic key expansion (derived alias keys) ──

    it('gives +2 for a proper noun phrase derived from content first sentence', () => {
        const entry = {
            comment: 'Elena',
            key: [],
            uid: 1,
            content: 'Elena trained at the Grand Cathedral under Master Aldric.',
        };
        // "grand cathedral" is a proper noun phrase derived from the first sentence
        expect(scoreEntry(entry, 'they arrived at the grand cathedral')).toBeGreaterThanOrEqual(2);
    });

    it('gives +2 for a role descriptor derived from content first sentence', () => {
        const entry = {
            comment: 'Kael',
            key: [],
            uid: 2,
            content: 'Kael is a wandering merchant who travels between villages.',
        };
        // "wandering merchant" is a role descriptor ("a wandering merchant who...")
        expect(scoreEntry(entry, 'a wandering merchant appeared at the gate')).toBeGreaterThanOrEqual(2);
    });

    it('gives +2 for a capitalized word derived from content (not first word)', () => {
        const entry = {
            comment: '',
            key: [],
            uid: 3,
            content: 'The artifact was forged by Aldric in the old forge.',
        };
        // "aldric" is a capitalized word in the first sentence (not the first word)
        expect(scoreEntry(entry, 'aldric appeared from nowhere')).toBeGreaterThanOrEqual(2);
    });

    it('stacks derived alias score with title and key scores', () => {
        const entry = {
            comment: 'Elena',
            key: ['magic'],
            uid: 4,
            content: 'Elena is a powerful sorceress who commands fire.',
        };
        // title "elena" => +10, key "magic" => +3, derived "powerful sorceress" => +2
        const score = scoreEntry(entry, 'elena used magic, the powerful sorceress');
        expect(score).toBeGreaterThanOrEqual(15);
    });

    it('does not derive keys from entries with empty content', () => {
        const entry = { comment: '', key: [], uid: 5, content: '' };
        expect(scoreEntry(entry, 'anything at all')).toBe(0);
    });

    it('derives multiple alias keys from a rich first sentence', () => {
        const entry = {
            comment: '',
            key: [],
            uid: 6,
            content: 'Lord Varen is a reclusive nobleman who rules over Stonereach Keep.',
        };
        // Should derive "lord varen" (proper noun phrase), "varen" (capitalized), "stonereach keep" (proper noun phrase)
        // and "reclusive nobleman" (role descriptor)
        const score1 = scoreEntry(entry, 'lord varen was displeased');
        const score2 = scoreEntry(entry, 'the reclusive nobleman retreated');
        expect(score1).toBeGreaterThanOrEqual(2);
        expect(score2).toBeGreaterThanOrEqual(2);
    });

    it('does not give alias bonus for short derived keys under 3 chars', () => {
        const entry = {
            comment: '',
            key: [],
            uid: 7,
            content: 'A. B. Smith is an old man who lives nearby.',
        };
        // Single-letter words should not be derived as alias keys
        expect(scoreEntry(entry, 'a b')).toBe(0);
    });

    it('caches derived keys across calls (second call uses cache)', () => {
        const entry = {
            comment: '',
            key: [],
            uid: 8,
            content: 'Captain Thorne patrols the northern border.',
        };
        const score1 = scoreEntry(entry, 'thorne was spotted');
        const score2 = scoreEntry(entry, 'thorne returned');
        expect(score1).toBe(score2);
        expect(score1).toBeGreaterThanOrEqual(2);
    });

    // ── presentKeySet fast path (2D perf optimization) ──

    it('produces same score with presentKeySet as without for title match', () => {
        const entry = { comment: 'Elena', key: [], uid: 20 };
        const text = 'elena went to the market';
        const keySet = new Set(['elena']);
        expect(scoreEntry(entry, text, keySet)).toBe(scoreEntry(entry, text));
    });

    it('produces same score with presentKeySet as without for key matches', () => {
        const entry = { comment: '', key: ['sword', 'shield'], uid: 21 };
        const text = 'she drew her sword and shield';
        const keySet = new Set(['sword', 'shield']);
        expect(scoreEntry(entry, text, keySet)).toBe(scoreEntry(entry, text));
    });

    it('produces same combined score with presentKeySet as without', () => {
        const entry = { comment: 'Elena', key: ['elena', 'magic'], uid: 22 };
        const text = 'elena used magic';
        const keySet = new Set(['elena', 'magic']);
        expect(scoreEntry(entry, text, keySet)).toBe(scoreEntry(entry, text));
    });

    it('returns 0 via presentKeySet when keys are absent from the set', () => {
        const entry = { comment: 'Elena', key: ['sword'], uid: 23 };
        const emptySet = new Set();
        expect(scoreEntry(entry, 'elena used a sword', emptySet)).toBe(0);
    });

    it('scores partial matches correctly via presentKeySet', () => {
        const entry = { comment: 'Elena', key: ['sword', 'shield'], uid: 24 };
        const keySet = new Set(['elena', 'sword']);
        // title match (+10) + sword (+3) but not shield
        expect(scoreEntry(entry, 'elena sword shield', keySet)).toBe(13);
    });

    it('handles presentKeySet with derived alias keys', () => {
        const entry = {
            comment: '',
            key: [],
            uid: 25,
            content: 'Lord Varen is a reclusive nobleman who rules over Stonereach.',
        };
        const text = 'lord varen sent a message';
        const withoutSet = scoreEntry(entry, text);
        // Build a set that includes the derived key
        const keySet = new Set(['lord varen']);
        const withSet = scoreEntry(entry, text, keySet);
        // Both should detect "lord varen" as a derived proper noun phrase
        expect(withoutSet).toBeGreaterThanOrEqual(2);
        expect(withSet).toBeGreaterThanOrEqual(2);
    });
});

// ── getFeedbackMap ───────────────────────────────────────────────

describe('getFeedbackMap', () => {
    it('returns empty object when no feedback exists', () => {
        expect(getFeedbackMap()).toEqual({});
    });

    it('returns stored feedback data', () => {
        mockMetadata.tunnelvision_feedback = { '42': { injections: 3, references: 1, missStreak: 0, lastReferenced: 100 } };
        const map = getFeedbackMap();
        expect(map['42'].injections).toBe(3);
        expect(map['42'].references).toBe(1);
    });
});

// ── processRelevanceFeedback ─────────────────────────────────────

describe('processRelevanceFeedback', () => {
    it('does nothing when _lastInjectedEntries is empty (no prior injection)', () => {
        mockChat.push({ is_user: true, mes: 'Hello' });
        mockChat.push({ is_user: false, mes: 'Hi there' });

        processRelevanceFeedback();
        expect(getFeedbackMap()).toEqual({});
    });
});

// ── computeEntryTier ─────────────────────────────────────────────

describe('computeEntryTier', () => {
    const baseOpts = {
        isTracker: false,
        isSummary: false,
        feedbackMap: {},
        relevanceMap: {},
        chatLength: 200,
        maxUid: 1000,
        arcOverlap: 0,
    };

    it('classifies trackers as hot', () => {
        const entry = { uid: 500 };
        expect(computeEntryTier(entry, { ...baseOpts, isTracker: true })).toBe(TIER_HOT);
    });

    it('classifies recently referenced entries as hot', () => {
        const entry = { uid: 500 };
        const opts = {
            ...baseOpts,
            feedbackMap: { 500: { lastReferenced: Date.now() - 30 * 60 * 1000, injections: 1, references: 1 } },
        };
        expect(computeEntryTier(entry, opts)).toBe(TIER_HOT);
    });

    it('classifies arc-overlapping recently seen entries as hot', () => {
        const entry = { uid: 500 };
        const opts = {
            ...baseOpts,
            relevanceMap: { 500: Date.now() - 3 * 60 * 60 * 1000 },
            arcOverlap: 4,
        };
        expect(computeEntryTier(entry, opts)).toBe(TIER_HOT);
    });

    it('classifies recently created entries as warm', () => {
        const entry = { uid: 950 };
        expect(computeEntryTier(entry, baseOpts)).toBe(TIER_WARM);
    });

    it('classifies entries with recent feedback as warm', () => {
        const entry = { uid: 100 };
        const opts = {
            ...baseOpts,
            feedbackMap: { 100: { lastReferenced: Date.now() - 6 * 60 * 60 * 1000, injections: 5, references: 3 } },
        };
        expect(computeEntryTier(entry, opts)).toBe(TIER_WARM);
    });

    it('classifies old entries with no engagement as cold', () => {
        const entry = { uid: 50 };
        expect(computeEntryTier(entry, baseOpts)).toBe(TIER_COLD);
    });

    it('classifies old entries with poor reference rate as cold', () => {
        const entry = { uid: 50 };
        const opts = {
            ...baseOpts,
            feedbackMap: { 50: { lastReferenced: Date.now() - 48 * 60 * 60 * 1000, injections: 10, references: 1 } },
        };
        expect(computeEntryTier(entry, opts)).toBe(TIER_COLD);
    });
});

// ── invalidatePreWarmCache ───────────────────────────────────────

describe('invalidatePreWarmCache', () => {
    it('is callable and does not throw', () => {
        expect(() => invalidatePreWarmCache()).not.toThrow();
    });

    it('can be called multiple times without error', () => {
        invalidatePreWarmCache();
        invalidatePreWarmCache();
        invalidatePreWarmCache();
    });
});
