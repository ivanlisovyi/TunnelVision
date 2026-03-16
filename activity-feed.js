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
import { getSettings, isLorebookEnabled, getTree, isSummaryTitle, isTrackerTitle } from './tree-store.js';
import { findEntry, getCachedWorldInfo, getEntryVersions } from './entry-manager.js';
import { openTreeEditorForBook } from './ui-controller.js';
import { createTrackerForCharacter } from './post-turn-processor.js';
import { countStaleEntries } from './entry-scoring.js';
import { CHARS_PER_TOKEN } from './constants.js';
import { getInjectionSizes, getMaxContextTokens } from './agent-utils.js';
import { _registerFeedCallbacks, addBackgroundEvent, markBackgroundStart, registerBackgroundTask, cancelBackgroundTask, getActiveTasks, getFailedTasks, retryFailedTask, dismissFailedTask } from './background-events.js';

// ── Sub-module imports ──────────────────────────────────────────

import {MAX_FEED_ITEMS, MAX_RENDERED_RETRIEVED_ENTRIES, LOREBOOK_STATS_CACHE_TTL,
    TOOL_DISPLAY, TRACKER_SUGGESTION_NAME_RE,
    getActiveChatId, setActiveChatId,
    getFeedItemsRaw, setFeedItems,
    getNextId, setNextId, bumpNextId,
    getFeedInitialized, setFeedInitialized,
    getTriggerEl, setTriggerEl,
    getPanelEl, setPanelEl,
    getPanelBody, setPanelBody,
    getPanelTabs, setPanelTabs,
    getShowingWorldState, setShowingWorldState,
    getShowingTimeline, setShowingTimeline,
    getShowingArcs, setShowingArcs,
    getShowingHealth, setShowingHealth,
    getLorebookStatsCache, setLorebookStatsCache,
    getLorebookStatsCacheTime, setLorebookStatsCacheTime,
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
    truncate, formatTime,
    createEntryFeedItem, shouldIncludeLorebookForEntries,
    formatEntrySummary, formatRetrievedEntryLabel,
    parseInvocationParameters, extractRetrievedEntries, parseRetrievedEntryHeader,
    buildToolSummary, computeLineDiff, buildDiffView, buildVersionHistoryPanel,
} from './feed-helpers.js';

// ── Re-exports (preserve existing public API) ───────────────────

export { initActivityFeed, refreshHiddenToolCallMessages, clearFeed, getFeedItems };
export { parseTimestamp, loadTimelineEntries };
export { parseRetrievedEntryHeader, buildToolSummary, computeLineDiff };

// ── Constants (module-private) ──────────────────────────────────

const STORAGE_KEY_POS = 'tv-feed-trigger-position';
const METADATA_KEY = 'tunnelvision_feed';
const HIDDEN_TOOL_CALL_FLAG = 'tvHiddenToolCalls';

// ── DOM Helpers ─────────────────────────────────────────────────

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
}

function icon(iconClass) {
    const i = document.createElement('i');
    i.className = `fa-solid ${iconClass}`;
    return i;
}

// ── Tree editor shortcut ────────────────────────────────────────

/**
 * Open the tree editor for an active TV lorebook.
 * Single book → opens directly. Multiple → shows a quick picker dropdown.
 */
function openTreeEditorFromFeed() {
    const books = getActiveTunnelVisionBooks().filter(b => {
        const tree = getTree(b);
        return tree && tree.root;
    });

    if (books.length === 0) {
        toastr.info('No lorebooks with built trees. Build a tree first in TunnelVision settings.', 'TunnelVision');
        return;
    }

    if (books.length === 1) {
        openTreeEditorForBook(books[0]);
        return;
    }

    // Multiple books — show a quick picker
    const panelEl = getPanelEl();
    const picker = el('div', 'tv-book-picker');
    const label = el('div', 'tv-book-picker-label');
    label.textContent = 'Choose lorebook:';
    picker.appendChild(label);

    for (const name of books) {
        const btn = el('button', 'tv-book-picker-btn');
        btn.textContent = name;
        btn.addEventListener('click', () => {
            picker.remove();
            openTreeEditorForBook(name);
        });
        picker.appendChild(btn);
    }

    const panelHeader = panelEl?.querySelector('.tv-float-panel-header');
    if (panelHeader) {
        panelHeader.appendChild(picker);
        const dismiss = (e) => {
            if (!picker.contains(e.target)) {
                picker.remove();
                document.removeEventListener('click', dismiss, true);
            }
        };
        setTimeout(() => document.addEventListener('click', dismiss, true), 0);
    }
}

// ── Trigger Button ──────────────────────────────────────────────

function createTriggerButton() {
    const triggerEl = el('div', 'tv-float-trigger');
    setTriggerEl(triggerEl);
    triggerEl.title = 'TunnelVision Activity Feed';
    triggerEl.setAttribute('data-tv-count', '0');
    triggerEl.appendChild(icon('fa-satellite-dish'));

    // Load saved position
    const saved = localStorage.getItem(STORAGE_KEY_POS);
    if (saved) {
        try {
            const pos = JSON.parse(saved);
            triggerEl.style.left = pos.left;
            triggerEl.style.top = pos.top;
            triggerEl.style.bottom = 'auto';
            triggerEl.style.right = 'auto';
        } catch { /* use default */ }
    }

    // Drag support
    let dragging = false;
    let offsetX = 0, offsetY = 0;

    triggerEl.addEventListener('pointerdown', (e) => {
        dragging = false;
        offsetX = e.clientX - triggerEl.getBoundingClientRect().left;
        offsetY = e.clientY - triggerEl.getBoundingClientRect().top;
        triggerEl.setPointerCapture(e.pointerId);
    });

    triggerEl.addEventListener('pointermove', (e) => {
        if (!triggerEl.hasPointerCapture(e.pointerId)) return;
        const dx = e.clientX - triggerEl.getBoundingClientRect().left - offsetX;
        const dy = e.clientY - triggerEl.getBoundingClientRect().top - offsetY;
        if (!dragging && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
            dragging = true;
        }
        if (dragging) {
            const x = Math.max(0, Math.min(window.innerWidth - 40, e.clientX - offsetX));
            const y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - offsetY));
            triggerEl.style.left = `${x}px`;
            triggerEl.style.top = `${y}px`;
            triggerEl.style.bottom = 'auto';
            triggerEl.style.right = 'auto';
        }
    });

    triggerEl.addEventListener('pointerup', (e) => {
        triggerEl.releasePointerCapture(e.pointerId);
        if (dragging) {
            localStorage.setItem(STORAGE_KEY_POS, JSON.stringify({
                left: triggerEl.style.left,
                top: triggerEl.style.top,
            }));
            dragging = false;
        } else {
            togglePanel();
        }
    });

    document.body.appendChild(triggerEl);
}

// ── Panel ───────────────────────────────────────────────────────

function createPanel() {
    const panelEl = el('div', 'tv-float-panel');
    setPanelEl(panelEl);

    // Header
    const header = el('div', 'tv-float-panel-header');
    const title = el('span', 'tv-float-panel-title');
    title.appendChild(icon('fa-satellite-dish'));
    title.append(' TunnelVision Feed');
    header.appendChild(title);
    const timelineBtn = el('button', 'tv-float-panel-btn tv-timeline-btn');
    timelineBtn.title = 'Timeline view';
    timelineBtn.appendChild(icon('fa-clock-rotate-left'));
    timelineBtn.addEventListener('click', toggleTimelineView);
    header.appendChild(timelineBtn);

    const arcsBtn = el('button', 'tv-float-panel-btn tv-arcs-btn');
    arcsBtn.title = 'Narrative arcs';
    arcsBtn.appendChild(icon('fa-diagram-project'));
    arcsBtn.addEventListener('click', toggleArcsView);
    header.appendChild(arcsBtn);

    const healthBtn = el('button', 'tv-float-panel-btn tv-health-btn');
    healthBtn.title = 'Lorebook health dashboard';
    healthBtn.appendChild(icon('fa-heart-pulse'));
    healthBtn.addEventListener('click', toggleHealthView);
    header.appendChild(healthBtn);

    const worldStateBtn = el('button', 'tv-float-panel-btn tv-ws-btn');
    worldStateBtn.title = 'View/edit world state';
    worldStateBtn.appendChild(icon('fa-globe'));
    worldStateBtn.addEventListener('click', toggleWorldStateView);
    header.appendChild(worldStateBtn);

    const settingsBtn = el('button', 'tv-float-panel-btn');
    settingsBtn.title = 'Open tree editor';
    settingsBtn.appendChild(icon('fa-folder-tree'));
    settingsBtn.addEventListener('click', openTreeEditorFromFeed);
    header.appendChild(settingsBtn);

    const clearBtn = el('button', 'tv-float-panel-btn');
    clearBtn.title = 'Clear feed';
    clearBtn.appendChild(icon('fa-trash-can'));
    clearBtn.addEventListener('click', () => clearFeed());
    header.appendChild(clearBtn);

    const closeBtn = el('button', 'tv-float-panel-btn');
    closeBtn.title = 'Close';
    closeBtn.appendChild(icon('fa-xmark'));
    closeBtn.addEventListener('click', () => {
        panelEl.classList.remove('open');
    });
    header.appendChild(closeBtn);
    panelEl.appendChild(header);

    // Tabs
    const panelTabs = el('div', 'tv-float-panel-tabs');
    setPanelTabs(panelTabs);
    for (const [key, label] of [['all', 'All'], ['wi', 'Entries'], ['tools', 'Tools'], ['bg', 'Agent']]) {
        const tab = el('button', `tv-float-tab${key === 'all' ? ' active' : ''}`, label);
        tab.dataset.tab = key;
        tab.addEventListener('click', () => {
            panelTabs.querySelectorAll('.tv-float-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            renderAllItems();
        });
        panelTabs.appendChild(tab);
    }
    panelEl.appendChild(panelTabs);

    // Body
    const panelBody = el('div', 'tv-float-panel-body');
    setPanelBody(panelBody);
    panelEl.appendChild(panelBody);

    renderEmptyState('all');

    document.body.appendChild(panelEl);
}

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

function positionPanel() {
    const triggerEl = getTriggerEl();
    const panelEl = getPanelEl();
    if (!triggerEl || !panelEl) return;
    const rect = triggerEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pw = 340;
    const ph = 420;

    let left = rect.right + 8;
    if (left + pw > vw - 16) left = rect.left - pw - 8;
    if (left < 16) left = 16;

    let top = rect.top;
    if (top + ph > vh - 16) top = vh - ph - 16;
    if (top < 16) top = 16;

    panelEl.style.left = `${left}px`;
    panelEl.style.top = `${top}px`;
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

// ── Rendering ───────────────────────────────────────────────────

function getActiveTab() {
    return getPanelEl()?.querySelector('.tv-float-tab.active')?.dataset.tab || 'all';
}

function renderEmptyState(tab) {
    const panelBody = getPanelBody();
    if (!panelBody) return;
    panelBody.replaceChildren();
    const empty = el('div', 'tv-float-empty');
    empty.appendChild(icon('fa-satellite-dish'));

    let message = 'No activity yet';
    let subMessage = 'Injected entries and tool calls will appear here during generation';

    if (tab === 'tools') {
        message = 'No tool calls yet';
        subMessage = 'Tool calls will appear here during generation';
    } else if (tab === 'wi') {
        message = 'No injected entries yet';
        subMessage = 'Native activations and TunnelVision retrievals will appear here';
    }

    empty.appendChild(el('span', null, message));
    empty.appendChild(el('span', 'tv-float-empty-sub', subMessage));
    panelBody.appendChild(empty);
}

function renderAllItems() {
    const panelBody = getPanelBody();
    if (!panelBody) return;
    const tab = getActiveTab();
    const feedItems = getFeedItemsRaw();

    panelBody.replaceChildren();

    // Stats bar — only on "All" tab when there are items
    if (tab === 'all' && feedItems.length > 0) {
        panelBody.appendChild(renderStatsBar());
    }

    // Active background tasks — shown at top in'all' and 'bg' tabs
    const activeTasks = getActiveTasks();
    const failedTasks = getFailedTasks();
    const showActiveTasks = (tab === 'all' || tab === 'bg') && activeTasks.size > 0;
    const showFailedTasks = (tab === 'all' || tab === 'bg') && failedTasks.size > 0;
    if (showActiveTasks) {
        for (const task of activeTasks.values()) {
            panelBody.appendChild(buildActiveTaskElement(task));
        }
    }
    if (showFailedTasks) {
        for (const task of failedTasks.values()) {
            panelBody.appendChild(buildFailedTaskElement(task));
        }
    }

    const filtered = feedItems.filter(item => {
        if (tab === 'all') return true;
        if (tab === 'wi') return item.type === 'entry' || item.type === 'wi';
        if (tab === 'tools') return item.type === 'tool';
        if (tab === 'bg') return item.type === 'background';
        return true;
    });

    if (filtered.length === 0 && !showActiveTasks && !showFailedTasks) {
        renderEmptyState(tab);
        return;
    }

    for (const item of filtered) {
        panelBody.appendChild(buildItemElement(item));
    }
}

function buildActiveTaskElement(task) {
    const row = el('div', 'tv-float-item tv-active-task');

    const iconWrap = el('div', 'tv-float-item-icon');
    iconWrap.style.color = task.color;
    const spinner = document.createElement('i');
    spinner.className = task.cancelled
        ? `fa-solid ${task.icon} tv-active-task-fading`
        : `fa-solid ${task.icon} fa-spin`;
    iconWrap.appendChild(spinner);
    row.appendChild(iconWrap);

    const body = el('div', 'tv-float-item-body');
    const textRow = el('div', 'tv-float-item-row');
    const verb = el('span', 'tv-float-item-verb', task.label);
    verb.style.color = task.color;
    textRow.appendChild(verb);

    const statusText = task.cancelled ? 'Cancelling...' : 'Running...';
    textRow.appendChild(el('span', 'tv-float-item-summary', statusText));
    body.appendChild(textRow);
    row.appendChild(body);

    if (!task.cancelled) {
        const cancelBtn = el('button', 'tv-active-task-cancel');
        cancelBtn.title = 'Cancel';
        cancelBtn.appendChild(icon('fa-xmark'));
        cancelBtn.addEventListener('click', () => cancelBackgroundTask(task.id));
        row.appendChild(cancelBtn);
    }

    return row;
}

function buildFailedTaskElement(task) {
    const row = el('div', 'tv-float-item tv-failed-task');

    const iconWrap = el('div', 'tv-float-item-icon');
    iconWrap.style.color = '#d63031';
    iconWrap.appendChild(icon('fa-triangle-exclamation'));
    row.appendChild(iconWrap);

    const body = el('div', 'tv-float-item-body');
    const textRow = el('div', 'tv-float-item-row');
    const verb = el('span', 'tv-float-item-verb', `${task.label} failed`);
    verb.style.color = '#d63031';
    textRow.appendChild(verb);
    textRow.appendChild(el('span', 'tv-float-item-summary', task.errorMessage));
    body.appendChild(textRow);
    row.appendChild(body);

    const btnGroup = el('div', 'tv-feed-expand-actions');
    btnGroup.style.cssText = 'display:flex;gap:4px;align-items:center;flex-shrink:0;';

    const retryBtn = el('button', 'tv-failed-task-retry');
    if (task.retrying) {
        retryBtn.appendChild(icon('fa-spinner fa-spin'));
        retryBtn.append(' Retrying…');
        retryBtn.disabled = true;
    } else {
        retryBtn.appendChild(icon('fa-rotate-right'));
        retryBtn.append(' Retry');
        retryBtn.addEventListener('click', async () => {
            retryBtn.disabled = true;
            retryBtn.replaceChildren(icon('fa-spinner fa-spin'));
            retryBtn.append(' Retrying…');
            const success = await retryFailedTask(task.id);
            if (success) {
                retryBtn.replaceChildren(icon('fa-check'));
                retryBtn.append(' Done');
                retryBtn.classList.add('tv-retry-success');
            }});
    }
    btnGroup.appendChild(retryBtn);

    const dismissBtn = el('button', 'tv-failed-task-retry');
    dismissBtn.title = 'Dismiss';
    dismissBtn.appendChild(icon('fa-xmark'));
    dismissBtn.addEventListener('click', () => dismissFailedTask(task.id));
    btnGroup.appendChild(dismissBtn);

    row.appendChild(btnGroup);
    return row;
}

function buildItemElement(item) {
    const rowClasses = ['tv-float-item'];
    if (item.type === 'entry') {
        rowClasses.push('tv-float-item-entry');
        rowClasses.push(item.source === 'native' ? 'tv-float-item-entry-native' : 'tv-float-item-entry-tv');
    } else if (item.type === 'wi') {
        rowClasses.push('tv-float-item-wi');}
    if (item.completedAt) rowClasses.push('tv-float-item--completed');
    if (item.dismissedAt) rowClasses.push('tv-float-item--dismissed');

    const row = el('div', rowClasses.join(' '));

    // Icon
    const iconWrap = el('div', 'tv-float-item-icon');
    iconWrap.style.color = item.color;
    iconWrap.appendChild(icon(item.icon));
    if (item.completedAt) {
        const badge = el('span', 'tv-float-item-badge');
        badge.appendChild(icon('fa-check'));
        iconWrap.appendChild(badge);
    }
    row.appendChild(iconWrap);

    // Body
    const body = el('div', 'tv-float-item-body');
    const textRow = el('div', 'tv-float-item-row');
    const verb = el('span', 'tv-float-item-verb', item.verb);
    verb.style.color = item.color;
    textRow.appendChild(verb);

    const summaryText = (item.type === 'entry')
        ? formatEntrySummary(item, shouldIncludeLorebookForEntries())
        : (item.summary || '');
    textRow.appendChild(el('span', 'tv-float-item-summary', summaryText));
    body.appendChild(textRow);

    // Keys (for entry items)
    if (item.keys?.length > 0) {
        const keysRow = el('div', 'tv-float-item-keys');
        const shown = item.keys.slice(0, 4);
        for (const k of shown) {
            keysRow.appendChild(el('span', 'tv-float-key-tag', k));
        }
        if (item.keys.length > 4) {
            keysRow.appendChild(el('span', 'tv-float-key-more', `+${item.keys.length - 4}`));
        }
        body.appendChild(keysRow);
    }

    // Detail lines (for background agent items)
    if (item.type === 'background' && item.details?.length) {
        const detailsRow = el('div', 'tv-float-item-keys');
        for (const detail of item.details) {
            detailsRow.appendChild(el('span', 'tv-float-key-tag tv-float-bg-detail', detail));
        }
        body.appendChild(detailsRow);
    }

    // Retrieved entries (for tool items from search)
    if (item.type === 'tool' && item.retrievedEntries?.length) {
        const entriesRow = el('div', 'tv-float-item-entries');
        const uniqueBooks = new Set(item.retrievedEntries.map(entry => entry.lorebook).filter(Boolean));
        const includeLorebook = uniqueBooks.size > 1;
        const shown = item.retrievedEntries.slice(0, MAX_RENDERED_RETRIEVED_ENTRIES);

        for (const entry of shown) {
            const chip = el('div', 'tv-float-entry-tag', formatRetrievedEntryLabel(entry, includeLorebook));
            chip.title = `${entry.lorebook ||'Lorebook'} |UID ${entry.uid ?? '?'}${entry.title ? ` | ${entry.title}` : ''}`;
            entriesRow.appendChild(chip);
        }

        if (item.retrievedEntries.length > MAX_RENDERED_RETRIEVED_ENTRIES) {
            const remaining = item.retrievedEntries.length - MAX_RENDERED_RETRIEVED_ENTRIES;
            entriesRow.appendChild(
                el('div', 'tv-float-entry-more', `+${remaining} more retrieved entr${remaining === 1 ?'y' : 'ies'}`),
            );
        }

        body.appendChild(entriesRow);
    }

    row.appendChild(body);

    // Time
    row.appendChild(el('div', 'tv-float-item-time', formatTime(item.timestamp)));

    // Clickable entry expansion
    if (item.type === 'entry' && item.lorebook && item.uid != null) {
        row.classList.add('tv-feed-clickable');
        row.addEventListener('click', () => toggleFeedEntryExpand(row, item));
    }

    // Clickable tool expansion (show retrieved entry content)
    if (item.type === 'tool' && item.retrievedEntries?.length) {
        row.classList.add('tv-feed-clickable');
        row.addEventListener('click', () => toggleToolItemExpand(row, item));
    }

    // Clickable background expansion (action button)
    if (item.type === 'background' && item.action) {
        row.classList.add('tv-feed-clickable');
        row.addEventListener('click', () => toggleBackgroundExpand(row, item));
    }

    return row;
}

async function toggleFeedEntryExpand(row, item) {
    const expandEl = row.nextElementSibling;
    if (expandEl?.classList.contains('tv-feed-expand')) {
        expandEl.remove();
        row.classList.remove('expanded');
        return;
    }

    row.classList.add('expanded');
    const expandDiv = el('div', 'tv-feed-expand');
    expandDiv.textContent = 'Loading…';
    row.after(expandDiv);

    try {
        const result = await findEntry(item.lorebook, item.uid);
        if (!row.classList.contains('expanded')) return;
        expandDiv.replaceChildren();

        if (!result?.entry) {
            expandDiv.appendChild(el('div', 'tv-feed-expand-empty', 'Entry not found or deleted'));
            return;
        }

        const entry = result.entry;
        const contentDiv = el('div', 'tv-feed-expand-content');
        contentDiv.textContent = entry.content || '(empty)';
        expandDiv.appendChild(contentDiv);

        const actions = el('div', 'tv-feed-expand-actions');
        const openBtn = el('button', 'tv-btn tv-btn-sm tv-btn-secondary');
        openBtn.appendChild(icon('fa-folder-tree'));
        openBtn.append(' Open in Tree');
        openBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openTreeEditorForBook(item.lorebook);
        });
        actions.appendChild(openBtn);

        const copyBtn = el('button', 'tv-btn tv-btn-sm tv-btn-secondary');
        copyBtn.appendChild(icon('fa-copy'));
        copyBtn.append(' Copy');
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(entry.content || '');
            copyBtn.replaceChildren(icon('fa-check'));
            copyBtn.append(' Copied');
            setTimeout(() => {
                copyBtn.replaceChildren(icon('fa-copy'));
                copyBtn.append(' Copy');
            }, 1500);
        });
        actions.appendChild(copyBtn);

        const versions = getEntryVersions(item.lorebook, item.uid);
        if (versions.length > 0) {
            const histBtn = el('button', 'tv-btn tv-btn-sm tv-btn-secondary');
            histBtn.appendChild(icon('fa-clock-rotate-left'));
            histBtn.append(` History (${versions.length})`);
            histBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const existing = expandDiv.querySelector('.tv-version-history');
                if (existing) {
                    existing.remove();return;
                }
                expandDiv.appendChild(buildVersionHistoryPanel(versions, entry.content));
            });
            actions.appendChild(histBtn);
        }

        expandDiv.appendChild(actions);
    } catch (err) {
        expandDiv.replaceChildren(el('div', 'tv-feed-expand-empty', `Failed to load: ${err.message}`));
    }
}

async function toggleToolItemExpand(row, item) {
    const expandEl = row.nextElementSibling;
    if (expandEl?.classList.contains('tv-feed-expand')) {
        expandEl.remove();
        row.classList.remove('expanded');
        return;
    }

    row.classList.add('expanded');
    const expandDiv = el('div', 'tv-feed-expand tv-feed-expand-tool');
    expandDiv.textContent = 'Loading…';
    row.after(expandDiv);

    try {
        expandDiv.replaceChildren();

        for (const re of item.retrievedEntries.slice(0, MAX_RENDERED_RETRIEVED_ENTRIES)) {
            const entryBlock = el('div', 'tv-feed-expand-retrieved');
            const header = el('div', 'tv-feed-expand-entry-header');
            const titleSpan = el('span', 'tv-feed-expand-entry-title', re.title || `UID ${re.uid ?? '?'}`);
            header.appendChild(titleSpan);
            if (re.lorebook) {
                header.appendChild(el('span', 'tv-feed-expand-entry-book', re.lorebook));
            }
            entryBlock.appendChild(header);

            try {
                const result = await findEntry(re.lorebook, re.uid);
                if (result?.entry) {
                    const contentDiv = el('div', 'tv-feed-expand-content');
                    contentDiv.textContent = result.entry.content || '(empty)';
                    entryBlock.appendChild(contentDiv);
                } else {
                    entryBlock.appendChild(el('div', 'tv-feed-expand-empty', 'Entry not found'));
                }
            } catch {
                entryBlock.appendChild(el('div', 'tv-feed-expand-empty', 'Could not load entry'));
            }

            expandDiv.appendChild(entryBlock);
        }

        if (item.retrievedEntries.length > MAX_RENDERED_RETRIEVED_ENTRIES) {
            const remaining = item.retrievedEntries.length - MAX_RENDERED_RETRIEVED_ENTRIES;
            expandDiv.appendChild(el('div', 'tv-feed-expand-empty', `+${remaining} more not shown`));
        }
    } catch {
        expandDiv.replaceChildren(el('div', 'tv-feed-expand-empty', 'Failed to load entries'));
    }
}

function toggleBackgroundExpand(row, item) {
    const expandEl = row.nextElementSibling;
    if (expandEl?.classList.contains('tv-feed-expand')) {
        expandEl.remove();
        row.classList.remove('expanded');
        return;
    }

    row.classList.add('expanded');
    const expandDiv = el('div', 'tv-feed-expand tv-feed-expand-bg');
    const actionsDiv = el('div', 'tv-feed-expand-actions');

    if (item.completedAt) {
        const doneLabel = el('span', 'tv-feed-completed-label');
        doneLabel.appendChild(icon('fa-circle-check'));
        doneLabel.append(' Completed');
        actionsDiv.appendChild(doneLabel);
    } else if (item.dismissedAt) {
        const undoBtn = el('button', 'tv-btn tv-btn-sm tv-btn-secondary');
        undoBtn.appendChild(icon('fa-rotate-left'));
        undoBtn.append(' Undo dismiss');
        undoBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            delete item.dismissedAt;
            saveFeed();
            renderAllItems();
        });
        actionsDiv.appendChild(undoBtn);
    } else {
        const actionBtn = el('button', 'tv-btn tv-btn-sm tv-btn-secondary');
        actionBtn.appendChild(icon(item.action.icon || 'fa-arrow-right'));
        actionBtn.append(` ${item.action.label}`);
        actionBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            handleBackgroundAction(item.action, actionBtn, item);
        });
        actionsDiv.appendChild(actionBtn);

        const dismissBtn = el('button', 'tv-btn tv-btn-sm tv-btn-secondary tv-btn-dismiss');
        dismissBtn.appendChild(icon('fa-xmark'));
        dismissBtn.append(' Dismiss');
        dismissBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            item.dismissedAt = Date.now();
            saveFeed();
            renderAllItems();
        });
        actionsDiv.appendChild(dismissBtn);
    }

    expandDiv.appendChild(actionsDiv);
    row.after(expandDiv);
}

async function handleBackgroundAction(action, btn, item) {
    switch (action.type) {
        case 'create-tracker':
            await handleCreateTrackerAction(action, btn, item);
            break;
        case 'open-tree-editor':
            openTreeEditorFromFeed();
            break;
    }
}

async function handleCreateTrackerAction(action, btn, item) {
    if (!action.characterName) return;
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.replaceChildren(icon('fa-spinner fa-spin'));
    btn.append(' Creating…');

    try {
        const result = await createTrackerForCharacter(action.characterName);
        btn.replaceChildren(icon('fa-check'));
        btn.append(` Created (UID ${result.uid})`);
        btn.classList.add('tv-btn-success');

        if (item) {
            item.completedAt = Date.now();
            saveFeed();
        }

        addBackgroundEvent({
            icon: 'fa-address-card',
            verb: 'Tracker created',
            color: '#00b894',
            summary: `"${result.comment}" in ${result.bookName} → ${result.nodeLabel}`,
            details: [`UID ${result.uid}`, result.bookName],
        });
    } catch (err) {
        btn.replaceChildren(icon('fa-triangle-exclamation'));
        btn.append(` Failed: ${err.message}`);
        btn.classList.add('tv-btn-error');
        btn.disabled = false;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            btn.innerHTML = originalHtml;
            btn.classList.remove('tv-btn-error');
            handleCreateTrackerAction(action, btn, item);
        }, { once: true });
    }
}

//── Stats Bar ───────────────────────────────────────────────────

function renderStatsBar() {
    const feedItems = getFeedItemsRaw();
    const bar = el('div', 'tv-feed-stats');
    let nativeEntries = 0, tvEntries = 0, toolCount = 0, bgCount = 0;
    for (const item of feedItems) {
        if (item.type === 'entry') {
            item.source === 'native' ? nativeEntries++ : tvEntries++;
        } else if (item.type === 'tool') toolCount++;
        else if (item.type === 'background') bgCount++;
    }

    addStatPair(bar, 'fa-book-open', nativeEntries + tvEntries, `Entries (${nativeEntries} native, ${tvEntries} TV)`, '#e84393');
    addStatPair(bar, 'fa-gear', toolCount, 'Tool calls', '#f0946c');
    addStatPair(bar, 'fa-robot', bgCount, 'Agent tasks', '#6c5ce7');

    const lbStat = el('div', 'tv-feed-stat');
    lbStat.title = 'Lorebook entries (loading…)';
    const lbIcon = icon('fa-database');
    lbIcon.style.color = '#00b894';
    lbStat.appendChild(lbIcon);
    const lbValue = el('span', 'tv-feed-stat-value', '…');
    lbStat.appendChild(lbValue);
    bar.appendChild(lbStat);

    computeLorebookStats().then(({ facts, summaries, trackers, stale }) => {
        const total = facts + summaries + trackers;
        lbValue.textContent = String(total);
        const staleSuffix = stale > 0 ? `, ${stale} stale` : '';
        lbStat.title = `Lorebook: ${facts} facts, ${summaries} summaries, ${trackers} trackers${staleSuffix}`;

        if (stale > 0) {
            const staleEl = el('div', 'tv-feed-stat');
            staleEl.title = `${stale} entries injected 3+ times but never referenced by the AI`;
            const staleIcon = icon('fa-triangle-exclamation');
            staleIcon.style.color = '#e17055';
            staleEl.appendChild(staleIcon);
            staleEl.appendChild(el('span', 'tv-feed-stat-value', String(stale)));
            bar.appendChild(staleEl);
        }
    }).catch(() => {
        lbValue.textContent = '–';
        lbStat.title = 'Lorebook stats unavailable';
    });

    // Context usage bar
    const usageBar = buildContextUsageBar();
    if (usageBar) bar.appendChild(usageBar);

    return bar;
}

async function computeLorebookStats() {
    const now = Date.now();
    const cache = getLorebookStatsCache();
    if (cache && now - getLorebookStatsCacheTime() < LOREBOOK_STATS_CACHE_TTL) {
        return cache;
    }

    const activeBooks = getActiveTunnelVisionBooks();
    let facts = 0, summaries = 0, trackers = 0, stale = 0;

    for (const bookName of activeBooks) {
        try {
            const bookData = await getCachedWorldInfo(bookName);
            if (!bookData?.entries) continue;
            for (const key of Object.keys(bookData.entries)) {
                const entry = bookData.entries[key];
                if (entry.disable) continue;
                const title = entry.comment || '';
                if (isSummaryTitle(title)) summaries++;
                else if (isTrackerTitle(title)) trackers++;
                else facts++;
            }
            stale += countStaleEntries(bookData);
        } catch { /* skip unavailable books */ }
    }

    const result = { facts, summaries, trackers, stale };
    setLorebookStatsCache(result);
    setLorebookStatsCacheTime(now);
    return result;
}

function buildContextUsageBar() {
    const sizes = getInjectionSizes();
    if (sizes.total === 0) return null;

    const maxTokens = getMaxContextTokens();
    const maxChars = maxTokens > 0 ? maxTokens * CHARS_PER_TOKEN : 0;

    const wrapper = el('div', 'tv-context-usage');

    // Header label
    const labelRow = el('div', 'tv-context-usage-label');
    const labelIcon = icon('fa-microchip');
    labelIcon.style.color = '#a29bfe';
    labelRow.appendChild(labelIcon);

    const tokensUsed = Math.round(sizes.total / CHARS_PER_TOKEN);
    let labelText = `TV: ~${tokensUsed.toLocaleString()} tok`;
    if (maxTokens > 0) {
        const pct = ((sizes.total / maxChars) * 100).toFixed(1);
        labelText += ` / ${maxTokens.toLocaleString()} (${pct}%)`;
    }
    labelRow.appendChild(el('span', 'tv-context-usage-text', labelText));
    wrapper.appendChild(labelRow);

    // Stacked bar showing each slot's contribution
    const SLOT_CONFIG = [
        { key: 'mandatory', label: 'Prompt', color: '#e84393' },
        { key: 'worldState', label: 'World State', color: '#00b894' },
        { key: 'smartContext', label: 'Smart Context', color: '#6c5ce7' },
        { key: 'notebook', label: 'Notebook', color: '#fdcb6e' },
    ];

    const barBase = maxChars > 0 ? maxChars : sizes.total;
    const barOuter = el('div', 'tv-budget-bar');

    for (const slot of SLOT_CONFIG) {
        const val = sizes[slot.key] || 0;
        if (val === 0) continue;
        const pct = Math.max((val / barBase) * 100, 0.5);
        const seg = el('div', 'tv-budget-seg');
        seg.style.width = `${Math.min(pct, 100)}%`;
        seg.style.background = slot.color;
        seg.title = `${slot.label}: ${val.toLocaleString()} chars (~${Math.round(val / 4)} tok)`;
        barOuter.appendChild(seg);
    }

    // Remaining headroom segment
    if (maxChars > 0 && sizes.total < maxChars) {
        const headroom = maxChars - sizes.total;
        const headPct = (headroom / barBase) * 100;
        const headSeg = el('div', 'tv-budget-seg tv-budget-seg-headroom');
        headSeg.style.width = `${headPct}%`;
        headSeg.title = `Available: ${headroom.toLocaleString()} chars (~${Math.round(headroom / 4)} tok)`;
        barOuter.appendChild(headSeg);
    }
    wrapper.appendChild(barOuter);

    // Legend
    const legend = el('div', 'tv-budget-legend');
    for (const slot of SLOT_CONFIG) {
        const val = sizes[slot.key] || 0;
        if (val === 0) continue;
        const item = el('span', 'tv-budget-legend-item');
        const dot = el('span', 'tv-budget-legend-dot');
        dot.style.background = slot.color;
        item.appendChild(dot);
        item.appendChild(document.createTextNode(`${slot.label} ${Math.round(val / 4)}`));
        legend.appendChild(item);
    }
    wrapper.appendChild(legend);

    // Tooltip
    const parts = [];
    if (sizes.mandatory) parts.push(`Prompt: ${sizes.mandatory}`);
    if (sizes.worldState) parts.push(`WS: ${sizes.worldState}`);
    if (sizes.smartContext) parts.push(`SC: ${sizes.smartContext}`);
    if (sizes.notebook) parts.push(`NB: ${sizes.notebook}`);
    wrapper.title = `TunnelVision injection: ${sizes.total} chars (~${tokensUsed} tokens)\n${parts.join(' | ')}`;

    return wrapper;
}

function addStatPair(container, iconClass, value, tooltip, color) {
    const pair = el('div', 'tv-feed-stat');
    pair.title = tooltip;
    const i = icon(iconClass);
    i.style.color = color;
    pair.appendChild(i);
    pair.appendChild(el('span', 'tv-feed-stat-value', String(value)));
    container.appendChild(pair);
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

function refreshActiveTasksInPanel() {
    if (!getPanelEl()?.classList.contains('open')) return;
    if (getShowingWorldState() || getShowingTimeline() || getShowingArcs()) return;
    renderAllItems();
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

function saveFeed() {
    try {
        const context = getContext();
        if (!context.chatMetadata || !context.chatId) return;
        if (getActiveChatId() && context.chatId !== getActiveChatId()) return;
        context.chatMetadata[METADATA_KEY] = { items: getFeedItemsRaw(), nextId: getNextId() };
        context.saveMetadataDebounced?.();
    } catch { /* no active chat */ }
}

function loadFeed() {
    setFeedItems([]);
    setNextId(0);
    setActiveChatId(null);
    try {
        const context = getContext();
        if (!context.chatId) return;
        setActiveChatId(context.chatId);
        const data = context.chatMetadata?.[METADATA_KEY];
        if (data && Array.isArray(data.items)) {
            setFeedItems(data.items);
            setNextId(typeof data.nextId === 'number' ? data.nextId : data.items.length);
            migrateFeedItems(getFeedItemsRaw());
        }
    } catch { /* no active chat */ }
}

/**
 * Backfill missing properties on old feed items so they gain
 * UI affordances that were added after they were originally persisted.
 */
function migrateFeedItems(items) {
    let mutated = false;
    for (const item of items) {
        if (item.type === 'background' && item.verb === 'Tracker suggested' && !item.action && item.summary) {
            const m = item.summary.match(TRACKER_SUGGESTION_NAME_RE);
            if (m) {
                item.action = { type: 'create-tracker', label: 'Create Tracker', icon: 'fa-address-card', characterName: m[1] };
                mutated = true;
            }
        }
    }
    if (mutated) saveFeed();
}

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

    loadFeed();
    createTriggerButton();
    createPanel();

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
            loadFeed();
            setShowingWorldState(false);
            setShowingTimeline(false);
            setShowingArcs(false);
            setShowingHealth(false);
            const panelTabs = getPanelTabs();
            if (panelTabs) panelTabs.style.display = '';if (getPanelEl()?.classList.contains('open')) renderAllItems();
            queueHiddenToolCallRefresh(false);
        });
    }

    // Reset turn accumulator each generation
    if (event_types.GENERATION_STARTED) {
        eventSource.on(event_types.GENERATION_STARTED, () => {
            setTurnToolCalls([]);});
    }
    if (event_types.MESSAGE_RECEIVED) {
        eventSource.on(event_types.MESSAGE_RECEIVED, printTurnSummary);
    }

    queueHiddenToolCallRefresh(false);
}