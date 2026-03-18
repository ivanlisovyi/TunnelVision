/**
 * TunnelVision - Reasoning-Based Lorebook Retrieval
 *
 * Replaces keyword-based lorebook activation with LLM-driven hierarchical
 * tree search via tool calls. The model navigates a tree index to find
 * contextually relevant entries instead of relying on brittle keyword triggers.
 *
 * Architecture:
 *   index.js        — Lean orchestrator (this file). Init, events, wiring only.
 *   tree-store.js   — Tree data structure, CRUD, serialization.
 *   tree-builder.js — Auto-build trees from metadata or LLM.
 *   tool-registry.js— ToolManager registration for all TunnelVision tools.
 *   tools/          — One file per tool (search, remember, update, forget, reorganize, notebook).
 *   entry-manager.js— Lorebook CRUD operations shared by memory tools.
 *   ui-controller.js— Settings panel rendering, tree editor, drag-and-drop.
 *   diagnostics.js  — Failure point checks and auto-fixes.
 *   commands.js     — !command syntax interceptor (summarize, remember, search, forget, ingest).
 *   auto-summary.js — Automatic summary injection every N messages.
 *   world-state.js  — Rolling world state: living story snapshot, updated periodically.
 *   post-turn-processor.js — Background agent: fact extraction + tracker updates after each turn.
 *   smart-context.js — Proactive pre-fetch: auto-inject relevant entries at generation start.
 *   memory-lifecycle.js — Periodic maintenance: consolidation, compression, duplicate detection.
 */

import { eventSource, event_types, extension_prompt_types, extension_prompt_roles, setExtensionPrompt } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { getSettings, isLorebookEnabled } from './tree-store.js';
import { preflightToolRuntimeState, registerTools, unregisterTools, isSearchToolAvailable, NOTEBOOK_NAME, invalidateActiveBookCache, applyRecurseLimit } from './tool-registry.js';
import { invalidateWorldInfoCache } from './entry-manager.js';
import { handleGenerationStartedPromptInjection } from './prompt-injection-service.js';
import { initWorldState } from './world-state.js';
import { initPostTurnProcessor } from './post-turn-processor.js';
import { initSmartContext, invalidatePreWarmCache, initHierarchyRefs } from './smart-context.js';
import { initMemoryLifecycle } from './memory-lifecycle.js';
import { bindUIEvents, refreshUI } from './ui-controller.js';
import { initActivityFeed } from './activity-feed.js';
import { initCommands } from './commands.js';
import { initAutoSummary } from './auto-summary.js';
import {
    beginInitialization,
    completeInitialization,
    recordOrchestrationEvent,
    consumePendingInvalidationState,
    beginSync,
    completeSync,
    updateLastGenerationContext,
    recordGenerationPreflightSummary,
    getOrchestrationRuntimeSnapshot,
    __orchestrationDebug,
} from './runtime-orchestration.js';

const EXTENSION_NAME = 'tunnelvision';
const EXTENSION_FOLDER = `third-party/TunnelVision`;

async function syncToolRegistration(reason) {
    beginSync(reason);

    try {
        const settings = getSettings();
        if (settings.globalEnabled === false) {
            unregisterTools();
            console.log(`[TunnelVision] Tools unregistered (${reason}: extension disabled)`);
            return;
        }

        await registerTools();
        console.log(`[TunnelVision] Tool registration synced (${reason})`);
    } finally {
        completeSync();
    }
}

async function init() {
    beginInitialization();

    // Ensure settings exist
    getSettings();

    // Render settings panel
    const settingsHtml = $(await renderExtensionTemplateAsync(EXTENSION_FOLDER, 'settings'));
    const container = document.getElementById('extensions_settings2');
    if (container) {
        container.appendChild(settingsHtml[0]);
    } else {
        console.error('[TunnelVision] Could not find extensions_settings2 container');
        return;
    }

    // Bind UI events
    bindUIEvents();

    // Initialize activity feed (listens for tool call events)
    initActivityFeed();

    // Register slash commands (/tv-summarize, /tv-remember, etc.)
    initCommands();

    // Wire up auto-summary interval tracking
    initAutoSummary();

    // Wire up rolling world state
    initWorldState();



    // Wire up post-turn processor (background fact extraction + tracker updates)
    initPostTurnProcessor();

    // Wire up memory lifecycle manager (periodic consolidation + compression)
    initMemoryLifecycle();

    // Wire up smart context relevance feedback loop
    initSmartContext();

    // 5A: Connect summary hierarchy to smart-context (lazy to avoid circular imports)
    try {
        const { getRolledUpSceneUids } = await import('./summary-hierarchy.js');
        initHierarchyRefs({ getRolledUpSceneUids });
    } catch (e) {
        console.warn('[TunnelVision] Summary hierarchy init failed:', e);
    }

    // Clean up legacy auto-summary prompt key from the old injection-based system
    try {
        setExtensionPrompt('tunnelvision_autosummary', '', extension_prompt_types.IN_CHAT, 1, false, extension_prompt_roles.SYSTEM);
    } catch { /* ignore if prompt system isn't ready */ }

    // Load initial state
    refreshUI();

    // Apply recurse limit override and register tools
    const settings = getSettings();
    applyRecurseLimit(settings);
    if (settings.globalEnabled !== false) {
        await syncToolRegistration('init');
    }

    // Listen for relevant events
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.WORLDINFO_UPDATED, onWorldInfoUpdated);
    if (event_types.WORLDINFO_SETTINGS_UPDATED) {
        eventSource.on(event_types.WORLDINFO_SETTINGS_UPDATED, onWorldInfoUpdated);
    }
    eventSource.on(event_types.APP_READY, onAppReady);

    // Suppress normal WI keyword scanning for TV-managed lorebooks
    if (event_types.WORLDINFO_ENTRIES_LOADED) {
        eventSource.on(event_types.WORLDINFO_ENTRIES_LOADED, onWorldInfoEntriesLoaded);
        console.debug('[TunnelVision] WI suppression listener registered');
    } else {
        console.warn('[TunnelVision] WORLDINFO_ENTRIES_LOADED event not found, WI suppression disabled');
    }

    // Inject mandatory tool call instruction when enabled
    if (event_types.GENERATION_STARTED) {
        eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    }

    completeInitialization();

    console.log('[TunnelVision] Extension loaded');
}

async function onChatChanged() {
    recordOrchestrationEvent('chat-changed', { invalidationReason: 'chat_changed' });
    invalidateActiveBookCache();
    invalidateWorldInfoCache();
    invalidatePreWarmCache();
    refreshUI();
    await syncToolRegistration('chat-changed');
}

async function onWorldInfoUpdated() {
    recordOrchestrationEvent('worldinfo-updated', { invalidationReason: 'worldinfo_updated' });
    invalidateActiveBookCache();
    invalidateWorldInfoCache();
    invalidatePreWarmCache();
    refreshUI();
    await syncToolRegistration('worldinfo-updated');
}

async function onAppReady() {
    recordOrchestrationEvent('app-ready');
    await syncToolRegistration('app-ready');
}

/**
 * Suppress normal WI keyword scanning for entries belonging to TV-managed lorebooks.
 * TV retrieves these entries via tool calls instead — letting them also trigger via
 * keywords would double-inject them into context.
 * @param {{ globalLore: Array, characterLore: Array, chatLore: Array, personaLore: Array }} data
 */
function onWorldInfoEntriesLoaded(data) {
    const settings = getSettings();
    if (settings.globalEnabled === false) return;

    // Safety net: don't suppress entries if the Search tool isn't registered or
    // tool calling isn't supported. Without Search, suppression would leave the
    // model with zero lorebook context — a total blackout.
    if (!isSearchToolAvailable()) return;

    const passthrough = settings.passthroughConstant !== false;
    let removed = 0;
    let passed = 0;
    const filterTvEntries = (arr) => {
        for (let i = arr.length - 1; i >= 0; i--) {
            if (arr[i].world && isLorebookEnabled(arr[i].world)) {
                // Let constant (always-active) entries through if the toggle is on
                if (passthrough && arr[i].constant) {
                    passed++;
                    continue;
                }
                arr.splice(i, 1);
                removed++;
            }
        }
    };

    filterTvEntries(data.globalLore);
    filterTvEntries(data.characterLore);
    filterTvEntries(data.chatLore);
    filterTvEntries(data.personaLore);

    if (removed > 0 || passed > 0) {
        console.log(`[TunnelVision] Suppressed ${removed} TV-managed entries from normal WI scanning` + (passed > 0 ? `, passed through ${passed} constant entries` : ''));
    }
}



/**
 * Strip TunnelVision tool results from older chat messages to save context tokens.
 * Only strips tools in the user-configured filter list. Notebook is always immune
 * (its results are action confirmations, not retrievable data).
 * Only strips from messages before the last user message (current turn is preserved).
 * Mutates chat data permanently — results cannot be recovered.
 */
function stripOldToolResults() {
    const settings = getSettings();
    const filterList = settings.ephemeralToolFilter;
    if (!Array.isArray(filterList) || filterList.length === 0) return;

    // Notebook is always immune — it stores action confirmations the model needs
    const strippable = new Set(filterList.filter(n => n !== NOTEBOOK_NAME));
    if (strippable.size === 0) return;

    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length < 2) return;

    // Find the last user message index — everything before it is "old"
    let lastUserIdx = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].is_user) { lastUserIdx = i; break; }
    }
    if (lastUserIdx < 1) return;

    let stripped = 0;
    for (let i = 0; i < lastUserIdx; i++) {
        const invocations = chat[i]?.extra?.tool_invocations;
        if (!Array.isArray(invocations)) continue;

        for (const inv of invocations) {
            if (!inv.name || !strippable.has(inv.name)) continue;
            if (!inv.result || inv.result === ' ') continue;
            inv.result = ' ';
            stripped++;
        }
    }

    if (stripped > 0) {
        console.log(`[TunnelVision] Ephemeral mode: cleared ${stripped} old tool result(s) from context`);
    }
}

/**
 * Inject or clear the mandatory tool call system prompt before each generation.
 * Runs before ST assembles the next request, so it can validate TV tool state first.
 *
 * IMPORTANT: All prompt injection and chat mutation is done synchronously (before
 * any await) so it takes effect even if ST's event emitter doesn't await async
 * handlers. The async preflight runs afterward as a background repair for future
 * generations.
 */
async function onGenerationStarted(type, opts) {
    const consumedInvalidations = consumePendingInvalidationState();
    recordOrchestrationEvent('generation-started', {
        generationType: type || null,
        hasOptions: !!opts,
        invalidationReason: 'generation_started',
        consumedInvalidationReasons: consumedInvalidations.reasons,
        consumedInvalidationCounts: consumedInvalidations.counts,
    });

    const { settings, isRecursiveToolPass } = await handleGenerationStartedPromptInjection({
        stripOldToolResults,
        preflightToolRuntimeState,
    });

    updateLastGenerationContext({
        promptInjectionPrepared: true,
        isRecursiveToolPass: !!isRecursiveToolPass,
        mandatoryToolsEnabled: settings?.mandatoryTools === true,
        globalEnabled: settings?.globalEnabled !== false,
    });

    if (
        settings?.globalEnabled !== false
        && !isRecursiveToolPass
        && settings?.mandatoryTools
    ) {
        const runtimeState = await preflightToolRuntimeState({ repair: true, reason: 'generation', log: true });

        recordGenerationPreflightSummary(runtimeState);

        if (
            runtimeState.activeBooks.length > 0
            && runtimeState.expectedToolNames.length > 0
            && runtimeState.eligibleToolNames.length === 0
        ) {
            console.warn('[TunnelVision] Mandatory tools enabled, but no eligible TunnelVision tools are available for this generation.');
        }
    }
}

export { getOrchestrationRuntimeSnapshot, __orchestrationDebug };

// Initialize
await init();
