import { getContext } from '../../../st-context.js';

export const RUNTIME_EVENTS_METADATA_KEY = 'tunnelvision_runtime_events';
export const MAX_RUNTIME_EVENTS = 100;

let _eventSequence = 0;

function createDefaultStore() {
    return {
        version: 1,
        events: [],
    };
}

function normalizeDetails(details) {
    if (!Array.isArray(details)) return [];
    return details.filter(detail => typeof detail === 'string' && detail.trim().length > 0);
}

function normalizeEventRecord(event = {}) {
    const timestamp = Number.isFinite(event.timestamp) ? event.timestamp : Date.now();
    const severity = ['info', 'warn', 'error'].includes(event.severity) ? event.severity : 'info';
    const category = typeof event.category === 'string' && event.category.trim()
        ? event.category.trim()
        : 'runtime';
    const title = typeof event.title === 'string' && event.title.trim()
        ? event.title.trim()
        : 'Runtime event';
    const summary = typeof event.summary === 'string' ? event.summary : '';
    const source = typeof event.source === 'string' && event.source.trim()
        ? event.source.trim()
        : category;
    const status = typeof event.status === 'string' && event.status.trim()
        ? event.status.trim()
        : null;
    const group = typeof event.group === 'string' && event.group.trim()
        ? event.group.trim()
        : null;
    const correlationId = typeof event.correlationId === 'string' && event.correlationId.trim()
        ? event.correlationId.trim()
        : null;

    _eventSequence += 1;

    return {
        id: event.id || `runtime-${timestamp}-${_eventSequence}`,
        timestamp,
        severity,
        category,
        source,
        title,
        summary,
        details: normalizeDetails(event.details),
        status,
        group,
        correlationId,
        context: event.context && typeof event.context === 'object' ? { ...event.context } : null,
    };
}

export function createRuntimeCorrelationId(prefix = 'runtime') {
    _eventSequence += 1;
    return `${prefix}-${Date.now()}-${_eventSequence}`;
}

function getStoreFromContext(context, metadataKey) {
    const raw = context?.chatMetadata?.[metadataKey];
    if (raw && typeof raw === 'object' && Array.isArray(raw.events)) {
        return {
            version: Number.isFinite(raw.version) ? raw.version : 1,
            events: raw.events.map(event => normalizeEventRecord(event)),
        };
    }

    if (Array.isArray(raw)) {
        return {
            version: 1,
            events: raw.map(event => normalizeEventRecord(event)),
        };
    }

    return createDefaultStore();
}

function persistStore(context, metadataKey, store) {
    if (!context?.chatMetadata) return;
    context.chatMetadata[metadataKey] = {
        version: 1,
        events: Array.isArray(store?.events) ? store.events : [],
    };
    context.saveMetadataDebounced?.();
}

export function appendRuntimeEvent(event, {
    metadataKey = RUNTIME_EVENTS_METADATA_KEY,
    maxEvents = MAX_RUNTIME_EVENTS,
} = {}) {
    try {
        const context = getContext();
        if (!context?.chatMetadata) return null;

        const store = getStoreFromContext(context, metadataKey);
        const normalized = normalizeEventRecord(event);
        const trimmedEvents = [...store.events, normalized].slice(-Math.max(1, maxEvents));
        persistStore(context, metadataKey, {
            version: 1,
            events: trimmedEvents,
        });
        return normalized;
    } catch {
        return null;
    }
}

export function getRuntimeEvents({
    metadataKey = RUNTIME_EVENTS_METADATA_KEY,
    limit = MAX_RUNTIME_EVENTS,
    newestFirst = true,
} = {}) {
    try {
        const context = getContext();
        const store = getStoreFromContext(context, metadataKey);
        const events = store.events.slice(-Math.max(1, limit));
        return newestFirst ? [...events].reverse() : events;
    } catch {
        return [];
    }
}

export function clearRuntimeEvents({ metadataKey = RUNTIME_EVENTS_METADATA_KEY } = {}) {
    try {
        const context = getContext();
        if (!context?.chatMetadata) return false;
        persistStore(context, metadataKey, createDefaultStore());
        return true;
    } catch {
        return false;
    }
}
