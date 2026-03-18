/**
 * TunnelVision Runtime Health
 *
 * Shared Phase 1 primitives for structured runtime audits.
 * Keep this intentionally small: stable reason codes, repair classes,
 * severities, and helper builders for subsystem audit results.
 */

export const RUNTIME_AUDIT_GROUPS = Object.freeze({
    REGISTRATION: 'registration-integrity',
    PROMPT_INJECTION: 'prompt-injection-integrity',
    POST_TURN: 'post-turn-processor-integrity',
    SMART_CONTEXT: 'smart-context-integrity',
    WORLD_STATE: 'world-state-integrity',
    METADATA: 'metadata-integrity',
    INVALIDATION: 'invalidation-integrity',
    SIDECAR: 'sidecar-integrity',
    BACKGROUND_TASKS: 'background-task-integrity',
});

export const RUNTIME_AUDIT_SEVERITIES = Object.freeze({
    INFO: 'info',
    WARN: 'warn',
    ERROR: 'error',
});

export const RUNTIME_REPAIR_CLASSES = Object.freeze({
    SAFE_AUTO: 'safe_auto',
    EXPLICIT: 'explicit',
    DESTRUCTIVE: 'destructive',
});

export const RUNTIME_REASON_CODES = Object.freeze({
    MISSING_REGISTRATION: 'missing_registration',
    STEALTH_REGISTRATION: 'stealth_registration',
    ELIGIBILITY_MISMATCH: 'eligibility_mismatch',
    REDUNDANT_REGISTRATION: 'redundant_registration',
    STALE_PROMPT_TOOL_METADATA: 'stale_prompt_tool_metadata',

    STALE_PROMPT_PLAN: 'stale_prompt_plan',
    NONDETERMINISTIC_BUDGET: 'nondeterministic_budget',
    RECURSIVE_PASS_STATE_LEAK: 'recursive_pass_state_leak',
    PROMPT_KEY_INTEGRITY_FAILURE: 'prompt_key_integrity_failure',

    INVALID_PERSISTED_METADATA: 'invalid_persisted_metadata',
    ROLLBACK_MISMATCH: 'rollback_mismatch',
    PROCESSOR_GATE_INCONSISTENCY: 'processor_gate_inconsistency',
    STALE_TRACKER_METADATA: 'stale_tracker_metadata',

    STALE_CACHE_EPOCH: 'stale_cache_epoch',
    DERIVED_CONTEXT_MISMATCH: 'derived_context_mismatch',
    CACHE_OWNER_CONFLICT: 'cache_owner_conflict',

    INVALID_WORLD_STATE_METADATA: 'invalid_world_state_metadata',
    STALE_WORLD_STATE_OUTPUT: 'stale_world_state_output',
    WORLD_STATE_INJECTION_INTEGRITY_FAILURE: 'world_state_injection_integrity_failure',

    INVALIDATION_NOT_COALESCED: 'invalidation_not_coalesced',
    GENERATION_PREFLIGHT_ORDER_VIOLATION: 'generation_preflight_order_violation',
    LOST_INVALIDATION_REASON: 'lost_invalidation_reason',
    RUNTIME_SYNC_BACKOFF: 'runtime_sync_backoff',
    RUNTIME_SYNC_EXHAUSTED: 'runtime_sync_exhausted',
    SIDECAR_CIRCUIT_OPEN: 'sidecar_circuit_open',
    SIDECAR_FAILURE_STREAK: 'sidecar_failure_streak',
    BACKGROUND_TASK_FAILURES: 'background_task_failures',
    BACKGROUND_TASK_STALLED: 'background_task_stalled',
});

function toArray(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (value == null || value === '') return [];
    return [value];
}

function normalizeSeverity(severity) {
    return Object.values(RUNTIME_AUDIT_SEVERITIES).includes(severity)
        ? severity
        : RUNTIME_AUDIT_SEVERITIES.INFO;
}

function normalizeRepairClass(repairClass) {
    return Object.values(RUNTIME_REPAIR_CLASSES).includes(repairClass)
        ? repairClass
        : null;
}

export function createRuntimeFinding({
    id,
    subsystem,
    severity = RUNTIME_AUDIT_SEVERITIES.INFO,
    message = '',
    reasonCode = null,
    repairClass = null,
    repairActionId = null,
    context = null,
} = {}) {
    return {
        id: id || null,
        subsystem: subsystem || null,
        severity: normalizeSeverity(severity),
        message: String(message || ''),
        reasonCode: reasonCode || null,
        repairClass: normalizeRepairClass(repairClass),
        repairActionId: repairActionId || null,
        context: context ?? null,
    };
}

export function createRuntimeRepair({
    id,
    label,
    repairClass = RUNTIME_REPAIR_CLASSES.EXPLICIT,
    reasonCode = null,
    context = null,
} = {}) {
    return {
        id: id || null,
        label: String(label || ''),
        repairClass: normalizeRepairClass(repairClass) || RUNTIME_REPAIR_CLASSES.EXPLICIT,
        reasonCode: reasonCode || null,
        context: context ?? null,
    };
}

export function createRuntimeAuditResult({
    group,
    ok = true,
    summary = '',
    findings = [],
    safeRepairs = [],
    requiresConfirmation = [],
    reasonCodes = [],
    context = null,
} = {}) {
    const normalizedFindings = Array.isArray(findings)
        ? findings.filter(Boolean)
        : [];
    const derivedReasonCodes = new Set([
        ...toArray(reasonCodes),
        ...normalizedFindings.map(f => f?.reasonCode).filter(Boolean),
    ]);

    return {
        group: group || 'runtime-integrity',
        ok: Boolean(ok) && !normalizedFindings.some(f => f?.severity === RUNTIME_AUDIT_SEVERITIES.ERROR),
        summary: String(summary || ''),
        findings: normalizedFindings,
        safeRepairs: Array.isArray(safeRepairs) ? safeRepairs.filter(Boolean) : [],
        requiresConfirmation: Array.isArray(requiresConfirmation) ? requiresConfirmation.filter(Boolean) : [],
        reasonCodes: [...derivedReasonCodes],
        context: context ?? null,
    };
}

export function summarizeRuntimeAudit(result) {
    if (!result) return 'Runtime audit unavailable';

    const findingCount = Array.isArray(result.findings) ? result.findings.length : 0;
    const severityCounts = countRuntimeFindingsBySeverity(result.findings || []);
    const state = result.ok ? 'ok' : 'issues';

    return [
        result.group || 'runtime-integrity',
        state,
        `findings=${findingCount}`,
        `errors=${severityCounts.error}`,
        `warn=${severityCounts.warn}`,
        `info=${severityCounts.info}`,
    ].join(' | ');
}

export function countRuntimeFindingsBySeverity(findings = []) {
    const counts = {
        info: 0,
        warn: 0,
        error: 0,
    };

    for (const finding of findings) {
        const severity = normalizeSeverity(finding?.severity);
        counts[severity] += 1;
    }

    return counts;
}

export function mergeRuntimeAuditResults(results = []) {
    const normalized = Array.isArray(results) ? results.filter(Boolean) : [];
    const findings = normalized.flatMap(result => Array.isArray(result.findings) ? result.findings : []);
    const safeRepairs = normalized.flatMap(result => Array.isArray(result.safeRepairs) ? result.safeRepairs : []);
    const requiresConfirmation = normalized.flatMap(result => Array.isArray(result.requiresConfirmation) ? result.requiresConfirmation : []);
    const reasonCodes = [...new Set(normalized.flatMap(result => toArray(result.reasonCodes)))];

    return createRuntimeAuditResult({
        group: 'runtime-integrity',
        ok: normalized.every(result => result.ok !== false),
        summary: normalized.map(summarizeRuntimeAudit).join(' || '),
        findings,
        safeRepairs,
        requiresConfirmation,
        reasonCodes,
        context: {
            groups: normalized.map(result => result.group).filter(Boolean),
        },
    });
}

export function hasRuntimeReasonCode(result, reasonCode) {
    if (!result || !reasonCode) return false;
    return toArray(result.reasonCodes).includes(reasonCode)
        || (Array.isArray(result.findings) && result.findings.some(f => f?.reasonCode === reasonCode));
}

export function getRuntimeFindingsByReason(result, reasonCode) {
    if (!result || !reasonCode || !Array.isArray(result.findings)) return [];
    return result.findings.filter(finding => finding?.reasonCode === reasonCode);
}