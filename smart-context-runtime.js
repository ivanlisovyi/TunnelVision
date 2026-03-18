import { getContext } from '../../../st-context.js';
import { getSettings } from './tree-store.js';
import { getActiveTunnelVisionBooks } from './tool-registry.js';
import {
  RUNTIME_AUDIT_GROUPS,
  RUNTIME_AUDIT_SEVERITIES,
  RUNTIME_REASON_CODES,
  RUNTIME_REPAIR_CLASSES,
  createRuntimeAuditResult,
  createRuntimeFinding,
  createRuntimeRepair,
} from './runtime-health.js';
import { hashString } from './shared-utils.js';
import { smartContextRuntimeState } from './smart-context-runtime-state.js';

export const PREWARM_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

export function buildPreWarmCacheKey({
  getContextImpl = getContext,
  getSettingsImpl = getSettings,
  getActiveTunnelVisionBooksImpl = getActiveTunnelVisionBooks,
  hashStringImpl = hashString,
} = {}) {
  try {
    const context = getContextImpl();
    const settings = getSettingsImpl();
    const chat = context.chat || [];
    const chatLen = chat.length;
    const books = getActiveTunnelVisionBooksImpl().sort().join(',');
    const settingsFingerprint = JSON.stringify({
      smartContextLookback: settings.smartContextLookback || 6,
    });

    const lastMsg = chat[chatLen - 1] || null;
    const lastMsgFingerprint = lastMsg
      ? hashStringImpl(
        JSON.stringify({
          is_user: !!lastMsg.is_user,
          name: lastMsg.name || '',
          mes: lastMsg.mes || '',
          tool_invocations:
            Array.isArray(lastMsg?.extra?.tool_invocations)
            && lastMsg.extra.tool_invocations.length > 0,
        }),
      )
      : 0;

    return `${chatLen}:${books}:${settingsFingerprint}:${lastMsgFingerprint}`;
  } catch {
    return null;
  }
}

export function isPreWarmCacheFresh(cacheKey, {
  runtimeState = smartContextRuntimeState,
  now = Date.now(),
} = {}) {
  if (!runtimeState.preWarmedCandidates || runtimeState.preWarmCacheKey !== cacheKey) return false;
  if (!runtimeState.preWarmCachedAt) return false;
  return now - runtimeState.preWarmCachedAt <= PREWARM_CACHE_MAX_AGE_MS;
}

export function getSmartContextRuntimeSnapshot({
  runtimeState = smartContextRuntimeState,
  getContextImpl = getContext,
  getSettingsImpl = getSettings,
  getActiveTunnelVisionBooksImpl = getActiveTunnelVisionBooks,
  buildPreWarmCacheKeyImpl = buildPreWarmCacheKey,
  isPreWarmCacheFreshImpl = isPreWarmCacheFresh,
  derivedKeyCacheSize = 0,
  now = Date.now(),
} = {}) {
  const cacheKey = buildPreWarmCacheKeyImpl({
    getContextImpl,
    getSettingsImpl,
    getActiveTunnelVisionBooksImpl,
  });
  const activeBooks = getActiveTunnelVisionBooksImpl();
  const settings = getSettingsImpl();
  const context = getContextImpl();
  const chatLength = context?.chat?.length || 0;
  const cacheAgeMs = runtimeState.preWarmCachedAt
    ? Math.max(now - runtimeState.preWarmCachedAt, 0)
    : null;
  const cacheFresh = cacheKey
    ? isPreWarmCacheFreshImpl(cacheKey, { runtimeState, now })
    : false;

  return {
    activeBooks,
    chatLength,
    settings,
    cacheKey,
    cachedKey: runtimeState.preWarmCacheKey,
    cacheFresh,
    cacheAgeMs,
    preWarmSource: runtimeState.preWarmSource,
    preWarmEpoch: runtimeState.preWarmEpoch,
    cachedPreWarmEpoch: runtimeState.cachedPreWarmEpoch,
    preWarmInFlight: runtimeState.preWarmInFlight,
    preWarmPendingKey: runtimeState.preWarmPendingKey,
    preWarmPendingEpoch: runtimeState.preWarmPendingEpoch,
    preWarmedCandidates: runtimeState.preWarmedCandidates,
    preWarmedCandidateCount: Array.isArray(runtimeState.preWarmedCandidates)
      ? runtimeState.preWarmedCandidates.length
      : null,
    preWarmCachedAt: runtimeState.preWarmCachedAt,
    lastInjectedEntries: runtimeState.lastInjectedEntries,
    injectedEntryCount: Array.isArray(runtimeState.lastInjectedEntries)
      ? runtimeState.lastInjectedEntries.length
      : null,
    derivedKeyCacheSize,
  };
}

export function auditSmartContextRuntime(snapshot = getSmartContextRuntimeSnapshot()) {
  const findings = [];
  const safeRepairs = [];
  const {
    cacheKey,
    activeBooks,
    settings,
    chatLength,
    cacheAgeMs,
    cacheFresh,
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
    derivedKeyCacheSize,
  } = snapshot;
  const awaitingFreshPreWarm = Boolean(
    preWarmInFlight
    && cacheKey
    && preWarmPendingKey
    && preWarmPendingKey === cacheKey
    && preWarmPendingEpoch >= preWarmEpoch
  );

  if (preWarmedCandidates != null && !Array.isArray(preWarmedCandidates)) {
    findings.push(createRuntimeFinding({
      id: 'smartcontext-prewarm-cache-malformed',
      subsystem: 'smart-context',
      severity: RUNTIME_AUDIT_SEVERITIES.ERROR,
      message: 'Smart-context prewarm cache is malformed.',
      reasonCode: RUNTIME_REASON_CODES.STALE_CACHE_EPOCH,
      repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
      repairActionId: 'reset-smart-context-cache',
      context: { cacheType: typeof preWarmedCandidates },
    }));
  }

  if (
    Array.isArray(preWarmedCandidates)
    && preWarmedCandidates.length > 0
    && cachedPreWarmEpoch !== preWarmEpoch
    && !awaitingFreshPreWarm
  ) {
    findings.push(createRuntimeFinding({
      id: 'smartcontext-stale-cache-epoch',
      subsystem: 'smart-context',
      severity: RUNTIME_AUDIT_SEVERITIES.WARN,
      message: 'Smart-context prewarm cache was produced for an older cache epoch.',
      reasonCode: RUNTIME_REASON_CODES.STALE_CACHE_EPOCH,
      repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
      repairActionId: 'reset-smart-context-cache',
      context: { cachedPreWarmEpoch, preWarmEpoch },
    }));
  }

  if (Array.isArray(preWarmedCandidates) && preWarmedCandidates.length > 0 && !cachedKey) {
    findings.push(createRuntimeFinding({
      id: 'smartcontext-missing-cache-key',
      subsystem: 'smart-context',
      severity: RUNTIME_AUDIT_SEVERITIES.ERROR,
      message: 'Smart-context prewarm candidates exist without a cache key.',
      reasonCode: RUNTIME_REASON_CODES.STALE_CACHE_EPOCH,
      repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
      repairActionId: 'reset-smart-context-cache',
      context: { candidateCount: preWarmedCandidates.length },
    }));
  }

  if (
    Array.isArray(preWarmedCandidates)
    && preWarmedCandidates.length > 0
    && cachedKey
    && cacheKey
    && cachedKey !== cacheKey
    && !awaitingFreshPreWarm
  ) {
    findings.push(createRuntimeFinding({
      id: 'smartcontext-stale-cache-key',
      subsystem: 'smart-context',
      severity: RUNTIME_AUDIT_SEVERITIES.WARN,
      message: 'Smart-context prewarm cache key no longer matches current runtime inputs.',
      reasonCode: RUNTIME_REASON_CODES.STALE_CACHE_EPOCH,
      repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
      repairActionId: 'reset-smart-context-cache',
      context: { cachedKey, expectedKey: cacheKey, cacheAgeMs },
    }));
  }

  if (
    Array.isArray(preWarmedCandidates)
    && preWarmedCandidates.length > 0
    && preWarmCachedAt
    && !cacheFresh
    && !awaitingFreshPreWarm
  ) {
    findings.push(createRuntimeFinding({
      id: 'smartcontext-expired-cache',
      subsystem: 'smart-context',
      severity: RUNTIME_AUDIT_SEVERITIES.WARN,
      message: 'Smart-context prewarm cache is older than the allowed freshness window.',
      reasonCode: RUNTIME_REASON_CODES.STALE_CACHE_EPOCH,
      repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
      repairActionId: 'reset-smart-context-cache',
      context: { cacheAgeMs, maxAgeMs: PREWARM_CACHE_MAX_AGE_MS },
    }));
  }

  if (cachedKey == null && preWarmCachedAt > 0) {
    findings.push(createRuntimeFinding({
      id: 'smartcontext-cache-owner-conflict',
      subsystem: 'smart-context',
      severity: RUNTIME_AUDIT_SEVERITIES.WARN,
      message: 'Smart-context cache freshness metadata exists without cache ownership state.',
      reasonCode: RUNTIME_REASON_CODES.CACHE_OWNER_CONFLICT,
      repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
      repairActionId: 'reset-smart-context-cache',
      context: { preWarmCachedAt, preWarmSource },
    }));
  }

  if (lastInjectedEntries != null && !Array.isArray(lastInjectedEntries)) {
    findings.push(createRuntimeFinding({
      id: 'smartcontext-injection-bookkeeping-malformed',
      subsystem: 'smart-context',
      severity: RUNTIME_AUDIT_SEVERITIES.ERROR,
      message: 'Smart-context injected-entry bookkeeping is malformed.',
      reasonCode: RUNTIME_REASON_CODES.DERIVED_CONTEXT_MISMATCH,
      repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
      repairActionId: 'reset-smart-context-cache',
      context: { injectedEntriesType: typeof lastInjectedEntries },
    }));
  }

  if (
    Array.isArray(lastInjectedEntries)
    && lastInjectedEntries.some(entry => !entry || typeof entry !== 'object' || !Number.isFinite(entry.uid))
  ) {
    findings.push(createRuntimeFinding({
      id: 'smartcontext-injection-bookkeeping-invalid-entry',
      subsystem: 'smart-context',
      severity: RUNTIME_AUDIT_SEVERITIES.WARN,
      message: 'Smart-context injected-entry bookkeeping contains invalid entry metadata.',
      reasonCode: RUNTIME_REASON_CODES.DERIVED_CONTEXT_MISMATCH,
      repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
      repairActionId: 'reset-smart-context-cache',
      context: { injectedEntries: lastInjectedEntries },
    }));
  }

  if (derivedKeyCacheSize > 0 && activeBooks.length === 0) {
    findings.push(createRuntimeFinding({
      id: 'smartcontext-derived-key-cache-without-books',
      subsystem: 'smart-context',
      severity: RUNTIME_AUDIT_SEVERITIES.WARN,
      message: 'Derived smart-context key cache is populated even though no active lorebooks are selected.',
      reasonCode: RUNTIME_REASON_CODES.CACHE_OWNER_CONFLICT,
      repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
      repairActionId: 'reset-smart-context-cache',
      context: { derivedKeyCacheSize },
    }));
  }

  if (findings.length > 0) {
    safeRepairs.push(createRuntimeRepair({
      id: 'reset-smart-context-cache',
      label: 'Reset smart-context caches and derived bookkeeping',
      repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
      reasonCode: findings[0]?.reasonCode || RUNTIME_REASON_CODES.STALE_CACHE_EPOCH,
      context: { activeBooks, chatLength },
    }));
  }

  if (findings.length === 0) {
    findings.push(createRuntimeFinding({
      id: 'smartcontext-runtime-valid',
      subsystem: 'smart-context',
      severity: RUNTIME_AUDIT_SEVERITIES.INFO,
      message: 'Smart-context cache freshness and bookkeeping validated.',
      context: {
        activeBooks,
        chatLength,
        cacheKey,
        cacheFresh,
        cacheAgeMs,
        preWarmSource,
        smartContextEnabled: settings.smartContextEnabled !== false,
      },
    }));
  }

  return createRuntimeAuditResult({
    group: RUNTIME_AUDIT_GROUPS.SMART_CONTEXT,
    ok: findings.every(finding => finding.severity !== RUNTIME_AUDIT_SEVERITIES.ERROR),
    summary: findings.some(finding => finding.severity === RUNTIME_AUDIT_SEVERITIES.ERROR)
      ? 'Smart-context audit found integrity issues.'
      : findings.some(finding => finding.severity === RUNTIME_AUDIT_SEVERITIES.WARN)
        ? 'Smart-context audit found coordination issues.'
        : 'Smart-context audit passed.',
    findings,
    safeRepairs,
    context: {
      ...snapshot,
      settingsSnapshot: {
        smartContextEnabled: settings.smartContextEnabled !== false,
        globalEnabled: settings.globalEnabled !== false,
        smartContextLookback: settings.smartContextLookback || 6,
      },
    },
  });
}