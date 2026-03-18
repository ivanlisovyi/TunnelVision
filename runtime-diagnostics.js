/**
 * TunnelVision Runtime Diagnostics
 *
 * Extracts runtime audit aggregation and formatting out of `diagnostics.js`.
 * This module is intentionally narrow:
 * - collect structured runtime audits from subsystem modules
 * - summarize them into legacy diagnostics pass/warn/fail entries
 * - expose the raw structured audits for future diagnostics/activity-feed work
 */

import { auditToolRegistrationRuntime } from './tool-registry.js';
import { auditPromptInjectionRuntime } from './prompt-injection-service.js';
import { auditPostTurnProcessorRuntime } from './post-turn-processor.js';
import { auditSmartContextRuntime } from './smart-context.js';
import { auditWorldStateRuntime } from './world-state.js';
import { auditEntryManagerRuntime } from './entry-manager.js';
import { getOrchestrationRuntimeSnapshot } from './runtime-orchestration.js';
import {
    countRuntimeFindingsBySeverity,
    createRuntimeRepair,
    RUNTIME_REASON_CODES,
    RUNTIME_REPAIR_CLASSES,
} from './runtime-health.js';
import { executeSafeRuntimeAuditRepairs } from './runtime-repairs.js';

/**
 * @typedef {Object} DiagResult
 * @property {'pass'|'warn'|'fail'} status
 * @property {string} message
 * @property {string|null} fix
 */

/**
 * Build a legacy diagnostics result object.
 * @param {'pass'|'warn'|'fail'} status
 * @param {string} message
 * @param {string|null} [fix]
 * @returns {DiagResult}
 */
function makeDiagResult(status, message, fix = null) {
    return {
        status,
        message,
        fix,
    };
}

function hasReasonCountMismatch(reasons = [], counts = {}) {
    const actualCounts = {};

    for (const reason of Array.isArray(reasons) ? reasons : []) {
        actualCounts[reason] = (actualCounts[reason] || 0) + 1;
    }

    const expectedKeys = Object.keys(counts || {}).sort();
    const actualKeys = Object.keys(actualCounts).sort();
    if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
        return true;
    }

    return expectedKeys.some(key => actualCounts[key] !== counts[key]);
}

/**
 * Convert a structured runtime audit result into the legacy diagnostics shape.
 * @param {object} audit
 * @param {{ applied?: string[] } | null} [repairSummary]
 * @returns {DiagResult}
 */
export function formatRuntimeAuditResult(audit, repairSummary = null) {
    if (!audit || typeof audit !== 'object') {
        return makeDiagResult('fail', 'Runtime audit returned no structured result.');
    }

    const severityCounts = countRuntimeFindingsBySeverity(audit.findings || []);
    const reasonSummary = Array.isArray(audit.reasonCodes) && audit.reasonCodes.length > 0
        ? ` Reasons: ${audit.reasonCodes.join(', ')}.`
        : '';
    const summary = audit.summary || 'Runtime audit completed.';
    const message = `${summary} Findings: ${severityCounts.error} error(s), ${severityCounts.warn} warning(s), ${severityCounts.info} info item(s).${reasonSummary}`;
    const fixParts = [];

    if (repairSummary?.applied?.length) {
        fixParts.push(`Applied safe repair(s): ${repairSummary.applied.join(', ')}.`);
    }

    const confirmationLabels = Array.isArray(audit.requiresConfirmation)
        ? audit.requiresConfirmation
            .map(repair => repair?.label || repair?.id)
            .filter(Boolean)
        : [];

    if (confirmationLabels.length > 0) {
        fixParts.push(`Requires confirmation: ${confirmationLabels.join(', ')}.`);
    }

    const fix = fixParts.length > 0 ? fixParts.join(' ') : null;

    if (severityCounts.error > 0) {
        return makeDiagResult('fail', message, fix);
    }

    if (severityCounts.warn > 0) {
        return makeDiagResult('warn', message, fix);
    }

    return makeDiagResult('pass', message, fix);
}

export function formatRuntimeAuditResultDetailed(audit, repairSummary = null) {
    const result = formatRuntimeAuditResult(audit, repairSummary);
    return {
        ...result,
        group: audit?.group || null,
        actions: Array.isArray(audit?.requiresConfirmation)
            ? audit.requiresConfirmation.filter(repair => repair?.id && repair?.label)
            : [],
    };
}

/**
 * Build a structured orchestration runtime audit from the index-level runtime snapshot.
 * @returns {object}
 */
export function auditOrchestrationRuntime({ registrationSnapshot = null, promptContext = null } = {}) {
    const snapshot = getOrchestrationRuntimeSnapshot();
    const findings = [];
    const reasonCodes = [];
    const safeRepairs = [];
    const generationContext = snapshot.lastGenerationContext;
    const activeSyncPlan = snapshot.activeSyncPlan;

    if (snapshot.syncInFlight && !snapshot.lastSyncReason) {
        findings.push({
            severity: 'error',
            reasonCode: 'lost_invalidation_reason',
        });
        reasonCodes.push('lost_invalidation_reason');
    }

    if (
        snapshot.pendingInvalidationReasons.length > 1
        && new Set(snapshot.pendingInvalidationReasons).size !== snapshot.pendingInvalidationReasons.length
    ) {
        findings.push({
            severity: 'warn',
            reasonCode: 'invalidation_not_coalesced',
        });
        reasonCodes.push('invalidation_not_coalesced');
    }

    if (
        snapshot.hasPendingSync
        && (
            !Array.isArray(snapshot.pendingSyncReasons)
            || snapshot.pendingSyncReasons.length === 0
            || hasReasonCountMismatch(snapshot.pendingSyncReasons, snapshot.pendingSyncCounts)
        )
    ) {
        findings.push({
            severity: 'warn',
            reasonCode: 'lost_invalidation_reason',
        });
        reasonCodes.push('lost_invalidation_reason');
    }

    if (snapshot.syncInFlight && snapshot.lastSyncReason && !activeSyncPlan) {
        findings.push({
            severity: 'warn',
            reasonCode: 'lost_invalidation_reason',
        });
        reasonCodes.push('lost_invalidation_reason');
    }

    if (
        activeSyncPlan
        && (
            hasReasonCountMismatch(activeSyncPlan.syncReasons, activeSyncPlan.syncReasonCounts)
            || hasReasonCountMismatch(activeSyncPlan.invalidationReasons, activeSyncPlan.invalidationCounts)
            || (snapshot.lastSyncReason && activeSyncPlan.syncReason !== snapshot.lastSyncReason)
        )
    ) {
        findings.push({
            severity: 'warn',
            reasonCode: 'lost_invalidation_reason',
        });
        reasonCodes.push('lost_invalidation_reason');
    }

    if (
        generationContext
        && (
            hasReasonCountMismatch(generationContext.pendingInvalidationReasons, generationContext.pendingInvalidationCounts)
            || hasReasonCountMismatch(generationContext.consumedInvalidationReasons, generationContext.consumedInvalidationCounts)
        )
    ) {
        findings.push({
            severity: 'warn',
            reasonCode: 'lost_invalidation_reason',
        });
        reasonCodes.push('lost_invalidation_reason');
    }

    if (
        generationContext
        && (
            (generationContext.preflightCompleted === true && !generationContext.preflightSummary)
            || (generationContext.preflightSummary && generationContext.preflightCompleted !== true)
        )
    ) {
        findings.push({
            severity: 'warn',
            reasonCode: 'generation_preflight_order_violation',
        });
        reasonCodes.push('generation_preflight_order_violation');
    }

    if (
        !snapshot.syncInFlight
        && !snapshot.hasPendingSync
        && registrationSnapshot
        && promptContext
    ) {
        const registrationBooks = [...(registrationSnapshot.activeBooks || [])].sort();
        const promptBooks = [...(promptContext.activeBooks || [])].sort();

        if (JSON.stringify(registrationBooks) !== JSON.stringify(promptBooks)) {
            findings.push({
                severity: 'warn',
                reasonCode: 'derived_context_mismatch',
            });
            reasonCodes.push('derived_context_mismatch');
        }

        if (
            JSON.stringify(registrationBooks) === JSON.stringify(promptBooks)
            && promptContext.installedPlanEpoch > 0
            && promptContext.expectedPlanSignature
            && promptContext.installedPlanSignature
            && promptContext.expectedPlanSignature !== promptContext.installedPlanSignature
        ) {
            findings.push({
                severity: 'warn',
                reasonCode: 'stale_prompt_plan',
            });
            reasonCodes.push('stale_prompt_plan');
            safeRepairs.push(createRuntimeRepair({
                id: 'rebuild-prompt-plan',
                label: 'Rebuild prompt injection plan',
                repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
                reasonCode: RUNTIME_REASON_CODES.STALE_PROMPT_PLAN,
                context: {
                    activeBooks: promptBooks,
                },
            }));
        }
    }

    if (findings.length === 0) {
        findings.push({
            severity: 'info',
            reasonCode: null,
        });
    }

    return {
        group: 'orchestration-integrity',
        ok: !findings.some(finding => finding.severity === 'error'),
        summary: findings.some(finding => finding.severity === 'error')
            ? 'Orchestration audit found integrity issues.'
            : findings.some(finding => finding.severity === 'warn')
                ? 'Orchestration audit found coordination issues.'
                : 'Orchestration audit passed.',
        findings,
        reasonCodes: [...new Set(reasonCodes)],
        safeRepairs,
        requiresConfirmation: [],
        context: snapshot,
    };
}

function summarizeRepairsByGroup(audits = [], repairExecution = null) {
    const summaryByGroup = new Map();
    if (!repairExecution?.applied?.length) {
        return summaryByGroup;
    }

    const repairsById = new Map(repairExecution.applied.map(repair => [repair.id, repair]));
    for (const audit of audits) {
        const group = audit?.group;
        if (!group) continue;

        const applied = [];
        for (const repair of Array.isArray(audit.safeRepairs) ? audit.safeRepairs : []) {
            if (repairsById.has(repair.id)) {
                applied.push(repair.id);
            }
        }

        if (applied.length > 0) {
            summaryByGroup.set(group, { applied: [...new Set(applied)] });
        }
    }

    return summaryByGroup;
}

/**
 * Run all structured runtime audits and return their raw results.
 * @returns {Promise<object[]>}
 */
export async function collectRuntimeAudits() {
    const audits = await Promise.all([
        auditToolRegistrationRuntime({ repair: false, reason: 'diagnostics' }),
        auditPromptInjectionRuntime(),
        Promise.resolve(auditPostTurnProcessorRuntime()),
        Promise.resolve(auditSmartContextRuntime()),
        Promise.resolve(auditWorldStateRuntime()),
        Promise.resolve(auditEntryManagerRuntime()),
    ]);

    return [
        ...audits,
        auditOrchestrationRuntime({
            registrationSnapshot: audits[0]?.context || null,
            promptContext: audits[1]?.context || null,
        }),
    ];
}

/**
 * Run all structured runtime audits and return legacy diagnostics results.
 * @returns {Promise<DiagResult[]>}
 */
export async function runRuntimeAuditDiagnostics({ repair = false } = {}) {
    const results = await runRuntimeAuditDiagnosticsDetailed({ repair });
    return results.map(({ status, message, fix }) => ({ status, message, fix }));
}

export async function runRuntimeAuditDiagnosticsDetailed({ repair = false } = {}) {
    const initialAudits = await collectRuntimeAudits();
    const repairExecution = repair
        ? await executeSafeRuntimeAuditRepairs(initialAudits)
        : null;
    const audits = repairExecution?.applied?.length
        ? await collectRuntimeAudits()
        : initialAudits;
    const repairSummaryByGroup = summarizeRepairsByGroup(initialAudits, repairExecution);
    const results = audits.map(audit => formatRuntimeAuditResultDetailed(audit, repairSummaryByGroup.get(audit?.group) || null));

    if (repairExecution?.failed?.length) {
        results.push(makeDiagResult(
            'fail',
            `Runtime repair execution failed for ${repairExecution.failed.length} action(s): ${repairExecution.failed.map(repair => repair.id).join(', ')}.`,
        ));
    }

    return results;
}
