import { registerTools } from './tool-registry.js';
import { prepareAndInjectGenerationPrompts } from './prompt-injection-service.js';
import {
    resetPostTurnEphemeralState,
    rebuildPostTurnMetadata,
    clearPostTurnRollback,
} from './post-turn-processor.js';
import { invalidatePreWarmCache } from './smart-context.js';
import {
    repairWorldStateSections,
    rebuildWorldStateMetadata,
    discardInvalidWorldStateHistory,
} from './world-state.js';
import { invalidateDirtyWorldInfoCache, invalidateWorldInfoCache } from './entry-manager.js';
import { addBackgroundEvent } from './background-events.js';

const SAFE_RUNTIME_REPAIR_ORDER = Object.freeze([
    'invalidate-dirty-worldinfo-cache',
    'reset-entry-manager-cache',
    'reset-smart-context-cache',
    'reparse-world-state-sections',
    'reset-postturn-ephemeral-state',
    'rebuild-tool-registration',
    'rebuild-prompt-plan',
]);

const SAFE_RUNTIME_REPAIR_HANDLERS = Object.freeze({
    'invalidate-dirty-worldinfo-cache': async () => {
        invalidateDirtyWorldInfoCache();
        return true;
    },
    'reset-entry-manager-cache': async () => {
        invalidateWorldInfoCache();
        return true;
    },
    'reset-smart-context-cache': async () => {
        invalidatePreWarmCache();
        return true;
    },
    'reparse-world-state-sections': async () => {
        return repairWorldStateSections();
    },
    'reset-postturn-ephemeral-state': async () => {
        return resetPostTurnEphemeralState();
    },
    'rebuild-tool-registration': async () => {
        await registerTools();
        return true;
    },
    'rebuild-prompt-plan': async () => {
        await prepareAndInjectGenerationPrompts();
        return true;
    },
});

const EXPLICIT_RUNTIME_REPAIR_HANDLERS = Object.freeze({
    'rebuild-world-state-metadata': async () => {
        return rebuildWorldStateMetadata();
    },
    'discard-invalid-world-state-history': async () => {
        return discardInvalidWorldStateHistory();
    },
    'rebuild-postturn-metadata': async () => {
        return rebuildPostTurnMetadata();
    },
    'clear-postturn-rollback': async () => {
        return clearPostTurnRollback();
    },
});

const RUNTIME_REPAIR_HANDLERS = Object.freeze({
    ...SAFE_RUNTIME_REPAIR_HANDLERS,
    ...EXPLICIT_RUNTIME_REPAIR_HANDLERS,
});

function logRuntimeRepairEvent({ status, repair, origin = 'runtime-audit', groups = [], error = null }) {
    addBackgroundEvent({
        icon: status === 'failed' ? 'fa-screwdriver-wrench' : 'fa-wand-magic-sparkles',
        verb: status === 'failed' ? 'Repair failed' : 'Repaired',
        color: status === 'failed' ? '#ef4444' : '#4ade80',
        summary: repair.label || repair.id,
        details: [
            groups.length > 0 ? `Groups: ${groups.join(', ')}` : '',
            origin ? `Source: ${origin}` : '',
            error ? `Error: ${error}` : '',
        ],
    });
}

function collectSafeRepairQueue(audits = []) {
    const repairsById = new Map();

    for (const audit of audits) {
        const group = audit?.group || 'runtime-integrity';
        for (const repair of Array.isArray(audit?.safeRepairs) ? audit.safeRepairs : []) {
            if (!repair?.id || !SAFE_RUNTIME_REPAIR_HANDLERS[repair.id]) {
                continue;
            }

            const existing = repairsById.get(repair.id);
            if (existing) {
                existing.groups.add(group);
                continue;
            }

            repairsById.set(repair.id, {
                ...repair,
                groups: new Set([group]),
            });
        }
    }

    return SAFE_RUNTIME_REPAIR_ORDER
        .filter(id => repairsById.has(id))
        .map(id => {
            const repair = repairsById.get(id);
            return {
                ...repair,
                groups: [...repair.groups],
            };
        });
}

export async function executeSafeRuntimeAuditRepairs(audits = []) {
    const queue = collectSafeRepairQueue(audits);
    const applied = [];
    const failed = [];

    for (const repair of queue) {
        const result = await executeRuntimeRepairAction(repair, {
            origin: 'runtime-audit:auto',
            groups: repair.groups,
        });
        if (result.status === 'applied') {
            applied.push(result.repair);
        } else if (result.status === 'failed') {
            failed.push({
                ...result.repair,
                error: result.error,
            });
        }
    }

    return {
        attempted: queue.length,
        applied,
        failed,
    };
}

export function canExecuteRuntimeRepairAction(repairId) {
    return Boolean(repairId && RUNTIME_REPAIR_HANDLERS[repairId]);
}

export async function executeRuntimeRepairAction(repair, { origin = 'runtime-audit', groups = [] } = {}) {
    const normalizedRepair = {
        id: repair?.id || null,
        label: repair?.label || repair?.id || '',
        groups: Array.isArray(groups) && groups.length > 0
            ? [...groups]
            : Array.isArray(repair?.groups)
                ? [...repair.groups]
                : [],
        context: repair?.context ?? null,
    };
    const handler = normalizedRepair.id ? RUNTIME_REPAIR_HANDLERS[normalizedRepair.id] : null;

    if (!handler) {
        return {
            status: 'failed',
            repair: normalizedRepair,
            error: 'No runtime repair handler is registered for this action.',
        };
    }

    try {
        const changed = await handler(normalizedRepair.context, normalizedRepair.groups);
        if (changed === false) {
            return {
                status: 'skipped',
                repair: normalizedRepair,
                error: null,
            };
        }

        logRuntimeRepairEvent({
            status: 'applied',
            repair: normalizedRepair,
            origin,
            groups: normalizedRepair.groups,
        });
        return {
            status: 'applied',
            repair: normalizedRepair,
            error: null,
        };
    } catch (error) {
        const message = error?.message || String(error);
        logRuntimeRepairEvent({
            status: 'failed',
            repair: normalizedRepair,
            origin,
            groups: normalizedRepair.groups,
            error: message,
        });
        return {
            status: 'failed',
            repair: normalizedRepair,
            error: message,
        };
    }
}