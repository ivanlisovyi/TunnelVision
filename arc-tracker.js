/**
 * TunnelVision Arc Tracker
 *
 * Tracks multi-scene narrative arcs: creation, progression, resolution.
 * Arcs are stored in chat_metadata and surfaced in the world state injection
 * and the activity feed's arcs panel.
 *
 * Extracted into its own module to avoid circular dependencies between
 * post-turn-processor.js (which writes arcs) and world-state.js (which reads them).
 */

import { getContext } from '../../../st-context.js';

const ARCS_KEY = 'tunnelvision_arcs';
const VALID_STATUSES = new Set(['active', 'stalled', 'resolved', 'abandoned']);
const MAX_HISTORY = 10;

// ── Persistence ──────────────────────────────────────────────────

function generateArcId() {
    const arr = new Uint8Array(4);
    crypto.getRandomValues(arr);
    return `arc_${Date.now()}_${Array.from(arr, b => b.toString(36).padStart(2, '0')).join('')}`;
}

function getArcsState() {
    try {
        return getContext().chatMetadata?.[ARCS_KEY] || { arcs: [], lastUpdated: 0 };
    } catch {
        return { arcs: [], lastUpdated: 0 };
    }
}

function setArcsState(state) {
    try {
        const context = getContext();
        if (!context.chatMetadata) return;
        context.chatMetadata[ARCS_KEY] = state;
        context.saveMetadataDebounced?.();
    } catch { /* metadata not available */ }
}

// ── Queries ──────────────────────────────────────────────────────

/**
 * Get the list of active (non-resolved, non-abandoned) arcs.
 * @returns {Array<{id:string, title:string, status:string, progression:string, createdAt:number, updatedAt:number}>}
 */
export function getActiveArcs() {
    return getArcsState().arcs.filter(a => a.status !== 'resolved' && a.status !== 'abandoned');
}

/**
 * Get all arcs including resolved/abandoned ones.
 * @returns {Array<{id:string, title:string, status:string, progression:string, createdAt:number, updatedAt:number, history:Array}>}
 */
export function getAllArcs() {
    return getArcsState().arcs;
}

/**
 * Build a compact markdown summary of current arcs for prompt injection.
 * Returns empty string if no arcs exist.
 * @returns {string}
 */
export function buildArcsSummary() {
    const arcs = getArcsState().arcs;
    if (arcs.length === 0) return '';

    const lines = arcs.map(a => {
        const statusTag = a.status === 'active' ? '' : ` [${a.status}]`;
        return `- **${a.title}**${statusTag}: ${a.progression || '(no progression noted)'}`;
    });

    return '## Narrative Arcs\n' + lines.join('\n');
}

/**
 * Build the "[Current Known Arcs]" context block for the post-turn analysis prompt.
 * @returns {string}
 */
export function buildArcsContextBlock() {
    const arcs = getArcsState().arcs;
    if (arcs.length === 0) return '';

    const arcLines = arcs.map(a => `  - [${a.id}] "${a.title}" (${a.status}): ${a.progression || 'N/A'}`);
    return '\n[Current Known Arcs]\n' + arcLines.join('\n') + '\n';
}

// ── Mutations ────────────────────────────────────────────────────

/**
 * Process arc updates from the LLM analysis response.
 * Creates new arcs or updates existing ones, maintaining a history log.
 *
 * @param {Array<{id:string|null, title:string, status:string, progression:string}>} arcUpdates
 * @returns {{ created: number, updated: number, resolved: number }}
 */
export function processArcUpdates(arcUpdates) {
    const result = { created: 0, updated: 0, resolved: 0 };
    if (!Array.isArray(arcUpdates) || arcUpdates.length === 0) return result;

    const state = getArcsState();
    const arcs = [...state.arcs];
    const now = Date.now();
    const arcMap = new Map(arcs.map(a => [a.id, a]));

    for (const update of arcUpdates) {
        if (!update?.title || !update?.status) continue;

        const status = String(update.status).toLowerCase();
        if (!VALID_STATUSES.has(status)) continue;

        if (update.id && arcMap.has(update.id)) {
            const existing = arcMap.get(update.id);
            const historyEntry = {
                status: existing.status,
                progression: existing.progression,
                timestamp: existing.updatedAt,
            };
            if (!existing.history) existing.history = [];
            existing.history.push(historyEntry);
            if (existing.history.length > MAX_HISTORY) existing.history = existing.history.slice(-MAX_HISTORY);

            existing.status = status;
            existing.progression = String(update.progression || '').trim();
            existing.updatedAt = now;
            result.updated++;
            if (status === 'resolved' || status === 'abandoned') result.resolved++;
        } else {
            const newArc = {
                id: generateArcId(),
                title: String(update.title).trim(),
                status,
                progression: String(update.progression || '').trim(),
                createdAt: now,
                updatedAt: now,
                history: [],
            };
            arcs.push(newArc);
            arcMap.set(newArc.id, newArc);
            result.created++;
        }
    }

    setArcsState({ arcs, lastUpdated: now });
    return result;
}
