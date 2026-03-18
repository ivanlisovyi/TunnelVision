import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = {
    settings: {},
    context: { chat: [] },
    activeBooks: [],
    cachedWorldInfoCalls: [],
    worldStatePrompt: '',
    smartContextPrompt: '',
    notebookPrompt: '',
    injectionSizes: null,
};

vi.mock('../tree-store.js', () => ({
    getSettings: vi.fn(() => mockState.settings),
}));

vi.mock('../../../st-context.js', () => ({
    getContext: vi.fn(() => mockState.context),
}));

vi.mock('../tool-registry.js', () => ({
    getActiveTunnelVisionBooks: vi.fn(() => mockState.activeBooks),
}));

vi.mock('../entry-manager.js', () => ({
    getCachedWorldInfo: vi.fn(async (book) => {
        mockState.cachedWorldInfoCalls.push(book);
        return null;
    }),
    resetTurnEntryCount: vi.fn(),
    invalidateDirtyWorldInfoCache: vi.fn(),
}));

vi.mock('../agent-utils.js', () => ({
    setInjectionSizes: vi.fn((sizes) => {
        mockState.injectionSizes = sizes;
    }),
}));

vi.mock('../tools/notebook.js', () => ({
    buildNotebookPrompt: vi.fn(() => mockState.notebookPrompt),
    resetNotebookWriteGuard: vi.fn(),
}));

vi.mock('../world-state.js', () => ({
    buildWorldStatePrompt: vi.fn(() => mockState.worldStatePrompt),
}));

vi.mock('../smart-context.js', () => ({
    buildSmartContextPrompt: vi.fn(() => mockState.smartContextPrompt),
}));

vi.mock('../../../../script.js', () => ({
    extension_prompt_types: {
        IN_PROMPT: 'IN_PROMPT',
        IN_CHAT: 'IN_CHAT',
    },
    extension_prompt_roles: {
        SYSTEM: 'SYSTEM',
        USER: 'USER',
        ASSISTANT: 'ASSISTANT',
    },
    setExtensionPrompt: vi.fn(),
}));

vi.mock('../runtime-health.js', () => ({
    RUNTIME_AUDIT_GROUPS: {
        PROMPT_INJECTION: 'prompt-injection-integrity',
    },
    RUNTIME_AUDIT_SEVERITIES: {
        INFO: 'info',
        WARN: 'warn',
        ERROR: 'error',
    },
    RUNTIME_REPAIR_CLASSES: {
        SAFE_AUTO: 'safe_auto',
        EXPLICIT: 'explicit',
        DESTRUCTIVE: 'destructive',
    },
    RUNTIME_REASON_CODES: {
        STALE_PROMPT_PLAN: 'stale_prompt_plan',
        NONDETERMINISTIC_BUDGET: 'nondeterministic_budget',
        RECURSIVE_PASS_STATE_LEAK: 'recursive_pass_state_leak',
        PROMPT_KEY_INTEGRITY_FAILURE: 'prompt_key_integrity_failure',
    },
    createRuntimeAuditResult: vi.fn((payload = {}) => ({
        group: payload.group || 'prompt-injection-integrity',
        ok: payload.ok ?? true,
        summary: payload.summary || '',
        findings: payload.findings || [],
        safeRepairs: payload.safeRepairs || [],
        requiresConfirmation: payload.requiresConfirmation || [],
        reasonCodes: payload.reasonCodes || [...new Set((payload.findings || []).map(f => f?.reasonCode).filter(Boolean))],
        context: payload.context ?? null,
    })),
    createRuntimeFinding: vi.fn((payload = {}) => ({
        id: payload.id || null,
        subsystem: payload.subsystem || null,
        severity: payload.severity || 'info',
        message: payload.message || '',
        reasonCode: payload.reasonCode || null,
        repairClass: payload.repairClass || null,
        repairActionId: payload.repairActionId || null,
        context: payload.context ?? null,
    })),
    createRuntimeRepair: vi.fn((payload = {}) => ({
        id: payload.id || null,
        label: payload.label || '',
        repairClass: payload.repairClass || 'explicit',
        reasonCode: payload.reasonCode || null,
        context: payload.context ?? null,
    })),
}));

import {
    buildPromptInjectionPlan,
    applyPromptInjectionPlan,
    getPromptInjectionRuntimeSnapshot,
    mapPositionSetting,
    mapRoleSetting,
    TV_PROMPT_KEY,
    TV_WORLDSTATE_KEY,
    TV_SMARTCTX_KEY,
    TV_NOTEBOOK_KEY,
    auditPromptInjectionRuntime,
} from '../prompt-injection-service.js';
import { resetTurnEntryCount, invalidateDirtyWorldInfoCache } from '../entry-manager.js';
import { setInjectionSizes } from '../agent-utils.js';
import { resetNotebookWriteGuard } from '../tools/notebook.js';
import { setExtensionPrompt } from '../../../../script.js';

function makeSettings(overrides = {}) {
    return {
        globalEnabled: true,
        mandatoryTools: true,
        mandatoryPromptText: '',
        mandatoryPromptPosition: 'in_chat',
        mandatoryPromptDepth: 1,
        mandatoryPromptRole: 'system',
        worldStateEnabled: false,
        worldStatePosition: 'in_chat',
        worldStateDepth: 2,
        worldStateRole: 'system',
        smartContextEnabled: false,
        smartContextPosition: 'in_chat',
        smartContextDepth: 3,
        smartContextRole: 'system',
        notebookEnabled: true,
        notebookPromptPosition: 'in_chat',
        notebookPromptDepth: 1,
        notebookPromptRole: 'system',
        totalInjectionBudget: 0,
        ...overrides,
    };
}

beforeEach(() => {
    mockState.settings = makeSettings();
    mockState.context = { chat: [] };
    mockState.activeBooks = [];
    mockState.cachedWorldInfoCalls = [];
    mockState.worldStatePrompt = '';
    mockState.smartContextPrompt = '';
    mockState.notebookPrompt = '';
    mockState.injectionSizes = null;
    vi.clearAllMocks();
});

describe('prompt-injection-service mapping helpers', () => {
    it('maps prompt position settings to ST prompt types', () => {
        expect(mapPositionSetting('in_prompt')).toBe('IN_PROMPT');
        expect(mapPositionSetting('in_chat')).toBe('IN_CHAT');
        expect(mapPositionSetting('unknown')).toBe('IN_CHAT');
    });

    it('maps role settings to ST prompt roles', () => {
        expect(mapRoleSetting('system')).toBe('SYSTEM');
        expect(mapRoleSetting('user')).toBe('USER');
        expect(mapRoleSetting('assistant')).toBe('ASSISTANT');
        expect(mapRoleSetting('unknown')).toBe('SYSTEM');
    });
});

describe('buildPromptInjectionPlan', () => {
    it('builds mandatory prompt on first-pass generation when active books exist', async () => {
        mockState.settings = makeSettings({
            mandatoryPromptText: 'Use TV tools now.',
        });
        mockState.activeBooks = ['Book A'];

        const plan = await buildPromptInjectionPlan({
            isRecursiveToolPassImpl: () => false,
        });

        expect(plan.prompts.mandatory).toBe('Use TV tools now.');
        expect(plan.prompts.worldState).toBe('');
        expect(plan.prompts.smartContext).toBe('');
        expect(plan.prompts.notebook).toBe('');
        expect(plan.activeBooks).toEqual(['Book A']);
        expect(plan.enabled).toBe(true);
    });

    it('uses default mandatory prompt text when custom text is empty', async () => {
        mockState.settings = makeSettings({
            mandatoryPromptText: '',
        });
        mockState.activeBooks = ['Book A'];

        const plan = await buildPromptInjectionPlan({
            isRecursiveToolPassImpl: () => false,
        });

        expect(plan.prompts.mandatory).toContain('You MUST use TunnelVision tools this turn');
    });

    it('does not build mandatory prompt during recursive tool pass', async () => {
        mockState.activeBooks = ['Book A'];

        const plan = await buildPromptInjectionPlan({
            isRecursiveToolPassImpl: () => true,
        });

        expect(plan.prompts.mandatory).toBe('');
    });

    it('does not build mandatory prompt when no active books exist', async () => {
        mockState.activeBooks = [];

        const plan = await buildPromptInjectionPlan({
            isRecursiveToolPassImpl: () => false,
        });

        expect(plan.prompts.mandatory).toBe('');
    });

    it('builds world state, smart context, and notebook prompts when enabled', async () => {
        mockState.settings = makeSettings({
            worldStateEnabled: true,
            smartContextEnabled: true,
            notebookEnabled: true,
        });
        mockState.activeBooks = ['Book A', 'Book B'];
        mockState.worldStatePrompt = 'WORLD STATE';
        mockState.smartContextPrompt = 'SMART CONTEXT';
        mockState.notebookPrompt = 'NOTEBOOK';

        const plan = await buildPromptInjectionPlan({
            isRecursiveToolPassImpl: () => false,
        });

        expect(plan.prompts.worldState).toBe('WORLD STATE');
        expect(plan.prompts.smartContext).toBe('SMART CONTEXT');
        expect(plan.prompts.notebook).toBe('NOTEBOOK');
        expect(mockState.cachedWorldInfoCalls).toEqual([]);
    });

    it('does not prefetch world info for smart context when no active books exist', async () => {
        mockState.settings = makeSettings({
            smartContextEnabled: true,
        });
        mockState.activeBooks = [];
        mockState.smartContextPrompt = 'SMART CONTEXT';

        const plan = await buildPromptInjectionPlan({
            isRecursiveToolPassImpl: () => false,
        });

        expect(plan.prompts.smartContext).toBe('SMART CONTEXT');
        expect(mockState.cachedWorldInfoCalls).toEqual([]);
    });

    it('clears all prompts when globally disabled', async () => {
        mockState.settings = makeSettings({
            globalEnabled: false,
            worldStateEnabled: true,
            smartContextEnabled: true,
            notebookEnabled: true,
        });
        mockState.activeBooks = ['Book A'];
        mockState.worldStatePrompt = 'WORLD STATE';
        mockState.smartContextPrompt = 'SMART CONTEXT';
        mockState.notebookPrompt = 'NOTEBOOK';

        const plan = await buildPromptInjectionPlan({
            isRecursiveToolPassImpl: () => false,
        });

        expect(plan.enabled).toBe(false);
        expect(plan.prompts.mandatory).toBe('');
        expect(plan.prompts.worldState).toBe('');
        expect(plan.prompts.smartContext).toBe('');
        expect(plan.prompts.notebook).toBe('');
        expect(mockState.cachedWorldInfoCalls).toEqual([]);
    });

    it('drops all prompts when the total budget is below the minimum truncation threshold', async () => {
        mockState.settings = makeSettings({
            worldStateEnabled: true,
            smartContextEnabled: true,
            notebookEnabled: true,
            totalInjectionBudget: 50,
        });
        mockState.activeBooks = ['Book A'];
        mockState.worldStatePrompt = 'W'.repeat(60);
        mockState.smartContextPrompt = 'S'.repeat(60);
        mockState.notebookPrompt = 'N'.repeat(60);

        const plan = await buildPromptInjectionPlan({
            isRecursiveToolPassImpl: () => false,
        });

        expect(plan.prompts.mandatory).toBe('');
        expect(plan.prompts.worldState).toBe('');
        expect(plan.prompts.smartContext).toBe('');
        expect(plan.prompts.notebook).toBe('');
    });

    it('trims an oversized prompt to fit remaining budget and appends truncation marker', async () => {
        mockState.settings = makeSettings({
            worldStateEnabled: true,
            mandatoryPromptText: 'MANDATORY',
            totalInjectionBudget: 220,
        });
        mockState.activeBooks = ['Book A'];
        mockState.worldStatePrompt = `alpha
beta
gamma
delta
epsilon
zeta
eta
theta
iota
kappa
lambda
mu
nu
xi
omicron
pi
rho
sigma
tau
upsilon
phi
chi
psi
omega
one
two
three
four
five
six
seven
eight
nine
ten
eleven
twelve
thirteen
fourteen
fifteen
sixteen
seventeen
eighteen
nineteen
twenty`;

        const plan = await buildPromptInjectionPlan({
            isRecursiveToolPassImpl: () => false,
        });

        expect(plan.prompts.mandatory).toBe('MANDATORY');
        expect(plan.prompts.worldState).toContain('[...budget limit reached]');
        expect(plan.prompts.worldState.length).toBeGreaterThan(0);
        expect(plan.prompts.smartContext).toBe('');
        expect(plan.prompts.notebook).toBe('');
    });

    it('tracks injection sizes from the final prompt texts', async () => {
        mockState.settings = makeSettings({
            worldStateEnabled: true,
            notebookEnabled: true,
        });
        mockState.activeBooks = ['Book A'];
        mockState.worldStatePrompt = 'WORLD';
        mockState.notebookPrompt = 'NOTE';

        const plan = await buildPromptInjectionPlan({
            isRecursiveToolPassImpl: () => false,
        });

        expect(plan.prompts).toEqual({
            mandatory: expect.any(String),
            worldState: 'WORLD',
            smartContext: '',
            notebook: 'NOTE',
        });
        expect(plan.prompts.mandatory.length).toBeGreaterThan(0);
        expect(mockState.injectionSizes).toEqual({
            mandatory: plan.prompts.mandatory.length,
            worldState: 5,
            smartContext: 0,
            notebook: 4,
        });
    });

    it('leaves prompts unchanged when they already fit within the remaining budget', async () => {
        mockState.settings = makeSettings({
            worldStateEnabled: true,
            mandatoryPromptText: 'MANDATORY',
            totalInjectionBudget: 260,
        });
        mockState.activeBooks = ['Book A'];
        mockState.worldStatePrompt = `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
trim-here
this part should be removed`;

        const plan = await buildPromptInjectionPlan({
            isRecursiveToolPassImpl: () => false,
        });

        expect(plan.prompts.mandatory).toBe('MANDATORY');
        expect(plan.prompts.worldState).toBe(mockState.worldStatePrompt);
        expect(plan.prompts.worldState).not.toContain('[...budget limit reached]');
        expect(plan.prompts.smartContext).toBe('');
        expect(plan.prompts.notebook).toBe('');
    });

    it('preserves a prompt that is below the remaining budget even when it contains an early newline', async () => {
        mockState.settings = makeSettings({
            worldStateEnabled: true,
            mandatoryPromptText: 'MANDATORY',
            totalInjectionBudget: 260,
        });
        mockState.activeBooks = ['Book A'];
        mockState.worldStatePrompt = `${'A'.repeat(80)}
${'B'.repeat(160)}`;

        const plan = await buildPromptInjectionPlan({
            isRecursiveToolPassImpl: () => false,
        });

        expect(plan.prompts.worldState).toBe(mockState.worldStatePrompt);
        expect(plan.prompts.worldState).not.toContain('[...budget limit reached]');
        expect(plan.prompts.worldState.startsWith(`${'A'.repeat(80)}
`)).toBe(true);
        expect(plan.prompts.worldState).toContain('B');
    });

    it('drops later prompt slots entirely after an earlier slot consumes the remaining budget', async () => {
        mockState.settings = makeSettings({
            worldStateEnabled: true,
            smartContextEnabled: true,
            notebookEnabled: true,
            mandatoryPromptText: 'MANDATORY',
            totalInjectionBudget: 260,
        });
        mockState.activeBooks = ['Book A'];
        mockState.worldStatePrompt = `${'W'.repeat(260)}
tail`;
        mockState.smartContextPrompt = 'SMART SHOULD NOT APPEAR';
        mockState.notebookPrompt = 'NOTE SHOULD NOT APPEAR';

        const plan = await buildPromptInjectionPlan({
            isRecursiveToolPassImpl: () => false,
        });

        expect(plan.prompts.mandatory).toBe('MANDATORY');
        expect(plan.prompts.worldState).toContain('[...budget limit reached]');
        expect(plan.prompts.smartContext).toBe('');
        expect(plan.prompts.notebook).toBe('');
    });
});

describe('buildPromptInjectionPlan sync behavior', () => {
    it('does not await async world info loading during current-turn prompt planning', async () => {
        mockState.settings = makeSettings({
            smartContextEnabled: true,
        });
        mockState.activeBooks = ['Book A'];
        mockState.smartContextPrompt = 'SMART CONTEXT';

        const planPromise = buildPromptInjectionPlan({
            isRecursiveToolPassImpl: () => false,
        });

        const result = await Promise.race([
            planPromise.then(() => 'resolved'),
            Promise.resolve().then(() => 'pending'),
        ]);

        expect(result).toBe('resolved');
        expect(mockState.cachedWorldInfoCalls).toEqual([]);
    });
});

describe('auditPromptInjectionRuntime', () => {
    it('returns an info finding for a healthy prompt plan', async () => {
        mockState.settings = makeSettings({
            worldStateEnabled: true,
            smartContextEnabled: true,
            notebookEnabled: true,
            mandatoryPromptText: 'MANDATORY',
        });
        mockState.activeBooks = ['Book A'];
        mockState.worldStatePrompt = 'WORLD';
        mockState.smartContextPrompt = 'SMART';
        mockState.notebookPrompt = 'NOTE';

        const audit = await auditPromptInjectionRuntime({
            isRecursiveToolPassImpl: () => false,
        });

        expect(audit.group).toBe('prompt-injection-integrity');
        expect(audit.ok).toBe(true);
        expect(audit.summary).toBe('Prompt injection audit passed.');
        expect(audit.findings).toHaveLength(1);
        expect(audit.findings[0].id).toBe('prompt-plan-valid');
        expect(audit.findings[0].severity).toBe('info');
        expect(audit.safeRepairs).toEqual([]);
        expect(audit.reasonCodes).toEqual([]);
        expect(resetTurnEntryCount).not.toHaveBeenCalled();
        expect(invalidateDirtyWorldInfoCache).not.toHaveBeenCalled();
        expect(resetNotebookWriteGuard).not.toHaveBeenCalled();
        expect(setInjectionSizes).not.toHaveBeenCalled();
    });

    it('reports recursive pass leakage when mandatory prompt content appears during tool recursion', async () => {
        const audit = await auditPromptInjectionRuntime({
            payload: {
                settings: makeSettings({
                    mandatoryTools: true,
                }),
                activeBooks: ['Book A'],
                enabled: true,
                isRecursiveToolPass: true,
                prompts: {
                    mandatory: 'MANDATORY LEAK',
                    worldState: '',
                    smartContext: '',
                    notebook: '',
                },
                promptMeta: {
                    mandatory: { position: 'IN_CHAT', depth: 1, role: 'SYSTEM' },
                    worldState: { position: 'IN_CHAT', depth: 2, role: 'SYSTEM' },
                    smartContext: { position: 'IN_CHAT', depth: 3, role: 'SYSTEM' },
                    notebook: { position: 'IN_CHAT', depth: 1, role: 'SYSTEM' },
                },
                promptKeys: {
                    mandatory: TV_PROMPT_KEY,
                    worldState: TV_WORLDSTATE_KEY,
                    smartContext: TV_SMARTCTX_KEY,
                    notebook: TV_NOTEBOOK_KEY,
                },
                auditContext: {
                    enabled: true,
                    activeBooks: ['Book A'],
                    isRecursiveToolPass: true,
                },
            },
        });

        expect(audit.ok).toBe(false);
        expect(audit.summary).toBe('Prompt injection audit found integrity issues.');
        expect(audit.findings.some(finding =>
            finding.id === 'prompt-recursive-mandatory-leak'
            && finding.reasonCode === 'recursive_pass_state_leak'
            && finding.severity === 'error'
        )).toBe(true);
        expect(audit.safeRepairs).toEqual([
            expect.objectContaining({
                id: 'rebuild-prompt-plan',
                repairClass: 'safe_auto',
            }),
        ]);
        expect(audit.reasonCodes).toContain('recursive_pass_state_leak');
    });

    it('reports prompt key integrity mismatches', async () => {
        const audit = await auditPromptInjectionRuntime({
            payload: {
                settings: makeSettings(),
                activeBooks: ['Book A'],
                enabled: true,
                isRecursiveToolPass: false,
                prompts: {
                    mandatory: 'MANDATORY',
                    worldState: '',
                    smartContext: '',
                    notebook: '',
                },
                promptMeta: {
                    mandatory: { position: 'IN_CHAT', depth: 1, role: 'SYSTEM' },
                    worldState: { position: 'IN_CHAT', depth: 2, role: 'SYSTEM' },
                    smartContext: { position: 'IN_CHAT', depth: 3, role: 'SYSTEM' },
                    notebook: { position: 'IN_CHAT', depth: 1, role: 'SYSTEM' },
                },
                promptKeys: {
                    mandatory: 'wrong_mandatory_key',
                    worldState: TV_WORLDSTATE_KEY,
                    smartContext: TV_SMARTCTX_KEY,
                    notebook: TV_NOTEBOOK_KEY,
                },
                auditContext: {
                    enabled: true,
                    activeBooks: ['Book A'],
                    isRecursiveToolPass: false,
                },
            },
        });

        expect(audit.findings.some(finding =>
            finding.id === 'prompt-key-integrity-failure'
            && finding.reasonCode === 'prompt_key_integrity_failure'
            && finding.severity === 'error'
        )).toBe(true);
        expect(audit.reasonCodes).toContain('prompt_key_integrity_failure');
    });

    it('reports missing mandatory prompt content for first-pass generations with active books', async () => {
        const audit = await auditPromptInjectionRuntime({
            payload: {
                settings: makeSettings({
                    mandatoryTools: true,
                }),
                activeBooks: ['Book A'],
                enabled: true,
                isRecursiveToolPass: false,
                prompts: {
                    mandatory: '',
                    worldState: '',
                    smartContext: '',
                    notebook: '',
                },
                promptMeta: {
                    mandatory: { position: 'IN_CHAT', depth: 1, role: 'SYSTEM' },
                    worldState: { position: 'IN_CHAT', depth: 2, role: 'SYSTEM' },
                    smartContext: { position: 'IN_CHAT', depth: 3, role: 'SYSTEM' },
                    notebook: { position: 'IN_CHAT', depth: 1, role: 'SYSTEM' },
                },
                promptKeys: {
                    mandatory: TV_PROMPT_KEY,
                    worldState: TV_WORLDSTATE_KEY,
                    smartContext: TV_SMARTCTX_KEY,
                    notebook: TV_NOTEBOOK_KEY,
                },
                auditContext: {
                    enabled: true,
                    activeBooks: ['Book A'],
                    isRecursiveToolPass: false,
                },
            },
        });

        expect(audit.ok).toBe(true);
        expect(audit.findings.some(finding =>
            finding.id === 'prompt-mandatory-plan-missing'
            && finding.reasonCode === 'stale_prompt_plan'
            && finding.severity === 'warn'
        )).toBe(true);
        expect(audit.safeRepairs).toEqual([
            expect.objectContaining({
                id: 'rebuild-prompt-plan',
                reasonCode: 'stale_prompt_plan',
            }),
        ]);
        expect(audit.reasonCodes).toContain('stale_prompt_plan');
    });
});

describe('applyPromptInjectionPlan', () => {
    it('applies all prompts via setExtensionPrompt and records sizes', async () => {
        mockState.settings = makeSettings({
            worldStateEnabled: true,
            smartContextEnabled: true,
            notebookEnabled: true,
            mandatoryPromptText: 'MANDATORY',
            mandatoryPromptPosition: 'in_prompt',
            mandatoryPromptDepth: 9,
            mandatoryPromptRole: 'user',
            worldStatePosition: 'in_chat',
            worldStateDepth: 2,
            worldStateRole: 'assistant',
            smartContextPosition: 'in_prompt',
            smartContextDepth: 7,
            smartContextRole: 'system',
            notebookPromptPosition: 'in_chat',
            notebookPromptDepth: 4,
            notebookPromptRole: 'assistant',
        });
        mockState.activeBooks = ['Book A'];
        mockState.worldStatePrompt = 'WORLD';
        mockState.smartContextPrompt = 'SMART';
        mockState.notebookPrompt = 'NOTE';

        const plan = await buildPromptInjectionPlan({
            isRecursiveToolPassImpl: () => false,
        });
        applyPromptInjectionPlan(plan);

        expect(setExtensionPrompt).toHaveBeenCalledTimes(4);
        expect(setExtensionPrompt).toHaveBeenNthCalledWith(1, TV_PROMPT_KEY, 'MANDATORY', 'IN_PROMPT', 9, false, 'USER');
        expect(setExtensionPrompt).toHaveBeenNthCalledWith(2, TV_WORLDSTATE_KEY, 'WORLD', 'IN_CHAT', 2, false, 'ASSISTANT');
        expect(setExtensionPrompt).toHaveBeenNthCalledWith(3, TV_SMARTCTX_KEY, 'SMART', 'IN_PROMPT', 7, false, 'SYSTEM');
        expect(setExtensionPrompt).toHaveBeenNthCalledWith(4, TV_NOTEBOOK_KEY, 'NOTE', 'IN_CHAT', 4, false, 'ASSISTANT');

        expect(mockState.injectionSizes).toEqual({
            mandatory: 'MANDATORY'.length,
            worldState: 'WORLD'.length,
            smartContext: 'SMART'.length,
            notebook: 'NOTE'.length,
        });
    });

    it('applies empty prompts when features are disabled', async () => {
        mockState.settings = makeSettings({
            globalEnabled: false,
        });

        const plan = await buildPromptInjectionPlan({
            isRecursiveToolPassImpl: () => false,
        });
        applyPromptInjectionPlan(plan);

        expect(setExtensionPrompt).toHaveBeenNthCalledWith(1, TV_PROMPT_KEY, '', 'IN_CHAT', 1, false, 'SYSTEM');
        expect(setExtensionPrompt).toHaveBeenNthCalledWith(2, TV_WORLDSTATE_KEY, '', 'IN_CHAT', 2, false, 'SYSTEM');
        expect(setExtensionPrompt).toHaveBeenNthCalledWith(3, TV_SMARTCTX_KEY, '', 'IN_CHAT', 3, false, 'SYSTEM');
        expect(setExtensionPrompt).toHaveBeenNthCalledWith(4, TV_NOTEBOOK_KEY, '', 'IN_CHAT', 1, false, 'SYSTEM');
        expect(mockState.injectionSizes).toEqual({
            mandatory: 0,
            worldState: 0,
            smartContext: 0,
            notebook: 0,
        });
    });

    it('records an installed prompt-plan epoch in the runtime snapshot', async () => {
        mockState.settings = makeSettings({
            worldStateEnabled: true,
            smartContextEnabled: true,
            notebookEnabled: true,
            mandatoryPromptText: 'MANDATORY',
        });
        mockState.activeBooks = ['Book A'];
        mockState.worldStatePrompt = 'WORLD';
        mockState.smartContextPrompt = 'SMART';
        mockState.notebookPrompt = 'NOTE';

        const plan = await buildPromptInjectionPlan({
            isRecursiveToolPassImpl: () => false,
        });
        applyPromptInjectionPlan(plan);

        const snapshot = await getPromptInjectionRuntimeSnapshot({
            isRecursiveToolPassImpl: () => false,
        });

        expect(snapshot.installedPlanEpoch).toBeGreaterThan(0);
        expect(typeof snapshot.installedPlanSignature).toBe('string');
        expect(snapshot.expectedPlanSignature).toBe(snapshot.installedPlanSignature);
    });

    it('reports stale installed prompt plans as a warning', async () => {
        const audit = await auditPromptInjectionRuntime({
            payload: {
                settings: makeSettings({ mandatoryTools: true }),
                activeBooks: ['Book A'],
                enabled: true,
                isRecursiveToolPass: false,
                prompts: {
                    mandatory: 'MANDATORY',
                    worldState: '',
                    smartContext: '',
                    notebook: '',
                },
                promptMeta: {
                    mandatory: { position: 'IN_CHAT', depth: 1, role: 'SYSTEM' },
                    worldState: { position: 'IN_CHAT', depth: 2, role: 'SYSTEM' },
                    smartContext: { position: 'IN_CHAT', depth: 3, role: 'SYSTEM' },
                    notebook: { position: 'IN_CHAT', depth: 1, role: 'SYSTEM' },
                },
                promptKeys: {
                    mandatory: TV_PROMPT_KEY,
                    worldState: TV_WORLDSTATE_KEY,
                    smartContext: TV_SMARTCTX_KEY,
                    notebook: TV_NOTEBOOK_KEY,
                },
                installedPlanEpoch: 2,
                installedPlanSignature: 'stale-installed-plan',
                expectedPlanSignature: 'fresh-plan',
                auditContext: {
                    enabled: true,
                    activeBooks: ['Book A'],
                    isRecursiveToolPass: false,
                },
            },
        });

        expect(audit.ok).toBe(true);
        expect(audit.findings.some(finding =>
            finding.id === 'prompt-installed-plan-stale'
            && finding.reasonCode === 'stale_prompt_plan'
            && finding.severity === 'warn'
        )).toBe(true);
    });
});