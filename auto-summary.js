/**
 * TunnelVision Auto-Summary
 * Tracks message count and triggers a background summarization
 * every N messages via generateQuietPrompt. Completely transparent —
 * does not hijack or interfere with the model's normal generation.
 */

import { eventSource, event_types } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { getSettings } from './tree-store.js';
import { getActiveTunnelVisionBooks, resolveTargetBook } from './tool-registry.js';

const TV_COUNTER_META_KEY = 'tunnelvision_autosummary_count';

/** Message count since last summary, keyed by chatId (in-memory cache). */
const counters = new Map();

let _autoSummaryInitialized = false;
let _backgroundSummaryRunning = false;

/**
 * Chat length at the time of the last successful counter increment.
 * Used to detect regeneration/swipe — if chat.length hasn't grown since
 * we last counted, the message replaced an existing one rather than adding new.
 */
let _lastCountedChatLength = 0;

export function initAutoSummary() {
    if (_autoSummaryInitialized) return;
    _autoSummaryInitialized = true;

    if (event_types.MESSAGE_RECEIVED) {
        eventSource.on(event_types.MESSAGE_RECEIVED, onAiMessageReceived);
    }
    if (event_types.MESSAGE_SENT) {
        eventSource.on(event_types.MESSAGE_SENT, onUserMessageSent);
    }
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    }
}

// ---------------------------------------------------------------------------
// Chat ID and persistence
// ---------------------------------------------------------------------------

function getChatId() {
    try {
        return getContext().chatId || null;
    } catch {
        return null;
    }
}

function loadPersistedCount() {
    try {
        const val = getContext().chatMetadata?.[TV_COUNTER_META_KEY];
        return typeof val === 'number' ? val : 0;
    } catch {
        return 0;
    }
}

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

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/**
 * Count user messages. Only increments — never triggers background summary.
 * Summary is triggered only after an AI response (MESSAGE_RECEIVED).
 */
function onUserMessageSent() {
    incrementCounter();
}

/**
 * Count AI messages and trigger background summary when threshold is reached.
 * Runs after the AI's response is complete, so the quiet prompt won't compete
 * with the current generation.
 */
function onAiMessageReceived() {
    if (!incrementCounter()) return;

    const chatId = getChatId();
    if (!chatId) return;

    const settings = getSettings();
    const interval = settings.autoSummaryInterval || 20;
    const count = getCount(chatId);

    if (count >= interval) {
        runBackgroundSummary(chatId, count).catch(e => {
            console.error('[TunnelVision] Background auto-summary failed:', e);
        });
    }
}

/**
 * Increment the counter for the active chat. Returns false if skipped.
 */
function incrementCounter() {
    const settings = getSettings();
    if (!settings.autoSummaryEnabled || settings.globalEnabled === false) return false;

    const chatId = getChatId();
    if (!chatId) return false;

    // Skip counting during tool-recursion passes
    try {
        const context = getContext();
        const lastMsg = context.chat?.[context.chat.length - 1];
        if (Array.isArray(lastMsg?.extra?.tool_invocations) && lastMsg.extra.tool_invocations.length > 0) return false;
    } catch { /* proceed */ }

    // Skip if chat hasn't grown — the message is a regeneration or swipe,
    // not a genuinely new message that advances the conversation.
    try {
        const chatLength = getContext().chat?.length || 0;
        if (chatLength > 0 && chatLength <= _lastCountedChatLength) return false;
        _lastCountedChatLength = chatLength;
    } catch { /* proceed */ }

    const count = getCount(chatId) + 1;
    counters.set(chatId, count);
    persistCount(count);
    return true;
}

function onChatChanged() {
    // Snapshot current chat length so the first regeneration in this chat
    // is correctly detected (chat.length stays the same → skip).
    try {
        _lastCountedChatLength = getContext().chat?.length || 0;
    } catch {
        _lastCountedChatLength = 0;
    }

    const chatId = getChatId();
    if (chatId && !counters.has(chatId)) {
        const persisted = loadPersistedCount();
        if (persisted > 0) {
            counters.set(chatId, persisted);
        }
    }
}

// ---------------------------------------------------------------------------
// Background summarization
// ---------------------------------------------------------------------------

async function runBackgroundSummary(chatId, count) {
    if (_backgroundSummaryRunning) return;

    const settings = getSettings();
    if (!settings.autoSummaryEnabled || settings.globalEnabled === false) return;

    const activeBooks = getActiveTunnelVisionBooks();
    if (activeBooks.length === 0) return;

    const { book: lorebook, error } = resolveTargetBook(activeBooks.length === 1 ? activeBooks[0] : activeBooks[0]);
    if (error || !lorebook) {
        console.warn('[TunnelVision] Auto-summary: could not resolve target lorebook:', error);
        return;
    }

    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length < 5) return;

    _backgroundSummaryRunning = true;
    console.log(`[TunnelVision] Auto-summary triggered after ${count} messages`);

    try {
        // Dynamic import to avoid circular dependency at module load time
        const { runQuietSummarize } = await import('./commands.js');
        const messageCount = Math.min(chat.length, count);
        const result = await runQuietSummarize(lorebook, chat, messageCount);
        const factsMsg = result.factsCreated > 0 ? ` + ${result.factsCreated} fact(s)` : '';
        toastr.success(`Auto-summary saved: "${result.title}"${factsMsg}`, 'TunnelVision');
    } catch (e) {
        console.error('[TunnelVision] Auto-summary failed:', e);
        toastr.error(`Auto-summary failed: ${e.message}`, 'TunnelVision');
    } finally {
        _backgroundSummaryRunning = false;
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function markAutoSummaryComplete() {
    const chatId = getChatId();
    if (!chatId) return;

    counters.set(chatId, 0);
    persistCount(0);
}

export function getAutoSummaryCount() {
    const chatId = getChatId();
    if (!chatId) return 0;
    return getCount(chatId);
}

export function resetAutoSummaryCount() {
    const chatId = getChatId();
    if (!chatId) return;

    counters.set(chatId, 0);
    persistCount(0);
}
