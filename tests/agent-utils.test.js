import { describe, it, expect, vi, beforeEach } from 'vitest';
import { trigramSimilarity, callWithRetry, setInjectionSizes, getInjectionSizes, getMaxContextTokens } from '../agent-utils.js';

// ── setInjectionSizes / getInjectionSizes ────────────────────────

describe('injection size tracking', () => {
    beforeEach(() => {
        setInjectionSizes({ mandatory: 0, worldState: 0, smartContext: 0, notebook: 0 });
    });

    it('defaults to all zeros', () => {
        const sizes = getInjectionSizes();
        expect(sizes).toEqual({ mandatory: 0, worldState: 0, smartContext: 0, notebook: 0, total: 0 });
    });

    it('stores and retrieves injection sizes', () => {
        setInjectionSizes({ mandatory: 100, worldState: 200, smartContext: 300, notebook: 50 });
        const sizes = getInjectionSizes();
        expect(sizes.mandatory).toBe(100);
        expect(sizes.worldState).toBe(200);
        expect(sizes.smartContext).toBe(300);
        expect(sizes.notebook).toBe(50);
    });

    it('computes total as sum of all slots', () => {
        setInjectionSizes({ mandatory: 100, worldState: 200, smartContext: 300, notebook: 50 });
        expect(getInjectionSizes().total).toBe(650);
    });

    it('treats missing properties as 0', () => {
        setInjectionSizes({ mandatory: 500 });
        const sizes = getInjectionSizes();
        expect(sizes.mandatory).toBe(500);
        expect(sizes.worldState).toBe(0);
        expect(sizes.total).toBe(500);
    });

    it('returns a copy (not a reference)', () => {
        setInjectionSizes({ mandatory: 100, worldState: 0, smartContext: 0, notebook: 0 });
        const a = getInjectionSizes();
        const b = getInjectionSizes();
        a.mandatory = 999;
        expect(b.mandatory).toBe(100);
    });
});

// ── getMaxContextTokens ──────────────────────────────────────────

describe('getMaxContextTokens', () => {
    it('returns 0 when context has no maxContext property', () => {
        expect(getMaxContextTokens()).toBe(0);
    });
});

// ── trigramSimilarity ────────────────────────────────────────────

describe('trigramSimilarity', () => {
    it('returns 1 for identical strings', () => {
        expect(trigramSimilarity('hello', 'hello')).toBe(1);
    });

    it('returns 1 for two empty strings', () => {
        expect(trigramSimilarity('', '')).toBe(1);
    });

    it('returns 0 when one string is empty', () => {
        expect(trigramSimilarity('hello', '')).toBe(0);
        expect(trigramSimilarity('', 'hello')).toBe(0);
    });

    it('returns a value between 0 and 1 for similar strings', () => {
        const score = trigramSimilarity('hello world', 'hello earth');
        expect(score).toBeGreaterThan(0);
        expect(score).toBeLessThan(1);
    });

    it('is case-insensitive', () => {
        expect(trigramSimilarity('Hello', 'hello')).toBe(1);
        expect(trigramSimilarity('WORLD', 'world')).toBe(1);
    });

    it('ignores punctuation', () => {
        expect(trigramSimilarity('hello, world!', 'hello world')).toBe(1);
    });

    it('scores more-similar strings higher than less-similar ones', () => {
        const high = trigramSimilarity('cat', 'cats');
        const low = trigramSimilarity('cat', 'dog');
        expect(high).toBeGreaterThan(low);
    });

    it('is symmetric', () => {
        const ab = trigramSimilarity('alpha', 'beta');
        const ba = trigramSimilarity('beta', 'alpha');
        expect(ab).toBeCloseTo(ba);
    });
});

// ── callWithRetry ────────────────────────────────────────────────

describe('callWithRetry', () => {
    it('returns result on first successful call', async () => {
        const fn = vi.fn().mockResolvedValue('ok');
        const result = await callWithRetry(fn, { timeout: 5000, backoff: 10 });
        expect(result).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on empty string result and succeeds', async () => {
        const fn = vi.fn()
            .mockResolvedValueOnce('')
            .mockResolvedValueOnce('got it');
        const result = await callWithRetry(fn, { timeout: 5000, backoff: 10, maxRetries: 2 });
        expect(result).toBe('got it');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('retries on null result and succeeds', async () => {
        const fn = vi.fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce('recovered');
        const result = await callWithRetry(fn, { timeout: 5000, backoff: 10 });
        expect(result).toBe('recovered');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('retries on thrown error and succeeds', async () => {
        const fn = vi.fn()
            .mockRejectedValueOnce(new Error('transient'))
            .mockResolvedValueOnce('recovered');
        const result = await callWithRetry(fn, { timeout: 5000, backoff: 10 });
        expect(result).toBe('recovered');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('throws last error after exhausting retries', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('persistent'));
        await expect(
            callWithRetry(fn, { timeout: 5000, backoff: 10, maxRetries: 1 }),
        ).rejects.toThrow('persistent');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('returns last empty value after exhausting retries', async () => {
        const fn = vi.fn().mockResolvedValue(null);
        const result = await callWithRetry(fn, { timeout: 5000, backoff: 10, maxRetries: 1 });
        expect(result).toBeNull();
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('rejects with timeout error when function exceeds timeout', async () => {
        const fn = vi.fn(() => new Promise(r => setTimeout(() => r('late'), 10_000)));
        await expect(
            callWithRetry(fn, { timeout: 50, backoff: 10, maxRetries: 0 }),
        ).rejects.toThrow(/timed out/);
    });
});
