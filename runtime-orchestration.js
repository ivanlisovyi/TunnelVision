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

function cloneSyncEffects(effects) {
    return {
        invalidateActiveBookCache: effects?.invalidateActiveBookCache === true,
        invalidateWorldInfoCache: effects?.invalidateWorldInfoCache === true,
        invalidatePreWarmCache: effects?.invalidatePreWarmCache === true,
        refreshUI: effects?.refreshUI === true,
    };
}

function cloneSyncPlan(plan) {
    if (!plan) return null;

    return {
        ...plan,
        syncReasons: [...(plan.syncReasons || [])],
        syncReasonCounts: { ...(plan.syncReasonCounts || {}) },
        invalidationReasons: [...(plan.invalidationReasons || [])],
        invalidationCounts: { ...(plan.invalidationCounts || {}) },
        effects: cloneSyncEffects(plan.effects),
        retryAttempt: Number.isFinite(plan.retryAttempt) ? plan.retryAttempt : 1,
        previousFailureCount: Number.isFinite(plan.previousFailureCount) ? plan.previousFailureCount : 0,
        lastFailureAt: Number.isFinite(plan.lastFailureAt) ? plan.lastFailureAt : 0,
        lastFailureMessage: plan.lastFailureMessage || null,
        maxFailures: Number.isFinite(plan.maxFailures) ? plan.maxFailures : MAX_RUNTIME_SYNC_FAILURES,
    };
}

const MAX_RUNTIME_SYNC_FAILURES = 3;
const BASE_RUNTIME_SYNC_BACKOFF_MS = 1_000;
const MAX_RUNTIME_SYNC_BACKOFF_MS = 30_000;

function computeRuntimeSyncBackoffMs(failureCount) {
    if (!Number.isFinite(failureCount) || failureCount <= 0) return 0;

    return Math.min(
        BASE_RUNTIME_SYNC_BACKOFF_MS * (2 ** Math.max(failureCount - 1, 0)),
        MAX_RUNTIME_SYNC_BACKOFF_MS,
    );
}

function createEmptySyncEffects() {
    return {
        invalidateActiveBookCache: false,
        invalidateWorldInfoCache: false,
        invalidatePreWarmCache: false,
        refreshUI: false,
    };
}

function appendOrderedReason(reasons, counts, reason) {
    if (!reason) return;

    if (reasons[reasons.length - 1] !== reason) {
        reasons.push(reason);
    }

    counts[reason] = (counts[reason] || 0) + 1;
}

function mergeSyncEffects(target, source = {}) {
    target.invalidateActiveBookCache ||= source.invalidateActiveBookCache === true;
    target.invalidateWorldInfoCache ||= source.invalidateWorldInfoCache === true;
    target.invalidatePreWarmCache ||= source.invalidatePreWarmCache === true;
    target.refreshUI ||= source.refreshUI === true;
}

function buildSyncReason(reasons) {
    if (!Array.isArray(reasons) || reasons.length === 0) {
        return 'runtime-sync';
    }

    if (reasons.length === 1) {
        return reasons[0];
    }

    return `coalesced:${reasons.join('+')}`;
}

function mergeReasonCounts(targetReasons, targetCounts, sourceReasons = [], sourceCounts = {}) {
    for (const reason of sourceReasons) {
        if (targetReasons[targetReasons.length - 1] !== reason) {
            targetReasons.push(reason);
        }

        targetCounts[reason] = (targetCounts[reason] || 0) + (sourceCounts[reason] || 0);
    }
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
        pendingSyncReasons: [],
        pendingSyncCounts: {},
        pendingSyncEffects: createEmptySyncEffects(),
        pendingSyncRequestedAt: 0,
        syncRetryCount: 0,
        syncRetryBackoffUntil: 0,
        syncRetryLastFailureAt: 0,
        syncRetryLastErrorMessage: null,
        lastExhaustedSyncPlan: null,
        nextSyncPlanId: 1,
        activeSyncPlan: null,
        lastSyncPlan: null,
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
        appendOrderedReason(
            _state.pendingInvalidationReasons,
            _state.pendingInvalidationCounts,
            context.invalidationReason,
        );
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

export function requestRuntimeSync({
    eventName,
    invalidationReason = null,
    syncReason = null,
    effects = {},
    now = Date.now(),
} = {}) {
    if (
        !_state.syncInFlight
        && !_state.activeSyncPlan
        && _state.pendingSyncReasons.length === 0
        && _state.syncRetryCount === 0
        && _state.syncRetryBackoffUntil === 0
    ) {
        _state.lastExhaustedSyncPlan = null;
        _state.syncRetryLastFailureAt = 0;
        _state.syncRetryLastErrorMessage = null;
    }

    recordOrchestrationEvent(eventName, { invalidationReason }, now);

    appendOrderedReason(
        _state.pendingSyncReasons,
        _state.pendingSyncCounts,
        syncReason || eventName || invalidationReason || 'runtime-sync',
    );

    mergeSyncEffects(_state.pendingSyncEffects, effects);

    if (_state.pendingSyncRequestedAt === 0) {
        _state.pendingSyncRequestedAt = now;
    }

    return getOrchestrationRuntimeSnapshot();
}

export function hasPendingRuntimeSync() {
    return _state.pendingSyncReasons.length > 0;
}

export function getRuntimeSyncBackoffDelay(now = Date.now()) {
    if (!hasPendingRuntimeSync()) return 0;
    if (_state.syncRetryBackoffUntil <= now) return 0;
    return _state.syncRetryBackoffUntil - now;
}

export function beginRuntimeSyncPlan(now = Date.now()) {
    if (_state.syncInFlight || _state.pendingSyncReasons.length === 0) {
        return null;
    }

    if (_state.syncRetryBackoffUntil > now) {
        return null;
    }

    const plan = {
        id: _state.nextSyncPlanId++,
        syncReason: buildSyncReason(_state.pendingSyncReasons),
        syncReasons: [..._state.pendingSyncReasons],
        syncReasonCounts: { ..._state.pendingSyncCounts },
        invalidationReasons: [..._state.pendingInvalidationReasons],
        invalidationCounts: { ..._state.pendingInvalidationCounts },
        effects: cloneSyncEffects(_state.pendingSyncEffects),
        requestedAt: _state.pendingSyncRequestedAt || now,
        retryAttempt: _state.syncRetryCount + 1,
        previousFailureCount: _state.syncRetryCount,
        lastFailureAt: _state.syncRetryLastFailureAt,
        lastFailureMessage: _state.syncRetryLastErrorMessage,
        maxFailures: MAX_RUNTIME_SYNC_FAILURES,
    };

    _state.activeSyncPlan = cloneSyncPlan(plan);
    _state.lastSyncPlan = cloneSyncPlan(plan);
    _state.pendingSyncReasons = [];
    _state.pendingSyncCounts = {};
    _state.pendingSyncEffects = createEmptySyncEffects();
    _state.pendingSyncRequestedAt = 0;

    beginSync(plan.syncReason, now);

    return cloneSyncPlan(plan);
}

export function completeRuntimeSyncPlan({ requeue = false, errorMessage = null, now = Date.now() } = {}) {
    const result = {
        requeued: false,
        exhausted: false,
        failureCount: _state.syncRetryCount,
        backoffMs: 0,
        maxFailures: MAX_RUNTIME_SYNC_FAILURES,
    };

    if (requeue && _state.activeSyncPlan) {
        const requeuedReasons = [];
        const requeuedCounts = {};

        mergeReasonCounts(
            requeuedReasons,
            requeuedCounts,
            _state.activeSyncPlan.syncReasons,
            _state.activeSyncPlan.syncReasonCounts,
        );
        mergeReasonCounts(
            requeuedReasons,
            requeuedCounts,
            _state.pendingSyncReasons,
            _state.pendingSyncCounts,
        );

        _state.pendingSyncReasons = requeuedReasons;
        _state.pendingSyncCounts = requeuedCounts;
        mergeSyncEffects(_state.activeSyncPlan.effects, _state.pendingSyncEffects);
        _state.pendingSyncEffects = cloneSyncEffects(_state.activeSyncPlan.effects);
        _state.pendingSyncRequestedAt ||= now;

        const failureCount = _state.syncRetryCount + 1;
        _state.syncRetryLastFailureAt = now;
        _state.syncRetryLastErrorMessage = errorMessage || 'Unknown runtime sync error';

        if (failureCount >= MAX_RUNTIME_SYNC_FAILURES) {
            _state.lastExhaustedSyncPlan = cloneSyncPlan({
                ..._state.activeSyncPlan,
                retryAttempt: failureCount,
                previousFailureCount: failureCount,
                lastFailureAt: now,
                lastFailureMessage: _state.syncRetryLastErrorMessage,
                maxFailures: MAX_RUNTIME_SYNC_FAILURES,
            });
            _state.pendingSyncReasons = [];
            _state.pendingSyncCounts = {};
            _state.pendingSyncEffects = createEmptySyncEffects();
            _state.pendingSyncRequestedAt = 0;
            _state.syncRetryCount = 0;
            _state.syncRetryBackoffUntil = 0;
            result.exhausted = true;
            result.failureCount = failureCount;
        } else {
            const backoffMs = computeRuntimeSyncBackoffMs(failureCount);
            _state.syncRetryCount = failureCount;
            _state.syncRetryBackoffUntil = now + backoffMs;
            result.requeued = true;
            result.failureCount = failureCount;
            result.backoffMs = backoffMs;
        }
    } else {
        _state.syncRetryCount = 0;
        _state.syncRetryBackoffUntil = 0;
        _state.syncRetryLastFailureAt = 0;
        _state.syncRetryLastErrorMessage = null;
        _state.lastExhaustedSyncPlan = null;
    }

    _state.activeSyncPlan = null;
    completeSync();
    return result;
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
        pendingSyncReasons: [..._state.pendingSyncReasons],
        pendingSyncCounts: { ..._state.pendingSyncCounts },
        pendingSyncEffects: cloneSyncEffects(_state.pendingSyncEffects),
        pendingSyncRequestedAt: _state.pendingSyncRequestedAt,
        syncRetryCount: _state.syncRetryCount,
        syncRetryBackoffUntil: _state.syncRetryBackoffUntil,
        syncRetryLastFailureAt: _state.syncRetryLastFailureAt,
        syncRetryLastErrorMessage: _state.syncRetryLastErrorMessage,
        hasPendingSync: hasPendingRuntimeSync(),
        runtimeSyncBackoffDelay: getRuntimeSyncBackoffDelay(),
        lastExhaustedSyncPlan: cloneSyncPlan(_state.lastExhaustedSyncPlan),
        activeSyncPlan: cloneSyncPlan(_state.activeSyncPlan),
        lastSyncPlan: cloneSyncPlan(_state.lastSyncPlan),
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
        if (patch.pendingSyncReasons !== undefined) {
            _state.pendingSyncReasons = Array.isArray(patch.pendingSyncReasons)
                ? [...patch.pendingSyncReasons]
                : [];
        }
        if (patch.pendingSyncCounts !== undefined) {
            _state.pendingSyncCounts =
                patch.pendingSyncCounts && typeof patch.pendingSyncCounts === 'object'
                    ? { ...patch.pendingSyncCounts }
                    : {};
        }
        if (patch.pendingSyncEffects !== undefined) {
            _state.pendingSyncEffects = cloneSyncEffects(patch.pendingSyncEffects);
        }
        if (patch.pendingSyncRequestedAt !== undefined) _state.pendingSyncRequestedAt = patch.pendingSyncRequestedAt;
        if (patch.syncRetryCount !== undefined) _state.syncRetryCount = patch.syncRetryCount;
        if (patch.syncRetryBackoffUntil !== undefined) _state.syncRetryBackoffUntil = patch.syncRetryBackoffUntil;
        if (patch.syncRetryLastFailureAt !== undefined) _state.syncRetryLastFailureAt = patch.syncRetryLastFailureAt;
        if (patch.syncRetryLastErrorMessage !== undefined) _state.syncRetryLastErrorMessage = patch.syncRetryLastErrorMessage;
        if (patch.lastExhaustedSyncPlan !== undefined) _state.lastExhaustedSyncPlan = cloneSyncPlan(patch.lastExhaustedSyncPlan);
        if (patch.nextSyncPlanId !== undefined) _state.nextSyncPlanId = patch.nextSyncPlanId;
        if (patch.activeSyncPlan !== undefined) _state.activeSyncPlan = cloneSyncPlan(patch.activeSyncPlan);
        if (patch.lastSyncPlan !== undefined) _state.lastSyncPlan = cloneSyncPlan(patch.lastSyncPlan);
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