/**
 * TunnelVision Auto-Summary
 * Tracks message count and injects a forced summarize instruction
 * every N messages. Lightweight — no LLM calls of its own, just
 * piggybacks on the next generation by injecting an extension prompt.
 */

import { eventSource, event_types, setExtensionPrompt, extension_prompt_types } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { getSettings } from './tree-store.js';
import { getActiveTunnelVisionBooks } from './tool-registry.js';

const TV_AUTOSUMMARY_KEY = 'tunnelvision_autosummary';
const TV_COUNTER_META_KEY = 'tunnelvision_autosummary_count';

/** Message count since last summary, keyed by chatId (in-memory cache). */
const counters = new Map();
const pendingSummaries = new Map();

let _autoSummaryInitialized = false;

export function initAutoSummary() {
    if (_autoSummaryInitialized) return;
    _autoSummaryInitialized = true;

    // Count user+AI messages
    if (event_types.MESSAGE_RECEIVED) {
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    }
    // Also count user messages sent
    if (event_types.MESSAGE_SENT) {
        eventSource.on(event_types.MESSAGE_SENT, onMessageReceived);
    }
    // Inject prompt before generation when threshold hit
    if (event_types.GENERATION_STARTED) {
        eventSource.on(event_types.GENERATION_STARTED, onGenerationForAutoSummary);
    }
    // Reset pending flag on chat change
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    }
}

function getChatId() {
    try {
        return getContext().chatId || null;
    } catch {
        return null;
    }
}

/**
 * Read the persisted counter from chat metadata.
 * Falls back to 0 if metadata is unavailable.
 */
function loadPersistedCount() {
    try {
        const val = getContext().chatMetadata?.[TV_COUNTER_META_KEY];
        return typeof val === 'number' ? val : 0;
    } catch {
        return 0;
    }
}

/**
 * Persist the counter to chat metadata so it survives page refreshes.
 */
function persistCount(count) {
    try {
        const context = getContext();
        if (context.chatMetadata) {
            context.chatMetadata[TV_COUNTER_META_KEY] = count;
            context.saveMetadataDebounced?.();
        }
    } catch {
        // Metadata not available — in-memory only
    }
}

/**
 * Get the current counter for a chat, syncing from persisted metadata
 * if the in-memory cache is missing (e.g. after page refresh).
 */
function getCount(chatId) {
    if (counters.has(chatId)) {
        return counters.get(chatId);
    }
    const persisted = loadPersistedCount();
    if (persisted > 0) {
        counters.set(chatId, persisted);
    }
    return persisted;
}

function onMessageReceived() {
    const settings = getSettings();
    if (!settings.autoSummaryEnabled || settings.globalEnabled === false) return;

    const chatId = getChatId();
    if (!chatId) return;

    const count = getCount(chatId) + 1;
    counters.set(chatId, count);
    persistCount(count);
}

function onGenerationForAutoSummary() {
    const settings = getSettings();
    if (!settings.autoSummaryEnabled || settings.globalEnabled === false) {
        clearPrompt();
        return;
    }

    const chatId = getChatId();
    if (!chatId) {
        clearPrompt();
        return;
    }

    const count = getCount(chatId);
    const interval = settings.autoSummaryInterval || 20;
    const activeBooks = getActiveTunnelVisionBooks();
    if (activeBooks.length === 0) {
        clearPrompt();
        return;
    }

    if (count >= interval) {
        if (!pendingSummaries.has(chatId)) {
            pendingSummaries.set(chatId, { triggeredAt: count });
            console.log(`[TunnelVision] Auto-summary pending after ${count} messages`);
        }

        const prompt = `[AUTO-SUMMARY INSTRUCTION: ${count} messages have passed since the last summary. You MUST call TunnelVision_Summarize this turn to create a summary of recent events. Write a descriptive title and thorough summary of what has happened in the last ~${count} messages. After summarizing, continue responding to the user normally.]`;
        setExtensionPrompt(TV_AUTOSUMMARY_KEY, prompt, extension_prompt_types.IN_PROMPT, 0);
        return;
    }

    clearPrompt();
}

function onChatChanged() {
    clearPrompt();
    const chatId = getChatId();
    if (chatId && !counters.has(chatId)) {
        const persisted = loadPersistedCount();
        if (persisted > 0) {
            counters.set(chatId, persisted);
        }
    }
}

function clearPrompt() {
    setExtensionPrompt(TV_AUTOSUMMARY_KEY, '', extension_prompt_types.IN_PROMPT, 0);
}

export function markAutoSummaryComplete() {
    const chatId = getChatId();
    if (!chatId) return;

    counters.set(chatId, 0);
    pendingSummaries.delete(chatId);
    clearPrompt();
    persistCount(0);
}

/** Get the current counter for the active chat. Used by UI. */
export function getAutoSummaryCount() {
    const chatId = getChatId();
    if (!chatId) return 0;
    return getCount(chatId);
}

/** Reset the counter for the active chat. Used by UI and diagnostics. */
export function resetAutoSummaryCount() {
    const chatId = getChatId();
    if (!chatId) return;

    counters.set(chatId, 0);
    pendingSummaries.delete(chatId);
    clearPrompt();
    persistCount(0);
}
