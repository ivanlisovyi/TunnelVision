/**
 * TunnelVision LLM Sidecar Transport Layer
 *
 * A standalone API client for making direct LLM calls without going through
 * SillyTavern's full generation pipeline. Used for background operations
 * (smart context reranking, embedding computation, analytical tasks) that
 * benefit from a separate, often cheaper model.
 *
 * Supports OpenAI-compatible, Anthropic, and Google (Gemini) API formats.
 * Reads provider config from a "Background Model" Connection Profile.
 * Falls back gracefully to generateRaw when sidecar is not configured.
 *
 * Circuit breaker: after repeated failures (403s, network errors), the sidecar
 * auto-disables for a cooldown period to avoid spamming a broken endpoint.
 */

import { getSettings } from './tree-store.js';

const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30_000;

let _consecutiveFailures = 0;
let _circuitOpenUntil = 0;

// ── Configuration ────────────────────────────────────────────────

/**
 * Check whether a sidecar background model is configured and operational.
 * @returns {boolean}
 */
export function isSidecarConfigured() {
    if (Date.now() < _circuitOpenUntil) return false;
    const config = getSidecarConfig();
    return !!(config && config.apiKey && config.endpoint);
}

/**
 * Get the sidecar configuration from settings.
 * @returns {{ endpoint: string, apiKey: string, model: string, format: string, maxTokens: number } | null}
 */
export function getSidecarConfig() {
    const settings = getSettings();
    const profile = settings.sidecarProfile;
    if (!profile || typeof profile !== 'object' || !profile.enabled) return null;

    const endpoint = (profile.endpoint || '').trim();
    const apiKey = (profile.apiKey || '').trim();
    if (!endpoint || !apiKey) return null;

    return {
        endpoint,
        apiKey,
        model: (profile.model || '').trim(),
        format: (profile.format || 'openai').trim().toLowerCase(),
        maxTokens: profile.maxTokens || 1000,
        temperature: profile.temperature ?? 0.3,
    };
}

// ── Circuit Breaker ──────────────────────────────────────────────

function recordSuccess() {
    _consecutiveFailures = 0;
}

function recordFailure(error) {
    _consecutiveFailures++;
    if (_consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        _circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
        console.warn(`[TunnelVision Sidecar] Circuit breaker opened after ${_consecutiveFailures} failures. Cooldown until ${new Date(_circuitOpenUntil).toLocaleTimeString()}`);
        _consecutiveFailures = 0;
    }
}

/** Reset the circuit breaker (e.g., after config change). */
export function resetCircuitBreaker() {
    _consecutiveFailures = 0;
    _circuitOpenUntil = 0;
}

// ── API Format Builders ──────────────────────────────────────────

function buildOpenAIBody(config, prompt, systemPrompt, maxTokens) {
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    return {
        model: config.model || 'gpt-4o-mini',
        messages,
        max_tokens: maxTokens || config.maxTokens,
        temperature: config.temperature,
    };
}

function buildAnthropicBody(config, prompt, systemPrompt, maxTokens) {
    return {
        model: config.model || 'claude-3-haiku-20240307',
        max_tokens: maxTokens || config.maxTokens,
        system: systemPrompt || '',
        messages: [{ role: 'user', content: prompt }],
        temperature: config.temperature,
    };
}

function buildGoogleBody(config, prompt, systemPrompt, maxTokens) {
    const contents = [{ role: 'user', parts: [{ text: prompt }] }];
    const body = {
        contents,
        generationConfig: {
            maxOutputTokens: maxTokens || config.maxTokens,
            temperature: config.temperature,
        },
    };
    if (systemPrompt) {
        body.systemInstruction = { parts: [{ text: systemPrompt }] };
    }
    return body;
}

function buildRequestBody(config, prompt, systemPrompt, maxTokens) {
    switch (config.format) {
        case 'anthropic': return buildAnthropicBody(config, prompt, systemPrompt, maxTokens);
        case 'google':
        case 'gemini': return buildGoogleBody(config, prompt, systemPrompt, maxTokens);
        default: return buildOpenAIBody(config, prompt, systemPrompt, maxTokens);
    }
}

function buildHeaders(config) {
    switch (config.format) {
        case 'anthropic':
            return {
                'Content-Type': 'application/json',
                'x-api-key': config.apiKey,
                'anthropic-version': '2023-06-01',
            };
        case 'google':
        case 'gemini':
            return { 'Content-Type': 'application/json' };
        default:
            return {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`,
            };
    }
}

function buildUrl(config) {
    let url = config.endpoint;
    if (config.format === 'google' || config.format === 'gemini') {
        const model = config.model || 'gemini-1.5-flash';
        if (!url.includes(':generateContent')) {
            url = url.replace(/\/?$/, '');
            url += `/v1beta/models/${model}:generateContent?key=${config.apiKey}`;
        }
    } else if (config.format === 'anthropic') {
        if (!url.endsWith('/messages') && url.endsWith('/v1')) {
            url = url.replace(/\/?$/, '/messages');
        }
    } else {
        // Only append /chat/completions if the URL ends with /v1 or /v1/
        // (standard OpenAI base URL). Custom proxy paths are used as-is.
        if (/\/v\d\/?$/.test(url)) {
            url = url.replace(/\/?$/, '/chat/completions');
        }
    }
    return url;
}

// ── Response Parsing ─────────────────────────────────────────────

function extractResponseText(config, json) {
    switch (config.format) {
        case 'anthropic':
            return json?.content?.[0]?.text || '';
        case 'google':
        case 'gemini':
            return json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        default:
            return json?.choices?.[0]?.message?.content || '';
    }
}

// ── Core Generation ──────────────────────────────────────────────

const THINK_BLOCK_RE = /<think[\s\S]*?<\/think>/gi;

/**
 * Make a direct LLM API call via the sidecar transport.
 * @param {Object} opts
 * @param {string} opts.prompt - The user prompt
 * @param {string} [opts.systemPrompt] - Optional system prompt
 * @param {number} [opts.maxTokens] - Override max tokens
 * @param {number} [opts.timeout] - Request timeout in ms
 * @returns {Promise<string>} Generated text
 * @throws {Error} If sidecar is not configured or the request fails
 */
export async function sidecarGenerate({ prompt, systemPrompt, maxTokens, timeout }) {
    const config = getSidecarConfig();
    if (!config) throw new Error('Sidecar not configured');
    if (Date.now() < _circuitOpenUntil) throw new Error('Sidecar circuit breaker open');

    const url = buildUrl(config);
    const headers = buildHeaders(config);
    const body = buildRequestBody(config, prompt, systemPrompt, maxTokens);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout || DEFAULT_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            const error = new Error(`Sidecar HTTP ${response.status}: ${errorText.substring(0, 200)}`);
            error.status = response.status;
            throw error;
        }

        const json = await response.json();
        const text = extractResponseText(config, json);
        const cleaned = typeof text === 'string' ? text.replace(THINK_BLOCK_RE, '').trim() : '';

        recordSuccess();
        return cleaned;
    } catch (error) {
        recordFailure(error);
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

// ── Embedding Support ────────────────────────────────────────────

/**
 * Get the embedding-specific configuration from settings.
 * Reads from the dedicated embeddingProfile, which is independent of the
 * sidecar profile so users can point embeddings at a different proxy/provider.
 * @returns {{ endpoint: string, apiKey: string, model: string, format: string } | null}
 */
export function getEmbeddingConfig() {
    const settings = getSettings();
    const profile = settings.embeddingProfile;
    if (!profile || typeof profile !== 'object' || !profile.enabled) return null;

    const endpoint = (profile.endpoint || '').trim();
    if (!endpoint) return null;

    return {
        endpoint,
        apiKey: (profile.apiKey || '').trim(),
        model: (profile.model || '').trim(),
        format: (profile.format || 'openai').trim().toLowerCase(),
    };
}

/**
 * Check if embedding computation is available and enabled.
 * Requires a configured embedding profile with a valid endpoint.
 * @returns {boolean}
 */
export function isEmbeddingSupported() {
    const config = getEmbeddingConfig();
    if (!config) return false;
    return config.format === 'openai' || config.format === 'google' || config.format === 'gemini';
}

/**
 * Compute embeddings for an array of text strings.
 * Uses the dedicated embedding profile (separate from the sidecar).
 * @param {string[]} texts - Texts to embed
 * @returns {Promise<number[][]>} Array of embedding vectors
 */
export async function computeEmbeddings(texts) {
    const config = getEmbeddingConfig();
    if (!config) throw new Error('Embedding not configured');

    if (config.format === 'google' || config.format === 'gemini') {
        return computeGoogleEmbeddings(config, texts);
    }

    return computeOpenAIEmbeddings(config, texts);
}

async function computeOpenAIEmbeddings(config, texts) {
    let url = config.endpoint;
    url = url.replace(/\/chat\/completions\/?$/, '/embeddings');
    if (!url.endsWith('/embeddings')) {
        url = url.replace(/\/?$/, '/embeddings');
    }

    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model: config.model || 'text-embedding-3-small',
            input: texts,
        }),
    });

    if (!response.ok) throw new Error(`Embedding HTTP ${response.status}`);
    const json = await response.json();
    return (json.data || []).map(d => d.embedding);
}

async function computeGoogleEmbeddings(config, texts) {
    const model = config.model || 'text-embedding-004';
    const url = `${config.endpoint.replace(/\/?$/, '')}/v1beta/models/${model}:batchEmbedContents?key=${config.apiKey}`;

    const requests = texts.map(text => ({
        model: `models/${model}`,
        content: { parts: [{ text }] },
    }));

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests }),
    });

    if (!response.ok) throw new Error(`Embedding HTTP ${response.status}`);
    const json = await response.json();
    return (json.embeddings || []).map(e => e.values);
}

/**
 * Run a connectivity test against the embedding endpoint.
 * @returns {Promise<{ok: boolean, message: string, latencyMs?: number}>}
 */
export async function testEmbeddingConnectivity() {
    const config = getEmbeddingConfig();
    if (!config) {
        return { ok: false, message: 'No embedding configuration found. Enable embeddings and set an endpoint.' };
    }

    const start = Date.now();
    try {
        const result = await computeEmbeddings(['connectivity test']);
        const latencyMs = Date.now() - start;
        const ok = Array.isArray(result) && result.length > 0 && Array.isArray(result[0]);
        return {
            ok,
            message: ok
                ? `Connected (${latencyMs}ms, model: ${config.model || 'default'}, dimensions: ${result[0].length})`
                : 'Unexpected response format from embedding endpoint',
            latencyMs,
        };
    } catch (error) {
        return {
            ok: false,
            message: `Connection failed: ${error.message}`,
            latencyMs: Date.now() - start,
        };
    }
}

// ── Diagnostics ──────────────────────────────────────────────────

/**
 * Run a connectivity test against the sidecar endpoint.
 * @returns {Promise<{ok: boolean, message: string, latencyMs?: number}>}
 */
export async function testSidecarConnectivity() {
    const config = getSidecarConfig();
    if (!config) {
        return { ok: false, message: 'No sidecar configuration found. Set up a Background Model in settings.' };
    }

    const start = Date.now();
    try {
        const result = await sidecarGenerate({
            prompt: 'Respond with exactly: OK',
            maxTokens: 10,
            timeout: 15_000,
        });
        const latencyMs = Date.now() - start;
        const ok = typeof result === 'string' && result.length > 0;
        return {
            ok,
            message: ok ? `Connected (${latencyMs}ms, model: ${config.model || 'default'})` : 'Empty response from sidecar',
            latencyMs,
        };
    } catch (error) {
        return {
            ok: false,
            message: `Connection failed: ${error.message}`,
            latencyMs: Date.now() - start,
        };
    }
}
