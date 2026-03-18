import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockContext = {
    chatMetadata: {},
    saveMetadataDebounced: vi.fn(),
};

vi.mock('../../../st-context.js', () => ({
    getContext: vi.fn(() => mockContext),
}));

import {
    appendRuntimeEvent,
    clearRuntimeEvents,
    getRuntimeEvents,
    MAX_RUNTIME_EVENTS,
    RUNTIME_EVENTS_METADATA_KEY,
} from '../runtime-events-log.js';

describe('runtime-events-log', () => {
    beforeEach(() => {
        mockContext.chatMetadata = {};
        mockContext.saveMetadataDebounced.mockClear();
    });

    it('appends normalized events into chat metadata', () => {
        const record = appendRuntimeEvent({
            severity: 'warn',
            category: 'runtime-audit',
            title: 'Runtime diagnostics',
            summary: '1 warning detected.',
            details: ['group: orchestration', '', null],
        });

        expect(record).toEqual(expect.objectContaining({
            severity: 'warn',
            category: 'runtime-audit',
            title: 'Runtime diagnostics',
            details: ['group: orchestration'],
        }));
        expect(mockContext.chatMetadata[RUNTIME_EVENTS_METADATA_KEY]).toEqual({
            version: 1,
            events: [expect.objectContaining({
                severity: 'warn',
                title: 'Runtime diagnostics',
            })],
        });
        expect(mockContext.saveMetadataDebounced).toHaveBeenCalledTimes(1);
    });

    it('returns newest events first and trims to the configured max size', () => {
        for (let index = 0; index < MAX_RUNTIME_EVENTS + 5; index++) {
            appendRuntimeEvent({
                title: `Event ${index}`,
                summary: `Summary ${index}`,
                timestamp: 1000 + index,
            });
        }

        const events = getRuntimeEvents();
        expect(events).toHaveLength(MAX_RUNTIME_EVENTS);
        expect(events[0]).toEqual(expect.objectContaining({ title: `Event ${MAX_RUNTIME_EVENTS + 4}` }));
        expect(events.at(-1)).toEqual(expect.objectContaining({ title: 'Event 5' }));
    });

    it('clears the persisted runtime event log', () => {
        appendRuntimeEvent({ title: 'One event' });

        expect(clearRuntimeEvents()).toBe(true);
        expect(getRuntimeEvents()).toEqual([]);
        expect(mockContext.chatMetadata[RUNTIME_EVENTS_METADATA_KEY]).toEqual({
            version: 1,
            events: [],
        });
    });
});
