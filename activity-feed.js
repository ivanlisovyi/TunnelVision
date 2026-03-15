/**
 * TunnelVision Activity Feed
 * Floating widget that shows real-time worldbook entry activations and tool call activity.
 * Lives on document.body as a draggable trigger button + expandable panel.
 */

import { chat, eventSource, event_types, saveChatConditional } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { ALL_TOOL_NAMES, getActiveTunnelVisionBooks } from './tool-registry.js';
import { getSettings, isLorebookEnabled, getTree, isSummaryTitle, isTrackerTitle } from './tree-store.js';
import { findEntry, getCachedWorldInfo } from './entry-manager.js';
import { openTreeEditorForBook } from './ui-controller.js';
import { getWorldStateText, updateWorldState, clearWorldState, isWorldStateUpdating, hasPreviousWorldState, revertWorldState } from './world-state.js';

const MAX_FEED_ITEMS = 50;
const MAX_RENDERED_RETRIEVED_ENTRIES = 5;
const STORAGE_KEY_POS = 'tv-feed-trigger-position';
const METADATA_KEY = 'tunnelvision_feed';
const HIDDEN_TOOL_CALL_FLAG = 'tvHiddenToolCalls';

/** Track which chatId the current feedItems belong to, prevents cross-chat bleed. */
let activeChatId = null;

// Turn-level tool call accumulator for console summary
/** @type {Array<{name: string, verb: string, summary: string}>} */
let turnToolCalls = [];

/**
 * @typedef {Object} RetrievedEntry
 * @property {string} lorebook
 * @property {number|null} uid
 * @property {string} title
 */

/**
 * @typedef {Object} FeedItem
 * @property {number} id
 * @property {'entry'|'tool'|'background'} type
 * @property {string} icon
 * @property {string} verb
 * @property {string} color
 * @property {string} [summary]
 * @property {number} timestamp
 * @property {'native'|'tunnelvision'} [source]
 * @property {string} [lorebook]
 * @property {number|null} [uid]
 * @property {string} [title]
 * @property {string[]} [keys]
 * @property {RetrievedEntry[]} [retrievedEntries]
 * @property {string[]} [details] - Extra detail lines for background items
 */

/** @type {FeedItem[]} */
let feedItems = [];
let nextId = 0;
let feedInitialized = false;
let hiddenToolCallRefreshTimer = null;
let hiddenToolCallRefreshNeedsSync = false;

/** @type {HTMLElement|null} */
let triggerEl = null;
/** @type {HTMLElement|null} */
let panelEl = null;
/** @type {HTMLElement|null} */
let panelBody = null;
/** @type {HTMLElement|null} */
let panelTabs = null;
/** Whether the panel is currently showing the world state view. */
let showingWorldState = false;
/** Whether the panel is currently showing the timeline view. */
let showingTimeline = false;

/** Cached lorebook stats for the stats bar. */
let _lorebookStatsCache = null;
let _lorebookStatsCacheTime = 0;
const LOREBOOK_STATS_CACHE_TTL = 30000;

// Tool display config
const TOOL_DISPLAY = {
    'TunnelVision_Search':     { icon: 'fa-magnifying-glass', verb: 'Searched', color: '#e84393' },
    'TunnelVision_Remember':   { icon: 'fa-brain',           verb: 'Remembered', color: '#6c5ce7' },
    'TunnelVision_Update':     { icon: 'fa-pen',             verb: 'Updated', color: '#f0946c' },
    'TunnelVision_Forget':     { icon: 'fa-eraser',          verb: 'Forgot', color: '#ef4444' },
    'TunnelVision_Reorganize': { icon: 'fa-arrows-rotate',   verb: 'Reorganized', color: '#00b894' },
    'TunnelVision_Summarize':  { icon: 'fa-file-lines',      verb: 'Summarized', color: '#fdcb6e' },
    'TunnelVision_MergeSplit': { icon: 'fa-code-merge',       verb: 'Merged/Split', color: '#0984e3' },
    'TunnelVision_Notebook':   { icon: 'fa-note-sticky',     verb: 'Noted', color: '#a29bfe' },
    // BlackBox
    'BlackBox_Pick':           { icon: 'fa-cube',            verb: 'Picked', color: '#00cec9' },
};

/**
 * Initialize the activity feed — create floating widget and bind events.
 * Called once from index.js init.
 */
export function initActivityFeed() {
    if (feedInitialized) return;
    feedInitialized = true;

    loadFeed();
    createTriggerButton();
    createPanel();

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
            showingWorldState = false;
            showingTimeline = false;
            if (panelTabs) panelTabs.style.display = '';
            if (panelEl?.classList.contains('open')) renderAllItems();
            queueHiddenToolCallRefresh(false);
        });
    }

    // Reset turn accumulator each generation
    if (event_types.GENERATION_STARTED) {
        eventSource.on(event_types.GENERATION_STARTED, () => {
            turnToolCalls = [];
        });
    }
    if (event_types.MESSAGE_RECEIVED) {
        eventSource.on(event_types.MESSAGE_RECEIVED, printTurnSummary);
    }

    queueHiddenToolCallRefresh(false);
}

// ── Persistence (chat metadata) ──

function saveFeed() {
    try {
        const context = getContext();
        if (!context.chatMetadata || !context.chatId) return;
        if (activeChatId && context.chatId !== activeChatId) return;
        context.chatMetadata[METADATA_KEY] = { items: feedItems, nextId };
        context.saveMetadataDebounced?.();
    } catch { /* no active chat */ }
}

function loadFeed() {
    feedItems = [];
    nextId = 0;
    activeChatId = null;
    try {
        const context = getContext();
        if (!context.chatId) return;
        activeChatId = context.chatId;
        const data = context.chatMetadata?.[METADATA_KEY];
        if (data && Array.isArray(data.items)) {
            feedItems = data.items;
            nextId = typeof data.nextId === 'number' ? data.nextId : feedItems.length;
        }
    } catch { /* no active chat */ }
}

// ── DOM Helpers ──

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

// ── Tree editor shortcut ──

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

// ── Trigger Button ──

function createTriggerButton() {
    triggerEl = el('div', 'tv-float-trigger');
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

// ── Panel ──

function createPanel() {
    panelEl = el('div', 'tv-float-panel');

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
    panelTabs = el('div', 'tv-float-panel-tabs');
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
    panelBody = el('div', 'tv-float-panel-body');
    panelEl.appendChild(panelBody);

    renderEmptyState('all');

    document.body.appendChild(panelEl);
}

function togglePanel() {
    if (!panelEl) return;
    const isOpen = panelEl.classList.toggle('open');
    if (isOpen) {
        _lorebookStatsCache = null;
        positionPanel();
        if (showingWorldState) {
            renderWorldStateView();
        } else if (showingTimeline) {
            renderTimelineView();
        } else {
            renderAllItems();
        }
        if (triggerEl) triggerEl.setAttribute('data-tv-count', '0');
    }
}

function positionPanel() {
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

// ── Event Handlers ──

function onWorldInfoActivated(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return;

    const settings = getSettings();
    if (settings.globalEnabled === false) return;

    // Guard: ignore callbacks from a chat we've already switched away from
    try {
        const currentChatId = getContext().chatId;
        if (activeChatId && currentChatId !== activeChatId) return;
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
            timestamp,
        }));
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
        if (activeChatId && currentChatId !== activeChatId) return;
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
            id: nextId++,
            type: 'tool',
            icon: display.icon,
            verb: display.verb,
            color: display.color,
            summary,
            timestamp,
            retrievedEntries,
        });

        // Accumulate for end-of-turn console summary
        turnToolCalls.push({ name: invocation.name, verb: display.verb, summary });
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

// ── Rendering ──

function getActiveTab() {
    return panelEl?.querySelector('.tv-float-tab.active')?.dataset.tab || 'all';
}

function renderEmptyState(tab) {
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
    if (!panelBody) return;
    const tab = getActiveTab();

    panelBody.replaceChildren();

    // Stats bar — only on "All" tab when there are items
    if (tab === 'all' && feedItems.length > 0) {
        panelBody.appendChild(renderStatsBar());
    }

    // Active background tasks — shown at top in 'all' and 'bg' tabs
    const showActiveTasks = (tab === 'all' || tab === 'bg') && _activeTasks.size > 0;
    if (showActiveTasks) {
        for (const task of _activeTasks.values()) {
            panelBody.appendChild(buildActiveTaskElement(task));
        }
    }

    const filtered = feedItems.filter(item => {
        if (tab === 'all') return true;
        if (tab === 'wi') return item.type === 'entry' || item.type === 'wi';
        if (tab === 'tools') return item.type === 'tool';
        if (tab === 'bg') return item.type === 'background';
        return true;
    });

    if (filtered.length === 0 && !showActiveTasks) {
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

function buildItemElement(item) {
    const rowClasses = ['tv-float-item'];
    if (item.type === 'entry') {
        rowClasses.push('tv-float-item-entry');
        rowClasses.push(item.source === 'native' ? 'tv-float-item-entry-native' : 'tv-float-item-entry-tv');
    } else if (item.type === 'wi') {
        // Legacy feed items from before the type rename
        rowClasses.push('tv-float-item-wi');
    }

    const row = el('div', rowClasses.join(' '));

    // Icon
    const iconWrap = el('div', 'tv-float-item-icon');
    iconWrap.style.color = item.color;
    iconWrap.appendChild(icon(item.icon));
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
            chip.title = `${entry.lorebook || 'Lorebook'} | UID ${entry.uid ?? '?'}${entry.title ? ` | ${entry.title}` : ''}`;
            entriesRow.appendChild(chip);
        }

        if (item.retrievedEntries.length > MAX_RENDERED_RETRIEVED_ENTRIES) {
            const remaining = item.retrievedEntries.length - MAX_RENDERED_RETRIEVED_ENTRIES;
            entriesRow.appendChild(
                el('div', 'tv-float-entry-more', `+${remaining} more retrieved entr${remaining === 1 ? 'y' : 'ies'}`),
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

        expandDiv.appendChild(actions);
    } catch (err) {
        expandDiv.replaceChildren(el('div', 'tv-feed-expand-empty', `Failed to load: ${err.message}`));
    }
}

function renderStatsBar() {
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

    computeLorebookStats().then(({ facts, summaries, trackers }) => {
        const total = facts + summaries + trackers;
        lbValue.textContent = String(total);
        lbStat.title = `Lorebook: ${facts} facts, ${summaries} summaries, ${trackers} trackers`;
    }).catch(() => {
        lbValue.textContent = '–';
        lbStat.title = 'Lorebook stats unavailable';
    });

    return bar;
}

async function computeLorebookStats() {
    const now = Date.now();
    if (_lorebookStatsCache && now - _lorebookStatsCacheTime < LOREBOOK_STATS_CACHE_TTL) {
        return _lorebookStatsCache;
    }

    const activeBooks = getActiveTunnelVisionBooks();
    let facts = 0, summaries = 0, trackers = 0;

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
        } catch { /* skip unavailable books */ }
    }

    _lorebookStatsCache = { facts, summaries, trackers };
    _lorebookStatsCacheTime = now;
    return _lorebookStatsCache;
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

function updateBadge(count) {
    if (!triggerEl || panelEl?.classList.contains('open')) return;
    const current = parseInt(triggerEl.getAttribute('data-tv-count') || '0', 10);
    triggerEl.setAttribute('data-tv-count', String(current + count));
}

function pulseTrigger() {
    if (!triggerEl) return;
    triggerEl.classList.add('tv-float-pulse');
    setTimeout(() => triggerEl.classList.remove('tv-float-pulse'), 600);
}

function trimFeed() {
    if (feedItems.length > MAX_FEED_ITEMS) {
        feedItems = feedItems.slice(0, MAX_FEED_ITEMS);
    }
    saveFeed();
}

function addFeedItems(items) {
    if (!Array.isArray(items) || items.length === 0) return;
    _lorebookStatsCache = null;

    feedItems = [...items, ...feedItems];
    trimFeed();
    updateBadge(items.length);
    if (panelEl?.classList.contains('open')) renderAllItems();
    pulseTrigger();
}

// ── Background Activity Indicator ────────────────────────────────

let _activeBackgroundCount = 0;

function setBackgroundActive(active) {
    _activeBackgroundCount += active ? 1 : -1;
    if (_activeBackgroundCount < 0) _activeBackgroundCount = 0;
    if (!triggerEl) return;
    if (_activeBackgroundCount > 0) {
        triggerEl.classList.add('tv-bg-active');
    } else {
        triggerEl.classList.remove('tv-bg-active');
    }
}

/**
 * Log a background agent event to the activity feed.
 * Call this from post-turn processor, world-state, auto-summary, lifecycle, etc.
 * @param {Object} opts
 * @param {string} opts.icon - FontAwesome icon class (e.g. 'fa-brain')
 * @param {string} opts.verb - Action label (e.g. 'Scene archived')
 * @param {string} opts.color - CSS color for the label
 * @param {string} [opts.summary] - Short description text
 * @param {string[]} [opts.details] - Extra detail tags
 */
export function addBackgroundEvent({ icon, verb, color, summary = '', details = [] }) {
    const item = {
        id: nextId++,
        type: 'background',
        icon,
        verb,
        color,
        summary,
        timestamp: Date.now(),
        details: details.filter(Boolean),
    };
    addFeedItems([item]);
}

/**
 * Mark the start of a background operation (shows spinner on trigger button).
 * Returns a function to call when the operation completes.
 * @returns {() => void} Call this when the background operation finishes
 */
export function markBackgroundStart() {
    setBackgroundActive(true);
    let ended = false;
    return () => {
        if (ended) return;
        ended = true;
        setBackgroundActive(false);
    };
}

// ── Cancellable Background Tasks ─────────────────────────────────

/** @type {Map<number, BackgroundTask>} */
const _activeTasks = new Map();
let _nextTaskId = 0;

/**
 * @typedef {Object} BackgroundTask
 * @property {number} id
 * @property {string} label
 * @property {string} icon
 * @property {string} color
 * @property {number} startedAt
 * @property {boolean} cancelled - Check this at async boundaries to abort early
 * @property {() => void} end - Call when the task finishes (success, error, or cancel)
 */

/**
 * Register a cancellable background task. Shows a live indicator in the feed
 * with a cancel button. The caller should check `task.cancelled` at each async
 * boundary and bail out if true.
 *
 * @param {Object} opts
 * @param {string} opts.label - Display label (e.g. 'Post-turn processing')
 * @param {string} [opts.icon='fa-gear'] - FontAwesome icon class
 * @param {string} [opts.color='#6c5ce7'] - CSS color
 * @returns {BackgroundTask}
 */
export function registerBackgroundTask({ label, icon: taskIcon = 'fa-gear', color = '#6c5ce7' }) {
    const id = _nextTaskId++;
    const task = {
        id,
        label,
        icon: taskIcon,
        color,
        startedAt: Date.now(),
        cancelled: false,
        _ended: false,
        end() {
            if (task._ended) return;
            task._ended = true;
            _activeTasks.delete(id);
            setBackgroundActive(false);
            refreshActiveTasksInPanel();
        },
    };

    _activeTasks.set(id, task);
    setBackgroundActive(true);
    refreshActiveTasksInPanel();
    return task;
}

/**
 * Cancel a running background task by ID.
 * Sets the cancelled flag — the processor is responsible for checking it.
 */
export function cancelBackgroundTask(id) {
    const task = _activeTasks.get(id);
    if (task && !task.cancelled) {
        task.cancelled = true;
        console.log(`[TunnelVision] Background task cancelled by user: ${task.label}`);
        refreshActiveTasksInPanel();
    }
}

/** @returns {ReadonlyMap<number, BackgroundTask>} */
export function getActiveTasks() {
    return _activeTasks;
}

function refreshActiveTasksInPanel() {
    if (!panelEl?.classList.contains('open')) return;
    if (showingWorldState || showingTimeline) return;
    renderAllItems();
}

// ── Hidden Tool Call (Visual Hiding) ──

export async function refreshHiddenToolCallMessages({ syncFlags = false } = {}) {
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
    hiddenToolCallRefreshNeedsSync = hiddenToolCallRefreshNeedsSync || syncFlags;
    if (hiddenToolCallRefreshTimer !== null) return;

    hiddenToolCallRefreshTimer = window.setTimeout(async () => {
        const shouldSync = hiddenToolCallRefreshNeedsSync;
        hiddenToolCallRefreshTimer = null;
        hiddenToolCallRefreshNeedsSync = false;
        await refreshHiddenToolCallMessages({ syncFlags: shouldSync });
    }, 50);
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

// ── World State View ──

function toggleWorldStateView() {
    if (showingWorldState) {
        exitWorldStateView();
    } else {
        enterWorldStateView();
    }
}

function enterWorldStateView() {
    showingWorldState = true;
    showingTimeline = false;
    if (panelTabs) panelTabs.style.display = 'none';
    panelEl?.querySelector('.tv-ws-btn')?.classList.add('tv-ws-active');
    panelEl?.querySelector('.tv-timeline-btn')?.classList.remove('tv-timeline-active');
    renderWorldStateView();
}

function exitWorldStateView() {
    showingWorldState = false;
    if (panelTabs) panelTabs.style.display = '';
    panelEl?.querySelector('.tv-ws-btn')?.classList.remove('tv-ws-active');
    if (showingTimeline) {
        renderTimelineView();
    } else {
        renderAllItems();
    }
}

function renderWorldStateView() {
    if (!panelBody) return;
    panelBody.replaceChildren();

    const text = getWorldStateText();
    const container = el('div', 'tv-ws-view');
    container.style.cssText = 'padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; height: 100%;';

    // Header row
    const headerRow = el('div', '');
    headerRow.style.cssText = 'display: flex; align-items: center; justify-content: space-between;';

    const titleEl = el('span', '', 'Rolling World State');
    titleEl.style.cssText = 'font-weight: 600; font-size: 0.9em;';
    headerRow.appendChild(titleEl);

    const backBtn = el('button', 'tv-float-panel-btn', 'Back to Feed');
    backBtn.style.cssText = 'font-size: 0.8em; padding: 2px 8px;';
    backBtn.addEventListener('click', exitWorldStateView);
    headerRow.appendChild(backBtn);
    container.appendChild(headerRow);

    if (!text) {
        // Empty state
        const emptyMsg = el('div', 'tv-float-empty');
        emptyMsg.style.cssText = 'flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;';
        emptyMsg.appendChild(icon('fa-globe'));
        emptyMsg.appendChild(el('span', null, 'No world state yet'));
        emptyMsg.appendChild(el('span', 'tv-float-empty-sub', 'Enable Rolling World State in settings, or click Refresh to generate one now.'));

        const refreshBtn = el('button', 'tv-float-panel-btn');
        refreshBtn.style.cssText = 'margin-top: 8px; padding: 4px 12px; font-size: 0.85em; border: 1px solid rgba(255,255,255,0.15); border-radius: 4px;';
        refreshBtn.textContent = 'Refresh Now';
        refreshBtn.addEventListener('click', () => onWorldStateRefreshFromFeed(refreshBtn));
        emptyMsg.appendChild(refreshBtn);

        container.appendChild(emptyMsg);
    } else {
        // Content display
        const contentEl = el('div', 'tv-ws-content');
        contentEl.style.cssText = 'flex: 1; overflow-y: auto; white-space: pre-wrap; font-size: 0.85em; line-height: 1.5; padding: 8px; border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; background: rgba(0,0,0,0.1); max-height: 260px;';
        contentEl.textContent = text;
        container.appendChild(contentEl);

        // Action buttons
        const actions = el('div', '');
        actions.style.cssText = 'display: flex; gap: 6px; flex-wrap: wrap;';

        const editBtn = el('button', 'tv-float-panel-btn');
        editBtn.style.cssText = 'padding: 3px 10px; font-size: 0.82em; border: 1px solid rgba(255,255,255,0.15); border-radius: 4px;';
        editBtn.appendChild(icon('fa-pen-to-square'));
        editBtn.append(' Edit');
        editBtn.addEventListener('click', () => renderWorldStateEditor(text));
        actions.appendChild(editBtn);

        const refreshBtn = el('button', 'tv-float-panel-btn');
        refreshBtn.style.cssText = 'padding: 3px 10px; font-size: 0.82em; border: 1px solid rgba(255,255,255,0.15); border-radius: 4px;';
        refreshBtn.appendChild(icon('fa-arrows-rotate'));
        refreshBtn.append(' Refresh');
        refreshBtn.addEventListener('click', () => onWorldStateRefreshFromFeed(refreshBtn));
        actions.appendChild(refreshBtn);

        if (hasPreviousWorldState()) {
            const revertBtn = el('button', 'tv-float-panel-btn');
            revertBtn.style.cssText = 'padding: 3px 10px; font-size: 0.82em; border: 1px solid rgba(255,255,255,0.15); border-radius: 4px; color: #e17055;';
            revertBtn.appendChild(icon('fa-rotate-left'));
            revertBtn.append(' Revert');
            revertBtn.addEventListener('click', () => {
                if (revertWorldState()) {
                    toastr.info('World state reverted to previous version', 'TunnelVision');
                    renderWorldStateView();
                } else {
                    toastr.warning('No previous version available', 'TunnelVision');
                }
            });
            actions.appendChild(revertBtn);
        }

        const clearBtn = el('button', 'tv-float-panel-btn');
        clearBtn.style.cssText = 'padding: 3px 10px; font-size: 0.82em; border: 1px solid rgba(255,255,255,0.15); border-radius: 4px; color: #ef4444;';
        clearBtn.appendChild(icon('fa-trash-can'));
        clearBtn.append(' Clear');
        clearBtn.addEventListener('click', () => {
            clearWorldState();
            toastr.info('World state cleared', 'TunnelVision');
            renderWorldStateView();
        });
        actions.appendChild(clearBtn);

        container.appendChild(actions);
    }

    panelBody.appendChild(container);
}

function renderWorldStateEditor(currentText) {
    if (!panelBody) return;
    panelBody.replaceChildren();

    const container = el('div', 'tv-ws-editor');
    container.style.cssText = 'padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; height: 100%;';

    const headerRow = el('div', '');
    headerRow.style.cssText = 'display: flex; align-items: center; justify-content: space-between;';
    const titleEl = el('span', '', 'Edit World State');
    titleEl.style.cssText = 'font-weight: 600; font-size: 0.9em;';
    headerRow.appendChild(titleEl);
    container.appendChild(headerRow);

    const textarea = document.createElement('textarea');
    textarea.className = 'tv-ws-textarea';
    textarea.style.cssText = 'flex: 1; min-height: 200px; max-height: 280px; resize: vertical; font-size: 0.85em; line-height: 1.5; padding: 8px; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; background: rgba(0,0,0,0.2); color: inherit; font-family: inherit;';
    textarea.value = currentText;
    container.appendChild(textarea);

    const actions = el('div', '');
    actions.style.cssText = 'display: flex; gap: 6px;';

    const saveBtn = el('button', 'tv-float-panel-btn');
    saveBtn.style.cssText = 'padding: 4px 14px; font-size: 0.85em; border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; background: rgba(108,92,231,0.3);';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => {
        const newText = textarea.value.trim();
        if (newText) {
            saveWorldStateFromEditor(newText);
            toastr.success('World state saved', 'TunnelVision');
        } else {
            clearWorldState();
            toastr.info('World state cleared', 'TunnelVision');
        }
        renderWorldStateView();
    });
    actions.appendChild(saveBtn);

    const cancelBtn = el('button', 'tv-float-panel-btn');
    cancelBtn.style.cssText = 'padding: 4px 14px; font-size: 0.85em; border: 1px solid rgba(255,255,255,0.1); border-radius: 4px;';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', renderWorldStateView);
    actions.appendChild(cancelBtn);

    container.appendChild(actions);
    panelBody.appendChild(container);

    textarea.focus();
}

function saveWorldStateFromEditor(text) {
    try {
        const context = getContext();
        if (!context.chatMetadata) return;
        const key = 'tunnelvision_worldstate';
        const existing = context.chatMetadata[key] || {};
        context.chatMetadata[key] = {
            ...existing,
            lastUpdated: Date.now(),
            lastUpdateMsgIdx: existing.lastUpdateMsgIdx ?? ((context.chat?.length || 1) - 1),
            text,
        };
        context.saveMetadataDebounced?.();
    } catch { /* metadata not available */ }
}

async function onWorldStateRefreshFromFeed(btn) {
    if (isWorldStateUpdating()) {
        toastr.info('World state update already in progress', 'TunnelVision');
        return;
    }

    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Updating...';

    try {
        const result = await updateWorldState(true);
        if (result) {
            toastr.success('World state updated', 'TunnelVision');
        } else {
            toastr.warning('No result. Ensure you have an active chat with enough messages.', 'TunnelVision');
        }
    } catch (e) {
        toastr.error(`Update failed: ${e.message}`, 'TunnelVision');
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
        if (showingWorldState) renderWorldStateView();
    }
}

// ── Timeline View ──────────────────────────────────────────────

function toggleTimelineView() {
    if (showingTimeline) {
        exitTimelineView();
    } else {
        enterTimelineView();
    }
}

function enterTimelineView() {
    showingTimeline = true;
    showingWorldState = false;
    if (panelTabs) panelTabs.style.display = 'none';
    panelEl?.querySelector('.tv-timeline-btn')?.classList.add('tv-timeline-active');
    panelEl?.querySelector('.tv-ws-btn')?.classList.remove('tv-ws-active');
    renderTimelineView();
}

function exitTimelineView() {
    showingTimeline = false;
    if (panelTabs) panelTabs.style.display = '';
    panelEl?.querySelector('.tv-timeline-btn')?.classList.remove('tv-timeline-active');
    renderAllItems();
}

/**
 * Parse a `[Day X, time]` or `[Day X]` prefix from entry content.
 * Returns { day: number|null, timeLabel: string, rest: string }.
 */
export function parseTimestamp(content) {
    if (!content) return { day: null, timeLabel: '', rest: content || '' };
    const match = content.match(/^\[([^\]]+)\]\s*/);
    if (!match) return { day: null, timeLabel: '', rest: content };

    const tag = match[1].trim();
    const dayMatch = tag.match(/Day\s+(\d+)/i);
    const day = dayMatch ? parseInt(dayMatch[1], 10) : null;
    const rest = content.slice(match[0].length);
    return { day, timeLabel: tag, rest };
}

/**
 * Load all fact/summary entries from active TV lorebooks and group by day.
 * Returns a sorted array of { day, timeLabel, entries[] } groups.
 */
export async function loadTimelineEntries() {
    const activeBooks = getActiveTunnelVisionBooks();
    const items = [];

    for (const bookName of activeBooks) {
        try {
            const bookData = await getCachedWorldInfo(bookName);
            if (!bookData?.entries) continue;
            for (const key of Object.keys(bookData.entries)) {
                const entry = bookData.entries[key];
                if (entry.disable) continue;
                const title = entry.comment || '';
                if (isTrackerTitle(title)) continue;

                const isSummary = isSummaryTitle(title);
                const { day, timeLabel, rest } = parseTimestamp(entry.content || '');
                items.push({
                    uid: entry.uid ?? null,
                    title,
                    content: rest,
                    timeLabel,
                    day,
                    isSummary,
                    lorebook: bookName,
                });
            }
        } catch { /* skip unavailable books */ }
    }

    // Sort: entries with a day come first (ascending), then entries without a day
    items.sort((a, b) => {
        if (a.day != null && b.day != null) return a.day - b.day;
        if (a.day != null) return -1;
        if (b.day != null) return 1;
        return 0;
    });

    // Group by day
    const groups = [];
    let currentGroup = null;
    for (const item of items) {
        const groupKey = item.day ?? -1;
        if (!currentGroup || currentGroup.dayKey !== groupKey) {
            currentGroup = { dayKey: groupKey, day: item.day, entries: [] };
            groups.push(currentGroup);
        }
        currentGroup.entries.push(item);
    }

    return groups;
}

async function renderTimelineView() {
    if (!panelBody) return;
    panelBody.replaceChildren();

    const container = el('div', 'tv-timeline-view');

    // Header row
    const headerRow = el('div', 'tv-timeline-header');
    const titleEl = el('span', 'tv-timeline-title');
    titleEl.appendChild(icon('fa-clock-rotate-left'));
    titleEl.append(' Timeline');
    headerRow.appendChild(titleEl);

    const backBtn = el('button', 'tv-float-panel-btn', 'Back to Feed');
    backBtn.style.cssText = 'font-size: 0.8em; padding: 2px 8px;';
    backBtn.addEventListener('click', exitTimelineView);
    headerRow.appendChild(backBtn);
    container.appendChild(headerRow);

    // Loading state
    const loadingEl = el('div', 'tv-timeline-loading');
    loadingEl.appendChild(el('span', 'tv_loading'));
    loadingEl.appendChild(el('span', null, 'Loading entries...'));
    container.appendChild(loadingEl);
    panelBody.appendChild(container);

    try {
        const groups = await loadTimelineEntries();
        loadingEl.remove();

        if (groups.length === 0) {
            const emptyEl = el('div', 'tv-float-empty');
            emptyEl.style.cssText = 'flex: 1;';
            emptyEl.appendChild(icon('fa-clock-rotate-left'));
            emptyEl.appendChild(el('span', null, 'No facts or summaries yet'));
            emptyEl.appendChild(el('span', 'tv-float-empty-sub', 'Facts and summaries will appear here grouped chronologically by their [Day X] timestamps'));
            container.appendChild(emptyEl);
            return;
        }

        // Stats line
        let totalFacts = 0, totalSummaries = 0;
        for (const g of groups) {
            for (const e of g.entries) {
                e.isSummary ? totalSummaries++ : totalFacts++;
            }
        }
        const statsEl = el('div', 'tv-timeline-stats');
        statsEl.textContent = `${totalFacts} fact${totalFacts !== 1 ? 's' : ''}, ${totalSummaries} summar${totalSummaries !== 1 ? 'ies' : 'y'} across ${groups.length} group${groups.length !== 1 ? 's' : ''}`;
        container.appendChild(statsEl);

        // Timeline body
        const timelineBody = el('div', 'tv-timeline-body');

        for (const group of groups) {
            // Day header
            const dayHeader = el('div', 'tv-timeline-day-header');
            const dayDot = el('div', 'tv-timeline-day-dot');
            dayHeader.appendChild(dayDot);
            const dayLabel = group.day != null
                ? `Day ${group.day}`
                : 'Undated';
            dayHeader.appendChild(el('span', 'tv-timeline-day-label', dayLabel));
            dayHeader.appendChild(el('span', 'tv-timeline-day-count', `${group.entries.length}`));
            timelineBody.appendChild(dayHeader);

            // Entries for this day
            const entriesContainer = el('div', 'tv-timeline-entries');
            for (const entry of group.entries) {
                entriesContainer.appendChild(buildTimelineEntry(entry));
            }
            timelineBody.appendChild(entriesContainer);
        }

        container.appendChild(timelineBody);
    } catch (err) {
        loadingEl.remove();
        container.appendChild(el('div', 'tv-feed-expand-empty', `Failed to load timeline: ${err.message}`));
    }
}

function buildTimelineEntry(entry) {
    const row = el('div', `tv-timeline-entry${entry.isSummary ? ' tv-timeline-summary' : ''}`);

    // Timeline connector
    const connector = el('div', 'tv-timeline-connector');
    const dot = el('div', 'tv-timeline-dot');
    if (entry.isSummary) {
        dot.classList.add('tv-timeline-dot-summary');
    }
    connector.appendChild(dot);
    row.appendChild(connector);

    // Entry content
    const body = el('div', 'tv-timeline-entry-body');

    // Title bar
    const titleRow = el('div', 'tv-timeline-entry-title-row');
    const entryIcon = entry.isSummary
        ? icon('fa-file-lines')
        : icon('fa-brain');
    entryIcon.classList.add('tv-timeline-entry-icon');
    entryIcon.style.color = entry.isSummary ? '#fdcb6e' : '#6c5ce7';
    titleRow.appendChild(entryIcon);
    titleRow.appendChild(el('span', 'tv-timeline-entry-title', truncate(entry.title, 60)));
    if (entry.timeLabel) {
        titleRow.appendChild(el('span', 'tv-timeline-entry-time', entry.timeLabel));
    }
    body.appendChild(titleRow);

    // Content preview (collapsible)
    const preview = el('div', 'tv-timeline-entry-preview');
    preview.textContent = truncate(entry.content, 120);
    body.appendChild(preview);

    // Expandable full content (hidden by default)
    const fullContent = el('div', 'tv-timeline-entry-full');
    fullContent.textContent = entry.content;
    fullContent.style.display = 'none';
    body.appendChild(fullContent);

    // Click to toggle expand
    row.addEventListener('click', () => {
        const isExpanded = row.classList.toggle('tv-timeline-expanded');
        preview.style.display = isExpanded ? 'none' : '';
        fullContent.style.display = isExpanded ? '' : 'none';
    });

    row.appendChild(body);
    return row;
}

// ── Public API ──

export function clearFeed() {
    feedItems = [];
    saveFeed();
    if (triggerEl) triggerEl.setAttribute('data-tv-count', '0');
    if (panelEl?.classList.contains('open')) renderAllItems();
}

export function getFeedItems() {
    return [...feedItems];
}

// ── Entry / Retrieved Entry Helpers ──

function createEntryFeedItem({ source, lorebook = '', uid = null, title = '', keys = [], timestamp }) {
    return {
        id: nextId++,
        type: 'entry',
        source,
        icon: 'fa-book-open',
        verb: source === 'native' ? 'Triggered' : 'Injected',
        color: source === 'native' ? '#e84393' : '#fdcb6e',
        lorebook,
        uid,
        title,
        keys,
        timestamp,
    };
}

function shouldIncludeLorebookForEntries() {
    const lorebooks = new Set(
        feedItems
            .filter(item => item.type === 'entry' && typeof item.lorebook === 'string' && item.lorebook.trim())
            .map(item => item.lorebook.trim()),
    );
    return lorebooks.size > 1;
}

function formatEntrySummary(item, includeLorebook) {
    const title = truncate(item.title || `UID ${item.uid ?? '?'}`, includeLorebook ? 42 : 52);
    const uidLabel = item.uid !== null && item.uid !== undefined ? `#${item.uid}` : '#?';

    if (includeLorebook && item.lorebook) {
        return `${item.lorebook}: ${title} (${uidLabel})`;
    }

    return `${title} (${uidLabel})`;
}

function formatRetrievedEntryLabel(entry, includeLorebook) {
    const title = truncate(entry.title || `UID ${entry.uid ?? '?'}`, includeLorebook ? 42 : 52);
    const uidLabel = entry.uid !== null && entry.uid !== undefined ? `#${entry.uid}` : '#?';

    return includeLorebook
        ? `${entry.lorebook}: ${title} (${uidLabel})`
        : `${title} (${uidLabel})`;
}

// ── Retrieved Entry Parsing ──

function parseInvocationParameters(parameters) {
    if (!parameters) return {};
    if (typeof parameters === 'object') return parameters;

    try {
        return JSON.parse(parameters);
    } catch {
        return {};
    }
}

function extractRetrievedEntries(result) {
    if (!result) return [];

    const text = typeof result === 'string' ? result : JSON.stringify(result);
    const entries = [];
    const seen = new Set();

    for (const line of text.split(/\r?\n/)) {
        const entry = parseRetrievedEntryHeader(line.trim());
        if (!entry) continue;

        const key = `${entry.lorebook}:${entry.uid ?? '?'}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push(entry);
    }

    return entries;
}

export function parseRetrievedEntryHeader(line) {
    if (!line.startsWith('[Lorebook: ') || !line.endsWith(']')) {
        return null;
    }

    const body = line.slice(1, -1);
    const parts = body.split(' | ');
    if (parts.length < 3) {
        return null;
    }

    const lorebook = parts[0].replace(/^Lorebook:\s*/, '').trim();
    const uidRaw = parts[1].replace(/^UID:\s*/, '').trim();
    const title = parts.slice(2).join(' | ').replace(/^Title:\s*/, '').trim();
    const uid = parseInt(uidRaw, 10);

    return {
        lorebook,
        uid: Number.isFinite(uid) ? uid : null,
        title,
    };
}

// ── Tool Summary Builder ──

export function buildToolSummary(toolName, params, result, retrievedEntries = []) {
    switch (toolName) {
        case 'TunnelVision_Search': {
            const action = params.action || 'retrieve';
            const nodeIds = Array.isArray(params.node_ids) ? params.node_ids : (params.node_id ? [params.node_id] : []);
            if (action === 'navigate') {
                return nodeIds.length > 0 ? `navigate ${nodeIds[0]}` : 'navigate tree';
            }
            if (retrievedEntries.length > 0) {
                if (retrievedEntries.length === 1) {
                    const entry = retrievedEntries[0];
                    return `retrieved "${truncate(entry.title || `UID ${entry.uid ?? '?'}`, 42)}"`;
                }
                const lorebooks = new Set(retrievedEntries.map(entry => entry.lorebook).filter(Boolean));
                if (lorebooks.size === 1) {
                    return `retrieved ${retrievedEntries.length} entries from ${Array.from(lorebooks)[0]}`;
                }
                return `retrieved ${retrievedEntries.length} entries from ${lorebooks.size} lorebooks`;
            }
            if (typeof result === 'string' && result.startsWith('Node(s) not found:')) {
                return truncate(result, 60);
            }
            return nodeIds.length > 0 ? `retrieve ${nodeIds.join(', ')}` : 'search tree';
        }
        case 'TunnelVision_Remember': {
            const title = params.title || '';
            return title ? `"${truncate(title, 50)}"` : 'new entry';
        }
        case 'TunnelVision_Update': {
            const uid = params.uid ?? '';
            const title = params.title || '';
            if (title) return `UID ${uid || '?'} -> "${truncate(title, 40)}"`;
            return uid ? `UID ${uid}` : 'existing entry';
        }
        case 'TunnelVision_Forget': {
            const uid = params.uid ?? '';
            const reason = params.reason || '';
            if (uid && reason) return `UID ${uid} (${truncate(reason, 30)})`;
            return uid ? `UID ${uid}` : 'an entry';
        }
        case 'TunnelVision_Reorganize':
            switch (params.action) {
                case 'move':
                    return `UID ${params.uid ?? '?'} -> ${params.target_node_id || '?'}`;
                case 'create_category':
                    return params.label ? `create "${truncate(params.label, 40)}"` : 'create category';
                case 'list_entries':
                    return params.node_id ? `list ${params.node_id}` : 'list entries';
                default:
                    return params.action || 'tree structure';
            }
        case 'TunnelVision_Summarize': {
            const title = params.title || '';
            return title ? `"${truncate(title, 50)}"` : 'scene summary';
        }
        case 'TunnelVision_MergeSplit': {
            const action = params.action || '';
            if (action === 'merge') {
                return `merge ${params.keep_uid ?? '?'} + ${params.remove_uid ?? '?'}`;
            }
            if (action === 'split') {
                return `split ${params.uid ?? '?'}`;
            }
            return 'entries';
        }
        case 'TunnelVision_Notebook': {
            const action = params.action || 'write';
            const title = params.title || '';
            return title ? `${action}: "${truncate(title, 40)}"` : action;
        }
        case 'BlackBox_Pick': {
            const dir = params.director || '?';
            const mood = params.mood || '?';
            return `${dir} × ${mood}`;
        }
        default:
            return '';
    }
}

function truncate(str, max) {
    if (!str) return '';
    return str.length > max ? str.substring(0, max) + '...' : str;
}

function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Print a concise console summary of all TV tool calls made this turn.
 * Fires on MESSAGE_RECEIVED (after all tool recursion completes).
 */
function printTurnSummary() {
    if (turnToolCalls.length === 0) return;
    const lines = turnToolCalls.map((tc, i) => `  ${i + 1}. ${tc.verb} ${tc.summary}`);
    console.log(`[TunnelVision] Turn summary (${turnToolCalls.length} tool calls):\n${lines.join('\n')}`);
    turnToolCalls = [];
}
