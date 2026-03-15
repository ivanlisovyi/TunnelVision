import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockMetadata = {};
const mockSaveDebounced = vi.fn();
vi.mock('../../../st-context.js', () => ({
    getContext: () => ({
        chatMetadata: mockMetadata,
        saveMetadataDebounced: mockSaveDebounced,
    }),
}));

vi.mock('../../../world-info.js', () => ({
    loadWorldInfo: vi.fn(),
    createWorldInfoEntry: vi.fn(),
    saveWorldInfo: vi.fn(),
}));

vi.mock('./tree-store.js', () => ({
    getTree: vi.fn(),
    saveTree: vi.fn(),
    findNodeById: vi.fn(),
    findBestNodeForEntry: vi.fn(),
    addEntryToNode: vi.fn(),
    removeEntryFromTree: vi.fn(),
    createTreeNode: vi.fn(),
    isTrackerTitle: vi.fn(() => false),
    isTrackerUid: vi.fn(() => false),
    setTrackerUid: vi.fn(),
}));

import { parseJsonFromLLM, cleanupEntryMetadata, recordEntryTemporal, getEntryTemporal, setEntrySupersedes, getEntryTurnIndex } from '../entry-manager.js';

describe('parseJsonFromLLM', () => {
    // ── Clean inputs ─────────────────────────────────────────────

    it('parses a clean JSON object', () => {
        expect(parseJsonFromLLM('{"a": 1}')).toEqual({ a: 1 });
    });

    it('parses a clean JSON array', () => {
        expect(parseJsonFromLLM('[1, 2, 3]', { type: 'array' })).toEqual([1, 2, 3]);
    });

    // ── Empty / missing input ────────────────────────────────────

    it('returns empty object for null input', () => {
        expect(parseJsonFromLLM(null)).toEqual({});
    });

    it('returns empty object for undefined input', () => {
        expect(parseJsonFromLLM(undefined)).toEqual({});
    });

    it('returns empty object for empty string', () => {
        expect(parseJsonFromLLM('')).toEqual({});
    });

    it('returns empty array for empty input when type=array', () => {
        expect(parseJsonFromLLM('', { type: 'array' })).toEqual([]);
        expect(parseJsonFromLLM(null, { type: 'array' })).toEqual([]);
    });

    // ── Wrapper stripping ────────────────────────────────────────

    it('strips markdown code fences', () => {
        expect(parseJsonFromLLM('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    });

    it('strips markdown code fences without language tag', () => {
        expect(parseJsonFromLLM('```\n{"a": 1}\n```')).toEqual({ a: 1 });
    });

    it('strips <think> tags', () => {
        expect(parseJsonFromLLM('<think>reasoning here</think>{"a": 1}')).toEqual({ a: 1 });
    });

    it('strips <output> wrapper', () => {
        expect(parseJsonFromLLM('<output>{"a": 1}</output>')).toEqual({ a: 1 });
    });

    it('strips <response> wrapper', () => {
        expect(parseJsonFromLLM('<response>{"a": 1}</response>')).toEqual({ a: 1 });
    });

    it('strips <json> wrapper', () => {
        expect(parseJsonFromLLM('<json>{"a": 1}</json>')).toEqual({ a: 1 });
    });

    // ── Extraction from surrounding text ─────────────────────────

    it('extracts JSON object from surrounding prose', () => {
        expect(parseJsonFromLLM('Here is the result: {"a": 1} Hope that helps!')).toEqual({ a: 1 });
    });

    it('extracts JSON array from surrounding prose', () => {
        expect(parseJsonFromLLM('Result: [1, 2] Done.', { type: 'array' })).toEqual([1, 2]);
    });

    // ── Error recovery ───────────────────────────────────────────

    it('fixes trailing commas in objects', () => {
        expect(parseJsonFromLLM('{"a": 1, "b": 2,}')).toEqual({ a: 1, b: 2 });
    });

    it('fixes trailing commas in arrays', () => {
        expect(parseJsonFromLLM('[1, 2, 3,]', { type: 'array' })).toEqual([1, 2, 3]);
    });

    // ── Complex structures ───────────────────────────────────────

    it('handles nested objects', () => {
        const input = '{"outer": {"inner": [1, 2, 3]}}';
        expect(parseJsonFromLLM(input)).toEqual({ outer: { inner: [1, 2, 3] } });
    });

    it('handles objects with string values containing braces', () => {
        const input = '{"text": "a {b} c"}';
        expect(parseJsonFromLLM(input)).toEqual({ text: 'a {b} c' });
    });

    // ── No JSON found ────────────────────────────────────────────

    it('returns empty object when no JSON found', () => {
        expect(parseJsonFromLLM('Just plain text with no JSON.')).toEqual({});
    });

    it('returns empty array when no JSON array found', () => {
        expect(parseJsonFromLLM('Plain text', { type: 'array' })).toEqual([]);
    });
});

// ── cleanupEntryMetadata ─────────────────────────────────────────

describe('cleanupEntryMetadata', () => {
    beforeEach(() => {
        for (const key of Object.keys(mockMetadata)) delete mockMetadata[key];
        mockSaveDebounced.mockClear();
    });

    it('removes numeric uid key from tunnelvision_relevance', () => {
        mockMetadata.tunnelvision_relevance = { 42: Date.now(), 99: Date.now() };
        cleanupEntryMetadata('book', 42);
        expect(mockMetadata.tunnelvision_relevance[42]).toBeUndefined();
        expect(mockMetadata.tunnelvision_relevance[99]).toBeDefined();
    });

    it('removes string uid key from tunnelvision_relevance', () => {
        mockMetadata.tunnelvision_relevance = { '42': Date.now() };
        cleanupEntryMetadata('book', 42);
        expect(mockMetadata.tunnelvision_relevance['42']).toBeUndefined();
    });

    it('removes uid from tunnelvision_feedback', () => {
        mockMetadata.tunnelvision_feedback = {
            42: { injections: 3, references: 1 },
            99: { injections: 1, references: 0 },
        };
        cleanupEntryMetadata('book', 42);
        expect(mockMetadata.tunnelvision_feedback[42]).toBeUndefined();
        expect(mockMetadata.tunnelvision_feedback[99]).toBeDefined();
    });

    it('removes bookName:uid key from tunnelvision_entry_history', () => {
        mockMetadata.tunnelvision_entry_history = {
            'book:42': [{ timestamp: 1, source: 'test' }],
            'book:99': [{ timestamp: 2, source: 'test' }],
            'other:42': [{ timestamp: 3, source: 'test' }],
        };
        cleanupEntryMetadata('book', 42);
        expect(mockMetadata.tunnelvision_entry_history['book:42']).toBeUndefined();
        expect(mockMetadata.tunnelvision_entry_history['book:99']).toBeDefined();
        expect(mockMetadata.tunnelvision_entry_history['other:42']).toBeDefined();
    });

    it('calls saveMetadataDebounced after cleanup', () => {
        mockMetadata.tunnelvision_relevance = { 1: Date.now() };
        cleanupEntryMetadata('book', 1);
        expect(mockSaveDebounced).toHaveBeenCalled();
    });

    it('does not throw when metadata maps are absent', () => {
        expect(() => cleanupEntryMetadata('book', 42)).not.toThrow();
    });

    it('removes bookName:uid key from tunnelvision_entry_temporal', () => {
        mockMetadata.tunnelvision_entry_temporal = {
            'book:42': { turnIndex: 10, when: 'Day 1', arcId: null, supersedes: null, createdAt: 100 },
            'book:99': { turnIndex: 20, when: null, arcId: null, supersedes: null, createdAt: 200 },
        };
        cleanupEntryMetadata('book', 42);
        expect(mockMetadata.tunnelvision_entry_temporal['book:42']).toBeUndefined();
        expect(mockMetadata.tunnelvision_entry_temporal['book:99']).toBeDefined();
    });
});

// ── Temporal Fact Metadata ───────────────────────────────────────

describe('recordEntryTemporal', () => {
    beforeEach(() => {
        for (const key of Object.keys(mockMetadata)) delete mockMetadata[key];
        mockSaveDebounced.mockClear();
    });

    it('records temporal data for a new entry', () => {
        recordEntryTemporal('mybook', 42, { turnIndex: 15, when: 'Day 3, evening' });
        const data = mockMetadata.tunnelvision_entry_temporal?.['mybook:42'];
        expect(data).toBeTruthy();
        expect(data.turnIndex).toBe(15);
        expect(data.when).toBe('Day 3, evening');
        expect(data.arcId).toBeNull();
        expect(data.supersedes).toBeNull();
        expect(data.createdAt).toBeGreaterThan(0);
    });

    it('records arcId when provided', () => {
        recordEntryTemporal('mybook', 42, { turnIndex: 10, arcId: 'arc_123' });
        const data = mockMetadata.tunnelvision_entry_temporal['mybook:42'];
        expect(data.arcId).toBe('arc_123');
    });

    it('stores null when and arcId when not provided', () => {
        recordEntryTemporal('mybook', 42, { turnIndex: 5 });
        const data = mockMetadata.tunnelvision_entry_temporal['mybook:42'];
        expect(data.when).toBeNull();
        expect(data.arcId).toBeNull();
    });
});

describe('getEntryTemporal', () => {
    beforeEach(() => {
        for (const key of Object.keys(mockMetadata)) delete mockMetadata[key];
    });

    it('returns null when no temporal data exists', () => {
        expect(getEntryTemporal('mybook', 42)).toBeNull();
    });

    it('returns stored temporal data', () => {
        mockMetadata.tunnelvision_entry_temporal = {
            'mybook:42': { turnIndex: 10, when: 'Day 1', arcId: null, supersedes: null, createdAt: 100 },
        };
        const data = getEntryTemporal('mybook', 42);
        expect(data.turnIndex).toBe(10);
        expect(data.when).toBe('Day 1');
    });
});

describe('setEntrySupersedes', () => {
    beforeEach(() => {
        for (const key of Object.keys(mockMetadata)) delete mockMetadata[key];
    });

    it('sets supersedes on existing temporal entry', () => {
        mockMetadata.tunnelvision_entry_temporal = {
            'mybook:100': { turnIndex: 50, when: null, arcId: null, supersedes: null, createdAt: 100 },
        };
        setEntrySupersedes('mybook', 100, 42);
        expect(mockMetadata.tunnelvision_entry_temporal['mybook:100'].supersedes).toBe(42);
    });

    it('creates temporal entry with supersedes when none exists', () => {
        setEntrySupersedes('mybook', 100, 42);
        const data = mockMetadata.tunnelvision_entry_temporal['mybook:100'];
        expect(data).toBeTruthy();
        expect(data.supersedes).toBe(42);
    });
});

describe('getEntryTurnIndex', () => {
    beforeEach(() => {
        for (const key of Object.keys(mockMetadata)) delete mockMetadata[key];
    });

    it('returns 0 when no temporal data exists', () => {
        expect(getEntryTurnIndex('mybook', 42)).toBe(0);
    });

    it('returns the stored turnIndex', () => {
        mockMetadata.tunnelvision_entry_temporal = {
            'mybook:42': { turnIndex: 25, when: null, arcId: null, supersedes: null, createdAt: 100 },
        };
        expect(getEntryTurnIndex('mybook', 42)).toBe(25);
    });
});
