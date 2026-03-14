/**
 * TunnelVision Rolling World State
 *
 * Maintains a living "world state" document that captures the current story state:
 * current scene, recent events, active story threads, and key character states.
 *
 * Updated periodically via background LLM calls (every N messages) and injected
 * into the AI's context every turn so it always knows where the story stands.
 *
 * Unlike auto-summary (which creates individual historical records), the world state
 * is a single continuously-updated document — a living snapshot, not an archive.
 *
 * Data lives in chat_metadata.tunnelvision_worldstate (per-chat).
 */

import { eventSource, event_types, generateQuietPrompt } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { getSettings } from './tree-store.js';
import { getActiveTunnelVisionBooks } from './tool-registry.js';

const METADATA_KEY = 'tunnelvision_worldstate';

let _updateRunning = false;
let _lastCountedChatLength = 0;

// ── Persistence ──────────────────────────────────────────────────

function getWorldState() {
    try {
        return getContext().chatMetadata?.[METADATA_KEY] || null;
    } catch {
        return null;
    }
}

function setWorldState(state) {
    try {
        const context = getContext();
        if (!context.chatMetadata) return;
        context.chatMetadata[METADATA_KEY] = state;
        context.saveMetadataDebounced?.();
    } catch { /* metadata not available */ }
}

// ── Prompt Building ──────────────────────────────────────────────

/**
 * Build the world state string for injection into the AI's context.
 * Returns empty string if no world state exists yet.
 * @returns {string}
 */
export function buildWorldStatePrompt() {
    const state = getWorldState();
    if (!state?.text) return '';

    return [
        '[Rolling World State — Your maintained memory of the current story.',
        'This is automatically kept up-to-date. Reference it to stay grounded in the scene,',
        'know what\'s happening, and maintain consistency. Do NOT repeat this information',
        'verbatim in your responses — use it to inform your writing.]',
        '',
        state.text,
    ].join('\n');
}

// ── Update Decision ──────────────────────────────────────────────

function shouldUpdate() {
    const settings = getSettings();
    if (!settings.worldStateEnabled || settings.globalEnabled === false) return false;
    if (getActiveTunnelVisionBooks().length === 0) return false;

    const context = getContext();
    const chatLength = context.chat?.length || 0;
    if (chatLength < 6) return false;

    const state = getWorldState();
    const lastIdx = state?.lastUpdateMsgIdx ?? -1;
    const interval = settings.worldStateInterval || 10;

    return (chatLength - 1 - lastIdx) >= interval;
}

// ── Chat Excerpt ─────────────────────────────────────────────────

function formatChatExcerpt(chat, count) {
    const start = Math.max(0, chat.length - count);
    const lines = [];
    for (let i = start; i < chat.length; i++) {
        const msg = chat[i];
        if (msg.is_system) continue;
        const role = msg.is_user ? 'User' : (msg.name || 'Character');
        const text = (msg.mes || '').trim();
        if (text) lines.push(`[${role}]: ${text}`);
    }
    return lines.join('\n\n');
}

// ── LLM Prompt ───────────────────────────────────────────────────

function buildUpdatePrompt(previousState, recentExcerpt) {
    const hasPrevious = previousState && previousState.trim().length > 0;

    const parts = [
        'You are a narrative state tracker for an ongoing roleplay. Maintain a concise "World State" document capturing the current state of the story.',
        '',
    ];

    if (hasPrevious) {
        parts.push(
            '[Previous World State]',
            previousState,
            '',
            '[Recent Messages Since Last Update]',
        );
    } else {
        parts.push(
            'No previous world state exists — create one from scratch based on the conversation.',
            '',
            '[Recent Conversation]',
        );
    }

    parts.push(
        recentExcerpt,
        '',
        hasPrevious
            ? 'Update the World State based on what happened in these messages. Preserve information that is still relevant, update what changed, remove what is no longer applicable.'
            : 'Create an initial World State based on this conversation.',
        '',
        'Follow this exact format:',
        '',
        '## Current Scene',
        'Location: [where the action is happening]',
        'Time: [in-world time estimate, or "unspecified" if unclear]',
        'Present: [characters currently in the scene]',
        'Situation: [1-2 sentences of what is actively happening right now]',
        '',
        '## Recent Events',
        '[3-5 bullet points of the most recent significant events, newest first. One line each.]',
        '',
        '## Active Threads',
        '[Ongoing storylines/plot threads. Format each as: "- **Thread Name**: current status". Remove resolved threads, add new ones as they emerge.]',
        '',
        '## Key Character States',
        '[For each active character: "- **Name**: mood, current goal, notable status". Only characters active in recent scenes.]',
        '',
        'Be concise — the entire document should be under 500 words. This replaces the previous version entirely.',
        'Respond with ONLY the world state content. No JSON, no code fences, no commentary.',
    );

    return parts.join('\n');
}

// ── Core Update Logic ────────────────────────────────────────────

/**
 * Run a background LLM call to update the world state.
 * @param {boolean} [forceUpdate=false] - Skip the interval check
 * @returns {Promise<Object|null>} The new state object, or null if skipped/failed
 */
export async function updateWorldState(forceUpdate = false) {
    if (_updateRunning) return null;
    if (!forceUpdate && !shouldUpdate()) return null;

    const settings = getSettings();
    if (!settings.worldStateEnabled || settings.globalEnabled === false) return null;

    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length < 6) return null;

    const chatId = getChatId();
    const currentState = getWorldState();
    const lastIdx = currentState?.lastUpdateMsgIdx ?? -1;
    const messagesSinceUpdate = Math.max(chat.length - 1 - lastIdx, 0);
    const excerptCount = Math.min(messagesSinceUpdate + 4, chat.length, 40);

    const recentExcerpt = formatChatExcerpt(chat, excerptCount);
    if (!recentExcerpt.trim()) return null;

    _updateRunning = true;
    console.log(`[TunnelVision] World state update triggered (${messagesSinceUpdate} new messages)`);

    try {
        if (getChatId() !== chatId) {
            console.log('[TunnelVision] World state update aborted: chat changed');
            return null;
        }

        const previousState = currentState?.text || '';
        const quietPrompt = buildUpdatePrompt(previousState, recentExcerpt);

        const response = await generateQuietPrompt({ quietPrompt, skipWIAN: true });

        if (getChatId() !== chatId) {
            console.log('[TunnelVision] World state update aborted: chat changed during generation');
            return null;
        }

        if (!response || !response.trim()) {
            console.warn('[TunnelVision] World state update returned empty response');
            return null;
        }

        let cleaned = response.trim();
        cleaned = cleaned.replace(/^```(?:markdown)?\s*/i, '').replace(/\s*```$/i, '');

        const newState = {
            lastUpdated: Date.now(),
            lastUpdateMsgIdx: chat.length - 1,
            text: cleaned,
        };

        setWorldState(newState);
        console.log(`[TunnelVision] World state updated (${cleaned.length} chars)`);
        return newState;
    } catch (e) {
        console.error('[TunnelVision] World state update failed:', e);
        return null;
    } finally {
        _updateRunning = false;
    }
}

// ── Event Handlers ───────────────────────────────────────────────

function getChatId() {
    try {
        return getContext().chatId || null;
    } catch {
        return null;
    }
}

/**
 * Called after each AI message. Checks if enough messages have accumulated
 * to warrant a world state update, and triggers one in the background.
 */
function onAiMessageReceived() {
    const settings = getSettings();
    if (!settings.worldStateEnabled || settings.globalEnabled === false) return;

    try {
        const context = getContext();
        const lastMsg = context.chat?.[context.chat.length - 1];
        if (Array.isArray(lastMsg?.extra?.tool_invocations) && lastMsg.extra.tool_invocations.length > 0) return;
    } catch { /* proceed */ }

    try {
        const chatLength = getContext().chat?.length || 0;
        if (chatLength > 0 && chatLength <= _lastCountedChatLength) return;
        _lastCountedChatLength = chatLength;
    } catch { /* proceed */ }

    if (shouldUpdate()) {
        updateWorldState().catch(e => {
            console.error('[TunnelVision] Background world state update failed:', e);
        });
    }
}

function onChatChanged() {
    try {
        _lastCountedChatLength = getContext().chat?.length || 0;
    } catch {
        _lastCountedChatLength = 0;
    }
}

// ── Init ─────────────────────────────────────────────────────────

let _initialized = false;

export function initWorldState() {
    if (_initialized) return;
    _initialized = true;

    if (event_types.MESSAGE_RECEIVED) {
        eventSource.on(event_types.MESSAGE_RECEIVED, onAiMessageReceived);
    }
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    }

    console.log('[TunnelVision] World state module initialized');
}

// ── Public API ───────────────────────────────────────────────────

/** Get the raw world state text, or empty string if none. */
export function getWorldStateText() {
    return getWorldState()?.text || '';
}

/** Get the message index of the last update, or -1 if never updated. */
export function getWorldStateLastIndex() {
    return getWorldState()?.lastUpdateMsgIdx ?? -1;
}

/** Clear the world state for the current chat. */
export function clearWorldState() {
    try {
        const context = getContext();
        if (context.chatMetadata) {
            delete context.chatMetadata[METADATA_KEY];
            context.saveMetadataDebounced?.();
        }
    } catch { /* ignore */ }
}

/** Check if a world state update is currently in progress. */
export function isWorldStateUpdating() {
    return _updateRunning;
}
