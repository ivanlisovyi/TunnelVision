import { getContext } from '../../../st-context.js';
import {
    RUNTIME_AUDIT_GROUPS,
    RUNTIME_AUDIT_SEVERITIES,
    RUNTIME_REASON_CODES,
    RUNTIME_REPAIR_CLASSES,
    createRuntimeAuditResult,
    createRuntimeFinding,
    createRuntimeRepair,
} from './runtime-health.js';
import { worldStateRuntimeState } from './world-state-runtime-state.js';

const METADATA_KEY = 'tunnelvision_worldstate';
const EXPECTED_SECTIONS = [
    '## Current Scene',
    '## Recent Changes',
    '## Off-Screen',
    '## Pending',
    '## Active Threads',
    '## Unresolved Threads',
    '## World Pressures',
    '## Key Character States',
    '## Story Momentum',
];
const SECTION_HEADER_RE = /^##\s+(.+)$/gm;

function getWorldState(getContextImpl = getContext) {
    try {
        return getContextImpl().chatMetadata?.[METADATA_KEY] || null;
    } catch {
        return null;
    }
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateWorldStateStructure(text) {
    if (!text || text.length < 200) {
        return { valid: false, reason: `too short (${text?.length || 0} chars, need ≥200)` };
    }
    if (/^[\s]*[\[{]/.test(text) || /```/.test(text)) {
        return { valid: false, reason: 'contains JSON or code fences' };
    }
    const matched = EXPECTED_SECTIONS.filter(h => text.includes(h));
    if (matched.length < 4) {
        return { valid: false, reason: `only ${matched.length}/9 expected ## headers found (need ≥4)` };
    }
    return { valid: true };
}

function parseWorldStateSections(text) {
    const sections = {};
    const headers = [];
    let match;
    SECTION_HEADER_RE.lastIndex = 0;
    while ((match = SECTION_HEADER_RE.exec(text)) !== null) {
        headers.push({ name: match[1].trim(), start: match.index });
    }
    for (let index = 0; index < headers.length; index++) {
        const end = index + 1 < headers.length ? headers[index + 1].start : text.length;
        const body = text.substring(headers[index].start, end).trim();
        sections[headers[index].name] = body;
    }
    return sections;
}

function getWorldStateSections(getContextImpl = getContext) {
    const state = getWorldState(getContextImpl);
    if (!state?.text) return null;
    if (isPlainObject(state.sections)) {
        return state.sections;
    }
    try {
        return parseWorldStateSections(state.text);
    } catch {
        return null;
    }
}

function isValidWorldStateMetadata(state) {
    if (state == null) return true;
    if (!isPlainObject(state)) return false;

    if (state.lastUpdated != null && !Number.isFinite(state.lastUpdated)) return false;
    if (state.lastUpdateMsgIdx != null && !Number.isFinite(state.lastUpdateMsgIdx)) return false;
    if (state.epoch != null && !Number.isFinite(state.epoch)) return false;
    if (state.sectionsEpoch != null && !Number.isFinite(state.sectionsEpoch)) return false;
    if (state.text != null && typeof state.text !== 'string') return false;
    if (state.previousText != null && typeof state.previousText !== 'string') return false;
    if (state.sections != null && !isPlainObject(state.sections)) return false;

    if (isPlainObject(state.sections)) {
        for (const [name, body] of Object.entries(state.sections)) {
            if (typeof name !== 'string' || typeof body !== 'string') return false;
        }
    }

    return true;
}

export function getWorldStateRuntimeSnapshot({
    getContextImpl = getContext,
    runtimeState = worldStateRuntimeState,
} = {}) {
    const state = getWorldState(getContextImpl);
    const sections = getWorldStateSections(getContextImpl);
    return {
        metadataKey: METADATA_KEY,
        state,
        stateEpoch: Number.isFinite(state?.epoch) ? state.epoch : 0,
        sectionsEpoch: Number.isFinite(state?.sectionsEpoch) ? state.sectionsEpoch : 0,
        sections,
        updateRunning: runtimeState.updateRunning,
        priorityRequested: runtimeState.priorityRequested,
        priorityContext: runtimeState.priorityContext,
        chatRef: { ...runtimeState.chatRef },
    };
}

export function auditWorldStateRuntime(snapshot = getWorldStateRuntimeSnapshot()) {
    const findings = [];
    const safeRepairs = [];
    const requiresConfirmation = [];
    const {
        state,
        stateEpoch,
        sectionsEpoch,
        sections,
        updateRunning,
        priorityRequested,
        priorityContext,
        metadataKey,
    } = snapshot;

    if (!isValidWorldStateMetadata(state)) {
        findings.push(createRuntimeFinding({
            id: 'worldstate-invalid-metadata',
            subsystem: 'world-state',
            severity: RUNTIME_AUDIT_SEVERITIES.ERROR,
            message: 'Persisted world-state metadata is malformed.',
            reasonCode: RUNTIME_REASON_CODES.INVALID_WORLD_STATE_METADATA,
            repairClass: RUNTIME_REPAIR_CLASSES.EXPLICIT,
            repairActionId: 'rebuild-world-state-metadata',
            context: { state },
        }));

        requiresConfirmation.push(createRuntimeRepair({
            id: 'rebuild-world-state-metadata',
            label: 'Rebuild persisted world-state metadata',
            repairClass: RUNTIME_REPAIR_CLASSES.EXPLICIT,
            reasonCode: RUNTIME_REASON_CODES.INVALID_WORLD_STATE_METADATA,
            context: { metadataKey },
        }));
    }

    if (state?.text && !validateWorldStateStructure(state.text).valid) {
        const validation = validateWorldStateStructure(state.text);
        findings.push(createRuntimeFinding({
            id: 'worldstate-invalid-structure',
            subsystem: 'world-state',
            severity: RUNTIME_AUDIT_SEVERITIES.ERROR,
            message: `Persisted world-state text failed structural validation: ${validation.reason}`,
            reasonCode: RUNTIME_REASON_CODES.INVALID_WORLD_STATE_METADATA,
            repairClass: RUNTIME_REPAIR_CLASSES.EXPLICIT,
            repairActionId: 'rebuild-world-state-metadata',
            context: {
                validation,
                textLength: state.text.length,
            },
        }));
    }

    if (
        state?.text
        && isPlainObject(state?.sections)
        && JSON.stringify(parseWorldStateSections(state.text)) !== JSON.stringify(state.sections)
    ) {
        findings.push(createRuntimeFinding({
            id: 'worldstate-sections-stale',
            subsystem: 'world-state',
            severity: RUNTIME_AUDIT_SEVERITIES.WARN,
            message: 'Persisted world-state sections are stale relative to the current text payload.',
            reasonCode: RUNTIME_REASON_CODES.STALE_WORLD_STATE_OUTPUT,
            repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
            repairActionId: 'reparse-world-state-sections',
            context: {
                parsedSections: parseWorldStateSections(state.text),
                persistedSections: state.sections,
            },
        }));

        safeRepairs.push(createRuntimeRepair({
            id: 'reparse-world-state-sections',
            label: 'Rebuild parsed world-state sections from current text',
            repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
            reasonCode: RUNTIME_REASON_CODES.STALE_WORLD_STATE_OUTPUT,
            context: { metadataKey },
        }));
    }

    if (
        state?.text
        && isPlainObject(state?.sections)
        && stateEpoch > 0
        && sectionsEpoch > 0
        && sectionsEpoch !== stateEpoch
    ) {
        findings.push(createRuntimeFinding({
            id: 'worldstate-sections-epoch-stale',
            subsystem: 'world-state',
            severity: RUNTIME_AUDIT_SEVERITIES.WARN,
            message: 'World-state section metadata was built for an older world-state epoch.',
            reasonCode: RUNTIME_REASON_CODES.STALE_WORLD_STATE_OUTPUT,
            repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
            repairActionId: 'reparse-world-state-sections',
            context: { stateEpoch, sectionsEpoch },
        }));

        if (!safeRepairs.some(repair => repair.id === 'reparse-world-state-sections')) {
            safeRepairs.push(createRuntimeRepair({
                id: 'reparse-world-state-sections',
                label: 'Rebuild parsed world-state sections from current text',
                repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
                reasonCode: RUNTIME_REASON_CODES.STALE_WORLD_STATE_OUTPUT,
                context: { metadataKey },
            }));
        }
    }

    if (state?.previousText && typeof state.previousText === 'string' && !validateWorldStateStructure(state.previousText).valid) {
        findings.push(createRuntimeFinding({
            id: 'worldstate-previous-text-invalid',
            subsystem: 'world-state',
            severity: RUNTIME_AUDIT_SEVERITIES.WARN,
            message: 'Previous world-state snapshot is present but structurally invalid.',
            reasonCode: RUNTIME_REASON_CODES.STALE_WORLD_STATE_OUTPUT,
            repairClass: RUNTIME_REPAIR_CLASSES.EXPLICIT,
            repairActionId: 'discard-invalid-world-state-history',
            context: { previousTextLength: state.previousText.length },
        }));

        requiresConfirmation.push(createRuntimeRepair({
            id: 'discard-invalid-world-state-history',
            label: 'Discard invalid previous world-state snapshot',
            repairClass: RUNTIME_REPAIR_CLASSES.EXPLICIT,
            reasonCode: RUNTIME_REASON_CODES.STALE_WORLD_STATE_OUTPUT,
            context: { metadataKey: METADATA_KEY },
        }));
    }

    if (updateRunning && priorityRequested) {
        findings.push(createRuntimeFinding({
            id: 'worldstate-priority-overlap',
            subsystem: 'world-state',
            severity: RUNTIME_AUDIT_SEVERITIES.WARN,
            message: 'Priority world-state update is still queued while an update is already running.',
            reasonCode: RUNTIME_REASON_CODES.WORLD_STATE_INJECTION_INTEGRITY_FAILURE,
            context: { updateRunning, priorityRequested, priorityContext },
        }));
    }

    if (state?.text && (!sections || Object.keys(sections).length === 0)) {
        findings.push(createRuntimeFinding({
            id: 'worldstate-missing-sections',
            subsystem: 'world-state',
            severity: RUNTIME_AUDIT_SEVERITIES.WARN,
            message: 'World-state text exists but no parsed sections are currently available.',
            reasonCode: RUNTIME_REASON_CODES.WORLD_STATE_INJECTION_INTEGRITY_FAILURE,
            repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
            repairActionId: 'reparse-world-state-sections',
            context: { textLength: state.text.length },
        }));

        if (!safeRepairs.some(repair => repair.id === 'reparse-world-state-sections')) {
            safeRepairs.push(createRuntimeRepair({
                id: 'reparse-world-state-sections',
                label: 'Rebuild parsed world-state sections from current text',
                repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
                reasonCode: RUNTIME_REASON_CODES.WORLD_STATE_INJECTION_INTEGRITY_FAILURE,
                context: { metadataKey },
            }));
        }
    }

    if (findings.length === 0) {
        findings.push(createRuntimeFinding({
            id: 'worldstate-runtime-valid',
            subsystem: 'world-state',
            severity: RUNTIME_AUDIT_SEVERITIES.INFO,
            message: 'World-state metadata, sections, and update state validated.',
            context: {
                hasState: Boolean(state),
                sectionCount: sections ? Object.keys(sections).length : 0,
                stateEpoch,
                sectionsEpoch,
                updateRunning,
                priorityRequested,
            },
        }));
    }

    return createRuntimeAuditResult({
        group: RUNTIME_AUDIT_GROUPS.WORLD_STATE,
        ok: findings.every(finding => finding.severity !== RUNTIME_AUDIT_SEVERITIES.ERROR),
        summary: findings.some(finding => finding.severity === RUNTIME_AUDIT_SEVERITIES.ERROR)
            ? 'World-state audit found integrity issues.'
            : findings.some(finding => finding.severity === RUNTIME_AUDIT_SEVERITIES.WARN)
                ? 'World-state audit found coordination issues.'
                : 'World-state audit passed.',
        findings,
        safeRepairs,
        requiresConfirmation,
        context: {
            ...snapshot,
            hasState: Boolean(state),
            sectionCount: sections ? Object.keys(sections).length : 0,
        },
    });
}