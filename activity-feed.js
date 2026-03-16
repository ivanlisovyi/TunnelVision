/**
 * TunnelVision Activity Feed
 * Floating widget that shows real-time worldbook entry activations and tool call activity.
 * Lives on document.body as a draggable trigger button + expandable panel.
 *
 * This is the main orchestration module. View logic lives in feed-views.js,
 * helper/parsing utilities in feed-helpers.js, and shared mutable state in feed-state.js.
 */

import { chat, eventSource, event_types, saveChatConditional } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { ALL_TOOL_NAMES, getActiveTunnelVisionBooks } from './tool-registry.js';
import { getSettings, isLorebookEnabled } from './tree-store.js';

import { _registerFeedCallbacks, addBackgroundEvent, markBackgroundStart, registerBackgroundTask } from './background-events.js';
import { renderStatsBar } from './feed-ui/feed-stats.js';
import { saveFeed, loadFeed } from './feed-ui/feed-storage.js';

// ── Sub-module imports ──────────────────────────────────────────

import {MAX_FEED_ITEMS,
    TOOL_DISPLAY,
    TRACKER_SUGGESTION_NAME_RE,
    getActiveChatId,
    getFeedItemsRaw, setFeedItems,
    bumpNextId,
    getFeedInitialized, setFeedInitialized,
    getTriggerEl,
    getPanelEl,
    getPanelBody,
    getPanelTabs,
    getShowingWorldState, setShowingWorldState,
    getShowingTimeline, setShowingTimeline,
    getShowingArcs, setShowingArcs,
    getShowingHealth, setShowingHealth,
    setLorebookStatsCache,
    getTurnToolCalls, setTurnToolCalls,
    getHiddenToolCallRefreshTimer, setHiddenToolCallRefreshTimer,
    getHiddenToolCallRefreshNeedsSync, setHiddenToolCallRefreshNeedsSync,
} from './feed-state.js';

import {
    registerViewCallbacks,
    toggleWorldStateView, toggleTimelineView, toggleArcsView, toggleHealthView,
    enterArcsView, enterHealthView,
    renderWorldStateView, renderTimelineView,
    parseTimestamp, loadTimelineEntries,
} from './feed-views.js';

import {
    truncate,
    createEntryFeedItem,
    parseInvocationParameters, extractRetrievedEntries, parseRetrievedEntryHeader,
    buildToolSummary, computeLineDiff,
} from './feed-helpers.js';

import { createTriggerButton, createPanel, positionPanel, openTreeEditorFromFeed } from './feed-ui/feed-panel.js';
import { renderAllItems, renderEmptyState, refreshActiveTasksInPanel, registerFeedRenderCallbacks } from './feed-ui/feed-render.js';

// ── Re-exports (preserve existing public API) ───────────────────

export { initActivityFeed, refreshHiddenToolCallMessages, clearFeed, getFeedItems };
export { parseTimestamp, loadTimelineEntries };
export { parseRetrievedEntryHeader, buildToolSummary, computeLineDiff };

// ── Constants (module-private) ──────────────────────────────────

const HIDDEN_TOOL_CALL_FLAG = 'tvHiddenToolCalls';

function togglePanel() {
    const panelEl = getPanelEl();
    if (!panelEl) return;
    const isOpen = panelEl.classList.toggle('open');
    if (isOpen) {
        setLorebookStatsCache(null);
        positionPanel();
        if (getShowingWorldState()) {
            renderWorldStateView();
        } else if (getShowingTimeline()) {
            renderTimelineView();
        } else if (getShowingArcs()) {
            enterArcsView();
        } else if (getShowingHealth()) {
            enterHealthView();
        } else {
            renderAllItems();
        }
        const triggerEl = getTriggerEl();
        if (triggerEl) triggerEl.setAttribute('data-tv-count', '0');
    }
}

// ── Event Handlers ──────────────────────────────────────────────

function onWorldInfoActivated(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return;

    const settings = getSettings();
    if (settings.globalEnabled === false) return;

    // Guard: ignore callbacks from a chat we've already switched away from
    try {
        const currentChatId = getContext().chatId;
        if (getActiveChatId() && currentChatId !== getActiveChatId()) return;
    } catch { /* no chat context */ }

    const activeBooks = getActiveTunnelVisionBooks();
    if (activeBooks.length === 0) return;

    const timestamp = Date.now();
    const items = [];
    for (const entry of entries) {
        // Only show entries from TV-managed lorebooks
        if (entry.world && !isLorebookEnabled(entry.world)) continue;

        items.push(createEntryFeedItem({
            source: 'native',
            lorebook: typeof entry?.world === 'string' ? entry.world : '',
            uid: Number.isFinite(entry?.uid) ? entry.uid : null,
            title: entry.comment || entry.key?.[0] || `UID ${entry.uid}`,
            keys: Array.isArray(entry.key) ? entry.key : [],
            timestamp,}));
    }

    addFeedItems(items);
}

function onToolCallsPerformed(invocations) {
    if (!Array.isArray(invocations) || invocations.length === 0) return;

    const settings = getSettings();
    if (settings.globalEnabled === false) return;

    // Guard: ignore callbacks from a chat we've already switched away from
    try {
        const currentChatId = getContext().chatId;
        if (getActiveChatId() && currentChatId !== getActiveChatId()) return;
    } catch { /* no chat context */ }

    const timestamp = Date.now();
    const items = [];

    for (const invocation of invocations) {
        if (!ALL_TOOL_NAMES.includes(invocation?.name) && !TOOL_DISPLAY[invocation?.name]) continue;

        const params = parseInvocationParameters(invocation.parameters);
        const retrievedEntries = invocation.name === 'TunnelVision_Search'
            ? extractRetrievedEntries(invocation.result)
            : [];

        // Create feed items for each retrieved entry
        for (const entry of retrievedEntries) {
            items.push(createEntryFeedItem({
                source: 'tunnelvision',
                lorebook: entry.lorebook,
                uid: entry.uid,
                title: entry.title || `UID ${entry.uid ?? '?'}`,
                timestamp,
            }));
        }

        const display = TOOL_DISPLAY[invocation.name] || { icon: 'fa-gear', verb: 'Used', color: '#888' };
        const summary = buildToolSummary(invocation.name, params, invocation.result || '', retrievedEntries);
        items.push({
            id: bumpNextId(),
            type: 'tool',
            icon: display.icon,
            verb: display.verb,
            color: display.color,
            summary,
            timestamp,
            retrievedEntries,
        });

        // Accumulate for end-of-turn console summary
        getTurnToolCalls().push({ name: invocation.name, verb: display.verb, summary });
    }

    addFeedItems(items);
}

function onToolCallsRendered(invocations) {
    if (!Array.isArray(invocations) || invocations.length === 0) return;

    if (!areTunnelVisionInvocations(invocations) || getSettings().stealthMode !== true) {
        queueHiddenToolCallRefresh(false);
        return;
    }

    const messageIndex = findRenderedToolCallMessageIndex(invocations);
    if (messageIndex < 0) {
        queueHiddenToolCallRefresh(false);
        return;
    }

    const message = chat[messageIndex];
    if (!message.extra) {
        message.extra = {};
    }
    message.extra[HIDDEN_TOOL_CALL_FLAG] = true;

    applyHiddenToolCallVisibility(messageIndex, true);
}

// ── Badge / Pulse / Trim / Add ──────────────────────────────────

function updateBadge(count) {
    const triggerEl = getTriggerEl();
    const panelEl = getPanelEl();
    if (!triggerEl || panelEl?.classList.contains('open')) return;
    const current = parseInt(triggerEl.getAttribute('data-tv-count') || '0', 10);
    triggerEl.setAttribute('data-tv-count', String(current + count));
}

function pulseTrigger() {
    const triggerEl = getTriggerEl();
    if (!triggerEl) return;
    triggerEl.classList.add('tv-float-pulse');
    setTimeout(() => triggerEl.classList.remove('tv-float-pulse'), 600);
}

function trimFeed() {
    let feedItems = getFeedItemsRaw();
    if (feedItems.length > MAX_FEED_ITEMS) {
        feedItems = feedItems.slice(0, MAX_FEED_ITEMS);
        setFeedItems(feedItems);
    }saveFeed();
}

function addFeedItems(items) {
    if (!Array.isArray(items) || items.length === 0) return;
    setLorebookStatsCache(null);

    const feedItems = getFeedItemsRaw();
    setFeedItems([...items, ...feedItems]);
    trimFeed();
    updateBadge(items.length);
    if (getPanelEl()?.classList.contains('open')) renderAllItems();
    pulseTrigger();
}



// ── Hidden Tool Call (Visual Hiding) ────────────────────────────

async function refreshHiddenToolCallMessages({ syncFlags = false } = {}) {
    try {
        const hideMode = getSettings().stealthMode === true;
        let flagsMutated = false;

        for (let messageIndex = 0; messageIndex < chat.length; messageIndex++) {
            const message = chat[messageIndex];
            const invocations = Array.isArray(message?.extra?.tool_invocations) ? message.extra.tool_invocations : null;
            if (!invocations?.length) continue;

            const isPureTunnelVision = areTunnelVisionInvocations(invocations);
            if (!message.extra) {
                message.extra = {};
            }

            if (syncFlags && !isPureTunnelVision && message.extra[HIDDEN_TOOL_CALL_FLAG]) {
                delete message.extra[HIDDEN_TOOL_CALL_FLAG];
                flagsMutated = true;
            }

            if (syncFlags && hideMode && isPureTunnelVision && message.extra[HIDDEN_TOOL_CALL_FLAG] !== true) {
                message.extra[HIDDEN_TOOL_CALL_FLAG] = true;
                flagsMutated = true;
            }

            const shouldHide = hideMode
                && isPureTunnelVision
                && message.extra[HIDDEN_TOOL_CALL_FLAG] === true;
            applyHiddenToolCallVisibility(messageIndex, shouldHide);
        }

        if (flagsMutated) {
            await saveChatConditional();
        }
    } catch (err) {
        console.error('[TunnelVision] Failed to refresh hidden tool call messages:', err);
    }
}

function queueHiddenToolCallRefresh(syncFlags = false) {
    setHiddenToolCallRefreshNeedsSync(getHiddenToolCallRefreshNeedsSync() || syncFlags);
    if (getHiddenToolCallRefreshTimer() !== null) return;

    setHiddenToolCallRefreshTimer(window.setTimeout(async () => {
        const shouldSync = getHiddenToolCallRefreshNeedsSync();
        setHiddenToolCallRefreshTimer(null);
        setHiddenToolCallRefreshNeedsSync(false);
        await refreshHiddenToolCallMessages({ syncFlags: shouldSync });
    }, 50));
}

function applyHiddenToolCallVisibility(messageIndex, shouldHide) {
    const messageElement = document.querySelector(`.mes[mesid="${messageIndex}"]`);
    if (!(messageElement instanceof HTMLElement)) return;

    messageElement.classList.toggle('tv-hidden-tool-call', shouldHide);
    if (shouldHide) {
        messageElement.dataset.tvHiddenToolCalls = 'true';
    } else {
        delete messageElement.dataset.tvHiddenToolCalls;
    }
}

function findRenderedToolCallMessageIndex(invocations) {
    for (let messageIndex = chat.length - 1; messageIndex >= 0; messageIndex--) {
        const messageInvocations = chat[messageIndex]?.extra?.tool_invocations;
        if (!Array.isArray(messageInvocations)) continue;

        if (messageInvocations === invocations || toolInvocationArraysMatch(messageInvocations, invocations)) {
            return messageIndex;
        }
    }

    return -1;
}

function toolInvocationArraysMatch(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
        return false;
    }

    return left.every((leftInvocation, index) => {
        const rightInvocation = right[index];
        return leftInvocation?.name === rightInvocation?.name
            && String(leftInvocation?.id ?? '') === String(rightInvocation?.id ?? '')
            && normalizeInvocationField(leftInvocation?.parameters) === normalizeInvocationField(rightInvocation?.parameters);
    });
}

function normalizeInvocationField(value) {
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return '';

    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function areTunnelVisionInvocations(invocations) {
    return Array.isArray(invocations)
        && invocations.length > 0
        && invocations.every(invocation => ALL_TOOL_NAMES.includes(invocation?.name));
}

// ── Persistence (chat metadata) ─────────────────────────────────



// ── Public API ──────────────────────────────────────────────────

function clearFeed() {
    setFeedItems([]);
    saveFeed();
    const triggerEl = getTriggerEl();
    if (triggerEl) triggerEl.setAttribute('data-tv-count', '0');
    if (getPanelEl()?.classList.contains('open')) renderAllItems();
}

function getFeedItems() {
    return [...getFeedItemsRaw()];
}

// ── Turn summary ────────────────────────────────────────────────

/**
 * Print a concise console summary of all TV tool calls made this turn.
 * Fires on MESSAGE_RECEIVED (after all tool recursion completes).
 */
function printTurnSummary() {
    const turnToolCalls = getTurnToolCalls();
    if (turnToolCalls.length === 0) return;
    const lines = turnToolCalls.map((tc, i) => `${i + 1}. ${tc.verb} ${tc.summary}`);
    console.log(`[TunnelVision] Turn summary (${turnToolCalls.length} tool calls):\n${lines.join('\n')}`);
    setTurnToolCalls([]);
}

// ── Initialization ──────────────────────────────────────────────

/**
 * Initialize the activity feed — create floating widget and bind events.
 * Called once from index.js init.
 */
function initActivityFeed() {
    if (getFeedInitialized()) return;
    setFeedInitialized(true);

    loadFeed({ trackerSuggestionNameRe: TRACKER_SUGGESTION_NAME_RE });

    createTriggerButton({ onTogglePanel: togglePanel });
    createPanel({
        onToggleTimelineView: toggleTimelineView,
        onToggleArcsView: toggleArcsView,
        onToggleHealthView: toggleHealthView,
        onToggleWorldStateView: toggleWorldStateView,
        onClearFeed: clearFeed,
        onRenderAllItems: renderAllItems,
    });
    renderEmptyState('all');

    registerFeedRenderCallbacks({
        renderStatsBar,
        saveFeed,
        renderAllItems,
        openTreeEditorFromFeed,
    });

    // Wire up the view sub-module so it can call back to renderAllItems
    registerViewCallbacks({ renderAllItems });

    _registerFeedCallbacks({
        addFeedItems,
        setTriggerActive: (active) => {
            const triggerEl = getTriggerEl();
            if (!triggerEl) return;
            triggerEl.classList.toggle('tv-bg-active', active);
        },
        refreshTasksUI: refreshActiveTasksInPanel,
        getFeedItems: () => getFeedItemsRaw(),
    });

    // Listen for WI activations (primary — shows what entries triggered)
    if (event_types.WORLD_INFO_ACTIVATED) {
        eventSource.on(event_types.WORLD_INFO_ACTIVATED, onWorldInfoActivated);
    }

    // Listen for TV tool calls (secondary)
    if (event_types.TOOL_CALLS_PERFORMED) {
        eventSource.on(event_types.TOOL_CALLS_PERFORMED, onToolCallsPerformed);
    }

    // Listen for tool call rendering to apply visual hiding
    if (event_types.TOOL_CALLS_RENDERED) {
        eventSource.on(event_types.TOOL_CALLS_RENDERED, onToolCallsRendered);
    }

    // Reload feed from chat metadata on chat switch
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            loadFeed({ trackerSuggestionNameRe: TRACKER_SUGGESTION_NAME_RE });
            setShowingWorldState(false);
            setShowingTimeline(false);
            setShowingArcs(false);
            setShowingHealth(false);
            const panelTabs = getPanelTabs();
            if (panelTabs) panelTabs.style.display = '';
            if (getPanelEl()?.classList.contains('open')) renderAllItems();
            queueHiddenToolCallRefresh(false);
        });
    }

    // Reset turn accumulator each generation
    if (event_types.GENERATION_STARTED) {
        eventSource.on(event_types.GENERATION_STARTED, () => {
            setTurnToolCalls([]);
        });
    }
    if (event_types.MESSAGE_RECEIVED) {
        eventSource.on(event_types.MESSAGE_RECEIVED, printTurnSummary);
    }

    queueHiddenToolCallRefresh(false);
}
