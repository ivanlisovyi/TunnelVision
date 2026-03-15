import { describe, it, expect, vi } from 'vitest';

// Mock internal dependencies with complex transitive imports
vi.mock('../tool-registry.js', () => ({
    getActiveTunnelVisionBooks: vi.fn(() => []),
}));
vi.mock('../entry-manager.js', () => ({
    getCachedWorldInfoSync: vi.fn(() => null),
}));
vi.mock('../world-state.js', () => ({
    getWorldStateSections: vi.fn(() => ({})),
}));

import { scoreEntry } from '../smart-context.js';

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
