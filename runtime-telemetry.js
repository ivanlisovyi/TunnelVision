import { appendRuntimeEvent, createRuntimeCorrelationId } from './runtime-events-log.js';

export function createTaskCorrelationId(taskId) {
    return Number.isFinite(taskId) ? `bg-task-${taskId}` : null;
}

export function createNamedCorrelationId(prefix = 'runtime') {
    return createRuntimeCorrelationId(prefix);
}

export function logRuntimeEvent(payload = {}) {
    return appendRuntimeEvent(payload);
}

export function logRuntimeFailure({
    category,
    source,
    title,
    error,
    taskId = null,
    status = 'failed',
    severity = 'error',
    details = [],
    correlationId = null,
    context = null,
} = {}) {
    return appendRuntimeEvent({
        severity,
        category,
        source,
        status,
        correlationId: correlationId || createTaskCorrelationId(taskId),
        title,
        summary: error?.message || error || 'Unknown error',
        details: [
            Number.isFinite(taskId) ? `Task ID: ${taskId}` : '',
            ...details,
        ].filter(Boolean),
        context,
    });
}

export function logRuntimeRepair({
    status,
    repair,
    origin = 'runtime-audit',
    groups = [],
    error = null,
    correlationId = null,
} = {}) {
    return appendRuntimeEvent({
        severity: status === 'failed' ? 'error' : 'info',
        category: 'runtime-repair',
        source: origin,
        status,
        group: groups.join(', ') || null,
        correlationId,
        title: repair?.label || repair?.id || 'Runtime repair',
        summary: status === 'failed'
            ? `Repair failed${error ? `: ${error}` : '.'}`
            : 'Repair applied successfully.',
        details: [
            repair?.id ? `Action: ${repair.id}` : '',
            groups.length > 0 ? `Groups: ${groups.join(', ')}` : '',
            error ? `Error: ${error}` : '',
        ],
        context: repair?.context ?? null,
    });
}

export function logRuntimeDiagnosticsSummary({
    repair = false,
    totals = { pass: 0, warn: 0, fail: 0 },
    resultCount = 0,
    repairExecution = null,
    correlationId = null,
} = {}) {
    const severity = totals.fail > 0 ? 'error' : totals.warn > 0 ? 'warn' : 'info';

    return appendRuntimeEvent({
        severity,
        category: 'runtime-audit',
        source: 'runtime-diagnostics',
        status: repair ? 'diagnostics-repair' : 'diagnostics',
        correlationId,
        title: repair ? 'Runtime diagnostics with repairs' : 'Runtime diagnostics',
        summary: `${totals.fail} fail, ${totals.warn} warn, ${totals.pass} pass across ${resultCount} checks.`,
        details: repairExecution?.applied?.length
            ? [`Applied repairs: ${repairExecution.applied.map(item => item.id).join(', ')}`]
            : [],
        context: {
            repairApplied: repairExecution?.applied?.length || 0,
            failedRepairs: repairExecution?.failed?.length || 0,
        },
    });
}