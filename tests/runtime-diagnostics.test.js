import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = {
    audits: {
        registration: null,
        promptInjection: null,
        postTurn: null,
        smartContext: null,
        worldState: null,
        entryManager: null,
    },
    orchestrationSnapshot: null,
};

function makeAudit({
    group = 'runtime-integrity',
    ok = true,
    summary = 'Runtime audit passed.',
    findings = [{ severity: 'info', reasonCode: null }],
    reasonCodes = [],
    safeRepairs = [],
    requiresConfirmation = [],
    context = null,
} = {}) {
    return {
        group,
        ok,
        summary,
        findings,
        reasonCodes,
        safeRepairs,
        requiresConfirmation,
        context,
    };
}

vi.mock('../tool-registry.js', () => ({
    auditToolRegistrationRuntime: vi.fn(async () => mockState.audits.registration),
}));

vi.mock('../prompt-injection-service.js', () => ({
    auditPromptInjectionRuntime: vi.fn(async () => mockState.audits.promptInjection),
}));

vi.mock('../post-turn-processor.js', () => ({
    auditPostTurnProcessorRuntime: vi.fn(() => mockState.audits.postTurn),
}));

vi.mock('../smart-context.js', () => ({
    auditSmartContextRuntime: vi.fn(() => mockState.audits.smartContext),
}));

vi.mock('../world-state.js', () => ({
    auditWorldStateRuntime: vi.fn(() => mockState.audits.worldState),
}));

vi.mock('../entry-manager.js', () => ({
    auditEntryManagerRuntime: vi.fn(() => mockState.audits.entryManager),
}));

vi.mock('../runtime-orchestration.js', () => ({
    getOrchestrationRuntimeSnapshot: vi.fn(() => mockState.orchestrationSnapshot),
}));

vi.mock('../runtime-health.js', () => ({
    countRuntimeFindingsBySeverity: vi.fn((findings = []) => {
        const counts = { info: 0, warn: 0, error: 0 };
        for (const finding of findings) {
            const severity = finding?.severity || 'info';
            if (severity === 'error') counts.error += 1;
            else if (severity === 'warn') counts.warn += 1;
            else counts.info += 1;
        }
        return counts;
    }),
}));

import {
    collectRuntimeAudits,
    formatRuntimeAuditResult,
    runRuntimeAuditDiagnostics,
} from '../runtime-diagnostics.js';

function resetMockState() {
    mockState.audits = {
        registration: makeAudit({
            group: 'registration-integrity',
            summary: 'Tool registration audit passed.',
            context: {
                activeBooks: [],
                registrationEpoch: 0,
                lastAppliedRegistrationEpoch: 0,
                lastComputedRegistrationEpoch: 0,
            },
        }),
        promptInjection: makeAudit({
            group: 'prompt-injection-integrity',
            summary: 'Prompt injection audit passed.',
            context: {
                activeBooks: [],
                installedPlanEpoch: 0,
            },
        }),
        postTurn: makeAudit({
            group: 'post-turn-processor-integrity',
            summary: 'Post-turn processor audit passed.',
        }),
        smartContext: makeAudit({
            group: 'smart-context-integrity',
            summary: 'Smart-context audit passed.',
        }),
        worldState: makeAudit({
            group: 'world-state-integrity',
            summary: 'World-state audit passed.',
        }),
        entryManager: makeAudit({
            group: 'metadata-integrity',
            summary: 'Entry-manager audit passed.',
        }),
    };
    mockState.orchestrationSnapshot = {
        initialized: true,
        initStartedAt: 1000,
        initCompletedAt: 2000,
        lastEvent: 'generation-started',
        lastEventAt: 3000,
        pendingInvalidationReasons: [],
        pendingInvalidationCounts: {},
        lastSyncReason: 'app-ready',
        lastSyncAt: 2500,
        syncInFlight: false,
        syncCount: 1,
        pendingSyncReasons: [],
        pendingSyncCounts: {},
        pendingSyncEffects: {
            invalidateActiveBookCache: false,
            invalidateWorldInfoCache: false,
            invalidatePreWarmCache: false,
            refreshUI: false,
        },
        pendingSyncRequestedAt: 0,
        hasPendingSync: false,
        activeSyncPlan: null,
        lastSyncPlan: null,
        lastGenerationStartedAt: 3000,
        lastGenerationContext: {
            pendingInvalidationReasons: [],
            pendingInvalidationCounts: {},
            generationType: null,
            hasOptions: false,
            promptInjectionPrepared: true,
            isRecursiveToolPass: false,
            mandatoryToolsEnabled: false,
            globalEnabled: true,
            preflightCompleted: true,
            preflightSummary: {
                activeBooks: 0,
                expectedTools: 0,
                eligibleTools: 0,
                repairApplied: false,
                failureReasons: [],
            },
        },
    };
}

describe('formatRuntimeAuditResult', () => {
    beforeEach(() => {
        resetMockState();
        vi.clearAllMocks();
    });

    it('formats healthy audits as pass diagnostics', () => {
        const result = formatRuntimeAuditResult(makeAudit({
            group: 'registration-integrity',
            summary: 'Tool registration audit passed.',
            findings: [{ severity: 'info', reasonCode: null }],
        }));

        expect(result).toEqual({
            status: 'pass',
            message: 'Tool registration audit passed. Findings: 0 error(s), 0 warning(s), 1 info item(s).',
            fix: null,
        });
    });

    it('formats warning audits with reason summaries', () => {
        const result = formatRuntimeAuditResult(makeAudit({
            group: 'smart-context-integrity',
            ok: true,
            summary: 'Smart-context audit found stale cache state.',
            findings: [
                { severity: 'warn', reasonCode: 'stale_cache_epoch' },
                { severity: 'warn', reasonCode: 'derived_context_mismatch' },
            ],
            reasonCodes: ['stale_cache_epoch', 'derived_context_mismatch'],
        }));

        expect(result).toEqual({
            status: 'warn',
            message: 'Smart-context audit found stale cache state. Findings: 0 error(s), 2 warning(s), 0 info item(s). Reasons: stale_cache_epoch, derived_context_mismatch.',
            fix: null,
        });
    });

    it('formats error audits as failures', () => {
        const result = formatRuntimeAuditResult(makeAudit({
            group: 'world-state-integrity',
            ok: false,
            summary: 'World-state audit found integrity issues.',
            findings: [
                { severity: 'error', reasonCode: 'invalid_world_state_metadata' },
                { severity: 'warn', reasonCode: 'stale_world_state_output' },
            ],
            reasonCodes: ['invalid_world_state_metadata', 'stale_world_state_output'],
        }));

        expect(result).toEqual({
            status: 'fail',
            message: 'World-state audit found integrity issues. Findings: 1 error(s), 1 warning(s), 0 info item(s). Reasons: invalid_world_state_metadata, stale_world_state_output.',
            fix: null,
        });
    });

    it('fails when the audit result is missing or malformed', () => {
        expect(formatRuntimeAuditResult(null)).toEqual({
            status: 'fail',
            message: 'Runtime audit returned no structured result.',
            fix: null,
        });

        expect(formatRuntimeAuditResult(undefined)).toEqual({
            status: 'fail',
            message: 'Runtime audit returned no structured result.',
            fix: null,
        });
    });
});

describe('collectRuntimeAudits', () => {
    beforeEach(() => {
        resetMockState();
        vi.clearAllMocks();
    });

    it('collects all runtime audit groups in order', async () => {
        const audits = await collectRuntimeAudits();

        expect(audits).toEqual([
            mockState.audits.registration,
            mockState.audits.promptInjection,
            mockState.audits.postTurn,
            mockState.audits.smartContext,
            mockState.audits.worldState,
            mockState.audits.entryManager,
            {
                group: 'orchestration-integrity',
                ok: true,
                summary: 'Orchestration audit passed.',
                findings: [
                    { severity: 'info', reasonCode: null },
                ],
                reasonCodes: [],
                safeRepairs: [],
                requiresConfirmation: [],
                context: mockState.orchestrationSnapshot,
            },
        ]);
    });

    it('builds a pass orchestration audit when the snapshot is coordinated', async () => {
        const audits = await collectRuntimeAudits();

        expect(audits[6]).toEqual({
            group: 'orchestration-integrity',
            ok: true,
            summary: 'Orchestration audit passed.',
            findings: [
                { severity: 'info', reasonCode: null },
            ],
            reasonCodes: [],
            safeRepairs: [],
            requiresConfirmation: [],
            context: mockState.orchestrationSnapshot,
        });
    });

    it('builds a warning orchestration audit when invalidation reasons are duplicated', async () => {
        mockState.orchestrationSnapshot = {
            ...mockState.orchestrationSnapshot,
            pendingInvalidationReasons: ['chat_changed', 'chat_changed'],
            pendingInvalidationCounts: { chat_changed: 2 },
        };

        const audits = await collectRuntimeAudits();

        expect(audits[6]).toEqual({
            group: 'orchestration-integrity',
            ok: true,
            summary: 'Orchestration audit found coordination issues.',
            findings: [
                { severity: 'warn', reasonCode: 'invalidation_not_coalesced' },
            ],
            reasonCodes: ['invalidation_not_coalesced'],
            safeRepairs: [],
            requiresConfirmation: [],
            context: mockState.orchestrationSnapshot,
        });
    });

    it('does not warn for normal prompt-preparation state before preflight completes', async () => {
        mockState.orchestrationSnapshot = {
            ...mockState.orchestrationSnapshot,
            lastGenerationContext: {
                ...mockState.orchestrationSnapshot.lastGenerationContext,
                mandatoryToolsEnabled: true,
                promptInjectionPrepared: true,
                preflightCompleted: false,
                preflightSummary: null,
            },
        };

        const audits = await collectRuntimeAudits();

        expect(audits[6]).toEqual({
            group: 'orchestration-integrity',
            ok: true,
            summary: 'Orchestration audit passed.',
            findings: [
                { severity: 'info', reasonCode: null },
            ],
            reasonCodes: [],
            safeRepairs: [],
            requiresConfirmation: [],
            context: mockState.orchestrationSnapshot,
        });
    });

    it('builds a warning orchestration audit when consumed invalidation bookkeeping is inconsistent', async () => {
        mockState.orchestrationSnapshot = {
            ...mockState.orchestrationSnapshot,
            lastGenerationContext: {
                ...mockState.orchestrationSnapshot.lastGenerationContext,
                consumedInvalidationReasons: ['chat_changed'],
                consumedInvalidationCounts: { worldinfo_updated: 1 },
            },
        };

        const audits = await collectRuntimeAudits();

        expect(audits[6]).toEqual({
            group: 'orchestration-integrity',
            ok: true,
            summary: 'Orchestration audit found coordination issues.',
            findings: [
                { severity: 'warn', reasonCode: 'lost_invalidation_reason' },
            ],
            reasonCodes: ['lost_invalidation_reason'],
            safeRepairs: [],
            requiresConfirmation: [],
            context: mockState.orchestrationSnapshot,
        });
    });

    it('builds a warning orchestration audit when pending sync bookkeeping is inconsistent', async () => {
        mockState.orchestrationSnapshot = {
            ...mockState.orchestrationSnapshot,
            hasPendingSync: true,
            pendingSyncReasons: ['chat-changed'],
            pendingSyncCounts: { 'worldinfo-updated': 1 },
        };

        const audits = await collectRuntimeAudits();

        expect(audits[6]).toEqual({
            group: 'orchestration-integrity',
            ok: true,
            summary: 'Orchestration audit found coordination issues.',
            findings: [
                { severity: 'warn', reasonCode: 'lost_invalidation_reason' },
            ],
            reasonCodes: ['lost_invalidation_reason'],
            safeRepairs: [],
            requiresConfirmation: [],
            context: mockState.orchestrationSnapshot,
        });
    });

    it('builds a warning orchestration audit when the active sync plan diverges from the running sync reason', async () => {
        mockState.orchestrationSnapshot = {
            ...mockState.orchestrationSnapshot,
            syncInFlight: true,
            lastSyncReason: 'chat-changed',
            activeSyncPlan: {
                id: 1,
                syncReason: 'worldinfo-updated',
                syncReasons: ['worldinfo-updated'],
                syncReasonCounts: { 'worldinfo-updated': 1 },
                invalidationReasons: ['worldinfo_updated'],
                invalidationCounts: { worldinfo_updated: 1 },
                effects: {
                    invalidateActiveBookCache: true,
                    invalidateWorldInfoCache: true,
                    invalidatePreWarmCache: true,
                    refreshUI: true,
                },
                requestedAt: 1000,
            },
        };

        const audits = await collectRuntimeAudits();

        expect(audits[6]).toEqual({
            group: 'orchestration-integrity',
            ok: true,
            summary: 'Orchestration audit found coordination issues.',
            findings: [
                { severity: 'warn', reasonCode: 'lost_invalidation_reason' },
            ],
            reasonCodes: ['lost_invalidation_reason'],
            safeRepairs: [],
            requiresConfirmation: [],
            context: mockState.orchestrationSnapshot,
        });
    });

    it('builds a warning orchestration audit when registration and prompt active books drift', async () => {
        mockState.audits.registration = makeAudit({
            group: 'registration-integrity',
            summary: 'Tool registration audit passed.',
            context: {
                activeBooks: ['Book A'],
                registrationEpoch: 3,
                lastAppliedRegistrationEpoch: 3,
                lastComputedRegistrationEpoch: 3,
            },
        });
        mockState.audits.promptInjection = makeAudit({
            group: 'prompt-injection-integrity',
            summary: 'Prompt injection audit passed.',
            context: {
                activeBooks: ['Book B'],
                installedPlanEpoch: 2,
            },
        });

        const audits = await collectRuntimeAudits();

        expect(audits[6]).toEqual({
            group: 'orchestration-integrity',
            ok: true,
            summary: 'Orchestration audit found coordination issues.',
            findings: [
                { severity: 'warn', reasonCode: 'derived_context_mismatch' },
            ],
            reasonCodes: ['derived_context_mismatch'],
            safeRepairs: [],
            requiresConfirmation: [],
            context: mockState.orchestrationSnapshot,
        });
    });

    it('builds a failure orchestration audit when sync loses its reason while in flight', async () => {
        mockState.orchestrationSnapshot = {
            ...mockState.orchestrationSnapshot,
            syncInFlight: true,
            lastSyncReason: null,
        };

        const audits = await collectRuntimeAudits();

        expect(audits[6]).toEqual({
            group: 'orchestration-integrity',
            ok: false,
            summary: 'Orchestration audit found integrity issues.',
            findings: [
                { severity: 'error', reasonCode: 'lost_invalidation_reason' },
            ],
            reasonCodes: ['lost_invalidation_reason'],
            safeRepairs: [],
            requiresConfirmation: [],
            context: mockState.orchestrationSnapshot,
        });
    });

    it('returns the raw structured audits without reformatting them', async () => {
        mockState.audits.postTurn = makeAudit({
            group: 'post-turn-processor-integrity',
            ok: false,
            summary: 'Post-turn processor audit found integrity issues.',
            findings: [
                { severity: 'error', reasonCode: 'invalid_persisted_metadata' },
            ],
            reasonCodes: ['invalid_persisted_metadata'],
            context: { metadataKey: 'tunnelvision_postturn' },
        });

        const audits = await collectRuntimeAudits();

        expect(audits[2]).toEqual({
            group: 'post-turn-processor-integrity',
            ok: false,
            summary: 'Post-turn processor audit found integrity issues.',
            findings: [
                { severity: 'error', reasonCode: 'invalid_persisted_metadata' },
            ],
            reasonCodes: ['invalid_persisted_metadata'],
            safeRepairs: [],
            requiresConfirmation: [],
            context: { metadataKey: 'tunnelvision_postturn' },
        });
    });
});

describe('runRuntimeAuditDiagnostics', () => {
    beforeEach(() => {
        resetMockState();
        vi.clearAllMocks();
    });

    it('returns formatted pass diagnostics for healthy audits', async () => {
        const results = await runRuntimeAuditDiagnostics();

        expect(results).toEqual([
            {
                status: 'pass',
                message: 'Tool registration audit passed. Findings: 0 error(s), 0 warning(s), 1 info item(s).',
                fix: null,
            },
            {
                status: 'pass',
                message: 'Prompt injection audit passed. Findings: 0 error(s), 0 warning(s), 1 info item(s).',
                fix: null,
            },
            {
                status: 'pass',
                message: 'Post-turn processor audit passed. Findings: 0 error(s), 0 warning(s), 1 info item(s).',
                fix: null,
            },
            {
                status: 'pass',
                message: 'Smart-context audit passed. Findings: 0 error(s), 0 warning(s), 1 info item(s).',
                fix: null,
            },
            {
                status: 'pass',
                message: 'World-state audit passed. Findings: 0 error(s), 0 warning(s), 1 info item(s).',
                fix: null,
            },
            {
                status: 'pass',
                message: 'Entry-manager audit passed. Findings: 0 error(s), 0 warning(s), 1 info item(s).',
                fix: null,
            },
            {
                status: 'pass',
                message: 'Orchestration audit passed. Findings: 0 error(s), 0 warning(s), 1 info item(s).',
                fix: null,
            },
        ]);
    });

    it('returns mixed pass/warn/fail diagnostics based on audit severities', async () => {
        mockState.audits.registration = makeAudit({
            group: 'registration-integrity',
            ok: false,
            summary: 'Tool registration audit found 1 runtime issue.',
            findings: [
                { severity: 'warn', reasonCode: 'missing_registration' },
            ],
            reasonCodes: ['missing_registration'],
        });
        mockState.audits.promptInjection = makeAudit({
            group: 'prompt-injection-integrity',
            ok: false,
            summary: 'Prompt injection audit found integrity issues.',
            findings: [
                { severity: 'error', reasonCode: 'prompt_key_integrity_failure' },
            ],
            reasonCodes: ['prompt_key_integrity_failure'],
        });
        mockState.audits.smartContext = makeAudit({
            group: 'smart-context-integrity',
            ok: true,
            summary: 'Smart-context audit found stale cache state.',
            findings: [
                { severity: 'warn', reasonCode: 'stale_cache_epoch' },
                { severity: 'warn', reasonCode: 'derived_context_mismatch' },
            ],
            reasonCodes: ['stale_cache_epoch', 'derived_context_mismatch'],
        });
        mockState.orchestrationSnapshot = {
            ...mockState.orchestrationSnapshot,
            pendingInvalidationReasons: ['chat_changed', 'chat_changed'],
            pendingInvalidationCounts: { chat_changed: 2 },
        };

        const results = await runRuntimeAuditDiagnostics();

        expect(results).toEqual([
            {
                status: 'warn',
                message: 'Tool registration audit found 1 runtime issue. Findings: 0 error(s), 1 warning(s), 0 info item(s). Reasons: missing_registration.',
                fix: null,
            },
            {
                status: 'fail',
                message: 'Prompt injection audit found integrity issues. Findings: 1 error(s), 0 warning(s), 0 info item(s). Reasons: prompt_key_integrity_failure.',
                fix: null,
            },
            {
                status: 'pass',
                message: 'Post-turn processor audit passed. Findings: 0 error(s), 0 warning(s), 1 info item(s).',
                fix: null,
            },
            {
                status: 'warn',
                message: 'Smart-context audit found stale cache state. Findings: 0 error(s), 2 warning(s), 0 info item(s). Reasons: stale_cache_epoch, derived_context_mismatch.',
                fix: null,
            },
            {
                status: 'pass',
                message: 'World-state audit passed. Findings: 0 error(s), 0 warning(s), 1 info item(s).',
                fix: null,
            },
            {
                status: 'pass',
                message: 'Entry-manager audit passed. Findings: 0 error(s), 0 warning(s), 1 info item(s).',
                fix: null,
            },
            {
                status: 'warn',
                message: 'Orchestration audit found coordination issues. Findings: 0 error(s), 1 warning(s), 0 info item(s). Reasons: invalidation_not_coalesced.',
                fix: null,
            },
        ]);
    });

    it('propagates malformed audit results into failure diagnostics', async () => {
        mockState.audits.worldState = null;

        const results = await runRuntimeAuditDiagnostics();

        expect(results[4]).toEqual({
            status: 'fail',
            message: 'Runtime audit returned no structured result.',
            fix: null,
        });
    });

    it('reports orchestration failures when sync state loses its invalidation reason', async () => {
        mockState.orchestrationSnapshot = {
            ...mockState.orchestrationSnapshot,
            syncInFlight: true,
            lastSyncReason: null,
        };

        const results = await runRuntimeAuditDiagnostics();

        expect(results[6]).toEqual({
            status: 'fail',
            message: 'Orchestration audit found integrity issues. Findings: 1 error(s), 0 warning(s), 0 info item(s). Reasons: lost_invalidation_reason.',
            fix: null,
        });
    });

    it('reports orchestration invalidation bookkeeping drift as a warning', async () => {
        mockState.orchestrationSnapshot = {
            ...mockState.orchestrationSnapshot,
            lastGenerationContext: {
                ...mockState.orchestrationSnapshot.lastGenerationContext,
                consumedInvalidationReasons: ['chat_changed'],
                consumedInvalidationCounts: { worldinfo_updated: 1 },
            },
        };

        const results = await runRuntimeAuditDiagnostics();

        expect(results[6]).toEqual({
            status: 'warn',
            message: 'Orchestration audit found coordination issues. Findings: 0 error(s), 1 warning(s), 0 info item(s). Reasons: lost_invalidation_reason.',
            fix: null,
        });
    });

    it('reports pending sync bookkeeping drift as a warning', async () => {
        mockState.orchestrationSnapshot = {
            ...mockState.orchestrationSnapshot,
            hasPendingSync: true,
            pendingSyncReasons: ['chat-changed'],
            pendingSyncCounts: { 'worldinfo-updated': 1 },
        };

        const results = await runRuntimeAuditDiagnostics();

        expect(results[6]).toEqual({
            status: 'warn',
            message: 'Orchestration audit found coordination issues. Findings: 0 error(s), 1 warning(s), 0 info item(s). Reasons: lost_invalidation_reason.',
            fix: null,
        });
    });

    it('reports cross-module active-book drift as a warning', async () => {
        mockState.audits.registration = makeAudit({
            group: 'registration-integrity',
            summary: 'Tool registration audit passed.',
            context: {
                activeBooks: ['Book A'],
                registrationEpoch: 3,
                lastAppliedRegistrationEpoch: 3,
                lastComputedRegistrationEpoch: 3,
            },
        });
        mockState.audits.promptInjection = makeAudit({
            group: 'prompt-injection-integrity',
            summary: 'Prompt injection audit passed.',
            context: {
                activeBooks: ['Book B'],
                installedPlanEpoch: 2,
            },
        });

        const results = await runRuntimeAuditDiagnostics();

        expect(results[6]).toEqual({
            status: 'warn',
            message: 'Orchestration audit found coordination issues. Findings: 0 error(s), 1 warning(s), 0 info item(s). Reasons: derived_context_mismatch.',
            fix: null,
        });
    });

    it('reports inconsistent preflight bookkeeping when summary and completion state diverge', async () => {
        mockState.orchestrationSnapshot = {
            ...mockState.orchestrationSnapshot,
            lastGenerationContext: {
                ...mockState.orchestrationSnapshot.lastGenerationContext,
                preflightCompleted: false,
                preflightSummary: {
                    activeBooks: 1,
                    expectedTools: 2,
                    eligibleTools: 2,
                    repairApplied: false,
                    failureReasons: [],
                },
            },
        };

        const results = await runRuntimeAuditDiagnostics();

        expect(results[6]).toEqual({
            status: 'warn',
            message: 'Orchestration audit found coordination issues. Findings: 0 error(s), 1 warning(s), 0 info item(s). Reasons: generation_preflight_order_violation.',
            fix: null,
        });
    });
});