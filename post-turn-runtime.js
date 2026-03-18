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
import { postTurnRuntimeState } from './post-turn-runtime-state.js';

const METADATA_KEY = 'tunnelvision_postturn';
const TRACKER_STALENESS_METADATA_KEY = 'tunnelvision_tracker_hashes';

function getProcessorState(getContextImpl = getContext) {
  try {
    return getContextImpl().chatMetadata?.[METADATA_KEY] || null;
  } catch {
    return null;
  }
}

function getTrackerHashes(getContextImpl = getContext) {
  try {
    const context = getContextImpl();
    return context.chatMetadata?.[TRACKER_STALENESS_METADATA_KEY] || {};
  } catch {
    return {};
  }
}

function isValidRollbackPayload(rollback) {
  if (rollback == null) return true;
  if (typeof rollback !== 'object' || Array.isArray(rollback)) return false;

  if (rollback.book != null && typeof rollback.book !== 'string') {
    return false;
  }

  if (rollback.createdUids != null) {
    if (!Array.isArray(rollback.createdUids) || rollback.createdUids.some(uid => !Number.isFinite(uid))) {
      return false;
    }
  }

  if (rollback.trackerReverts != null) {
    if (!Array.isArray(rollback.trackerReverts)) return false;
    for (const revert of rollback.trackerReverts) {
      if (!revert || typeof revert !== 'object' || Array.isArray(revert)) return false;
      if (!Number.isFinite(revert.uid)) return false;
      if (typeof revert.book !== 'string') return false;
      if (typeof revert.previousContent !== 'string') return false;
    }
  }

  return true;
}

function isValidProcessorMetadata(state) {
  if (state == null) return true;
  if (typeof state !== 'object' || Array.isArray(state)) return false;

  const numericFields = ['lastProcessedMsgIdx', 'lastProcessedAt'];
  for (const field of numericFields) {
    const value = state[field];
    if (value != null && !Number.isFinite(value)) {
      return false;
    }
  }

  if (state.lastResult != null && typeof state.lastResult !== 'object') {
    return false;
  }

  if (state.rollback != null && !isValidRollbackPayload(state.rollback)) {
    return false;
  }

  return true;
}

function auditTrackerHashMetadata(hashes = getTrackerHashes()) {
  const findings = [];

  if (hashes == null) {
    return findings;
  }

  if (typeof hashes !== 'object' || Array.isArray(hashes)) {
    findings.push(createRuntimeFinding({
      id: 'postturn-tracker-hash-metadata-invalid',
      subsystem: 'post-turn-processor',
      severity: RUNTIME_AUDIT_SEVERITIES.ERROR,
      message: 'Tracker hash metadata is malformed.',
      reasonCode: RUNTIME_REASON_CODES.STALE_TRACKER_METADATA,
      repairClass: RUNTIME_REPAIR_CLASSES.EXPLICIT,
      context: { trackerHashesType: typeof hashes },
    }));
    return findings;
  }

  for (const [key, value] of Object.entries(hashes)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      findings.push(createRuntimeFinding({
        id: 'postturn-tracker-hash-entry-invalid',
        subsystem: 'post-turn-processor',
        severity: RUNTIME_AUDIT_SEVERITIES.WARN,
        message: `Tracker hash metadata entry "${key}" is malformed.`,
        reasonCode: RUNTIME_REASON_CODES.STALE_TRACKER_METADATA,
        repairClass: RUNTIME_REPAIR_CLASSES.EXPLICIT,
        context: { key, value },
      }));
      continue;
    }

    if (
      (value.hash != null && !Number.isFinite(value.hash))
      || (value.timestamp != null && !Number.isFinite(value.timestamp))
    ) {
      findings.push(createRuntimeFinding({
        id: 'postturn-tracker-hash-entry-fields-invalid',
        subsystem: 'post-turn-processor',
        severity: RUNTIME_AUDIT_SEVERITIES.WARN,
        message: `Tracker hash metadata entry "${key}" has invalid hash or timestamp fields.`,
        reasonCode: RUNTIME_REASON_CODES.STALE_TRACKER_METADATA,
        repairClass: RUNTIME_REPAIR_CLASSES.EXPLICIT,
        context: { key, value },
      }));
    }
  }

  return findings;
}

function getProcessingGateState({
  getSettingsImpl = getSettings,
  getActiveTunnelVisionBooksImpl = getActiveTunnelVisionBooks,
  getContextImpl = getContext,
  getProcessorStateImpl = getProcessorState,
} = {}) {
  const settings = getSettingsImpl();
  if (!settings.postTurnEnabled || settings.globalEnabled === false) {
    return { allowed: false, reason: 'disabled' };
  }

  const activeBooks = getActiveTunnelVisionBooksImpl();
  if (activeBooks.length === 0) {
    return { allowed: false, reason: 'no-active-books' };
  }

  const context = getContextImpl();
  const chatLength = context.chat?.length || 0;
  const state = getProcessorStateImpl(getContextImpl);
  const lastIdx = state?.lastProcessedMsgIdx ?? -1;
  const cooldown = Math.max(Number(settings.postTurnCooldown) || 1, 1);
  const delta = chatLength - 1 - lastIdx;

  if (delta <= 0) {
    return {
      allowed: false,
      reason: 'already-processed-current-message',
      chatLength,
      lastIdx,
      cooldown,
      delta,
    };
  }

  if (delta < cooldown) {
    return {
      allowed: false,
      reason: 'turn-interval-not-met',
      chatLength,
      lastIdx,
      cooldown,
      delta,
    };
  }

  return {
    allowed: true,
    reason: 'ready',
    chatLength,
    lastIdx,
    cooldown,
    delta,
  };
}

export function getPostTurnProcessorRuntimeSnapshot({
  getContextImpl = getContext,
  getSettingsImpl = getSettings,
  getActiveTunnelVisionBooksImpl = getActiveTunnelVisionBooks,
  runtimeState = postTurnRuntimeState,
} = {}) {
  const state = getProcessorState(getContextImpl);
  const gate = getProcessingGateState({
    getSettingsImpl,
    getActiveTunnelVisionBooksImpl,
    getContextImpl,
    getProcessorStateImpl: getProcessorState,
  });
  const trackerHashes = getTrackerHashes(getContextImpl);

  return {
    metadataKey: METADATA_KEY,
    state,
    gate,
    processorRunning: runtimeState.processorRunning,
    hasCurrentTask: Boolean(runtimeState.currentTask),
    swipePending: runtimeState.swipePending,
    chatRef: { ...runtimeState.chatRef },
    lastArchivedAt: runtimeState.lastArchivedAt,
    hasLiveRollback: Boolean(runtimeState.liveRollback),
    liveRollback: runtimeState.liveRollback,
    trackerHashes,
  };
}

export function auditPostTurnProcessorRuntime(snapshot = getPostTurnProcessorRuntimeSnapshot()) {
  const findings = [];
  const safeRepairs = [];
  const requiresConfirmation = [];

  const {
    state,
    gate,
    processorRunning,
    hasCurrentTask,
    swipePending,
    metadataKey,
    trackerHashes,
  } = snapshot;

  if (!isValidProcessorMetadata(state)) {
    findings.push(createRuntimeFinding({
      id: 'postturn-invalid-metadata',
      subsystem: 'post-turn-processor',
      severity: RUNTIME_AUDIT_SEVERITIES.ERROR,
      message: 'Persisted post-turn processor metadata is malformed.',
      reasonCode: RUNTIME_REASON_CODES.INVALID_PERSISTED_METADATA,
      repairClass: RUNTIME_REPAIR_CLASSES.EXPLICIT,
      repairActionId: 'rebuild-postturn-metadata',
      context: { state },
    }));

    requiresConfirmation.push(createRuntimeRepair({
      id: 'rebuild-postturn-metadata',
      label: 'Rebuild persisted post-turn metadata',
      repairClass: RUNTIME_REPAIR_CLASSES.EXPLICIT,
      reasonCode: RUNTIME_REASON_CODES.INVALID_PERSISTED_METADATA,
      context: { metadataKey },
    }));
  }

  if (state?.rollback != null && !isValidRollbackPayload(state.rollback)) {
    findings.push(createRuntimeFinding({
      id: 'postturn-rollback-mismatch',
      subsystem: 'post-turn-processor',
      severity: RUNTIME_AUDIT_SEVERITIES.ERROR,
      message: 'Persisted rollback payload is malformed or inconsistent.',
      reasonCode: RUNTIME_REASON_CODES.ROLLBACK_MISMATCH,
      repairClass: RUNTIME_REPAIR_CLASSES.EXPLICIT,
      repairActionId: 'clear-postturn-rollback',
      context: { rollback: state.rollback },
    }));

    requiresConfirmation.push(createRuntimeRepair({
      id: 'clear-postturn-rollback',
      label: 'Clear persisted rollback payload',
      repairClass: RUNTIME_REPAIR_CLASSES.EXPLICIT,
      reasonCode: RUNTIME_REASON_CODES.ROLLBACK_MISMATCH,
      context: { metadataKey },
    }));
  }

  if (gate.allowed && gate.reason !== 'ready') {
    findings.push(createRuntimeFinding({
      id: 'postturn-gate-inconsistent-ready',
      subsystem: 'post-turn-processor',
      severity: RUNTIME_AUDIT_SEVERITIES.ERROR,
      message: 'Post-turn processor gate allows execution without reporting a ready state.',
      reasonCode: RUNTIME_REASON_CODES.PROCESSOR_GATE_INCONSISTENCY,
      context: { gate },
    }));
  } else if (!gate.allowed && !gate.reason) {
    findings.push(createRuntimeFinding({
      id: 'postturn-gate-missing-reason',
      subsystem: 'post-turn-processor',
      severity: RUNTIME_AUDIT_SEVERITIES.WARN,
      message: 'Post-turn processor gate denied execution without a reason code.',
      reasonCode: RUNTIME_REASON_CODES.PROCESSOR_GATE_INCONSISTENCY,
      context: { gate },
    }));
  }

  findings.push(...auditTrackerHashMetadata(trackerHashes));

  if (processorRunning && !hasCurrentTask) {
    findings.push(createRuntimeFinding({
      id: 'postturn-running-without-task',
      subsystem: 'post-turn-processor',
      severity: RUNTIME_AUDIT_SEVERITIES.WARN,
      message: 'Post-turn processor is marked running without an active task handle.',
      reasonCode: RUNTIME_REASON_CODES.PROCESSOR_GATE_INCONSISTENCY,
      repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
      repairActionId: 'reset-postturn-ephemeral-state',
      context: {
        processorRunning,
        hasCurrentTask,
      },
    }));

    safeRepairs.push(createRuntimeRepair({
      id: 'reset-postturn-ephemeral-state',
      label: 'Reset post-turn ephemeral state',
      repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
      reasonCode: RUNTIME_REASON_CODES.PROCESSOR_GATE_INCONSISTENCY,
      context: {
        processorRunning,
        swipePending,
      },
    }));
  }

  if (findings.length === 0) {
    findings.push(createRuntimeFinding({
      id: 'postturn-runtime-valid',
      subsystem: 'post-turn-processor',
      severity: RUNTIME_AUDIT_SEVERITIES.INFO,
      message: 'Post-turn processor integrity validated.',
      context: {
        gate,
        processorRunning,
        hasRollback: Boolean(state?.rollback),
      },
    }));
  }

  return createRuntimeAuditResult({
    group: RUNTIME_AUDIT_GROUPS.POST_TURN,
    ok: findings.every(finding => finding.severity !== RUNTIME_AUDIT_SEVERITIES.ERROR),
    summary: findings.some(finding => finding.severity === RUNTIME_AUDIT_SEVERITIES.ERROR)
      ? 'Post-turn processor audit found integrity issues.'
      : findings.some(finding => finding.severity === RUNTIME_AUDIT_SEVERITIES.WARN)
        ? 'Post-turn processor audit found coordination issues.'
        : 'Post-turn processor audit passed.',
    findings,
    safeRepairs,
    requiresConfirmation,
    context: snapshot,
  });
}