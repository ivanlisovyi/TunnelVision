import { describe, it, expect } from 'vitest';
import { findNodeById, isSummaryTitle, isTrackerTitle } from '../tree-store.js';

// ── isSummaryTitle ───────────────────────────────────────────────

describe('isSummaryTitle', () => {
    it('matches [Summary ...] titles', () => {
        expect(isSummaryTitle('[Summary of the battle]')).toBe(true);
    });

    it('matches [Scene Summary ...] titles', () => {
        expect(isSummaryTitle('[Scene Summary: The meeting]')).toBe(true);
    });

    it('is case-insensitive', () => {
        expect(isSummaryTitle('[SUMMARY something]')).toBe(true);
        expect(isSummaryTitle('[scene summary ...]')).toBe(true);
    });

    it('rejects non-summary titles', () => {
        expect(isSummaryTitle('Elena hair color')).toBe(false);
        expect(isSummaryTitle('[Tracker: Elena]')).toBe(false);
    });

    it('handles null, undefined, and empty string', () => {
        expect(isSummaryTitle(null)).toBe(false);
        expect(isSummaryTitle(undefined)).toBe(false);
        expect(isSummaryTitle('')).toBe(false);
    });
});

// ── isTrackerTitle ───────────────────────────────────────────────

describe('isTrackerTitle', () => {
    it('matches [Tracker: ...] titles', () => {
        expect(isTrackerTitle('[Tracker: Elena]')).toBe(true);
    });

    it('matches bare [Tracker]', () => {
        expect(isTrackerTitle('[Tracker]')).toBe(true);
    });

    it('is case-insensitive', () => {
        expect(isTrackerTitle('[TRACKER: Elena]')).toBe(true);
        expect(isTrackerTitle('[tracker: elena]')).toBe(true);
    });

    it('rejects non-tracker titles', () => {
        expect(isTrackerTitle('Elena personality')).toBe(false);
        expect(isTrackerTitle('[Summary of events]')).toBe(false);
    });

    it('handles null, undefined, and empty string', () => {
        expect(isTrackerTitle(null)).toBe(false);
        expect(isTrackerTitle(undefined)).toBe(false);
        expect(isTrackerTitle('')).toBe(false);
    });
});

// ── findNodeById ─────────────────────────────────────────────────

describe('findNodeById', () => {
    const tree = {
        id: 'root',
        label: 'Root',
        summary: '',
        entryUids: [],
        collapsed: false,
        children: [
            {
                id: 'child-1',
                label: 'Characters',
                summary: 'Character info',
                entryUids: [1, 2],
                collapsed: false,
                children: [
                    {
                        id: 'grandchild-1',
                        label: 'Elena',
                        summary: 'Elena details',
                        entryUids: [3],
                        collapsed: false,
                        children: [],
                    },
                ],
            },
            {
                id: 'child-2',
                label: 'Locations',
                summary: 'Location info',
                entryUids: [4, 5],
                collapsed: false,
                children: [],
            },
        ],
    };

    it('finds the root node', () => {
        expect(findNodeById(tree, 'root')).toBe(tree);
    });

    it('finds a direct child', () => {
        expect(findNodeById(tree, 'child-1')).toBe(tree.children[0]);
    });

    it('finds a deeply nested node', () => {
        expect(findNodeById(tree, 'grandchild-1')).toBe(tree.children[0].children[0]);
    });

    it('returns null for a non-existent id', () => {
        expect(findNodeById(tree, 'does-not-exist')).toBeNull();
    });

    it('returns null when tree is null', () => {
        expect(findNodeById(null, 'any')).toBeNull();
    });
});
