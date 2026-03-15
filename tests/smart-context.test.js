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
// Override the st-context mock for this file so we can control chatMetadata
vi.mock('../../../st-context.js', () => ({
    getContext: () => ({
        chatId: 'test-chat',
        chat: mockChat,
        chatMetadata: mockMetadata,
        saveMetadataDebounced: vi.fn(),
    }),
}));

import { scoreEntry, getFeedbackMap, processRelevanceFeedback, invalidatePreWarmCache } from '../smart-context.js';

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
