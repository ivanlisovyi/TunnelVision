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
import { getChatId, formatChatExcerpt, callWithRetry } from './agent-utils.js';
import { addBackgroundEvent, registerBackgroundTask } from './activity-feed.js';

const METADATA_KEY = 'tunnelvision_worldstate';

/** Default injection header wrapping the world state text in the AI's context. */
export const DEFAULT_WS_INJECTION_PROMPT = [
    '[Rolling World State — Your maintained memory of the current story.',
    'This is automatically kept up-to-date. Reference it to stay grounded in the scene,',
    'know what\'s happening, and maintain consistency. Do NOT repeat this information',
    'verbatim in your responses — use it to inform your writing.]',
].join('\n');

/** Default LLM instructions for generating/updating the world state document. */
export const DEFAULT_WS_UPDATE_PROMPT = [
    'You are a narrative state tracker for an ongoing roleplay. Maintain a concise "World State" document capturing the current state of the story.',
    '',
    'Follow this exact format:',
    '',
    '## Current Scene',
    'Day: [simulation day number]',
    'Date: [calendar date with year]',
    'Time: [exact in-world time; track elapsed time between updates]',
    'Location: [enforce hierarchy: Country > Region > City > Place]',
    'Present: [characters currently in the scene]',
    'Situation: [1-2 sentences of what is actively happening right now]',
    '',
    '## Recollection',
    '[Summarize recent events, recording important developments, character states, dynamics, and anything noteworthy. 3-5 sentences.]',
    '',
    '## Off-Screen',
    '[Characters not in the current scene. Format: "- **Name**: location / activity (since when)". Only include established characters.]',
    '',
    '## Pending',
    '[Near-term events, promises, appointments, and deadlines. Format: "- event/obligation (when)". Remove once resolved.]',
    '',
    '## Active Threads',
    '[Ongoing storylines. Format: "- **Thread Name** [status]: current state". Label status: active, suspended, ongoing, concluded.]',
    '',
    '## Unresolved Threads',
    '[Loose ends, NPC developments, plots that haven\'t been followed up on. Check for things that were established but dropped. If truly no longer relevant, mention once then drop.]',
    '',
    '## New Pending Threads',
    '[External threads NOT involving the main characters in the current scene — events brewing in the background, peripheral stakeholders, concurrent unrelated developments that may eventually come to the forefront. 1-3 items.]',
    '',
    '## Key Character States',
    '[For each active character: "- **Name**: mood, current goal, notable status".]',
    '',
    '## Cliché Check',
    '[Identify the most obvious narrative path from here. Note it so it can be consciously evaluated rather than defaulted to.]',
    '',
    'Be concise — the entire document should be under 800 words. This replaces the previous version entirely.',
    'Respond with ONLY the world state content. No JSON, no code fences, no commentary.',
].join('\n');

let _updateRunning = false;
const _chatRef = { lastChatLength: 0 };

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

    const settings = getSettings();
    const maxChars = settings.worldStateMaxChars || 3000;

    let text = state.text;
    if (text.length > maxChars) {
        const cutoff = text.lastIndexOf('\n', maxChars);
        text = text.substring(0, cutoff > maxChars * 0.5 ? cutoff : maxChars) + '\n[...truncated]';
    }

    const header = settings.worldStateInjectionOverride?.trim() || DEFAULT_WS_INJECTION_PROMPT;
    return header + '\n\n' + text;
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

// (formatChatExcerpt imported from agent-utils.js)

// ── LLM Prompt ───────────────────────────────────────────────────

function buildUpdatePrompt(previousState, recentExcerpt) {
    const hasPrevious = previousState && previousState.trim().length > 0;
    const settings = getSettings();
    const instructions = settings.worldStateUpdateOverride?.trim() || DEFAULT_WS_UPDATE_PROMPT;

    const parts = [];

    if (hasPrevious) {
        parts.push(
            '[Previous World State]',
            previousState,
            '',
            '[Recent Messages Since Last Update]',
        );
    } else {
        parts.push(
            '[Recent Conversation]',
        );
    }

    parts.push(
        recentExcerpt,
        '',
        hasPrevious
            ? 'Update the World State based on what happened in these messages. Preserve information that is still relevant, update what changed, remove what is no longer applicable.'
            : 'No previous world state exists. Create an initial World State based on this conversation.',
        '',
        instructions,
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
    const task = registerBackgroundTask({ label: 'World state', icon: 'fa-globe', color: '#00b894' });
    console.log(`[TunnelVision] World state update triggered (${messagesSinceUpdate} new messages)`);

    try {
        if (getChatId() !== chatId || task.cancelled) {
            console.log('[TunnelVision] World state update aborted');
            return null;
        }

        const previousState = currentState?.text || '';
        const quietPrompt = buildUpdatePrompt(previousState, recentExcerpt);

        const response = await callWithRetry(
            () => generateQuietPrompt({ quietPrompt, skipWIAN: true }),
            { label: 'World state update' },
        );

        if (getChatId() !== chatId || task.cancelled) {
            console.log('[TunnelVision] World state update aborted after generation');
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
        addBackgroundEvent({
            icon: 'fa-globe',
            verb: 'World state updated',
            color: '#00b894',
            summary: `${cleaned.length} chars`,
        });
        return newState;
    } catch (e) {
        console.error('[TunnelVision] World state update failed:', e);
        toastr.error(`World state update failed: ${e.message || 'Unknown error'}`, 'TunnelVision');
        addBackgroundEvent({
            icon: 'fa-triangle-exclamation',
            verb: 'World state failed',
            color: '#d63031',
            summary: e.message || 'Unknown error',
        });
        return null;
    } finally {
        _updateRunning = false;
        task.end();
    }
}

// ── Event Handlers ───────────────────────────────────────────────

function onAiMessageReceived() {
    const settings = getSettings();
    if (!settings.worldStateEnabled || settings.globalEnabled === false) return;

    // Skip tool-call recursion
    try {
        const context = getContext();
        const lastMsg = context.chat?.[context.chat.length - 1];
        if (Array.isArray(lastMsg?.extra?.tool_invocations) && lastMsg.extra.tool_invocations.length > 0) return;
    } catch { /* proceed */ }

    const chatLength = getContext().chat?.length || 0;
    const isSwipe = chatLength > 0 && chatLength <= _chatRef.lastChatLength;

    if (isSwipe) {
        _chatRef.lastChatLength = chatLength;
        // If the world state was last updated on the swiped message, invalidate it
        const state = getWorldState();
        if (state && state.lastUpdateMsgIdx >= chatLength - 1) {
            setWorldState({ ...state, lastUpdateMsgIdx: Math.max(state.lastUpdateMsgIdx - 1, -1) });
            console.log('[TunnelVision] World state invalidated after swipe — will re-update');
        }
        if (shouldUpdate()) {
            updateWorldState().catch(e => {
                console.error('[TunnelVision] World state re-update (swipe) failed:', e);
            });
        }
        return;
    }

    _chatRef.lastChatLength = chatLength;

    if (shouldUpdate()) {
        updateWorldState().catch(e => {
            console.error('[TunnelVision] Background world state update failed:', e);
        });
    }
}

function onChatChanged() {
    try {
        _chatRef.lastChatLength = getContext().chat?.length || 0;
    } catch {
        _chatRef.lastChatLength = 0;
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
