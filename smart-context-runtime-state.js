export const smartContextRuntimeState = {
  preWarmedCandidates: null,
  preWarmCacheKey: null,
  preWarmSource: "smart-context",
  lastReportedPreWarmKey: null,
  preWarmCachedAt: 0,
  preWarmEpoch: 0,
  cachedPreWarmEpoch: 0,
  preWarmInFlight: false,
  preWarmPendingKey: null,
  preWarmPendingEpoch: 0,
  preWarmRequestId: 0,
  lastInjectedEntries: [],
  lastReportedInjectionKey: null,
};

export function setSmartContextRuntimeSnapshotState({
  preWarmedCandidates,
  cachedKey,
  preWarmSource,
  preWarmCachedAt,
  preWarmEpoch,
  cachedPreWarmEpoch,
  preWarmInFlight,
  preWarmPendingKey,
  preWarmPendingEpoch,
  lastInjectedEntries,
} = {}) {
  if (preWarmedCandidates !== undefined)
    smartContextRuntimeState.preWarmedCandidates = preWarmedCandidates;
  if (cachedKey !== undefined)
    smartContextRuntimeState.preWarmCacheKey = cachedKey;
  if (preWarmSource !== undefined)
    smartContextRuntimeState.preWarmSource = preWarmSource;
  if (preWarmCachedAt !== undefined)
    smartContextRuntimeState.preWarmCachedAt = preWarmCachedAt;
  if (preWarmEpoch !== undefined)
    smartContextRuntimeState.preWarmEpoch = preWarmEpoch;
  if (cachedPreWarmEpoch !== undefined)
    smartContextRuntimeState.cachedPreWarmEpoch = cachedPreWarmEpoch;
  if (preWarmInFlight !== undefined)
    smartContextRuntimeState.preWarmInFlight = preWarmInFlight;
  if (preWarmPendingKey !== undefined)
    smartContextRuntimeState.preWarmPendingKey = preWarmPendingKey;
  if (preWarmPendingEpoch !== undefined)
    smartContextRuntimeState.preWarmPendingEpoch = preWarmPendingEpoch;
  if (lastInjectedEntries !== undefined)
    smartContextRuntimeState.lastInjectedEntries = lastInjectedEntries;
}