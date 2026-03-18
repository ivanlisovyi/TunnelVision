import { getSmartContextRuntimeSnapshot } from './smart-context.js';
import {
    buildPromptInjectionPlan,
    applyPromptBudget,
    buildPromptPlanSignature,
    TV_PROMPT_KEY,
    TV_WORLDSTATE_KEY,
    TV_SMARTCTX_KEY,
    TV_NOTEBOOK_KEY,
} from './prompt-injection-service.js';
import {
    RUNTIME_AUDIT_GROUPS,
    RUNTIME_AUDIT_SEVERITIES,
    RUNTIME_REASON_CODES,
    RUNTIME_REPAIR_CLASSES,
    createRuntimeAuditResult,
    createRuntimeFinding,
    createRuntimeRepair,
} from './runtime-health.js';
import { getPromptInjectionInstallState } from './prompt-injection-runtime-state.js';

function getExpectedPromptKeys(deps = {}) {
    return {
        mandatory: deps.promptKeys?.mandatory || TV_PROMPT_KEY,
        worldState: deps.promptKeys?.worldState || TV_WORLDSTATE_KEY,
        smartContext: deps.promptKeys?.smartContext || TV_SMARTCTX_KEY,
        notebook: deps.promptKeys?.notebook || TV_NOTEBOOK_KEY,
    };
}

function isAwaitingGenerationRefresh({ payload, installState, smartContextSnapshot }) {
    return Boolean(
        installState.installedPlanEpoch > 0
        && (
            (installState.installedPlanChatFingerprint && payload.auditContext?.currentChatFingerprint
                && installState.installedPlanChatFingerprint !== payload.auditContext.currentChatFingerprint)
            || ((installState.installedPlanChatLength || 0) !== (payload.auditContext?.currentChatLength || 0))
            || (
                smartContextSnapshot?.cacheFresh === true
                && smartContextSnapshot?.cacheKey
                && smartContextSnapshot.cacheKey === installState.installedPlanSmartContextCacheKey
                && (smartContextSnapshot.preWarmCachedAt || 0) > (installState.installedPlanSmartContextCachedAt || 0)
            )
        )
    );
}

export async function getPromptInjectionRuntimeSnapshot(deps = {}) {
    const smartContextSnapshot = typeof deps.getSmartContextRuntimeSnapshotImpl === 'function'
        ? deps.getSmartContextRuntimeSnapshotImpl()
        : getSmartContextRuntimeSnapshot();
    const installState = getPromptInjectionInstallState();
    const payload = await buildPromptInjectionPlan({
        ...deps,
        promptBuildMode: deps.promptBuildMode || 'audit',
        setInjectionSizesImpl: () => {},
        setLastInjectionPayloadImpl: () => {},
        resetTurnEntryCountImpl: () => {},
        invalidateDirtyWorldInfoCacheImpl: () => {},
        resetNotebookWriteGuardImpl: () => {},
        stripOldToolResultsImpl: () => {},
    });

    return {
        enabled: payload.enabled,
        activeBooks: payload.activeBooks,
        isRecursiveToolPass: payload.isRecursiveToolPass,
        prompts: payload.prompts,
        promptMeta: payload.promptMeta,
        promptKeys: payload.promptKeys,
        settings: payload.settings,
        auditContext: {
            ...(payload.auditContext || {}),
            installedPlanEpoch: installState.installedPlanEpoch,
        },
        expectedPlanSignature: buildPromptPlanSignature(payload),
        installedPlanEpoch: installState.installedPlanEpoch,
        installedPlanSignature: installState.installedPlanSignature,
        currentChatLength: payload.auditContext?.currentChatLength || 0,
        currentChatFingerprint: payload.auditContext?.currentChatFingerprint || null,
        installedPlanChatLength: installState.installedPlanChatLength,
        installedPlanChatFingerprint: installState.installedPlanChatFingerprint,
        smartContextCacheKey: smartContextSnapshot?.cacheKey || null,
        smartContextCacheFresh: smartContextSnapshot?.cacheFresh === true,
        smartContextCachedAt: smartContextSnapshot?.preWarmCachedAt || 0,
        installedPlanSmartContextCacheKey: installState.installedPlanSmartContextCacheKey,
        installedPlanSmartContextCachedAt: installState.installedPlanSmartContextCachedAt,
        installedPlanSmartContextCacheFresh: installState.installedPlanSmartContextCacheFresh === true,
        awaitingGenerationRefresh: isAwaitingGenerationRefresh({ payload, installState, smartContextSnapshot }),
    };
}

export async function auditPromptInjectionRuntime(deps = {}) {
    const payload = deps.payload || await getPromptInjectionRuntimeSnapshot(deps);
    const findings = [];
    const safeRepairs = [];
    const promptKeys = payload.promptKeys || getExpectedPromptKeys();
    const expectedPromptKeys = getExpectedPromptKeys(deps);

    if (payload.enabled && payload.isRecursiveToolPass && payload.prompts.mandatory) {
        findings.push(createRuntimeFinding({
            id: 'prompt-recursive-mandatory-leak',
            subsystem: 'prompt-injection-service',
            severity: RUNTIME_AUDIT_SEVERITIES.ERROR,
            message: 'Mandatory prompt content leaked into a recursive tool pass.',
            reasonCode: RUNTIME_REASON_CODES.RECURSIVE_PASS_STATE_LEAK,
            repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
            repairActionId: 'rebuild-prompt-plan',
            context: {
                isRecursiveToolPass: payload.isRecursiveToolPass,
                mandatoryLength: payload.prompts.mandatory.length,
            },
        }));
    }

    if (JSON.stringify(promptKeys) !== JSON.stringify(expectedPromptKeys)) {
        findings.push(createRuntimeFinding({
            id: 'prompt-key-integrity-failure',
            subsystem: 'prompt-injection-service',
            severity: RUNTIME_AUDIT_SEVERITIES.ERROR,
            message: 'Prompt injection keys do not match the expected runtime key set.',
            reasonCode: RUNTIME_REASON_CODES.PROMPT_KEY_INTEGRITY_FAILURE,
            repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
            repairActionId: 'rebuild-prompt-plan',
            context: {
                promptKeys,
                expectedPromptKeys,
            },
        }));
    }

    const rebudgeted = applyPromptBudget(payload.prompts, payload.settings?.totalInjectionBudget || 0, {
        minBudgetChars: deps.minBudgetChars,
        trimNewlineRatio: deps.trimNewlineRatio,
    });

    if (JSON.stringify(rebudgeted) !== JSON.stringify(payload.prompts)) {
        findings.push(createRuntimeFinding({
            id: 'prompt-budget-nondeterministic',
            subsystem: 'prompt-injection-service',
            severity: RUNTIME_AUDIT_SEVERITIES.ERROR,
            message: 'Prompt budget application is not deterministic for the current plan inputs.',
            reasonCode: RUNTIME_REASON_CODES.NONDETERMINISTIC_BUDGET,
            repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
            repairActionId: 'rebuild-prompt-plan',
            context: {
                currentPrompts: payload.prompts,
                rebudgetedPrompts: rebudgeted,
                totalInjectionBudget: payload.settings?.totalInjectionBudget || 0,
            },
        }));
    }

    if (
        payload.installedPlanEpoch > 0
        && payload.installedPlanSignature
        && payload.expectedPlanSignature
        && payload.installedPlanSignature !== payload.expectedPlanSignature
        && payload.awaitingGenerationRefresh !== true
    ) {
        findings.push(createRuntimeFinding({
            id: 'prompt-installed-plan-stale',
            subsystem: 'prompt-injection-service',
            severity: RUNTIME_AUDIT_SEVERITIES.WARN,
            message: 'Installed prompt plan no longer matches the current runtime inputs.',
            reasonCode: RUNTIME_REASON_CODES.STALE_PROMPT_PLAN,
            repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
            repairActionId: 'rebuild-prompt-plan',
            context: {
                installedPlanEpoch: payload.installedPlanEpoch,
            },
        }));
    }

    if (
        payload.enabled
        && payload.settings?.mandatoryTools
        && payload.activeBooks?.length > 0
        && !payload.isRecursiveToolPass
        && !payload.prompts.mandatory
    ) {
        findings.push(createRuntimeFinding({
            id: 'prompt-mandatory-plan-missing',
            subsystem: 'prompt-injection-service',
            severity: RUNTIME_AUDIT_SEVERITIES.WARN,
            message: 'Mandatory prompt content is missing for a first-pass generation with active books.',
            reasonCode: RUNTIME_REASON_CODES.STALE_PROMPT_PLAN,
            repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
            repairActionId: 'rebuild-prompt-plan',
            context: {
                activeBooks: payload.activeBooks,
                mandatoryTools: payload.settings?.mandatoryTools === true,
            },
        }));
    }

    if (findings.length > 0) {
        safeRepairs.push(createRuntimeRepair({
            id: 'rebuild-prompt-plan',
            label: 'Rebuild prompt injection plan',
            repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
            reasonCode: findings[0]?.reasonCode || RUNTIME_REASON_CODES.STALE_PROMPT_PLAN,
            context: {
                activeBooks: payload.activeBooks,
                isRecursiveToolPass: payload.isRecursiveToolPass,
            },
        }));
    }

    if (findings.length === 0) {
        findings.push(createRuntimeFinding({
            id: 'prompt-plan-valid',
            subsystem: 'prompt-injection-service',
            severity: RUNTIME_AUDIT_SEVERITIES.INFO,
            message: 'Prompt injection plan integrity validated for the current runtime inputs.',
            context: payload.auditContext || null,
        }));
    }

    return createRuntimeAuditResult({
        group: RUNTIME_AUDIT_GROUPS.PROMPT_INJECTION,
        ok: findings.every(finding => finding.severity !== RUNTIME_AUDIT_SEVERITIES.ERROR),
        summary: findings.some(finding => finding.severity === RUNTIME_AUDIT_SEVERITIES.ERROR)
            ? 'Prompt injection audit found integrity issues.'
            : findings.some(finding => finding.severity === RUNTIME_AUDIT_SEVERITIES.WARN)
                ? 'Prompt injection audit found coordination issues.'
                : 'Prompt injection audit passed.',
        findings,
        safeRepairs,
        context: {
            ...(payload.auditContext || {
                enabled: payload.enabled,
                activeBooks: payload.activeBooks,
                isRecursiveToolPass: payload.isRecursiveToolPass,
                promptKeys,
            }),
            installedPlanEpoch: payload.installedPlanEpoch || 0,
            expectedPlanSignature: payload.expectedPlanSignature || null,
            installedPlanSignature: payload.installedPlanSignature || null,
            currentChatLength: payload.currentChatLength || 0,
            installedPlanChatLength: payload.installedPlanChatLength || 0,
            smartContextCacheFresh: payload.smartContextCacheFresh === true,
            installedPlanSmartContextCacheFresh: payload.installedPlanSmartContextCacheFresh === true,
            awaitingGenerationRefresh: payload.awaitingGenerationRefresh === true,
        },
    });
}