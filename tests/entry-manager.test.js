import { describe, it, expect } from 'vitest';
import { parseJsonFromLLM } from '../entry-manager.js';

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
