import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = {
    calls: [],
    worldStateRepairResult: true,
    postTurnRepairResult: true,
    explicitPostTurnRepairResult: true,
    clearRollbackResult: true,
    rebuildWorldStateResult: true,
    discardWorldStateHistoryResult: true,
};

vi.mock('../tool-registry.js', () => ({
    registerTools: vi.fn(async () => {
        mockState.calls.push('rebuild-tool-registration');
    }),
}));

vi.mock('../prompt-injection-service.js', () => ({
    prepareAndInjectGenerationPrompts: vi.fn(async () => {
        mockState.calls.push('rebuild-prompt-plan');
    }),
}));

vi.mock('../post-turn-processor.js', () => ({
    resetPostTurnEphemeralState: vi.fn(() => {
        mockState.calls.push('reset-postturn-ephemeral-state');
        return mockState.postTurnRepairResult;
    }),
    rebuildPostTurnMetadata: vi.fn(() => {
        mockState.calls.push('rebuild-postturn-metadata');
        return mockState.explicitPostTurnRepairResult;
    }),
    clearPostTurnRollback: vi.fn(() => {
        mockState.calls.push('clear-postturn-rollback');
        return mockState.clearRollbackResult;
    }),
}));

vi.mock('../smart-context.js', () => ({
    invalidatePreWarmCache: vi.fn(() => {
        mockState.calls.push('reset-smart-context-cache');
    }),
}));

vi.mock('../world-state.js', () => ({
    repairWorldStateSections: vi.fn(() => {
        mockState.calls.push('reparse-world-state-sections');
        return mockState.worldStateRepairResult;
    }),
    rebuildWorldStateMetadata: vi.fn(() => {
        mockState.calls.push('rebuild-world-state-metadata');
        return mockState.rebuildWorldStateResult;
    }),
    discardInvalidWorldStateHistory: vi.fn(() => {
        mockState.calls.push('discard-invalid-world-state-history');
        return mockState.discardWorldStateHistoryResult;
    }),
}));

vi.mock('../entry-manager.js', () => ({
    invalidateDirtyWorldInfoCache: vi.fn(() => {
        mockState.calls.push('invalidate-dirty-worldinfo-cache');
    }),
    invalidateWorldInfoCache: vi.fn(() => {
        mockState.calls.push('reset-entry-manager-cache');
    }),
}));

vi.mock('../background-events.js', () => ({
    addBackgroundEvent: vi.fn((payload) => {
        mockState.calls.push(`feed:${payload.verb}:${payload.summary}`);
    }),
}));

import { executeSafeRuntimeAuditRepairs, executeRuntimeRepairAction } from '../runtime-repairs.js';

function makeAudit(group, safeRepairs) {
    return {
        group,
        safeRepairs,
    };
}

describe('executeSafeRuntimeAuditRepairs', () => {
    beforeEach(() => {
        mockState.calls = [];
        mockState.worldStateRepairResult = true;
        mockState.postTurnRepairResult = true;
        mockState.explicitPostTurnRepairResult = true;
        mockState.clearRollbackResult = true;
        mockState.rebuildWorldStateResult = true;
        mockState.discardWorldStateHistoryResult = true;
        vi.clearAllMocks();
    });

    it('runs safe repairs in stable priority order and deduplicates repeated repair ids', async () => {
        const result = await executeSafeRuntimeAuditRepairs([
            makeAudit('smart-context-integrity', [
                { id: 'reset-smart-context-cache', label: 'Reset smart-context cache' },
                { id: 'rebuild-prompt-plan', label: 'Rebuild prompt plan' },
            ]),
            makeAudit('registration-integrity', [
                { id: 'rebuild-tool-registration', label: 'Rebuild tool registration' },
                { id: 'rebuild-prompt-plan', label: 'Rebuild prompt plan' },
            ]),
            makeAudit('metadata-integrity', [
                { id: 'reset-entry-manager-cache', label: 'Reset entry manager cache' },
                { id: 'invalidate-dirty-worldinfo-cache', label: 'Invalidate dirty cache' },
            ]),
        ]);

        expect(mockState.calls).toEqual([
            'invalidate-dirty-worldinfo-cache',
            'feed:Repaired:Invalidate dirty cache',
            'reset-entry-manager-cache',
            'feed:Repaired:Reset entry manager cache',
            'reset-smart-context-cache',
            'feed:Repaired:Reset smart-context cache',
            'rebuild-tool-registration',
            'feed:Repaired:Rebuild tool registration',
            'rebuild-prompt-plan',
            'feed:Repaired:Rebuild prompt plan',
        ]);
        expect(result).toEqual({
            attempted: 5,
            applied: [
                { id: 'invalidate-dirty-worldinfo-cache', label: 'Invalidate dirty cache', groups: ['metadata-integrity'], context: null },
                { id: 'reset-entry-manager-cache', label: 'Reset entry manager cache', groups: ['metadata-integrity'], context: null },
                { id: 'reset-smart-context-cache', label: 'Reset smart-context cache', groups: ['smart-context-integrity'], context: null },
                { id: 'rebuild-tool-registration', label: 'Rebuild tool registration', groups: ['registration-integrity'], context: null },
                { id: 'rebuild-prompt-plan', label: 'Rebuild prompt plan', groups: ['smart-context-integrity', 'registration-integrity'], context: null },
            ],
            failed: [],
        });
    });

    it('does not report repairs as applied when a handler explicitly returns false', async () => {
        mockState.worldStateRepairResult = false;

        const result = await executeSafeRuntimeAuditRepairs([
            makeAudit('world-state-integrity', [
                { id: 'reparse-world-state-sections', label: 'Reparse world state sections' },
            ]),
        ]);

        expect(mockState.calls).toEqual(['reparse-world-state-sections']);
        expect(result).toEqual({
            attempted: 1,
            applied: [],
            failed: [],
        });
    });

    it('executes explicit confirmation repairs through the shared repair executor and logs them', async () => {
        const result = await executeRuntimeRepairAction({
            id: 'rebuild-world-state-metadata',
            label: 'Rebuild persisted world-state metadata',
        }, {
            origin: 'diagnostics-ui:confirmed',
            groups: ['world-state-integrity'],
        });

        expect(mockState.calls).toEqual([
            'rebuild-world-state-metadata',
            'feed:Repaired:Rebuild persisted world-state metadata',
        ]);
        expect(result).toEqual({
            status: 'applied',
            repair: {
                id: 'rebuild-world-state-metadata',
                label: 'Rebuild persisted world-state metadata',
                groups: ['world-state-integrity'],
                context: null,
            },
            error: null,
        });
    });
});
