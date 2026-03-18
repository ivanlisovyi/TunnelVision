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
import { countRuntimeFindingsBySeverity } from './runtime-health.js';

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
 * @returns {DiagResult}
 */
export function formatRuntimeAuditResult(audit) {
    if (!audit || typeof audit !== 'object') {
        return makeDiagResult('fail', 'Runtime audit returned no structured result.');
    }

    const severityCounts = countRuntimeFindingsBySeverity(audit.findings || []);
    const reasonSummary = Array.isArray(audit.reasonCodes) && audit.reasonCodes.length > 0
        ? ` Reasons: ${audit.reasonCodes.join(', ')}.`
        : '';
    const summary = audit.summary || 'Runtime audit completed.';
    const message = `${summary} Findings: ${severityCounts.error} error(s), ${severityCounts.warn} warning(s), ${severityCounts.info} info item(s).${reasonSummary}`;

    if (severityCounts.error > 0) {
        return makeDiagResult('fail', message);
    }

    if (severityCounts.warn > 0) {
        return makeDiagResult('warn', message);
    }

    return makeDiagResult('pass', message);
}

/**
 * Build a structured orchestration runtime audit from the index-level runtime snapshot.
 * @returns {object}
 */
export function auditOrchestrationRuntime() {
    const snapshot = getOrchestrationRuntimeSnapshot();
    const findings = [];
    const reasonCodes = [];
    const generationContext = snapshot.lastGenerationContext;

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
        safeRepairs: [],
        requiresConfirmation: [],
        context: snapshot,
    };
}

/**
 * Run all structured runtime audits and return their raw results.
 * @returns {Promise<object[]>}
 */
export async function collectRuntimeAudits() {
    return await Promise.all([
        auditToolRegistrationRuntime({ repair: false, reason: 'diagnostics' }),
        auditPromptInjectionRuntime(),
        Promise.resolve(auditPostTurnProcessorRuntime()),
        Promise.resolve(auditSmartContextRuntime()),
        Promise.resolve(auditWorldStateRuntime()),
        Promise.resolve(auditEntryManagerRuntime()),
        Promise.resolve(auditOrchestrationRuntime()),
    ]);
}

/**
 * Run all structured runtime audits and return legacy diagnostics results.
 * @returns {Promise<DiagResult[]>}
 */
export async function runRuntimeAuditDiagnostics() {
    const audits = await collectRuntimeAudits();
    return audits.map(formatRuntimeAuditResult);
}