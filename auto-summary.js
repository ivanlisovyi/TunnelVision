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
import { isProcessorRunning, hasRecentArchive } from './post-turn-processor.js';
import { getChatId, shouldSkipAiMessage } from './agent-utils.js';
import { addBackgroundEvent, registerBackgroundTask } from './background-events.js';

const TV_COUNTER_META_KEY = 'tunnelvision_autosummary_count';

/** Message count since last summary, keyed by chatId (in-memory cache). */
const counters = new Map();

let _autoSummaryInitialized = false;
let _backgroundSummaryRunning = false;
const _chatRef = { lastChatLength: 0 };

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
// Persistence
// ---------------------------------------------------------------------------

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

    // Keep the settings UI in sync
    try {
        const el = document.getElementById('tv_auto_summary_count');
        if (el) el.value = count;
    } catch { /* UI not ready */ }
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
    const settings = getSettings();
    if (!settings.autoSummaryEnabled || settings.globalEnabled === false) return;

    // Skip tool-call recursion
    try {
        const context = getContext();
        const lastMsg = context.chat?.[context.chat.length - 1];
        if (Array.isArray(lastMsg?.extra?.tool_invocations) && lastMsg.extra.tool_invocations.length > 0) return;
    } catch { /* proceed */ }

    // Detect swipe: chat length hasn't grown → regenerated response, skip counter
    const chatLength = getContext().chat?.length || 0;
    const isSwipe = chatLength > 0 && chatLength <= _chatRef.lastChatLength;
    _chatRef.lastChatLength = chatLength;
    if (isSwipe) return;

    const chatId = getChatId();
    if (!chatId) return;

    const count = getCount(chatId) + 1;
    counters.set(chatId, count);
    persistCount(count);

    const interval = settings.autoSummaryInterval || 50;
    if (count >= interval) {
        // Skip if the post-turn processor is currently running or just archived a scene,
        // to avoid producing a duplicate summary for the same range of messages.
        if (isProcessorRunning() || hasRecentArchive()) {
            console.log('[TunnelVision] Auto-summary deferred — post-turn processor active or recently archived');
            return;
        }
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
    if (shouldSkipAiMessage(_chatRef)) return false;

    const count = getCount(chatId) + 1;
    counters.set(chatId, count);
    persistCount(count);
    return true;
}

function onChatChanged() {
    try {
        _chatRef.lastChatLength = getContext().chat?.length || 0;
    } catch {
        _chatRef.lastChatLength = 0;
    }

    const chatId = getChatId();

    // Clean up stale counter entries — keep only current chat to prevent unbounded growth
    if (chatId) {
        for (const key of counters.keys()) {
            if (key !== chatId) counters.delete(key);
        }
    }

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

    const { book: lorebook, error } = resolveTargetBook(activeBooks[0]);
    if (error || !lorebook) {
        console.warn('[TunnelVision] Auto-summary: could not resolve target lorebook:', error);
        return;
    }

    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length < 5) return;

    _backgroundSummaryRunning = true;
    const task = registerBackgroundTask({ label: 'Auto-summary', icon: 'fa-scroll', color: '#fdcb6e' });
    console.log(`[TunnelVision] Auto-summary triggered after ${count} messages`);

    try {
        if (getChatId() !== chatId || task.cancelled) {
            console.log('[TunnelVision] Auto-summary aborted');
            return;
        }

        const { runQuietSummarize } = await import('./commands.js');

        if (getChatId() !== chatId || task.cancelled) {
            console.log('[TunnelVision] Auto-summary aborted');
            return;
        }

        const messageCount = Math.min(chat.length, count);
        const result = await runQuietSummarize(lorebook, chat, messageCount, '', { background: true });

        if (task.cancelled) return;

        const factsMsg = result.factsCreated > 0 ? ` + ${result.factsCreated} fact(s)` : '';
        toastr.success(`Auto-summary saved: "${result.title}"${factsMsg}`, 'TunnelVision');
        addBackgroundEvent({
            icon: 'fa-scroll',
            verb: 'Auto-summary',
            color: '#fdcb6e',
            summary: `"${result.title}"${factsMsg}`,
        });
    } catch (e) {
        console.error('[TunnelVision] Auto-summary failed:', e);
        toastr.error(`Auto-summary failed: ${e.message}`, 'TunnelVision');
        addBackgroundEvent({
            icon: 'fa-triangle-exclamation',
            verb: 'Auto-summary failed',
            color: '#d63031',
            summary: e.message || 'Unknown error',
        });
    } finally {
        _backgroundSummaryRunning = false;
        task.end();
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

export function setAutoSummaryCount(value) {
    const chatId = getChatId();
    if (!chatId) return;

    const clamped = Math.max(0, Math.round(Number(value)) || 0);
    counters.set(chatId, clamped);
    persistCount(clamped);
}
