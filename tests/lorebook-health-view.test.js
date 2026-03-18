/* @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../feed-helpers.js', () => ({
    truncate: vi.fn((value) => value),
}));

const mockState = {
    report: null,
};

vi.mock('../entry-manager.js', () => ({
    getCachedWorldInfo: vi.fn(async () => ({ entries: { a: { uid: 1 } } })),
}));

vi.mock('../entry-scoring.js', () => ({
    buildHealthReport: vi.fn(() => mockState.report),
}));

import { buildLorebookHealthDashboard } from '../lorebook-health-view.js';

describe('lorebook-health-view', () => {
    beforeEach(() => {
        mockState.report = {
            totalEntries: 3,
            facts: 1,
            summaries: 1,
            trackers: 1,
            disabled: 0,
            categoryDistribution: [{ label: 'Characters', count: 3 }],
            staleEntries: [],
            orphanedEntries: [],
            noTimestamp: [],
            avgLength: 120,
            outlierEntries: [],
            duplicateCandidates: [],
            growthRate: 2,
            duplicateDensity: 0,
            compressionRatio: 1,
            neverReferencedCount: 0,
            metadataSizes: [],
        };
    });

    it('renders an empty-state section when no lorebooks are active', async () => {
        const dashboard = await buildLorebookHealthDashboard({ activeBooks: [] });
        expect(dashboard.textContent).toContain('No active lorebooks');
    });

    it('renders lorebook metrics and healthy state when the report has no issues', async () => {
        const dashboard = await buildLorebookHealthDashboard({ activeBooks: ['Book A'] });
        expect(dashboard.textContent).toContain('Lorebook Entry Breakdown');
        expect(dashboard.textContent).toContain('Scalability Metrics');
        expect(dashboard.textContent).toContain('Lorebook looks healthy!');
    });
});