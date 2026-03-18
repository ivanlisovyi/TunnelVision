import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = {
    context: {
        chatMetadata: {},
        chat: [],
        saveMetadataDebounced: vi.fn(),
    },
};

vi.mock('../../../st-context.js', () => ({
    getContext: vi.fn(() => mockState.context),
}));

vi.mock('../../../../script.js', () => ({
    eventSource: { on: vi.fn() },
    event_types: {},
    generateQuietPrompt: vi.fn(),
}));

vi.mock('../constants.js', () => ({
    MAX_EXCERPT_CHARS: 3000,
}));

vi.mock('../tree-store.js', () => ({
    getSettings: vi.fn(() => ({ worldStateEnabled: true, globalEnabled: true })),
    isSummaryTitle: vi.fn(() => false),
    isTrackerTitle: vi.fn(() => false),
}));

vi.mock('../tool-registry.js', () => ({
    getActiveTunnelVisionBooks: vi.fn(() => []),
}));

vi.mock('../entry-manager.js', () => ({
    getCachedWorldInfo: vi.fn(async () => null),
}));

vi.mock('../agent-utils.js', () => ({
    getChatId: vi.fn(() => 'test-chat'),
    formatChatExcerpt: vi.fn(() => ''),
    callWithRetry: vi.fn(),
}));

vi.mock('../background-events.js', () => ({
    addBackgroundEvent: vi.fn(),
    registerBackgroundTask: vi.fn(() => ({ cancelled: false, _ended: false, end: vi.fn(), fail: vi.fn() })),
}));

vi.mock('../arc-tracker.js', () => ({
    buildArcsSummary: vi.fn(() => ''),
}));

vi.mock('../world-info-attribution.js', () => ({
    withWorldInfoAttribution: vi.fn(async (_source, operation) => await operation()),
}));

import { getWorldStateTemporalSnapshot, auditWorldStateRuntime, getWorldStateRuntimeSnapshot } from '../world-state.js';

describe('getWorldStateTemporalSnapshot', () => {
    beforeEach(() => {
        mockState.context = {
            chatMetadata: {},
            chat: [],
            saveMetadataDebounced: vi.fn(),
        };
    });

    it('extracts normalized day/date/time/location from Current Scene sections', () => {
        mockState.context.chatMetadata.tunnelvision_worldstate = {
            sections: {
                'Current Scene': [
                    '## Current Scene',
                    'Day: 6',
                    'Date: Sunday 16 March 2025',
                    'Time: around 13:10-13:20',
                    'Location: Germany > Berlin > Cafe',
                ].join('\n'),
            },
        };

        expect(getWorldStateTemporalSnapshot()).toEqual({
            day: 'Day 6',
            date: 'Sunday 16 March 2025',
            time: 'around 13:10-13:20',
            location: 'Germany > Berlin > Cafe',
        });
    });

    it('returns null when no temporal fields are available', () => {
        mockState.context.chatMetadata.tunnelvision_worldstate = {
            sections: {
                'Current Scene': '## Current Scene\nPresent: Elena\nSituation: Talking.',
            },
        };

        expect(getWorldStateTemporalSnapshot()).toBeNull();
    });
});

describe('getWorldStateRuntimeSnapshot', () => {
    beforeEach(() => {
        mockState.context = {
            chatMetadata: {},
            chat: [],
            saveMetadataDebounced: vi.fn(),
        };
    });

    it('returns a structured runtime snapshot for the current world-state module state', () => {
        mockState.context.chatMetadata.tunnelvision_worldstate = {
            lastUpdated: 123456789,
            lastUpdateMsgIdx: 7,
            epoch: 2,
            sectionsEpoch: 2,
            text: [
                '## Current Scene',
                'Day: 6',
                'Date: Sunday 16 March 2025',
                'Time: around 13:10-13:20',
                'Location: Germany > Berlin > Cafe',
                '',
                '## Recent Changes',
                'Elena arrived at the cafe after the cathedral meeting.',
                '',
                '## Off-Screen',
                'Rain gathers over the city.',
                '',
                '## Pending',
                'Elena must decide whether to trust Darius.',
                '',
                '## Active Threads',
                'The cathedral archives remain contested.',
            ].join('\n'),
            sections: {
                'Current Scene': [
                    '## Current Scene',
                    'Day: 6',
                    'Date: Sunday 16 March 2025',
                    'Time: around 13:10-13:20',
                    'Location: Germany > Berlin > Cafe',
                ].join('\n'),
                'Recent Changes': [
                    '## Recent Changes',
                    'Elena arrived at the cafe after the cathedral meeting.',
                ].join('\n'),
                'Off-Screen': [
                    '## Off-Screen',
                    'Rain gathers over the city.',
                ].join('\n'),
                'Pending': [
                    '## Pending',
                    'Elena must decide whether to trust Darius.',
                ].join('\n'),
                'Active Threads': [
                    '## Active Threads',
                    'The cathedral archives remain contested.',
                ].join('\n'),
            },
            previousText: '',
        };

        const snapshot = getWorldStateRuntimeSnapshot();

        expect(snapshot).toMatchObject({
            metadataKey: 'tunnelvision_worldstate',
            stateEpoch: 2,
            sectionsEpoch: 2,
            updateRunning: false,
            priorityRequested: false,
        });
        expect(snapshot.state).toMatchObject({
            lastUpdated: 123456789,
            lastUpdateMsgIdx: 7,
        });
        expect(snapshot.sections).toMatchObject({
            'Current Scene': expect.stringContaining('Day: 6'),
            'Active Threads': expect.stringContaining('The cathedral archives remain contested.'),
        });
        expect(snapshot.chatRef).toEqual({ lastChatLength: 0 });
    });
});

describe('auditWorldStateRuntime', () => {
    beforeEach(() => {
        mockState.context = {
            chatMetadata: {},
            chat: [],
            saveMetadataDebounced: vi.fn(),
        };
    });

    it('returns an info finding when world-state metadata is healthy', () => {
        mockState.context.chatMetadata.tunnelvision_worldstate = {
            lastUpdated: Date.now(),
            lastUpdateMsgIdx: 8,
            epoch: 4,
            sectionsEpoch: 4,
            text: [
                '## Current Scene',
                'Day: 6',
                'Date: Sunday 16 March 2025',
                'Time: around 13:10-13:20',
                'Location: Germany > Berlin > Cafe',
                '',
                '## Recent Changes',
                'Elena arrived at the cafe after the cathedral meeting.',
                '',
                '## Off-Screen',
                'Rain gathers over the city.',
                '',
                '## Pending',
                'Elena must decide whether to trust Darius.',
                '',
                '## Active Threads',
                'The cathedral archives remain contested.',
            ].join('\n'),
            sections: {
                'Current Scene': [
                    '## Current Scene',
                    'Day: 6',
                    'Date: Sunday 16 March 2025',
                    'Time: around 13:10-13:20',
                    'Location: Germany > Berlin > Cafe',
                ].join('\n'),
                'Recent Changes': [
                    '## Recent Changes',
                    'Elena arrived at the cafe after the cathedral meeting.',
                ].join('\n'),
                'Off-Screen': [
                    '## Off-Screen',
                    'Rain gathers over the city.',
                ].join('\n'),
                'Pending': [
                    '## Pending',
                    'Elena must decide whether to trust Darius.',
                ].join('\n'),
                'Active Threads': [
                    '## Active Threads',
                    'The cathedral archives remain contested.',
                ].join('\n'),
            },
            previousText: '',
        };

        const audit = auditWorldStateRuntime();

        expect(audit.group).toBe('world-state-integrity');
        expect(audit.ok).toBe(true);
        expect(audit.summary).toBe('World-state audit passed.');
        expect(audit.findings).toHaveLength(1);
        expect(audit.findings[0]).toMatchObject({
            id: 'worldstate-runtime-valid',
            severity: 'info',
            subsystem: 'world-state',
        });
        expect(audit.safeRepairs).toEqual([]);
        expect(audit.requiresConfirmation).toEqual([]);
    });

    it('reports malformed persisted metadata as an integrity error', () => {
        mockState.context.chatMetadata.tunnelvision_worldstate = 'broken-state';

        const audit = auditWorldStateRuntime();

        expect(audit.ok).toBe(false);
        expect(audit.summary).toBe('World-state audit found integrity issues.');
        expect(audit.findings.some(finding =>
            finding.id === 'worldstate-invalid-metadata'
            && finding.reasonCode === 'invalid_world_state_metadata'
            && finding.severity === 'error'
        )).toBe(true);
        expect(audit.requiresConfirmation).toEqual([
            expect.objectContaining({
                id: 'rebuild-world-state-metadata',
                repairClass: 'explicit',
            }),
        ]);
    });

    it('reports stale parsed sections when they no longer match persisted text', () => {
        mockState.context.chatMetadata.tunnelvision_worldstate = {
            lastUpdated: Date.now(),
            lastUpdateMsgIdx: 4,
            epoch: 3,
            sectionsEpoch: 1,
            text: [
                '## Current Scene',
                'Day: 7',
                'Location: Berlin',
                '',
                '## Recent Changes',
                'Elena left the archive.',
                '',
                '## Off-Screen',
                'The abbey bells continue to ring.',
                '',
                '## Pending',
                'A courier is expected by dusk.',
                '',
                '## Active Threads',
                'The archive dispute is escalating.',
            ].join('\n'),
            sections: {
                'Current Scene': '## Current Scene\nDay: 6\nLocation: Old Town',
            },
            previousText: '',
        };

        const audit = auditWorldStateRuntime();

        expect(audit.ok).toBe(true);
        expect(audit.summary).toBe('World-state audit found coordination issues.');
        expect(audit.findings.some(finding =>
            finding.id === 'worldstate-sections-stale'
            && finding.reasonCode === 'stale_world_state_output'
            && finding.severity === 'warn'
        )).toBe(true);
        expect(audit.findings.some(finding =>
            finding.id === 'worldstate-sections-epoch-stale'
            && finding.reasonCode === 'stale_world_state_output'
            && finding.severity === 'warn'
        )).toBe(true);
        expect(audit.safeRepairs).toEqual([
            expect.objectContaining({
                id: 'reparse-world-state-sections',
                repairClass: 'safe_auto',
            }),
        ]);
    });

    it('reports invalid previous world-state history as a warning', () => {
        mockState.context.chatMetadata.tunnelvision_worldstate = {
            lastUpdated: Date.now(),
            lastUpdateMsgIdx: 4,
            epoch: 5,
            sectionsEpoch: 5,
            text: [
                '## Current Scene',
                'Day: 7',
                'Date: Monday 17 March 2025',
                'Time: around 19:30',
                'Location: Germany > Berlin > Archive Annex',
                'Situation: Elena and Darius are waiting for the courier while reviewing what was taken from the sealed records room.',
                '',
                '## Recent Changes',
                'Elena left the main archive and relocated to the annex after confirming the sealed records were disturbed.',
                'Darius admitted someone else had access to the key earlier in the day, which changed their assumptions about the theft.',
                '',
                '## Off-Screen',
                'The abbey bells continue to ring while the courier crosses the city with the disputed inventory ledger.',
                '',
                '## Pending',
                'A courier is expected by dusk with a ledger that may identify who entered the archive before sunrise.',
                '',
                '## Active Threads',
                'The archive dispute is escalating as Elena tries to prove the theft was planned from inside the cathedral staff.',
            ].join('\n'),
            sections: {
                'Current Scene': '## Current Scene\nDay: 7\nLocation: Berlin',
                'Recent Changes': '## Recent Changes\nElena left the archive.',
                'Off-Screen': '## Off-Screen\nThe abbey bells continue to ring.',
                'Pending': '## Pending\nA courier is expected by dusk.',
            },
            previousText: 'too short',
        };

        const audit = auditWorldStateRuntime();

        expect(audit.summary).toBe('World-state audit found coordination issues.');
        expect(audit.findings.some(finding =>
            finding.id === 'worldstate-previous-text-invalid'
            && finding.reasonCode === 'stale_world_state_output'
            && finding.severity === 'warn'
        )).toBe(true);
        expect(audit.requiresConfirmation).toEqual([
            expect.objectContaining({
                id: 'discard-invalid-world-state-history',
                repairClass: 'explicit',
            }),
        ]);
    });
});