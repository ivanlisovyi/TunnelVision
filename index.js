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
import { preflightToolRuntimeState, registerTools, getActiveTunnelVisionBooks, isSearchToolAvailable, NOTEBOOK_NAME, invalidateActiveBookCache, applyRecurseLimit } from './tool-registry.js';
import { resetTurnEntryCount, invalidateWorldInfoCache, invalidateDirtyWorldInfoCache, getCachedWorldInfo } from './entry-manager.js';
import { setInjectionSizes } from './agent-utils.js';
import { buildNotebookPrompt, resetNotebookWriteGuard } from './tools/notebook.js';
import { buildWorldStatePrompt, initWorldState } from './world-state.js';
import { initPostTurnProcessor } from './post-turn-processor.js';
import { buildSmartContextPrompt, initSmartContext, invalidatePreWarmCache, initHierarchyRefs } from './smart-context.js';
import { initMemoryLifecycle } from './memory-lifecycle.js';
import { bindUIEvents, refreshUI } from './ui-controller.js';
import { initActivityFeed } from './activity-feed.js';
import { initCommands } from './commands.js';
import { initAutoSummary } from './auto-summary.js';

const EXTENSION_NAME = 'tunnelvision';
const EXTENSION_FOLDER = `third-party/TunnelVision`;

async function init() {
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
        await registerTools();
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

    console.log('[TunnelVision] Extension loaded');
}

async function onChatChanged() {
    invalidateActiveBookCache();
    invalidateWorldInfoCache();
    invalidatePreWarmCache();
    refreshUI();
    await registerTools();
}

async function onWorldInfoUpdated() {
    invalidateActiveBookCache();
    invalidateWorldInfoCache();
    invalidatePreWarmCache();
    refreshUI();
    await registerTools();
}

async function onAppReady() {
    await registerTools();
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

const TV_PROMPT_KEY = 'tunnelvision_mandatory';
const TV_NOTEBOOK_KEY = 'tunnelvision_notebook';
const TV_WORLDSTATE_KEY = 'tunnelvision_worldstate';
const TV_SMARTCTX_KEY = 'tunnelvision_smartcontext';

/**
 * Map a position setting string to the ST extension_prompt_types enum.
 */
function mapPositionSetting(val) {
    switch (val) {
        case 'in_prompt': return extension_prompt_types.IN_PROMPT;
        case 'in_chat':
        default: return extension_prompt_types.IN_CHAT;
    }
}

/**
 * Map a role setting string to the ST extension_prompt_roles enum.
 */
function mapRoleSetting(val) {
    switch (val) {
        case 'user': return extension_prompt_roles.USER;
        case 'assistant': return extension_prompt_roles.ASSISTANT;
        case 'system':
        default: return extension_prompt_roles.SYSTEM;
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
    let settings, isRecursiveToolPass;

    // ── Synchronous section — must complete before ST builds the prompt ──
    try {
        settings = getSettings();

        const context = getContext();
        const lastMsg = context.chat?.[context.chat.length - 1];
        const invocations = lastMsg?.extra?.tool_invocations;
        isRecursiveToolPass = Array.isArray(invocations) && invocations.length > 0;

        // Reset per-turn state on first pass only (not during tool recursion).
        // Use dirty-flag invalidation so unmodified books stay cached across turns.
        if (!isRecursiveToolPass) {
            resetTurnEntryCount();
            invalidateDirtyWorldInfoCache();
            resetNotebookWriteGuard();
        }

        if (settings.ephemeralResults) {
            stripOldToolResults();
        }

        const mandatoryPosition = mapPositionSetting(settings.mandatoryPromptPosition);
        const mandatoryDepth = settings.mandatoryPromptDepth ?? 1;
        const mandatoryRole = mapRoleSetting(settings.mandatoryPromptRole);

        const activeBooks = getActiveTunnelVisionBooks();
        const enabled = settings.globalEnabled !== false;

        // ── Collect all injection prompts ────────────────────────────
        // Priority order: mandatory > world state > smart context > notebook
        // (if a total budget is set, lower-priority prompts get trimmed first)

        const notebookPosition = mapPositionSetting(settings.notebookPromptPosition);
        const notebookDepth = settings.notebookPromptDepth ?? 1;
        const notebookRole = mapRoleSetting(settings.notebookPromptRole);
        const wsPosition = mapPositionSetting(settings.worldStatePosition);
        const wsDepth = settings.worldStateDepth ?? 2;
        const wsRole = mapRoleSetting(settings.worldStateRole);
        const scPosition = mapPositionSetting(settings.smartContextPosition);
        const scDepth = settings.smartContextDepth ?? 3;
        const scRole = mapRoleSetting(settings.smartContextRole);

        let mandatoryPrompt = '';
        let worldStatePrompt = '';
        let smartContextPrompt = '';
        let notebookPrompt = '';

        if (enabled) {
            if (!isRecursiveToolPass && settings.mandatoryTools && activeBooks.length > 0) {
                mandatoryPrompt = settings.mandatoryPromptText || '[IMPORTANT INSTRUCTION: You MUST use TunnelVision tools this turn.]';
            }
            if (settings.worldStateEnabled) {
                worldStatePrompt = buildWorldStatePrompt();
            }
            if (settings.smartContextEnabled) {
                if (activeBooks.length > 0) {
                    await Promise.all(activeBooks.map(book => getCachedWorldInfo(book)));
                }
                smartContextPrompt = buildSmartContextPrompt();
            }
            if (settings.notebookEnabled !== false) {
                notebookPrompt = buildNotebookPrompt();
            }
        }

        // ── Apply total injection budget (if configured) ────────────
        const budget = settings.totalInjectionBudget || 0;
        if (budget > 0) {
            let remaining = budget;
            // Priority: mandatory > world state > smart context > notebook
            const slots = [
                { name: 'mandatory', get: () => mandatoryPrompt, set: v => { mandatoryPrompt = v; } },
                { name: 'worldState', get: () => worldStatePrompt, set: v => { worldStatePrompt = v; } },
                { name: 'smartContext', get: () => smartContextPrompt, set: v => { smartContextPrompt = v; } },
                { name: 'notebook', get: () => notebookPrompt, set: v => { notebookPrompt = v; } },
            ];
            for (const slot of slots) {
                const text = slot.get();
                if (!text) continue;
                if (text.length <= remaining) {
                    remaining -= text.length;
                } else if (remaining > 200) {
                    const cutoff = text.lastIndexOf('\n', remaining);
                    slot.set(text.substring(0, cutoff > remaining * 0.5 ? cutoff : remaining) + '\n[...budget limit reached]');
                    remaining = 0;
                } else {
                    slot.set('');
                }
            }
        }

        // ── Track injection sizes for UI display ─────────────────────
        setInjectionSizes({
            mandatory: mandatoryPrompt.length,
            worldState: worldStatePrompt.length,
            smartContext: smartContextPrompt.length,
            notebook: notebookPrompt.length,
        });

        // ── Inject all prompts ──────────────────────────────────────
        setExtensionPrompt(TV_PROMPT_KEY, mandatoryPrompt, mandatoryPosition, mandatoryDepth, false, mandatoryRole);
        setExtensionPrompt(TV_WORLDSTATE_KEY, worldStatePrompt, wsPosition, wsDepth, false, wsRole);
        setExtensionPrompt(TV_SMARTCTX_KEY, smartContextPrompt, scPosition, scDepth, false, scRole);
        setExtensionPrompt(TV_NOTEBOOK_KEY, notebookPrompt, notebookPosition, notebookDepth, false, notebookRole);
    } catch (e) {
        console.error('[TunnelVision] Error in onGenerationStarted synchronous section:', e);
        if (!settings) return;
    }

    // ── Async section — background repair ──

    if (settings.globalEnabled !== false) {
        const runtimeState = await preflightToolRuntimeState({ repair: true, reason: 'generation', log: true });

        if (
            !isRecursiveToolPass
            && settings.mandatoryTools
            && runtimeState.activeBooks.length > 0
            && runtimeState.expectedToolNames.length > 0
            && runtimeState.eligibleToolNames.length === 0
        ) {
            console.warn('[TunnelVision] Mandatory tools enabled, but no eligible TunnelVision tools are available for this generation.');
        }
    }
}

// Initialize
await init();
