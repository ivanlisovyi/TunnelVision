import { describe, it, expect, beforeEach, vi } from 'vitest';

const getMockState = () => globalThis.__tvDiagnosticsMockState;

vi.mock('../tree-store.js', () => ({
    getTree: vi.fn(() => null),
    createEmptyTree: vi.fn((lorebookName) => ({
        lorebookName,
        root: { id: 'root', children: [], entryUids: [] },
        version: 1,
        lastBuilt: 0,
    })),
    getAllEntryUids: vi.fn(root => {
        const result = [];
        (function walk(node) {
            if (!node) return;
            for (const uid of node.entryUids || []) result.push(uid);
            for (const child of node.children || []) walk(child);
        })(root);
        return result;
    }),
    findNodeById: vi.fn(() => null),
    getSettings: vi.fn(() => getMockState().settings),
    saveTree: vi.fn((bookName, tree) => {
        getMockState().savedTrees.push({ bookName, tree });
    }),
    getBookDescription: vi.fn(() => ''),
    isTrackerTitle: vi.fn(title => /^\[tracker[^\]]*\]/i.test(String(title || '').trim())),
    getConnectionProfileId: vi.fn(() => null),
    findConnectionProfile: vi.fn(() => null),
}));

vi.mock('../tool-registry.js', () => ({
    getActiveTunnelVisionBooks: vi.fn(() => getMockState().activeBooks),
    ALL_TOOL_NAMES: [],
    CONFIRMABLE_TOOLS: new Set(),
    preflightToolRuntimeState: vi.fn(async () => ({
        ok: true,
        repairApplied: false,
        failureReasons: [],
        activeBooks: getMockState().activeBooks,
        disabledToolNames: [],
        expectedToolNames: [],
        registeredToolNames: [],
        missingToolNames: [],
        stealthToolNames: [],
        eligibleToolNames: [],
        eligibilityErrors: [],
    })),
    auditToolRegistrationRuntime: vi.fn(async () => getMockState().runtimeAudits.registration),
}));

vi.mock('../prompt-injection-service.js', () => ({
    auditPromptInjectionRuntime: vi.fn(async () => getMockState().runtimeAudits.promptInjection),
}));

vi.mock('../post-turn-processor.js', () => ({
    auditPostTurnProcessorRuntime: vi.fn(() => getMockState().runtimeAudits.postTurn),
}));

vi.mock('../smart-context.js', () => ({
    auditSmartContextRuntime: vi.fn(() => getMockState().runtimeAudits.smartContext),
}));

vi.mock('../world-state.js', () => ({
    auditWorldStateRuntime: vi.fn(() => getMockState().runtimeAudits.worldState),
}));

vi.mock('../entry-manager.js', () => ({
    buildUidMap: vi.fn(entries => {
        const map = new Map();
        for (const entry of Object.values(entries || {})) {
            if (entry && Number.isFinite(entry.uid)) {
                map.set(entry.uid, entry);
            }
        }
        return map;
    }),
    getCachedWorldInfo: vi.fn(async bookName => getMockState().lorebooks.get(bookName) || null),
    auditEntryManagerRuntime: vi.fn(() => getMockState().runtimeAudits.entryManager),
}));

vi.mock('../runtime-orchestration.js', () => ({
    getOrchestrationRuntimeSnapshot: vi.fn(() => getMockState().orchestrationSnapshot),
}));

vi.mock('../llm-sidecar.js', () => ({
    auditSidecarRuntime: vi.fn(() => getMockState().runtimeAudits.sidecar),
}));

vi.mock('../background-events.js', () => ({
    auditBackgroundTaskRuntime: vi.fn(() => getMockState().runtimeAudits.backgroundTasks),
}));

vi.mock('../runtime-health.js', () => ({
    RUNTIME_AUDIT_SEVERITIES: {
        INFO: 'info',
        WARN: 'warn',
        ERROR: 'error',
    },
    RUNTIME_REASON_CODES: {
        STALE_PROMPT_PLAN: 'stale_prompt_plan',
        RUNTIME_SYNC_BACKOFF: 'runtime_sync_backoff',
        RUNTIME_SYNC_EXHAUSTED: 'runtime_sync_exhausted',
    },
    RUNTIME_REPAIR_CLASSES: {
        SAFE_AUTO: 'safe-auto',
    },
    createRuntimeRepair: vi.fn((repair) => repair),
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

vi.mock('../runtime-repairs.js', () => ({
    executeSafeRuntimeAuditRepairs: vi.fn(async (audits) => {
        const state = getMockState();
        if (typeof state.runtimeRepairRun === 'function') {
            await state.runtimeRepairRun(audits);
        }
        return state.runtimeRepairResult || { attempted: 0, applied: [], failed: [] };
    }),
}));

vi.mock('../runtime-telemetry.js', () => ({
    createNamedCorrelationId: vi.fn(() => 'audit-correlation-id'),
    logRuntimeDiagnosticsSummary: vi.fn(),
}));

vi.mock('../../../st-context.js', () => ({
    getContext: vi.fn(() => ({
        chat: [],
        chatCompletionSettings: {},
        generateRaw: async () => '',
    })),
}));

vi.mock('../../../world-info.js', async () => {
    const actual = await vi.importActual('../../../world-info.js');
    return {
        ...actual,
        get world_names() {
            return getMockState().worldNames;
        },
    };
});

import { runDiagnostics } from '../diagnostics.js';

function resetMockState() {
    globalThis.__tvDiagnosticsMockState = {
        activeBooks: [],
        settings: { trackerUids: {} },
        worldNames: [],
        lorebooks: new Map(),
        savedTrees: [],
        runtimeAudits: {
            registration: {
                group: 'registration-integrity',
                ok: true,
                summary: 'Tool registration audit passed.',
                findings: [{ severity: 'info', reasonCode: null }],
                reasonCodes: [],
                safeRepairs: [],
                requiresConfirmation: [],
                context: null,
            },
            promptInjection: {
                group: 'prompt-injection-integrity',
                ok: true,
                summary: 'Prompt injection audit passed.',
                findings: [{ severity: 'info', reasonCode: null }],
                reasonCodes: [],
                safeRepairs: [],
                requiresConfirmation: [],
                context: null,
            },
            postTurn: {
                group: 'post-turn-processor-integrity',
                ok: true,
                summary: 'Post-turn processor audit passed.',
                findings: [{ severity: 'info', reasonCode: null }],
                reasonCodes: [],
                safeRepairs: [],
                requiresConfirmation: [],
                context: null,
            },
            smartContext: {
                group: 'smart-context-integrity',
                ok: true,
                summary: 'Smart-context audit passed.',
                findings: [{ severity: 'info', reasonCode: null }],
                reasonCodes: [],
                safeRepairs: [],
                requiresConfirmation: [],
                context: null,
            },
            worldState: {
                group: 'world-state-integrity',
                ok: true,
                summary: 'World-state audit passed.',
                findings: [{ severity: 'info', reasonCode: null }],
                reasonCodes: [],
                safeRepairs: [],
                requiresConfirmation: [],
                context: null,
            },
            entryManager: {
                group: 'metadata-integrity',
                ok: true,
                summary: 'Entry-manager audit passed.',
                findings: [{ severity: 'info', reasonCode: null }],
                reasonCodes: [],
                safeRepairs: [],
                requiresConfirmation: [],
                context: null,
            },
            sidecar: {
                group: 'sidecar-integrity',
                ok: true,
                summary: 'Sidecar audit passed.',
                findings: [{ severity: 'info', reasonCode: null }],
                reasonCodes: [],
                safeRepairs: [],
                requiresConfirmation: [],
                context: null,
            },
            backgroundTasks: {
                group: 'background-task-integrity',
                ok: true,
                summary: 'Background task audit passed.',
                findings: [{ severity: 'info', reasonCode: null }],
                reasonCodes: [],
                safeRepairs: [],
                requiresConfirmation: [],
                context: null,
            },
        },
        orchestrationSnapshot: {
            syncInFlight: false,
            lastSyncReason: null,
            pendingInvalidationReasons: [],
            hasPendingSync: false,
            pendingSyncReasons: [],
            pendingSyncCounts: {},
            activeSyncPlan: null,
            lastGenerationContext: null,
            syncRetryCount: 0,
            syncRetryBackoffUntil: 0,
            lastExhaustedSyncPlan: null,
        },
        runtimeRepairResult: { attempted: 0, applied: [], failed: [] },
        runtimeRepairRun: null,
    };
}

function makeEntry(uid, comment, extra = {}) {
    return {
        uid,
        comment,
        disable: false,
        key: [],
        content: '',
        ...extra,
    };
}

describe('runDiagnostics tracker UID normalization', () => {
    beforeEach(() => {
        resetMockState();
        vi.clearAllMocks();
    });

    it('removes stale and disabled tracker UIDs while adding title-based trackers', async () => {
        const state = getMockState();
        state.settings = {
            trackerUids: {
                'Book A': [30, 20, 10, 20],
            },
        };
        state.worldNames = ['Book A'];
        state.lorebooks.set('Book A', {
            entries: {
                a: makeEntry(10, '[Tracker: Elena]'),
                b: makeEntry(20, 'Ordinary Fact', { disable: true }),
                c: makeEntry(40, '[tracker] Darius'),
                d: makeEntry(50, 'Unrelated note'),
            },
        });

        const results = await runDiagnostics();

        expect(state.settings.trackerUids).toEqual({
            'Book A': [10, 40],
        });

        const normalized = results.find(result =>
            result.message.includes('"Book A" tracker list was normalized:'),
        );
        expect(normalized).toBeTruthy();
        expect(normalized.message).toContain('stale removed');
        expect(normalized.message).toContain('title-based tracker(s) added');
    });

    it('removes tracker UID state for missing lorebooks', async () => {
        const state = getMockState();
        state.settings = {
            trackerUids: {
                MissingBook: [1, 2, 3],
            },
        };
        state.worldNames = [];

        const results = await runDiagnostics();

        expect(state.settings.trackerUids).toEqual({});
        expect(results.some(result =>
            result.message === 'Tracker entries for missing lorebook "MissingBook" were removed.',
        )).toBe(true);
        expect(results.some(result =>
            result.message === 'Tracker entries: none configured',
        )).toBe(true);
    });

    it('leaves already-valid tracker state unchanged', async () => {
        const state = getMockState();
        state.settings = {
            trackerUids: {
                'Book A': [5, 8],
            },
        };
        state.worldNames = ['Book A'];
        state.lorebooks.set('Book A', {
            entries: {
                a: makeEntry(5, '[Tracker: Alpha]'),
                b: makeEntry(8, '[Tracker: Beta]'),
                c: makeEntry(9, 'Regular entry'),
            },
        });

        const results = await runDiagnostics();

        expect(state.settings.trackerUids).toEqual({
            'Book A': [5, 8],
        });
        expect(results.some(result =>
            result.message === '"Book A" tracker entries validated (2)',
        )).toBe(true);
        expect(results.some(result =>
            result.message.includes('tracker list was normalized'),
        )).toBe(false);
    });

    it('reports aggregate tracker coverage across multiple lorebooks', async () => {
        const state = getMockState();
        state.settings = {
            trackerUids: {
                'Book A': [1],
                'Book B': [2, 3],
            },
        };
        state.worldNames = ['Book A', 'Book B'];
        state.lorebooks.set('Book A', {
            entries: {
                a: makeEntry(1, '[Tracker: Alpha]'),
            },
        });
        state.lorebooks.set('Book B', {
            entries: {
                a: makeEntry(2, '[Tracker: Beta]'),
                b: makeEntry(3, '[Tracker: Gamma]'),
            },
        });

        const results = await runDiagnostics();

        expect(results.some(result =>
            result.message === 'Tracker entries: 3 configured across 2 lorebook(s)',
        )).toBe(true);
    });

    it('keeps tracker state unchanged and warns when a lorebook cannot be loaded', async () => {
        const state = getMockState();
        state.settings = {
            trackerUids: {
                'Book A': [1, 2],
            },
        };
        state.worldNames = ['Book A'];
        state.lorebooks.set('Book A', null);

        const results = await runDiagnostics();

        expect(state.settings.trackerUids).toEqual({
            'Book A': [1, 2],
        });
        expect(results.some(result =>
            result.message === 'Tracker entries for "Book A" could not be validated because the lorebook failed to load.',
        )).toBe(true);
    });
});

describe('runDiagnostics structured runtime audits', () => {
    beforeEach(() => {
        resetMockState();
        vi.clearAllMocks();
    });

    it('includes pass results when all structured runtime audits are healthy', async () => {
        const results = await runDiagnostics();

        expect(results.some(result =>
            result.status === 'pass'
            && result.message === 'Tool registration audit passed. Findings: 0 error(s), 0 warning(s), 1 info item(s).',
        )).toBe(true);

        expect(results.some(result =>
            result.status === 'pass'
            && result.message === 'Prompt injection audit passed. Findings: 0 error(s), 0 warning(s), 1 info item(s).',
        )).toBe(true);

        expect(results.some(result =>
            result.status === 'pass'
            && result.message === 'Post-turn processor audit passed. Findings: 0 error(s), 0 warning(s), 1 info item(s).',
        )).toBe(true);

        expect(results.some(result =>
            result.status === 'pass'
            && result.message === 'Smart-context audit passed. Findings: 0 error(s), 0 warning(s), 1 info item(s).',
        )).toBe(true);

        expect(results.some(result =>
            result.status === 'pass'
            && result.message === 'World-state audit passed. Findings: 0 error(s), 0 warning(s), 1 info item(s).',
        )).toBe(true);

        expect(results.some(result =>
            result.status === 'pass'
            && result.message === 'Entry-manager audit passed. Findings: 0 error(s), 0 warning(s), 1 info item(s).',
        )).toBe(true);
    });

    it('surfaces warning and failure severity from structured runtime audits', async () => {
        const state = getMockState();
        state.runtimeAudits.registration = {
            group: 'registration-integrity',
            ok: false,
            summary: 'Tool registration audit found 1 runtime issue.',
            findings: [
                { severity: 'warn', reasonCode: 'missing_registration' },
            ],
            reasonCodes: ['missing_registration'],
            safeRepairs: [],
            requiresConfirmation: [],
            context: null,
        };
        state.runtimeAudits.promptInjection = {
            group: 'prompt-injection-integrity',
            ok: false,
            summary: 'Prompt injection audit found integrity issues.',
            findings: [
                { severity: 'error', reasonCode: 'prompt_key_integrity_failure' },
                { severity: 'warn', reasonCode: 'stale_prompt_plan' },
            ],
            reasonCodes: ['prompt_key_integrity_failure', 'stale_prompt_plan'],
            safeRepairs: [],
            requiresConfirmation: [],
            context: null,
        };
        state.runtimeAudits.smartContext = {
            group: 'smart-context-integrity',
            ok: true,
            summary: 'Smart-context audit found stale cache state.',
            findings: [
                { severity: 'warn', reasonCode: 'stale_cache_epoch' },
                { severity: 'warn', reasonCode: 'derived_context_mismatch' },
            ],
            reasonCodes: ['stale_cache_epoch', 'derived_context_mismatch'],
            safeRepairs: [],
            requiresConfirmation: [],
            context: null,
        };
        state.runtimeAudits.worldState = {
            group: 'world-state-integrity',
            ok: false,
            summary: 'World-state audit found integrity issues.',
            findings: [
                { severity: 'error', reasonCode: 'invalid_world_state_metadata' },
            ],
            reasonCodes: ['invalid_world_state_metadata'],
            safeRepairs: [],
            requiresConfirmation: [],
            context: null,
        };
        state.runtimeAudits.entryManager = {
            group: 'metadata-integrity',
            ok: true,
            summary: 'Entry-manager audit found integrity issues.',
            findings: [
                { severity: 'warn', reasonCode: 'cache_owner_conflict' },
            ],
            reasonCodes: ['cache_owner_conflict'],
            safeRepairs: [],
            requiresConfirmation: [],
            context: null,
        };

        const results = await runDiagnostics();

        expect(results.some(result =>
            result.status === 'warn'
            && result.message === 'Tool registration audit found 1 runtime issue. Findings: 0 error(s), 1 warning(s), 0 info item(s). Reasons: missing_registration.',
        )).toBe(true);

        expect(results.some(result =>
            result.status === 'fail'
            && result.message === 'Prompt injection audit found integrity issues. Findings: 1 error(s), 1 warning(s), 0 info item(s). Reasons: prompt_key_integrity_failure, stale_prompt_plan.',
        )).toBe(true);

        expect(results.some(result =>
            result.status === 'warn'
            && result.message === 'Smart-context audit found stale cache state. Findings: 0 error(s), 2 warning(s), 0 info item(s). Reasons: stale_cache_epoch, derived_context_mismatch.',
        )).toBe(true);

        expect(results.some(result =>
            result.status === 'fail'
            && result.message === 'World-state audit found integrity issues. Findings: 1 error(s), 0 warning(s), 0 info item(s). Reasons: invalid_world_state_metadata.',
        )).toBe(true);

        expect(results.some(result =>
            result.status === 'warn'
            && result.message === 'Entry-manager audit found integrity issues. Findings: 0 error(s), 1 warning(s), 0 info item(s). Reasons: cache_owner_conflict.',
        )).toBe(true);
    });

    it('applies safe runtime repairs before returning diagnostics results', async () => {
        const state = getMockState();
        state.runtimeAudits.smartContext = {
            group: 'smart-context-integrity',
            ok: true,
            summary: 'Smart-context audit found stale cache state.',
            findings: [
                { severity: 'warn', reasonCode: 'stale_cache_epoch' },
            ],
            reasonCodes: ['stale_cache_epoch'],
            safeRepairs: [
                { id: 'reset-smart-context-cache', label: 'Reset smart-context cache' },
            ],
            requiresConfirmation: [],
            context: null,
        };
        state.runtimeRepairResult = {
            attempted: 1,
            applied: [{ id: 'reset-smart-context-cache', label: 'Reset smart-context cache', groups: ['smart-context-integrity'] }],
            failed: [],
        };
        state.runtimeRepairRun = async () => {
            state.runtimeAudits.smartContext = {
                group: 'smart-context-integrity',
                ok: true,
                summary: 'Smart-context audit passed.',
                findings: [{ severity: 'info', reasonCode: null }],
                reasonCodes: [],
                safeRepairs: [],
                requiresConfirmation: [],
                context: null,
            };
        };

        const results = await runDiagnostics();

        expect(results.some(result =>
            result.status === 'pass'
            && result.message === 'Smart-context audit passed. Findings: 0 error(s), 0 warning(s), 1 info item(s).'
            && result.fix === 'Applied safe repair(s): reset-smart-context-cache.',
        )).toBe(true);
    });

    it('surfaces confirmation-required runtime repairs in diagnostics output', async () => {
        const state = getMockState();
        state.runtimeAudits.worldState = {
            group: 'world-state-integrity',
            ok: false,
            summary: 'World-state audit found integrity issues.',
            findings: [
                { severity: 'error', reasonCode: 'invalid_world_state_metadata' },
            ],
            reasonCodes: ['invalid_world_state_metadata'],
            safeRepairs: [],
            requiresConfirmation: [
                { id: 'rebuild-world-state-metadata', label: 'Rebuild persisted world-state metadata' },
            ],
            context: null,
        };

        const results = await runDiagnostics();

        expect(results.some(result =>
            result.status === 'fail'
            && result.message === 'World-state audit found integrity issues. Findings: 1 error(s), 0 warning(s), 0 info item(s). Reasons: invalid_world_state_metadata.'
            && result.fix === 'Requires confirmation: Rebuild persisted world-state metadata.',
        )).toBe(true);
    });
});