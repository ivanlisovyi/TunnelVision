/**
 * TunnelVision Runtime Orchestration
 *
 * Dedicated state container for index-level orchestration bookkeeping.
 * This module keeps runtime coordination state small, explicit, and testable.
 *
 * Responsibilities:
 * - track initialization lifecycle timestamps
 * - track the latest orchestration event
 * - accumulate invalidation reasons until generation consumes them
 * - track tool-registration sync lifecycle state
 * - track the latest generation-start context and preflight outcome
 *
 * This module does not perform orchestration work itself. It only records
 * orchestration state and exposes stable snapshot/debug helpers.
 */

function cloneGenerationContext(context) {
    if (!context) return null;

    return {
        ...context,
        pendingInvalidationReasons: [...(context.pendingInvalidationReasons || [])],
        pendingInvalidationCounts: { ...(context.pendingInvalidationCounts || {}) },
        consumedInvalidationReasons: [...(context.consumedInvalidationReasons || [])],
        consumedInvalidationCounts: { ...(context.consumedInvalidationCounts || {}) },
        preflightSummary: context.preflightSummary
            ? {
                ...context.preflightSummary,
                failureReasons: [...(context.preflightSummary.failureReasons || [])],
            }
            : null,
    };
}

function createInitialState() {
    return {
        initialized: false,
        initStartedAt: 0,
        initCompletedAt: 0,
        lastEvent: null,
        lastEventAt: 0,
        pendingInvalidationReasons: [],
        pendingInvalidationCounts: {},
        lastSyncReason: null,
        lastSyncAt: 0,
        syncInFlight: false,
        syncCount: 0,
        lastGenerationStartedAt: 0,
        lastGenerationContext: null,
    };
}

const _state = createInitialState();

export function beginInitialization(now = Date.now()) {
    _state.initStartedAt = now;
}

export function completeInitialization(now = Date.now()) {
    _state.initialized = true;
    _state.initCompletedAt = now;
}

export function recordOrchestrationEvent(eventName, context = {}, now = Date.now()) {
    _state.lastEvent = eventName || null;
    _state.lastEventAt = now;

    if (context.invalidationReason) {
        _state.pendingInvalidationReasons.push(context.invalidationReason);
        _state.pendingInvalidationCounts[context.invalidationReason] =
            (_state.pendingInvalidationCounts[context.invalidationReason] || 0) + 1;
    }

    if (eventName === 'generation-started') {
        _state.lastGenerationStartedAt = now;
        _state.lastGenerationContext = cloneGenerationContext({
            pendingInvalidationReasons: [..._state.pendingInvalidationReasons],
            pendingInvalidationCounts: { ..._state.pendingInvalidationCounts },
            ...context,
        });
    }
}

export function consumePendingInvalidationState() {
    const snapshot = {
        reasons: [..._state.pendingInvalidationReasons],
        counts: { ..._state.pendingInvalidationCounts },
    };

    _state.pendingInvalidationReasons = [];
    _state.pendingInvalidationCounts = {};

    return snapshot;
}

export function beginSync(reason, now = Date.now()) {
    _state.syncInFlight = true;
    _state.lastSyncReason = reason || null;
    _state.lastSyncAt = now;
    _state.syncCount += 1;
}

export function completeSync() {
    _state.syncInFlight = false;
}

export function updateLastGenerationContext(patch = {}) {
    const current = _state.lastGenerationContext || {};
    _state.lastGenerationContext = cloneGenerationContext({
        ...current,
        ...patch,
    });
}

export function recordGenerationPreflightSummary(runtimeState) {
    if (!_state.lastGenerationContext) {
        _state.lastGenerationContext = cloneGenerationContext({});
    }

    _state.lastGenerationContext = cloneGenerationContext({
        ..._state.lastGenerationContext,
        preflightCompleted: true,
        preflightSummary: {
            activeBooks: Array.isArray(runtimeState?.activeBooks) ? runtimeState.activeBooks.length : 0,
            expectedTools: Array.isArray(runtimeState?.expectedToolNames) ? runtimeState.expectedToolNames.length : 0,
            eligibleTools: Array.isArray(runtimeState?.eligibleToolNames) ? runtimeState.eligibleToolNames.length : 0,
            repairApplied: runtimeState?.repairApplied === true,
            failureReasons: [...(runtimeState?.failureReasons || [])],
        },
    });
}

export function getOrchestrationRuntimeSnapshot() {
    return {
        initialized: _state.initialized,
        initStartedAt: _state.initStartedAt,
        initCompletedAt: _state.initCompletedAt,
        lastEvent: _state.lastEvent,
        lastEventAt: _state.lastEventAt,
        pendingInvalidationReasons: [..._state.pendingInvalidationReasons],
        pendingInvalidationCounts: { ..._state.pendingInvalidationCounts },
        lastSyncReason: _state.lastSyncReason,
        lastSyncAt: _state.lastSyncAt,
        syncInFlight: _state.syncInFlight,
        syncCount: _state.syncCount,
        lastGenerationStartedAt: _state.lastGenerationStartedAt,
        lastGenerationContext: cloneGenerationContext(_state.lastGenerationContext),
    };
}

export const __orchestrationDebug = {
    getRuntimeSnapshot: getOrchestrationRuntimeSnapshot,
    setRuntimeState(patch = {}) {
        if (!patch || typeof patch !== 'object') return;

        if (patch.initialized !== undefined) _state.initialized = !!patch.initialized;
        if (patch.initStartedAt !== undefined) _state.initStartedAt = patch.initStartedAt;
        if (patch.initCompletedAt !== undefined) _state.initCompletedAt = patch.initCompletedAt;
        if (patch.lastEvent !== undefined) _state.lastEvent = patch.lastEvent;
        if (patch.lastEventAt !== undefined) _state.lastEventAt = patch.lastEventAt;

        if (patch.pendingInvalidationReasons !== undefined) {
            _state.pendingInvalidationReasons = Array.isArray(patch.pendingInvalidationReasons)
                ? [...patch.pendingInvalidationReasons]
                : [];
        }

        if (patch.pendingInvalidationCounts !== undefined) {
            _state.pendingInvalidationCounts =
                patch.pendingInvalidationCounts && typeof patch.pendingInvalidationCounts === 'object'
                    ? { ...patch.pendingInvalidationCounts }
                    : {};
        }

        if (patch.lastSyncReason !== undefined) _state.lastSyncReason = patch.lastSyncReason;
        if (patch.lastSyncAt !== undefined) _state.lastSyncAt = patch.lastSyncAt;
        if (patch.syncInFlight !== undefined) _state.syncInFlight = !!patch.syncInFlight;
        if (patch.syncCount !== undefined) _state.syncCount = patch.syncCount;
        if (patch.lastGenerationStartedAt !== undefined) _state.lastGenerationStartedAt = patch.lastGenerationStartedAt;
        if (patch.lastGenerationContext !== undefined) {
            _state.lastGenerationContext = cloneGenerationContext(patch.lastGenerationContext);
        }
    },
    reset() {
        const fresh = createInitialState();
        Object.assign(_state, fresh);
    },
};