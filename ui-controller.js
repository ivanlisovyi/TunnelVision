/**
 * TunnelVision UI Controller
 * Handles tree editor rendering, drag-and-drop, settings panel, and all user interactions.
 */

import { saveSettingsDebounced } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { world_names, loadWorldInfo, saveWorldInfo } from '../../../world-info.js';
import { getAutoSummaryCount, resetAutoSummaryCount, setAutoSummaryCount } from './auto-summary.js';
import { getWorldStateText, getWorldStateLastIndex, updateWorldState, clearWorldState, isWorldStateUpdating, hasPreviousWorldState, revertWorldState, DEFAULT_WS_INJECTION_PROMPT, DEFAULT_WS_UPDATE_PROMPT } from './world-state.js';
import { getLastProcessingResult, getLastProcessedIndex } from './post-turn-processor.js';
import { getLastLifecycleResult, getLastLifecycleRunIndex } from './memory-lifecycle.js';
import { getActiveTunnelVisionBooks } from './tool-registry.js';
import { loadTimelineEntries } from './activity-feed.js';
import {
    getTree,
    saveTree,
    deleteTree,
    isLorebookEnabled,
    setLorebookEnabled,
    createTreeNode,
    addEntryToNode,
    removeNode,
    removeEntryFromTree,
    getAllEntryUids,
    getSettings,
    getBookDescription,
    setBookDescription,
    getSelectedLorebook,
    setSelectedLorebook,
    getConnectionProfileId,
    setConnectionProfileId,
    listConnectionProfiles,
    isTrackerUid,
    isTrackerTitle,
    setTrackerUid,
    syncTrackerUidsForLorebook,
    SETTING_DEFAULTS,
} from './tree-store.js';
import { buildTreeFromMetadata, buildTreeWithLLM, generateSummariesForTree, ingestChatMessages } from './tree-builder.js';
import { registerTools, unregisterTools, getDefaultToolDescriptions, stripDynamicContent } from './tool-registry.js';
import { runDiagnostics } from './diagnostics.js';
import { applyRecurseLimit } from './tool-registry.js';
import { refreshHiddenToolCallMessages } from './activity-feed.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { escapeHtml, getEntryVersions } from './entry-manager.js';
import { computeEntryQuality, getQualityRating, getQualityColor, qualityTooltip, buildQualityContext } from './entry-scoring.js';
import { getMaxContextTokens } from './agent-utils.js';


let currentLorebook = null;

function selectCurrentLorebook(bookName) {
    currentLorebook = bookName || null;
    setSelectedLorebook(currentLorebook);
}

function syncSelectedLorebook() {
    if (currentLorebook && world_names?.includes(currentLorebook)) {
        return;
    }

    const preferredLorebook = getSelectedLorebook();
    if (preferredLorebook && world_names?.includes(preferredLorebook)) {
        currentLorebook = preferredLorebook;
        return;
    }

    currentLorebook = null;
}

// ─── Event Bindings ──────────────────────────────────────────────

export function bindUIEvents() {
    // Main collapsible header
    $('#tv_header_toggle').on('click', function () {
        $(this).toggleClass('expanded');
        $(this).closest('.tv-container').find('.tv-settings-body').slideToggle(200);
    });

    $('#tv_global_enabled').on('change', onGlobalToggle);
    $('#tv_lorebook_select').on('change', onLorebookSelect);
    $('#tv_lorebook_enabled').on('change', onLorebookToggle);
    $('#tv_book_description').on('input', onBookDescriptionChange);
    $('#tv_build_metadata').on('click', onBuildFromMetadata);
    $('#tv_build_llm').on('click', onBuildWithLLM);
    $('#tv_open_tree_editor').on('click', onOpenTreeEditor);
    $('#tv_import_file').on('change', onImportTree);

    $('#tv_run_diagnostics').on('click', onRunDiagnostics);

    // Lorebook filter
    $('#tv_lorebook_filter').on('input', onLorebookFilter);

    // Advanced Settings collapsible header
    $('#tv_advanced_header').on('click', function () {
        $(this).toggleClass('expanded');
        $(this).next('.tv-advanced-body').slideToggle(200);
    });

    // Per-tool toggles
    $(document).on('change', '.tv_tool_enabled', onToolToggle);

    // Per-tool confirmation toggles
    $('.tv_tool_confirm').on('change', onToolConfirmToggle);

    // Tool prompt overrides
    $('#tv_tool_prompt_overrides').on('input', '.tv-tool-prompt-textarea', onToolPromptChange);
    $('#tv_tool_prompt_overrides').on('click', '.tv-tool-prompt-reset', onToolPromptReset);

    // Search mode radio
    $('input[name="tv_search_mode"]').on('change', onSearchModeChange);

    // Collapsed tree depth
    $('#tv_collapsed_depth').on('change', onCollapsedDepthChange);

    // Selective retrieval
    $('#tv_selective_retrieval').on('change', onSelectiveRetrievalToggle);

    // Recurse limit
    $('#tv_recurse_limit').on('change', onRecurseLimitChange);

    // LLM build detail level
    $('#tv_llm_detail').on('change', onLlmDetailChange);

    // Tree granularity
    $('#tv_tree_granularity').on('change', onTreeGranularityChange);

    // LLM chunk size
    $('#tv_chunk_tokens').on('change', onChunkTokensChange);

    // Vector dedup toggle + threshold
    $('#tv_vector_dedup').on('change', onVectorDedupToggle);
    $('#tv_dedup_threshold').on('change', onDedupThresholdChange);

    // Chat ingest
    $('#tv_ingest_chat').on('click', onIngestChat);

    // Mandatory tool calls & prompt injection settings
    $('#tv_mandatory_tools').on('change', onMandatoryToolsToggle);
    $('#tv_mandatory_position').on('change', onPromptInjectionChange);
    $('#tv_mandatory_depth').on('change', onPromptInjectionChange);
    $('#tv_mandatory_role').on('change', onPromptInjectionChange);
    $('#tv_mandatory_prompt_text').on('change', onMandatoryPromptTextChange);
    $('#tv_mandatory_prompt_reset').on('click', onMandatoryPromptReset);
    $('#tv_notebook_position').on('change', onPromptInjectionChange);
    $('#tv_notebook_depth').on('change', onPromptInjectionChange);
    $('#tv_notebook_role').on('change', onPromptInjectionChange);
    $('#tv_total_injection_budget').on('change', onTotalInjectionBudgetChange);
    $('#tv_budget_recommend').on('click', onBudgetRecommend);
    $('#tv_stealth_mode').on('change', onStealthModeToggle);
    $('#tv_ephemeral_results').on('change', onEphemeralResultsToggle);
    $('.tv_ephemeral_tool').on('change', onEphemeralToolFilterChange);

    // Slash commands settings
    $('#tv_commands_enabled').on('change', onCommandsEnabledToggle);
    $('#tv_command_context').on('change', onCommandContextChange);

    // Auto-summary settings
    $('#tv_auto_summary_enabled').on('change', onAutoSummaryToggle);
    $('#tv_auto_summary_interval').on('change', onAutoSummaryIntervalChange);
    $('#tv_auto_summary_count').on('change', onAutoSummaryCountChange);
    $('#tv_auto_summary_reset').on('click', onAutoSummaryCountReset);
    $('#tv_auto_hide_summarized').on('change', onAutoHideSummarizedToggle);

    // World state settings
    $('#tv_world_state_enabled').on('change', onWorldStateToggle);
    $('#tv_world_state_interval').on('change', onWorldStateIntervalChange);
    $('#tv_world_state_max_chars').on('change', onWorldStateMaxCharsChange);
    $('#tv_world_state_position').on('change', onWorldStateInjectionChange);
    $('#tv_world_state_depth').on('change', onWorldStateInjectionChange);
    $('#tv_world_state_role').on('change', onWorldStateInjectionChange);
    $('#tv_world_state_refresh').on('click', onWorldStateRefresh);
    $('#tv_world_state_revert').on('click', onWorldStateRevert);
    $('#tv_world_state_clear').on('click', onWorldStateClear);
    $('#tv_ws_injection_prompt').on('input', onWsInjectionPromptChange);
    $('#tv_ws_injection_reset').on('click', onWsInjectionPromptReset);
    $('#tv_ws_update_prompt').on('input', onWsUpdatePromptChange);
    $('#tv_ws_update_reset').on('click', onWsUpdatePromptReset);

    // Post-turn processor settings
    $('#tv_post_turn_enabled').on('change', onPostTurnToggle);
    $('#tv_post_turn_cooldown').on('change', onPostTurnCooldownChange);
    $('#tv_post_turn_extract_facts').on('change', onPostTurnOptionChange);
    $('#tv_post_turn_update_trackers').on('change', onPostTurnOptionChange);
    $('#tv_post_turn_scene_archive').on('change', onPostTurnOptionChange);

    // Lifecycle manager settings
    $('#tv_lifecycle_enabled').on('change', onLifecycleToggle);
    $('#tv_lifecycle_interval').on('change', onLifecycleIntervalChange);
    $('#tv_lifecycle_consolidate').on('change', onLifecycleOptionChange);
    $('#tv_lifecycle_compress').on('change', onLifecycleOptionChange);

    // Smart context settings
    $('#tv_smart_context_enabled').on('change', onSmartContextToggle);
    $('#tv_smart_context_lookback').on('change', onSmartContextSettingChange);
    $('#tv_smart_context_max_entries').on('change', onSmartContextSettingChange);
    $('#tv_smart_context_max_chars').on('change', onSmartContextSettingChange);
    $('#tv_smart_context_position').on('change', onSmartContextInjectionChange);
    $('#tv_smart_context_depth').on('change', onSmartContextInjectionChange);
    $('#tv_smart_context_role').on('change', onSmartContextInjectionChange);

    $('#tv_passthrough_constant').on('change', onPassthroughConstantToggle);

    // Multi-book mode
    $('input[name="tv_multi_book_mode"]').on('change', onMultiBookModeChange);

    // Connection profile
    $('#tv_connection_profile').on('change', onConnectionProfileChange);

    // Diagnostics collapsible header
    $('#tv_diagnostics_header').on('click', function () {
        $(this).toggleClass('expanded');
        $(this).next('.tv-diagnostics-body').slideToggle(200);
    });

    // Import/Export collapsible header
    $('#tv_importexport_header').on('click', function () {
        $(this).toggleClass('expanded');
        $(this).next('.tv-importexport-body').slideToggle(200);
    });

    // Export buttons
    $('#tv_export_worldstate').on('click', onExportWorldState);
    $('#tv_export_notebook').on('click', onExportNotebook);
    $('#tv_export_timeline').on('click', onExportTimeline);

    // Import facts
    $('#tv_import_facts_btn').on('click', () => $('#tv_import_facts_file').trigger('click'));
    $('#tv_import_facts_file').on('change', onImportFacts);

}

// ─── Refresh / Init ──────────────────────────────────────────────

export function refreshUI() {
    const settings = getSettings();
    const globalEnabled = settings.globalEnabled !== false;
    syncSelectedLorebook();

    $('#tv_global_enabled').prop('checked', globalEnabled);
    $('#tv_main_controls').toggle(globalEnabled);

    // Sync tool toggles from settings
    const disabledTools = settings.disabledTools || {};
    $('.tv_tool_enabled').each(function () {
        const toolName = $(this).data('tool');
        $(this).prop('checked', !disabledTools[toolName]);
    });

    // Sync tool confirmation toggles
    const confirmTools = settings.confirmTools || {};
    $('.tv_tool_confirm').each(function () {
        const toolName = $(this).data('tool');
        $(this).prop('checked', !!confirmTools[toolName]);
    });

    // Render tool prompt overrides
    renderToolPromptOverrides();

    // Sync search mode radio
    $(`input[name="tv_search_mode"][value="${settings.searchMode || 'traversal'}"]`).prop('checked', true);

    // Sync collapsed depth
    $('#tv_collapsed_depth').val(settings.collapsedDepth ?? 2);
    $('#tv_collapsed_depth_section').toggle((settings.searchMode || 'traversal') === 'collapsed');

    // Sync selective retrieval
    $('#tv_selective_retrieval').prop('checked', settings.selectiveRetrieval === true);

    // Sync recurse limit
    const recurseLimit = settings.recurseLimit ?? 5;
    $('#tv_recurse_limit').val(recurseLimit);
    $('#tv_recurse_warn').toggle(recurseLimit > 10);

    // Sync LLM detail level
    $('#tv_llm_detail').val(settings.llmBuildDetail || 'lite');

    // Sync tree granularity
    $('#tv_tree_granularity').val(settings.treeGranularity ?? 0);

    // Sync LLM chunk size
    $('#tv_chunk_tokens').val(settings.llmChunkTokens ?? 30000);

    // Sync vector dedup
    const dedupEnabled = settings.enableVectorDedup === true;
    $('#tv_vector_dedup').prop('checked', dedupEnabled);
    $('#tv_dedup_threshold_row').toggle(dedupEnabled);
    $('#tv_dedup_threshold').val(settings.vectorDedupThreshold ?? 0.85);
    updateDedupStatus(dedupEnabled);

    // Sync mandatory tool calls & prompt injection
    $('#tv_mandatory_tools').prop('checked', settings.mandatoryTools === true);
    $('#tv_mandatory_prompt_options').toggle(settings.mandatoryTools === true);
    $('#tv_mandatory_position').val(settings.mandatoryPromptPosition || 'in_chat');
    $('#tv_mandatory_depth').val(settings.mandatoryPromptDepth ?? 1);
    $('#tv_mandatory_role').val(settings.mandatoryPromptRole || 'system');
    $('#tv_mandatory_prompt_text').val(settings.mandatoryPromptText || '');
    $('#tv_mandatory_depth_row').toggle((settings.mandatoryPromptPosition || 'in_chat') === 'in_chat');

    // Sync notebook injection settings
    $('#tv_notebook_position').val(settings.notebookPromptPosition || 'in_chat');
    $('#tv_notebook_depth').val(settings.notebookPromptDepth ?? 1);
    $('#tv_notebook_role').val(settings.notebookPromptRole || 'system');
    $('#tv_notebook_depth_row').toggle((settings.notebookPromptPosition || 'in_chat') === 'in_chat');

    $('#tv_total_injection_budget').val(settings.totalInjectionBudget ?? 0);
    updateBudgetContextInfo(settings.totalInjectionBudget ?? 0);
    $('#tv_stealth_mode').prop('checked', settings.stealthMode === true);
    $('#tv_ephemeral_results').prop('checked', settings.ephemeralResults === true);
    $('#tv_ephemeral_filter_options').toggle(settings.ephemeralResults === true);
    const filterList = settings.ephemeralToolFilter || [];
    $('.tv_ephemeral_tool').each(function () {
        $(this).prop('checked', filterList.includes($(this).val()));
    });

    // Sync slash commands settings
    $('#tv_commands_enabled').prop('checked', settings.commandsEnabled !== false);
    $('#tv_command_context').val(settings.commandContextMessages ?? 50);

    // Sync auto-summary settings
    const autoEnabled = settings.autoSummaryEnabled === true;
    $('#tv_auto_summary_enabled').prop('checked', autoEnabled);
    $('#tv_auto_summary_options').toggle(autoEnabled);
    $('#tv_auto_summary_interval').val(settings.autoSummaryInterval ?? 50);
    $('#tv_auto_summary_count').val(getAutoSummaryCount());
    $('#tv_auto_hide_summarized').prop('checked', settings.autoHideSummarized !== false);

    // Sync world state settings
    const wsEnabled = settings.worldStateEnabled === true;
    $('#tv_world_state_enabled').prop('checked', wsEnabled);
    $('#tv_world_state_options').toggle(wsEnabled);
    $('#tv_world_state_interval').val(settings.worldStateInterval ?? 10);
    $('#tv_world_state_max_chars').val(settings.worldStateMaxChars ?? 3000);
    $('#tv_world_state_position').val(settings.worldStatePosition || 'in_chat');
    $('#tv_world_state_depth').val(settings.worldStateDepth ?? 2);
    $('#tv_world_state_role').val(settings.worldStateRole || 'system');
    $('#tv_world_state_depth_row').toggle((settings.worldStatePosition || 'in_chat') === 'in_chat');
    syncWsPromptOverrides(settings);
    refreshWorldStateStatus();

    // Sync post-turn processor settings
    const ptEnabled = settings.postTurnEnabled === true;
    $('#tv_post_turn_enabled').prop('checked', ptEnabled);
    $('#tv_post_turn_options').toggle(ptEnabled);
    $('#tv_post_turn_cooldown').val(settings.postTurnCooldown ?? 1);
    $('#tv_post_turn_extract_facts').prop('checked', settings.postTurnExtractFacts !== false);
    $('#tv_post_turn_update_trackers').prop('checked', settings.postTurnUpdateTrackers !== false);
    $('#tv_post_turn_scene_archive').prop('checked', settings.postTurnSceneArchive !== false);
    refreshPostTurnStatus();

    // Sync lifecycle manager settings
    const lcEnabled = settings.lifecycleEnabled === true;
    $('#tv_lifecycle_enabled').prop('checked', lcEnabled);
    $('#tv_lifecycle_options').toggle(lcEnabled);
    $('#tv_lifecycle_interval').val(settings.lifecycleInterval ?? 30);
    $('#tv_lifecycle_consolidate').prop('checked', settings.lifecycleConsolidate !== false);
    $('#tv_lifecycle_compress').prop('checked', settings.lifecycleCompress !== false);
    refreshLifecycleStatus();

    // Sync smart context settings
    const scEnabled = settings.smartContextEnabled === true;
    $('#tv_smart_context_enabled').prop('checked', scEnabled);
    $('#tv_smart_context_options').toggle(scEnabled);
    $('#tv_smart_context_lookback').val(settings.smartContextLookback ?? 6);
    $('#tv_smart_context_max_entries').val(settings.smartContextMaxEntries ?? 8);
    $('#tv_smart_context_max_chars').val(settings.smartContextMaxChars ?? 4000);
    $('#tv_smart_context_position').val(settings.smartContextPosition || 'in_chat');
    $('#tv_smart_context_depth').val(settings.smartContextDepth ?? 3);
    $('#tv_smart_context_role').val(settings.smartContextRole || 'system');
    $('#tv_smart_context_depth_row').toggle((settings.smartContextPosition || 'in_chat') === 'in_chat');

    $('#tv_passthrough_constant').prop('checked', settings.passthroughConstant !== false);

    // Sync multi-book mode
    $(`input[name="tv_multi_book_mode"][value="${settings.multiBookMode || 'unified'}"]`).prop('checked', true);

    // Sync connection profile
    populateConnectionProfiles();

    populateLorebookDropdown();
    $('#tv_lorebook_controls').toggle(!!currentLorebook);

    if (currentLorebook) {
        loadLorebookUI(currentLorebook);
    }
}

function onLorebookFilter() {
    const query = $('#tv_lorebook_filter').val().toLowerCase().trim();
    $('#tv_lorebook_list .tv-lorebook-card').each(function () {
        const bookName = $(this).attr('data-book')?.toLowerCase() || '';
        $(this).toggle(!query || bookName.includes(query));
    });
}

function populateLorebookDropdown() {
    syncSelectedLorebook();
    const $list = $('#tv_lorebook_list');
    $list.empty();

    if (!world_names?.length) {
        $list.append('<div class="tv-help-text" style="text-align:center; padding: 12px;">No lorebooks found.</div>');
        return;
    }

    // Sort: TV-enabled first, then active in chat, then alphabetical
    const activeBooks = getActiveTunnelVisionBooks();
    const sorted = [...world_names].sort((a, b) => {
        const aTV = isLorebookEnabled(a) ? 1 : 0;
        const bTV = isLorebookEnabled(b) ? 1 : 0;
        if (aTV !== bTV) return bTV - aTV;
        const aActive = activeBooks.includes(a) ? 1 : 0;
        const bActive = activeBooks.includes(b) ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        return a.localeCompare(b);
    });

    for (const name of sorted) {
        const isActive = activeBooks.includes(name);
        const tvEnabled = isLorebookEnabled(name);
        const tree = getTree(name);
        const hasTree = !!tree?.root?.children?.length;

        const $card = $('<div class="tv-lorebook-card"></div>')
            .toggleClass('tv-lorebook-active', isActive)
            .toggleClass('tv-lorebook-selected', name === currentLorebook)
            .attr('data-book', name);

        const $info = $('<div class="tv-lorebook-card-info"></div>');
        const $name = $('<span class="tv-lorebook-card-name"></span>').text(name);
        $info.append($name);

        // Status badges
        const $badges = $('<div class="tv-lorebook-card-badges"></div>');
        if (!isActive) {
            $badges.append('<span class="tv-badge-inactive">inactive</span>');
        }
        if (tvEnabled) {
            $badges.append('<span class="tv-badge-tv-on"><i class="fa-solid fa-eye"></i> TV On</span>');
        }
        if (hasTree) {
            const count = (tree.root.children || []).length;
            $badges.append(`<span class="tv-badge-tree">${count} cat</span>`);
        }
        $info.append($badges);

        // Status indicator dot
        const dotClass = tvEnabled ? 'tv-dot-on' : (hasTree ? 'tv-dot-ready' : 'tv-dot-off');
        const $dot = $(`<span class="tv-lorebook-dot ${dotClass}"></span>`);

        $card.append($dot, $info);

        $card.on('click', () => {
            selectCurrentLorebook(name);
            $('.tv-lorebook-card').removeClass('tv-lorebook-selected');
            $card.addClass('tv-lorebook-selected');
            $('#tv_lorebook_controls').show();
            loadLorebookUI(name);
        });

        $list.append($card);
    }
}

// ─── Lorebook & Toggle Handlers ──────────────────────────────────

function onGlobalToggle() {
    const enabled = $(this).prop('checked');
    const settings = getSettings();
    settings.globalEnabled = enabled;
    saveSettingsDebounced();
    $('#tv_main_controls').toggle(enabled);
    enabled ? registerTools() : unregisterTools();
}

function onLorebookSelect() {
    // Legacy handler for hidden select (kept for compatibility)
    const bookName = $(this).val();
    selectCurrentLorebook(bookName || null);
    $('#tv_lorebook_controls').toggle(!!bookName);
    if (bookName) loadLorebookUI(bookName);
}

async function loadLorebookUI(bookName) {
    const bookData = await loadWorldInfo(bookName);
    if (bookData?.entries) {
        await syncTrackerUidsForLorebook(bookName, bookData.entries);
    }
    $('#tv_lorebook_enabled').prop('checked', isLorebookEnabled(bookName));
    $('#tv_book_description').val(getBookDescription(bookName) || '');
    const tree = getTree(bookName);
    updateTreeStatus(bookName, tree);
    await renderTreeEditor(bookName, tree);
    await renderUnassignedEntries(bookName, tree, bookData);
    updateIngestUI();
}

function updateIngestUI() {
    const context = getContext();
    const hasChat = !!(context.chatId && context.chat?.length > 0);
    const hasBook = !!currentLorebook && isLorebookEnabled(currentLorebook);

    $('#tv_ingest_container').toggle(hasBook);

    if (hasChat) {
        const maxIdx = context.chat.length - 1;
        $('#tv_ingest_to').attr('max', maxIdx).val(maxIdx);
        $('#tv_ingest_from').attr('max', maxIdx);
        $('#tv_ingest_chat_info').text(`Chat has ${context.chat.length} messages (0-${maxIdx})`);
        $('#tv_ingest_chat').prop('disabled', false);
    } else {
        $('#tv_ingest_chat_info').text('No chat open. Open a chat to ingest messages.');
        $('#tv_ingest_chat').prop('disabled', true);
    }
}

function onLorebookToggle() {
    if (!currentLorebook) return;
    setLorebookEnabled(currentLorebook, $(this).prop('checked'));
    registerTools();
    populateLorebookDropdown(); // refresh badges
}

function onBookDescriptionChange() {
    if (!currentLorebook) return;
    const desc = $(this).val().trim();
    setBookDescription(currentLorebook, desc);
    saveSettingsDebounced();
}

function onToolToggle() {
    const toolName = $(this).data('tool');
    const enabled = $(this).prop('checked');
    const settings = getSettings();
    const disabledTools = settings.disabledTools || {};
    if (enabled) {
        delete disabledTools[toolName];
    } else {
        disabledTools[toolName] = true;
    }
    settings.disabledTools = disabledTools;

    // Sync notebook injection setting with tool toggle
    if (toolName === 'TunnelVision_Notebook') {
        settings.notebookEnabled = enabled;
    }

    saveSettingsDebounced();
    registerTools();
}

// ─── Tool Confirmation Toggles ───────────────────────────────────

function onToolConfirmToggle() {
    const toolName = $(this).data('tool');
    const settings = getSettings();
    if (!settings.confirmTools) settings.confirmTools = {};
    settings.confirmTools[toolName] = $(this).prop('checked');
    saveSettingsDebounced();
    registerTools();
}

// ─── Tool Prompt Overrides ───────────────────────────────────────

function renderToolPromptOverrides() {
    const $container = $('#tv_tool_prompt_overrides');
    $container.empty();

    const settings = getSettings();
    const overrides = settings.toolPromptOverrides || {};
    const defaults = getDefaultToolDescriptions();

    for (const [toolName, defaultDesc] of Object.entries(defaults)) {
        const rawOverride = overrides[toolName] ? stripDynamicContent(overrides[toolName]) : null;
        const currentValue = rawOverride || defaultDesc;
        const isModified = !!rawOverride && rawOverride !== defaultDesc;
        const shortName = toolName.replace('TunnelVision_', '');

        const $block = $(`<div class="tv-tool-prompt-block ${isModified ? 'tv-tool-prompt-modified' : ''}"></div>`);
        const $header = $('<div class="tv-tool-prompt-header"></div>');
        $header.append(`<span class="tv-tool-prompt-label">${shortName}</span>`);
        $header.append(`<button class="tv-tool-prompt-reset" data-tool="${toolName}" title="Reset to default">Reset</button>`);
        $block.append($header);

        const $textarea = $(`<textarea class="tv-tool-prompt-textarea" data-tool="${toolName}" rows="4"></textarea>`);
        $textarea.val(currentValue);
        $block.append($textarea);

        $container.append($block);
    }
}

function onToolPromptChange() {
    const toolName = $(this).data('tool');
    const value = stripDynamicContent($(this).val());
    const settings = getSettings();
    if (!settings.toolPromptOverrides) settings.toolPromptOverrides = {};

    const defaults = getDefaultToolDescriptions();
    if (value === defaults[toolName]) {
        // Value matches default — remove override
        delete settings.toolPromptOverrides[toolName];
        $(this).closest('.tv-tool-prompt-block').removeClass('tv-tool-prompt-modified');
    } else {
        settings.toolPromptOverrides[toolName] = value;
        $(this).closest('.tv-tool-prompt-block').addClass('tv-tool-prompt-modified');
    }
    saveSettingsDebounced();
}

function onToolPromptReset() {
    const toolName = $(this).data('tool');
    const settings = getSettings();
    if (settings.toolPromptOverrides) {
        delete settings.toolPromptOverrides[toolName];
    }
    saveSettingsDebounced();

    const defaults = getDefaultToolDescriptions();
    const $block = $(this).closest('.tv-tool-prompt-block');
    $block.find('.tv-tool-prompt-textarea').val(defaults[toolName] || '');
    $block.removeClass('tv-tool-prompt-modified');
}

function onSearchModeChange() {
    const mode = $('input[name="tv_search_mode"]:checked').val();
    const settings = getSettings();
    settings.searchMode = mode;
    saveSettingsDebounced();
    $('#tv_collapsed_depth_section').toggle(mode === 'collapsed');
    // Re-register to rebuild tool description with new mode
    registerTools();
}

function onCollapsedDepthChange() {
    const raw = Number($('#tv_collapsed_depth').val());
    const clamped = Math.min(4, Math.max(1, Math.round(raw) || 2));
    $('#tv_collapsed_depth').val(clamped);
    const settings = getSettings();
    settings.collapsedDepth = clamped;
    saveSettingsDebounced();
    registerTools();
}

async function onSelectiveRetrievalToggle() {
    const settings = getSettings();
    settings.selectiveRetrieval = $(this).prop('checked');
    saveSettingsDebounced();
    await registerTools();
}

function onRecurseLimitChange() {
    const raw = Number($('#tv_recurse_limit').val());
    const clamped = Math.min(Math.max(Math.round(raw) || 5, 1), 50);
    $('#tv_recurse_limit').val(clamped);
    $('#tv_recurse_warn').toggle(clamped > 10);

    const settings = getSettings();
    settings.recurseLimit = clamped;
    saveSettingsDebounced();
    applyRecurseLimit(settings);
}

function onLlmDetailChange() {
    const settings = getSettings();
    settings.llmBuildDetail = $('#tv_llm_detail').val();
    saveSettingsDebounced();
}

function onTreeGranularityChange() {
    const settings = getSettings();
    settings.treeGranularity = Number($('#tv_tree_granularity').val()) || 0;
    saveSettingsDebounced();
}

function onChunkTokensChange() {
    const raw = Number($('#tv_chunk_tokens').val());
    const clamped = Math.min(Math.max(Math.round(raw / 1000) * 1000 || 30000, 5000), 500000);
    $('#tv_chunk_tokens').val(clamped);

    const settings = getSettings();
    settings.llmChunkTokens = clamped;
    saveSettingsDebounced();
}

function onVectorDedupToggle() {
    const enabled = $(this).prop('checked');
    const settings = getSettings();
    settings.enableVectorDedup = enabled;
    saveSettingsDebounced();
    $('#tv_dedup_threshold_row').toggle(enabled);
    updateDedupStatus(enabled);
}

function onDedupThresholdChange() {
    const raw = Number($('#tv_dedup_threshold').val());
    const clamped = Math.min(Math.max(raw, 0.5), 0.99);
    $('#tv_dedup_threshold').val(clamped);

    const settings = getSettings();
    settings.vectorDedupThreshold = clamped;
    saveSettingsDebounced();
}

/**
 * Update the dedup status indicator.
 * @param {boolean} enabled
 */
function updateDedupStatus(enabled) {
    const $status = $('#tv_dedup_status');
    const $text = $('#tv_dedup_method_text');
    if (!enabled) {
        $status.hide();
        return;
    }
    $status.show();
    $text.text('Using trigram similarity — fast character n-gram matching that catches near-duplicates and morphological variants.');
}

// ─── Tree Building ───────────────────────────────────────────────

async function onBuildFromMetadata() {
    if (!currentLorebook) return;
    const $btn = $('#tv_build_metadata');
    try {
        $btn.prop('disabled', true).html('<span class="tv_loading"></span> Building...');
        const tree = await buildTreeFromMetadata(currentLorebook);
        toastr.success(`Built tree with ${(tree.root.children || []).length} categories`, 'TunnelVision');
        loadLorebookUI(currentLorebook);
        populateLorebookDropdown();
        registerTools();
    } catch (e) {
        toastr.error(e.message, 'TunnelVision');
        console.error('[TunnelVision]', e);
    } finally {
        $btn.prop('disabled', false).html('<i class="fa-solid fa-sitemap"></i> From Metadata');
    }
}

async function onBuildWithLLM() {
    if (!currentLorebook) return;
    const $btn = $('#tv_build_llm');
    const $progress = $('#tv_build_progress');
    const $progressText = $('#tv_build_progress_text');
    const $progressFill = $('#tv_build_progress_fill');
    const $progressDetail = $('#tv_build_progress_detail');

    try {
        $btn.prop('disabled', true).html('<span class="tv_loading"></span> Building...');
        $('#tv_build_metadata').prop('disabled', true);
        $progress.slideDown(200);
        $progressFill.css('width', '0%');
        $progressDetail.text('');

        const tree = await buildTreeWithLLM(currentLorebook, {
            onProgress: (msg, pct) => {
                $progressText.text(msg);
                if (typeof pct === 'number') {
                    $progressFill.css('width', `${Math.min(pct, 100)}%`);
                }
            },
            onDetail: (msg) => $progressDetail.text(msg),
        });

        $progressFill.css('width', '100%');
        $progressText.text('Done!');
        toastr.success(`LLM built tree with ${(tree.root.children || []).length} categories`, 'TunnelVision');
        loadLorebookUI(currentLorebook);
        populateLorebookDropdown();
        registerTools();
    } catch (e) {
        toastr.error(e.message, 'TunnelVision');
        console.error('[TunnelVision]', e);
    } finally {
        $btn.prop('disabled', false).html('<i class="fa-solid fa-brain"></i> With LLM');
        $('#tv_build_metadata').prop('disabled', false);
        setTimeout(() => $progress.slideUp(300), 2000);
    }
}

// ─── Chat Ingest ─────────────────────────────────────────────────

async function onIngestChat() {
    if (!currentLorebook) return;

    const context = getContext();
    if (!context.chatId || !context.chat?.length) {
        toastr.error('No chat is open. Open a chat first.', 'TunnelVision');
        return;
    }

    const from = parseInt($('#tv_ingest_from').val(), 10) || 0;
    const to = parseInt($('#tv_ingest_to').val(), 10) || 0;

    if (from > to) {
        toastr.warning('"From" must be less than or equal to "To".', 'TunnelVision');
        return;
    }

    const $btn = $('#tv_ingest_chat');
    const $progress = $('#tv_ingest_progress');
    const $progressText = $('#tv_ingest_progress_text');
    const $progressFill = $('#tv_ingest_progress_fill');
    const $progressDetail = $('#tv_ingest_progress_detail');

    try {
        $btn.prop('disabled', true).html('<span class="tv_loading"></span> Ingesting...');
        $progress.slideDown(200);
        $progressFill.css('width', '0%');
        $progressDetail.text('');

        const result = await ingestChatMessages(currentLorebook, {
            from,
            to,
            progress: (msg, pct) => {
                $progressText.text(msg);
                if (typeof pct === 'number') {
                    $progressFill.css('width', `${Math.min(pct, 100)}%`);
                }
            },
            detail: (msg) => $progressDetail.text(msg),
        });

        $progressFill.css('width', '100%');
        $progressText.text('Done!');
        toastr.success(`Created ${result.created} entries from chat (${result.errors} errors)`, 'TunnelVision');
        loadLorebookUI(currentLorebook);
        registerTools();
    } catch (e) {
        toastr.error(e.message, 'TunnelVision');
        console.error('[TunnelVision] Ingest error:', e);
    } finally {
        $btn.prop('disabled', false).html('<i class="fa-solid fa-download"></i> Ingest Messages');
        setTimeout(() => $progress.slideUp(300), 2000);
    }
}

function onMandatoryToolsToggle() {
    const settings = getSettings();
    settings.mandatoryTools = $(this).prop('checked');
    saveSettingsDebounced();
    $('#tv_mandatory_prompt_options').toggle(settings.mandatoryTools);
}

function onPromptInjectionChange() {
    const settings = getSettings();
    const $el = $(this);
    const id = $el.attr('id') || '';

    if (id.startsWith('tv_mandatory_')) {
        const field = id.replace('tv_mandatory_', '');
        if (field === 'position') {
            settings.mandatoryPromptPosition = $el.val();
            $('#tv_mandatory_depth_row').toggle($el.val() === 'in_chat');
        } else if (field === 'depth') {
            settings.mandatoryPromptDepth = Math.max(1, Math.round(Number($el.val()) || 1));
            $el.val(settings.mandatoryPromptDepth);
        } else if (field === 'role') {
            settings.mandatoryPromptRole = $el.val();
        }
    } else if (id.startsWith('tv_notebook_')) {
        const field = id.replace('tv_notebook_', '');
        if (field === 'position') {
            settings.notebookPromptPosition = $el.val();
            $('#tv_notebook_depth_row').toggle($el.val() === 'in_chat');
        } else if (field === 'depth') {
            settings.notebookPromptDepth = Math.max(1, Math.round(Number($el.val()) || 1));
            $el.val(settings.notebookPromptDepth);
        } else if (field === 'role') {
            settings.notebookPromptRole = $el.val();
        }
    }

    saveSettingsDebounced();
}

function onMandatoryPromptTextChange() {
    const settings = getSettings();
    settings.mandatoryPromptText = $(this).val() || '';
    saveSettingsDebounced();
}

function onMandatoryPromptReset() {
    const settings = getSettings();
    settings.mandatoryPromptText = SETTING_DEFAULTS.mandatoryPromptText;
    $('#tv_mandatory_prompt_text').val(settings.mandatoryPromptText);
    saveSettingsDebounced();
}

function onTotalInjectionBudgetChange() {
    const raw = Number($('#tv_total_injection_budget').val());
    const clamped = Math.max(Math.round(raw) || 0, 0);
    $('#tv_total_injection_budget').val(clamped);
    const settings = getSettings();
    settings.totalInjectionBudget = clamped;
    saveSettingsDebounced();
    updateBudgetContextInfo(clamped);
}

function onBudgetRecommend() {
    const maxTokens = getMaxContextTokens();
    if (!maxTokens) {
        toastr.warning('Could not detect context window size. Make sure you have an active API connection.', 'TunnelVision');
        return;
    }
    const maxChars = maxTokens * 4;
    const recommended = Math.min(Math.round(maxChars * 0.15 / 500) * 500, 8000);
    $('#tv_total_injection_budget').val(recommended).trigger('change');
    toastr.info(`Recommended ${recommended} chars (~${Math.round(recommended / 4)} tokens) for a ${maxTokens.toLocaleString()}-token context window`, 'TunnelVision');
}

function updateBudgetContextInfo(budget) {
    const infoEl = document.getElementById('tv_budget_context_info');
    const textEl = document.getElementById('tv_budget_percentage_text');
    if (!infoEl || !textEl) return;

    const maxTokens = getMaxContextTokens();
    if (!maxTokens || !budget) {
        infoEl.style.display = 'none';
        return;
    }

    const maxChars = maxTokens * 4;
    const pct = ((budget / maxChars) * 100).toFixed(1);
    const tokens = Math.round(budget / 4);
    textEl.textContent = `≈ ${tokens.toLocaleString()} tokens — ${pct}% of ${maxTokens.toLocaleString()}-token context window`;
    infoEl.style.display = '';
}

function onStealthModeToggle() {
    const settings = getSettings();
    settings.stealthMode = $(this).prop('checked');
    saveSettingsDebounced();
    void refreshHiddenToolCallMessages({ syncFlags: true });
}

function onEphemeralResultsToggle() {
    const settings = getSettings();
    settings.ephemeralResults = $(this).prop('checked');
    $('#tv_ephemeral_filter_options').toggle(settings.ephemeralResults);
    saveSettingsDebounced();
}

function onEphemeralToolFilterChange() {
    const settings = getSettings();
    const selected = [];
    $('.tv_ephemeral_tool:checked').each(function () {
        selected.push($(this).val());
    });
    settings.ephemeralToolFilter = selected;
    saveSettingsDebounced();
}

// ─── Slash Commands Settings ─────────────────────────────────────

function onCommandsEnabledToggle() {
    const settings = getSettings();
    settings.commandsEnabled = $(this).prop('checked');
    saveSettingsDebounced();
}

function onCommandContextChange() {
    const raw = Number($('#tv_command_context').val());
    const clamped = Math.min(Math.max(Math.round(raw) || 50, 5), 500);
    $('#tv_command_context').val(clamped);
    const settings = getSettings();
    settings.commandContextMessages = clamped;
    saveSettingsDebounced();
}

// ─── Auto-Summary Settings ──────────────────────────────────────

function onAutoSummaryToggle() {
    const enabled = $(this).prop('checked');
    const settings = getSettings();
    settings.autoSummaryEnabled = enabled;
    saveSettingsDebounced();
    $('#tv_auto_summary_options').toggle(enabled);
}

function onAutoSummaryIntervalChange() {
    const raw = Number($('#tv_auto_summary_interval').val());
    const clamped = Math.min(Math.max(Math.round(raw) || 50, 5), 200);
    $('#tv_auto_summary_interval').val(clamped);
    const settings = getSettings();
    settings.autoSummaryInterval = clamped;
    saveSettingsDebounced();
}

function onAutoSummaryCountChange() {
    const raw = Number($('#tv_auto_summary_count').val());
    const clamped = Math.max(0, Math.round(raw) || 0);
    $('#tv_auto_summary_count').val(clamped);
    setAutoSummaryCount(clamped);
}

function onAutoSummaryCountReset() {
    resetAutoSummaryCount();
    $('#tv_auto_summary_count').val(0);
}

function onAutoHideSummarizedToggle() {
    const enabled = $(this).prop('checked');
    const settings = getSettings();
    settings.autoHideSummarized = enabled;
    saveSettingsDebounced();
}

// ── World State Handlers ─────────────────────────────────────────

function onWorldStateToggle() {
    const enabled = $(this).prop('checked');
    const settings = getSettings();
    settings.worldStateEnabled = enabled;
    saveSettingsDebounced();
    $('#tv_world_state_options').toggle(enabled);
}

function onWorldStateIntervalChange() {
    const raw = Number($('#tv_world_state_interval').val());
    const clamped = Math.min(Math.max(Math.round(raw) || 10, 3), 100);
    $('#tv_world_state_interval').val(clamped);
    const settings = getSettings();
    settings.worldStateInterval = clamped;
    saveSettingsDebounced();
}

function onWorldStateMaxCharsChange() {
    const raw = Number($('#tv_world_state_max_chars').val());
    const clamped = Math.min(Math.max(Math.round(raw) || 3000, 500), 10000);
    $('#tv_world_state_max_chars').val(clamped);
    const settings = getSettings();
    settings.worldStateMaxChars = clamped;
    saveSettingsDebounced();
}

function onWorldStateInjectionChange() {
    const settings = getSettings();
    const $el = $(this);
    const id = $el.attr('id') || '';
    const field = id.replace('tv_world_state_', '');

    if (field === 'position') {
        settings.worldStatePosition = $el.val();
        $('#tv_world_state_depth_row').toggle($el.val() === 'in_chat');
    } else if (field === 'depth') {
        settings.worldStateDepth = Math.max(0, Math.round(Number($el.val()) || 2));
        $el.val(settings.worldStateDepth);
    } else if (field === 'role') {
        settings.worldStateRole = $el.val();
    }
    saveSettingsDebounced();
}

async function onWorldStateRefresh() {
    const $btn = $('#tv_world_state_refresh');
    $btn.prop('disabled', true).text('Updating...');
    try {
        const result = await updateWorldState(true);
        if (result) {
            toastr.success('World state updated', 'TunnelVision');
        } else {
            toastr.warning('World state update returned no result. Ensure you have an active chat with enough messages.', 'TunnelVision');
        }
    } catch (e) {
        toastr.error(`World state update failed: ${e.message}`, 'TunnelVision');
    } finally {
        $btn.prop('disabled', false).text('Refresh Now');
        refreshWorldStateStatus();
    }
}

function onWorldStateRevert() {
    if (revertWorldState()) {
        toastr.info('World state reverted to previous version', 'TunnelVision');
    } else {
        toastr.warning('No previous world state version available', 'TunnelVision');
    }
    refreshWorldStateStatus();
}

function onWorldStateClear() {
    clearWorldState();
    toastr.info('World state cleared', 'TunnelVision');
    refreshWorldStateStatus();
}

function refreshWorldStateStatus() {
    const text = getWorldStateText();
    const lastIdx = getWorldStateLastIndex();

    if (text) {
        const wordCount = text.split(/\s+/).length;
        const preview = text.length > 600 ? text.substring(0, 600) + '...' : text;
        $('#tv_world_state_status_text').text(`Last updated at message #${lastIdx + 1} (${wordCount} words)`);
        $('#tv_world_state_preview').text(preview).show();
    } else {
        $('#tv_world_state_status_text').text('No world state yet');
        $('#tv_world_state_preview').hide();
    }

    $('#tv_world_state_revert').toggle(hasPreviousWorldState());
}

// ── World State Prompt Override Handlers ──────────────────────────

function syncWsPromptOverrides(settings) {
    const injOverride = settings.worldStateInjectionOverride || '';
    const updOverride = settings.worldStateUpdateOverride || '';
    $('#tv_ws_injection_prompt').val(injOverride || DEFAULT_WS_INJECTION_PROMPT);
    $('#tv_ws_update_prompt').val(updOverride || DEFAULT_WS_UPDATE_PROMPT);
    $('#tv_ws_injection_block').toggleClass('tv-tool-prompt-modified', !!injOverride);
    $('#tv_ws_update_block').toggleClass('tv-tool-prompt-modified', !!updOverride);
}

function onWsInjectionPromptChange() {
    const value = $(this).val().trim();
    const settings = getSettings();
    if (!value || value === DEFAULT_WS_INJECTION_PROMPT) {
        settings.worldStateInjectionOverride = '';
        $('#tv_ws_injection_block').removeClass('tv-tool-prompt-modified');
    } else {
        settings.worldStateInjectionOverride = value;
        $('#tv_ws_injection_block').addClass('tv-tool-prompt-modified');
    }
    saveSettingsDebounced();
}

function onWsInjectionPromptReset() {
    const settings = getSettings();
    settings.worldStateInjectionOverride = '';
    saveSettingsDebounced();
    $('#tv_ws_injection_prompt').val(DEFAULT_WS_INJECTION_PROMPT);
    $('#tv_ws_injection_block').removeClass('tv-tool-prompt-modified');
}

function onWsUpdatePromptChange() {
    const value = $(this).val().trim();
    const settings = getSettings();
    if (!value || value === DEFAULT_WS_UPDATE_PROMPT) {
        settings.worldStateUpdateOverride = '';
        $('#tv_ws_update_block').removeClass('tv-tool-prompt-modified');
    } else {
        settings.worldStateUpdateOverride = value;
        $('#tv_ws_update_block').addClass('tv-tool-prompt-modified');
    }
    saveSettingsDebounced();
}

function onWsUpdatePromptReset() {
    const settings = getSettings();
    settings.worldStateUpdateOverride = '';
    saveSettingsDebounced();
    $('#tv_ws_update_prompt').val(DEFAULT_WS_UPDATE_PROMPT);
    $('#tv_ws_update_block').removeClass('tv-tool-prompt-modified');
}

// ── Post-Turn Processor Handlers ─────────────────────────────────

function onPostTurnToggle() {
    const enabled = $(this).prop('checked');
    const settings = getSettings();
    settings.postTurnEnabled = enabled;
    saveSettingsDebounced();
    $('#tv_post_turn_options').toggle(enabled);
}

function onPostTurnCooldownChange() {
    const raw = Number($('#tv_post_turn_cooldown').val());
    const clamped = Math.min(Math.max(Math.round(raw) || 1, 1), 20);
    $('#tv_post_turn_cooldown').val(clamped);
    const settings = getSettings();
    settings.postTurnCooldown = clamped;
    saveSettingsDebounced();
}

function onPostTurnOptionChange() {
    const settings = getSettings();
    settings.postTurnExtractFacts = $('#tv_post_turn_extract_facts').prop('checked');
    settings.postTurnUpdateTrackers = $('#tv_post_turn_update_trackers').prop('checked');
    settings.postTurnSceneArchive = $('#tv_post_turn_scene_archive').prop('checked');
    saveSettingsDebounced();
}

function refreshPostTurnStatus() {
    const lastResult = getLastProcessingResult();
    const lastIdx = getLastProcessedIndex();

    if (lastResult) {
        const parts = [];
        if (lastResult.factsCreated > 0) parts.push(`${lastResult.factsCreated} fact(s)`);
        if (lastResult.sceneArchived) parts.push('scene archived');
        if (lastResult.trackersUpdated > 0) parts.push(`${lastResult.trackersUpdated} tracker(s)`);
        const summary = parts.length > 0 ? parts.join(', ') : 'no changes';
        $('#tv_post_turn_status_text').text(`Last run at message #${lastIdx + 1}: ${summary}`);
    } else {
        $('#tv_post_turn_status_text').text('Not yet run this chat');
    }
}

// ── Lifecycle Manager Handlers ───────────────────────────────────

function onLifecycleToggle() {
    const enabled = $(this).prop('checked');
    const settings = getSettings();
    settings.lifecycleEnabled = enabled;
    saveSettingsDebounced();
    $('#tv_lifecycle_options').toggle(enabled);
}

function onLifecycleIntervalChange() {
    const raw = Number($('#tv_lifecycle_interval').val());
    const clamped = Math.min(Math.max(Math.round(raw) || 30, 10), 200);
    $('#tv_lifecycle_interval').val(clamped);
    const settings = getSettings();
    settings.lifecycleInterval = clamped;
    saveSettingsDebounced();
}

function onLifecycleOptionChange() {
    const settings = getSettings();
    settings.lifecycleConsolidate = $('#tv_lifecycle_consolidate').prop('checked');
    settings.lifecycleCompress = $('#tv_lifecycle_compress').prop('checked');
    saveSettingsDebounced();
}

function refreshLifecycleStatus() {
    const lastResult = getLastLifecycleResult();
    const lastIdx = getLastLifecycleRunIndex();

    if (lastResult) {
        const parts = [];
        if (lastResult.entriesCompressed > 0) parts.push(`${lastResult.entriesCompressed} compressed`);
        if (lastResult.duplicatesFound > 0) parts.push(`${lastResult.duplicatesFound} duplicate pairs`);
        const summary = parts.length > 0 ? parts.join(', ') : 'no changes';
        $('#tv_lifecycle_status_text').text(`Last run at message #${lastIdx + 1}: ${summary}`);
    } else {
        $('#tv_lifecycle_status_text').text('Not yet run this chat');
    }
}

// ── Smart Context Handlers ───────────────────────────────────────

function onSmartContextToggle() {
    const enabled = $(this).prop('checked');
    const settings = getSettings();
    settings.smartContextEnabled = enabled;
    saveSettingsDebounced();
    $('#tv_smart_context_options').toggle(enabled);
}

function onSmartContextSettingChange() {
    const settings = getSettings();
    settings.smartContextLookback = Math.min(Math.max(Math.round(Number($('#tv_smart_context_lookback').val())) || 6, 2), 30);
    settings.smartContextMaxEntries = Math.min(Math.max(Math.round(Number($('#tv_smart_context_max_entries').val())) || 8, 1), 30);
    settings.smartContextMaxChars = Math.min(Math.max(Math.round(Number($('#tv_smart_context_max_chars').val())) || 4000, 500), 20000);
    $('#tv_smart_context_lookback').val(settings.smartContextLookback);
    $('#tv_smart_context_max_entries').val(settings.smartContextMaxEntries);
    $('#tv_smart_context_max_chars').val(settings.smartContextMaxChars);
    saveSettingsDebounced();
}

function onSmartContextInjectionChange() {
    const settings = getSettings();
    const $el = $(this);
    const id = $el.attr('id') || '';
    const field = id.replace('tv_smart_context_', '');

    if (field === 'position') {
        settings.smartContextPosition = $el.val();
        $('#tv_smart_context_depth_row').toggle($el.val() === 'in_chat');
    } else if (field === 'depth') {
        settings.smartContextDepth = Math.max(0, Math.round(Number($el.val()) || 3));
        $el.val(settings.smartContextDepth);
    } else if (field === 'role') {
        settings.smartContextRole = $el.val();
    }
    saveSettingsDebounced();
}

function onPassthroughConstantToggle() {
    const enabled = $(this).prop('checked');
    const settings = getSettings();
    settings.passthroughConstant = enabled;
    saveSettingsDebounced();
}

// ─── Multi-Book Mode ─────────────────────────────────────────────

function onMultiBookModeChange() {
    const mode = $('input[name="tv_multi_book_mode"]:checked').val();
    const settings = getSettings();
    settings.multiBookMode = mode;
    saveSettingsDebounced();
    registerTools();
}

// ─── Connection Profile ──────────────────────────────────────────

function onConnectionProfileChange() {
    setConnectionProfileId($(this).val() || null);
}

function populateConnectionProfiles() {
    const $select = $('#tv_connection_profile');
    const currentVal = getConnectionProfileId() || '';

    // Keep the first option (default)
    $select.find('option:not(:first)').remove();

    for (const profile of listConnectionProfiles().sort((a, b) => (a.name || '').localeCompare(b.name || ''))) {
        if (!profile?.id || !profile?.name) continue;
        $select.append($('<option></option>').val(profile.id).text(profile.name));
    }

    $select.val(currentVal);
}

// ─── Tree Management ─────────────────────────────────────────────

/**
 * Open the tree editor for a specific lorebook. Exported for use by the activity feed.
 * Sets currentLorebook so internal state stays consistent.
 * @param {string} bookName
 */
export async function openTreeEditorForBook(bookName) {
    selectCurrentLorebook(bookName);
    await onOpenTreeEditor();
}

async function onOpenTreeEditor() {
    if (!currentLorebook) return;
    const tree = getTree(currentLorebook);
    if (!tree || !tree.root) {
        toastr.warning('Build a tree first before opening the editor.', 'TunnelVision');
        return;
    }

    const bookData = await loadWorldInfo(currentLorebook);
    if (bookData?.entries) {
        await syncTrackerUidsForLorebook(currentLorebook, bookData.entries);
    }
    const entryLookup = buildEntryLookup(bookData);
    const bookName = currentLorebook;

    // Pre-compute entry quality context once for the editor session
    const qualityCtx = buildQualityContext(bookData);

    // State: which node is selected in the tree
    let selectedNode = tree.root;

    // Build the popup content
    const $popup = $('<div class="tv-popup-editor"></div>');

    // Toolbar
    const $toolbar = $(`<div class="tv-popup-toolbar">
        <div class="tv-popup-toolbar-left">
            <span class="tv-popup-title"><i class="fa-solid fa-folder-tree"></i> ${escapeHtml(bookName)}</span>
        </div>
        <div class="tv-popup-toolbar-right">
            <button class="tv-popup-btn" id="tv_popup_add_cat" title="Add category"><i class="fa-solid fa-folder-plus"></i> Add Category</button>
            <button class="tv-popup-btn" id="tv_popup_regen" title="Regenerate summaries"><i class="fa-solid fa-rotate"></i> Regen Summaries</button>
            <button class="tv-popup-btn" id="tv_popup_export" title="Export"><i class="fa-solid fa-file-export"></i></button>
            <button class="tv-popup-btn" id="tv_popup_import" title="Import"><i class="fa-solid fa-file-import"></i></button>
            <button class="tv-popup-btn tv-popup-btn-danger" id="tv_popup_delete" title="Delete tree"><i class="fa-solid fa-trash-can"></i></button>
        </div>
    </div>`);
    $popup.append($toolbar);

    // Search bar
    const $search = $(`<div class="tv-popup-search">
        <i class="fa-solid fa-magnifying-glass"></i>
        <input type="text" id="tv_popup_search" placeholder="Search categories and entries..." />
    </div>`);
    $popup.append($search);

    // Body: tree sidebar + main panel
    const $body = $('<div class="tv-popup-body"></div>');
    const $treeSidebar = $('<div class="tv-tree-sidebar"></div>');
    const $treeHeader = $('<div class="tv-tree-sidebar-header"><span>Tree</span></div>');
    const $treeScroll = $('<div class="tv-tree-sidebar-scroll"></div>');
    $treeSidebar.append($treeHeader, $treeScroll);

    const $mainPanel = $('<div class="tv-main-panel"></div>');

    $body.append($treeSidebar, $mainPanel);
    $popup.append($body);

    // --- Render functions ---

    function selectNode(node) {
        selectedNode = node;
        renderTreeNodes();
        renderMainPanel();
    }

    function isRootNode(node) {
        return !!node && node.id === tree.root.id;
    }

    function countActiveEntries(node) {
        return getAllEntryUids(node).filter(uid => !!entryLookup[uid] && !entryLookup[uid].disable).length;
    }

    function assignEntryToNode(uid, targetNode) {
        removeEntryFromTree(tree.root, uid);
        addEntryToNode(targetNode, uid);
        saveTree(bookName, tree);
    }

    function renderTreeNodes() {
        $treeScroll.empty();
        $treeScroll.append(buildTreeNode(tree.root, 0, { isRoot: true }));
        // Unassigned pseudo-node
        const unassigned = getUnassignedEntries(bookData, tree);
        if (unassigned.length > 0) {
            const $unRow = $('<div class="tv-tree-row tv-tree-row-unassigned"></div>');
            $unRow.append($('<span class="tv-tree-toggle"></span>'));
            $unRow.append($('<span class="tv-tree-dot" style="opacity:0.4"></span>'));
            $unRow.append($('<span class="tv-tree-label" style="color:var(--SmartThemeQuoteColor,#888)"></span>').text('Unassigned'));
            $unRow.append($(`<span class="tv-tree-count">${unassigned.length}</span>`));
            $unRow.on('click', () => {
                selectedNode = { id: '__unassigned__', label: 'Unassigned', entryUids: unassigned.map(e => e.uid), children: [] };
                renderTreeNodes();
                renderMainPanel();
            });
            if (selectedNode?.id === '__unassigned__') $unRow.addClass('active');
            $treeScroll.append($('<div style="margin-top:6px;padding-top:6px;border-top:1px solid var(--SmartThemeBorderColor,#444)"></div>').append($unRow));
        }
    }

    function buildTreeNode(node, depth, { isRoot = false } = {}) {
        const $wrapper = $('<div class="tv-tree-node"></div>');
        const hasChildren = (node.children || []).length > 0;
        const isActive = selectedNode?.id === node.id;
        const count = countActiveEntries(node);
        const label = isRoot ? 'Root' : (node.label || 'Unnamed');

        const $row = $(`<div class="tv-tree-row${isActive ? ' active' : ''}${isRoot ? ' tv-tree-row-root' : ''}"></div>`);
        const $toggle = $(`<span class="tv-tree-toggle">${hasChildren ? (node.collapsed ? '\u25B6' : '\u25BC') : ''}</span>`);
        const $dot = $('<span class="tv-tree-dot"></span>');
        const $label = $('<span class="tv-tree-label"></span>').text(label);
        const $count = $(`<span class="tv-tree-count">${count}</span>`);

        // Click toggle to expand/collapse
        $toggle.on('click', (e) => {
            e.stopPropagation();
            node.collapsed = !node.collapsed;
            saveTree(bookName, tree);
            renderTreeNodes();
        });

        // Click row to select
        $row.on('click', () => selectNode(node));

        // Drop target: drag entries onto tree nodes
        $row.on('dragover', (e) => { e.preventDefault(); $row.addClass('tv-tree-drop-target'); });
        $row.on('dragleave', () => $row.removeClass('tv-tree-drop-target'));
        $row.on('drop', (e) => {
            e.preventDefault();
            $row.removeClass('tv-tree-drop-target');
            const raw = e.originalEvent.dataTransfer.getData('text/plain');
            if (!raw || !/^\d+$/.test(raw)) return;
            const uid = Number(raw);
            assignEntryToNode(uid, node);
            selectNode(node);
            renderUnassignedEntries(bookName, tree, bookData);
            registerTools();
        });

        $row.append($toggle, $dot, $label, $count);
        $wrapper.append($row);

        // Children (recursive — no depth limit)
        if (hasChildren && !node.collapsed) {
            const $children = $('<div class="tv-tree-children"></div>');
            for (const child of node.children) {
                $children.append(buildTreeNode(child, depth + 1));
            }
            $wrapper.append($children);
        }

        return $wrapper;
    }

    function buildBreadcrumb(node) {
        if (node.id === '__unassigned__') {
            const $bc = $('<div class="tv-main-breadcrumb"></div>');
            const $rootCrumb = $('<span class="tv-bc-crumb"></span>').text('Root');
            $rootCrumb.on('click', () => selectNode(tree.root));
            $bc.append($rootCrumb);
            $bc.append($('<span class="tv-bc-sep">\u25B8</span>'));
            $bc.append($('<span class="tv-bc-current"></span>').text('Unassigned'));
            return $bc;
        }

        const path = [];
        const findPath = (current, target, trail) => {
            trail.push(current);
            if (current.id === target.id) return true;
            for (const child of (current.children || [])) {
                if (findPath(child, target, trail)) return true;
            }
            trail.pop();
            return false;
        };
        findPath(tree.root, node, path);

        const $bc = $('<div class="tv-main-breadcrumb"></div>');
        for (let i = 0; i < path.length; i++) {
            if (i > 0) $bc.append($('<span class="tv-bc-sep">\u25B8</span>'));
            const n = path[i];
            const label = n === tree.root ? 'Root' : (n.label || 'Unnamed');
            if (i < path.length - 1) {
                const $crumb = $('<span class="tv-bc-crumb"></span>').text(label);
                $crumb.on('click', () => selectNode(n));
                $bc.append($crumb);
            } else {
                $bc.append($('<span class="tv-bc-current"></span>').text(label));
            }
        }
        return $bc;
    }

    function renderMainPanel() {
        $mainPanel.empty();
        const node = selectedNode;
        if (!node) return;

        const isUnassigned = node.id === '__unassigned__';
        const isRoot = isRootNode(node);

        // Header
        const $header = $('<div class="tv-main-header"></div>');
        $header.append(buildBreadcrumb(node));

        const $titleRow = $('<div class="tv-main-title-row"></div>');
        if (!isUnassigned && !isRoot) {
            const $titleInput = $(`<input class="tv-main-title" type="text" />`).val(node.label || 'Unnamed');
            $titleInput.on('change', function () {
                node.label = $(this).val().trim() || 'Unnamed';
                saveTree(bookName, tree);
                renderTreeNodes();
                registerTools();
            });
            $titleRow.append($titleInput);

            const $actions = $('<div class="tv-main-title-actions"></div>');
            const $addSub = $('<button class="tv-popup-btn" title="Add sub-category"><i class="fa-solid fa-folder-plus"></i></button>');
            $addSub.on('click', () => {
                node.children = node.children || [];
                node.children.push(createTreeNode('New Sub-category'));
                node.collapsed = false;
                saveTree(bookName, tree);
                selectNode(node);
                registerTools();
            });
            const $delNode = $('<button class="tv-popup-btn tv-popup-btn-danger" title="Delete this node"><i class="fa-solid fa-trash-can"></i></button>');
            $delNode.on('click', () => {
                if (!confirm(`Delete "${node.label}" and unassign its entries?`)) return;
                removeNode(tree.root, node.id);
                saveTree(bookName, tree);
                selectedNode = tree.root;
                renderTreeNodes();
                renderMainPanel();
                renderUnassignedEntries(bookName, tree, bookData);
                registerTools();
            });
            $actions.append($addSub, $delNode);
            $titleRow.append($actions);
        } else {
            $titleRow.append($('<div class="tv-main-title-static"></div>').text(isUnassigned ? 'Unassigned Entries' : 'Root'));
            if (isRoot) {
                const $actions = $('<div class="tv-main-title-actions"></div>');
                const $addSub = $('<button class="tv-popup-btn" title="Add category under root"><i class="fa-solid fa-folder-plus"></i></button>');
                $addSub.on('click', () => {
                    tree.root.children = tree.root.children || [];
                    tree.root.children.push(createTreeNode('New Category'));
                    tree.root.collapsed = false;
                    saveTree(bookName, tree);
                    selectNode(tree.root);
                    registerTools();
                });
                $actions.append($addSub);
                $titleRow.append($actions);
            }
        }
        $header.append($titleRow);
        $mainPanel.append($header);

        // Scrollable body
        const $body = $('<div class="tv-main-body"></div>');

        // Node summary
        if (node.summary && !isUnassigned && !isRoot) {
            $body.append($(`<div class="tv-node-summary">
                <div class="tv-node-summary-label">Node Summary</div>
                <div class="tv-node-summary-text"></div>
            </div>`).find('.tv-node-summary-text').text(node.summary).end());
        }

        // Direct entries
        const entryUids = node.entryUids || [];
        if (entryUids.length > 0) {
            const sectionLabel = isRoot ? 'Root Entries' : 'Direct Entries';
            $body.append($(`<div class="tv-entry-section-title">${sectionLabel} <span class="tv-entry-section-count">(${entryUids.length})</span></div>`));
            const $list = $('<div class="tv-entry-list-rows"></div>');
            for (const uid of entryUids) {
                const entry = entryLookup[uid];
                $list.append(buildEntryRow(uid, entry, node, bookName, tree, isUnassigned));
            }
            $body.append($list);
        }

        // Child nodes
        const children = node.children || [];
        if (children.length > 0) {
            $body.append($(`<div class="tv-entry-section-title">Sub-categories <span class="tv-entry-section-count">(${children.length})</span></div>`));
            const $cards = $('<div class="tv-child-cards"></div>');
            for (const child of children) {
                const childCount = countActiveEntries(child);
                const $card = $('<div class="tv-child-card"></div>');
                $card.append($('<span class="tv-tree-dot"></span>'));
                const $info = $('<div class="tv-child-card-info"></div>');
                $info.append($('<div class="tv-child-card-name"></div>').text(child.label || 'Unnamed'));
                if (child.summary) {
                    $info.append($('<div class="tv-child-card-summary"></div>').text(child.summary));
                }
                $card.append($info);
                $card.append($(`<span class="tv-child-card-count">${childCount}</span>`));
                $card.append($('<span class="tv-child-card-arrow">\u25B8</span>'));
                $card.on('click', () => {
                    child.collapsed = false;
                    saveTree(bookName, tree);
                    selectNode(child);
                });
                $cards.append($card);
            }
            $body.append($cards);
        }

        $mainPanel.append($body);
    }

    function buildEntryRow(uid, entry, node, bookName, tree, isUnassigned) {
        const label = entry ? (entry.comment || entry.key?.[0] || `#${uid}`) : `#${uid} (deleted)`;

        const $row = $(`<div class="tv-entry-row" draggable="true" data-uid="${uid}"></div>`);
        $row.append($('<span class="tv-entry-drag">\u22EE\u22EE</span>'));
        $row.append($('<span class="tv-entry-name"></span>').text(label));

        // Health dot — quality indicator
        if (entry && !entry.disable) {
            const q = computeEntryQuality(entry, qualityCtx.maxUid, qualityCtx.feedbackMap, qualityCtx.recentText);
            const rating = getQualityRating(q);
            const color = getQualityColor(rating);
            const $dot = $(`<span class="tv-entry-health" title="${escapeHtml(qualityTooltip(q))}"></span>`);
            $dot.css('background', color);
            $row.append($dot);
        }

        $row.append($(`<span class="tv-entry-uid">#${uid}</span>`));

        // Tracker toggle
        if (entry) {
            const tracked = isTrackerUid(bookName, uid);
            const $tracker = $(`<button class="tv-btn-icon tv-entry-tracker ${tracked ? 'is-on' : ''}" title="${tracked ? 'Tracked entry' : 'Track this entry'}"><i class="fa-solid ${tracked ? 'fa-location-crosshairs' : 'fa-location-dot'}"></i></button>`);
            $tracker.on('click', (e) => {
                e.stopPropagation();
                const nextTracked = !$tracker.hasClass('is-on');
                setTrackerUid(bookName, uid, nextTracked);
                $tracker.toggleClass('is-on', nextTracked);
                $tracker.attr('title', nextTracked ? 'Tracked entry' : 'Track this entry');
                $tracker.find('i').attr('class', `fa-solid ${nextTracked ? 'fa-location-crosshairs' : 'fa-location-dot'}`);
                registerTools();
            });
            $row.append($tracker);
        }

        // Enable/disable toggle
        if (entry) {
            const isDisabled = !!entry.disable;
            const $toggle = $(`<button class="tv-btn-icon tv-entry-toggle ${isDisabled ? 'is-off' : ''}" title="${isDisabled ? 'Enable entry' : 'Disable entry'}"><i class="fa-solid ${isDisabled ? 'fa-eye-slash' : 'fa-eye'}"></i></button>`);
            $toggle.on('click', async (e) => {
                e.stopPropagation();
                const wasTracked = isTrackerUid(bookName, uid);
                entry.disable = !entry.disable;
                await saveWorldInfo(bookName, bookData, true);
                if (entry.disable) {
                    setTrackerUid(bookName, uid, false);
                } else if (wasTracked || isTrackerTitle(entry.comment)) {
                    setTrackerUid(bookName, uid, true);
                }
                $toggle.toggleClass('is-off', !!entry.disable);
                $toggle.attr('title', entry.disable ? 'Enable entry' : 'Disable entry');
                $toggle.find('i').attr('class', `fa-solid ${entry.disable ? 'fa-eye-slash' : 'fa-eye'}`);
                $row.toggleClass('is-disabled', !!entry.disable);
                renderTreeNodes();
                renderMainPanel();
                await renderUnassignedEntries(bookName, tree, bookData);
                registerTools();
            });
            $row.append($toggle);
            if (isDisabled) $row.addClass('is-disabled');
        }

        if (!isUnassigned) {
            const $remove = $('<button class="tv-btn-icon tv-btn-danger-icon tv-entry-remove" title="Remove from node"><i class="fa-solid fa-xmark"></i></button>');
            $remove.on('click', async (e) => {
                e.stopPropagation();
                node.entryUids = (node.entryUids || []).filter(u => u !== uid);
                saveTree(bookName, tree);
                renderMainPanel();
                renderTreeNodes();
                await renderUnassignedEntries(bookName, tree, bookData);
                registerTools();
            });
            $row.append($remove);
        }

        // Drag
        $row.on('dragstart', (e) => {
            e.originalEvent.dataTransfer.setData('text/plain', String(uid));
            $row.addClass('dragging');
        });
        $row.on('dragend', () => $row.removeClass('dragging'));

        // Click to inline-expand entry detail
        if (entry) {
            $row.on('click', function () {
                const $existing = $row.next('.tv-entry-expand');
                if ($existing.length) {
                    $existing.slideUp(150, () => $existing.remove());
                    $row.removeClass('expanded');
                    return;
                }
                // Close any other expanded entries
                $row.closest('.tv-entry-list-rows').find('.tv-entry-expand').slideUp(150, function () { $(this).remove(); });
                $row.closest('.tv-entry-list-rows').find('.tv-entry-row').removeClass('expanded');

                $row.addClass('expanded');
                const $expand = $('<div class="tv-entry-expand" style="display:none"></div>');

                // Node summary context
                if (node.summary && !isUnassigned && !isRootNode(node)) {
                    $expand.append($(`<div class="tv-expand-node-box">
                        <div class="tv-expand-node-label">Parent node: ${escapeHtml(node.label || 'Unnamed')}</div>
                        <div class="tv-expand-node-text"></div>
                    </div>`).find('.tv-expand-node-text').text(node.summary).end());
                }

                // Keys
                const keys = entry.key || [];
                if (keys.length > 0) {
                    const $keys = $('<div class="tv-expand-keys"></div>');
                    $keys.append($('<span class="tv-expand-label">Keys</span>'));
                    const $tags = $('<div class="tv-expand-key-tags"></div>');
                    for (const k of keys) {
                        $tags.append($('<span class="tv-expand-key-tag"></span>').text(k));
                    }
                    $keys.append($tags);
                    $expand.append($keys);
                }

                // Content
                if (entry.content) {
                    $expand.append($('<div class="tv-expand-label">Content</div>'));
                    $expand.append($('<div class="tv-expand-content"></div>').text(entry.content));
                }

                // Version history button
                const versions = getEntryVersions(bookName, uid);
                if (versions.length > 0) {
                    const $histBtn = $(`<button class="tv-btn tv-btn-sm tv-btn-secondary tv-history-btn"><i class="fa-solid fa-clock-rotate-left"></i> History (${versions.length})</button>`);
                    $histBtn.on('click', function (e) {
                        e.stopPropagation();
                        const $existing = $expand.find('.tv-version-history');
                        if ($existing.length) {
                            $existing.slideUp(150, () => $existing.remove());
                            return;
                        }
                        const $histPanel = buildVersionHistoryElement(versions);
                        $expand.append($histPanel);
                        $histPanel.slideDown(150);
                    });
                    $expand.append($histBtn);
                }

                $row.after($expand);
                $expand.slideDown(150);
            });
        }

        return $row;
    }

    // --- Initial render ---
    renderTreeNodes();
    renderMainPanel();

    // Wire toolbar buttons BEFORE showing popup (callGenericPopup awaits until close)
    $popup.find('#tv_popup_add_cat').on('click', () => {
        tree.root.children = tree.root.children || [];
        tree.root.children.push(createTreeNode('New Category'));
        tree.root.collapsed = false;
        saveTree(bookName, tree);
        renderTreeNodes();
        renderMainPanel();
        registerTools();
    });

    $popup.find('#tv_popup_regen').on('click', async () => {
        const $btn = $popup.find('#tv_popup_regen');
        try {
            $btn.prop('disabled', true).find('i').addClass('fa-spin');
            await generateSummariesForTree(tree.root, bookName);
            saveTree(bookName, tree);
            renderTreeNodes();
            renderMainPanel();
            registerTools();
            toastr.success('Summaries regenerated.', 'TunnelVision');
        } catch (e) {
            toastr.error(e.message, 'TunnelVision');
        } finally {
            $btn.prop('disabled', false).find('i').removeClass('fa-spin');
        }
    });

    $popup.find('#tv_popup_export').on('click', () => onExportTree());
    $popup.find('#tv_popup_import').on('click', () => $('#tv_import_file').trigger('click'));
    $popup.find('#tv_popup_delete').on('click', () => {
        if (!confirm(`Delete the entire tree for "${bookName}"?`)) return;
        deleteTree(bookName);
        toastr.info('Tree deleted.', 'TunnelVision');
        loadLorebookUI(bookName);
        populateLorebookDropdown();
        registerTools();
        $('.popup.active .popup-button-close, .popup:last-child [data-i18n="Close"]').trigger('click');
    });

    // Search filter
    $popup.find('#tv_popup_search').on('input', function () {
        const q = $(this).val().toLowerCase().trim();
        $treeScroll.find('.tv-tree-row').each(function () {
            if ($(this).hasClass('tv-tree-row-root')) {
                $(this).closest('.tv-tree-node').show();
                return;
            }
            const label = $(this).find('.tv-tree-label').text().toLowerCase();
            $(this).closest('.tv-tree-node').toggle(!q || label.includes(q));
        });
        $mainPanel.find('.tv-entry-row').each(function () {
            const name = $(this).find('.tv-entry-name').text().toLowerCase();
            $(this).toggle(!q || name.includes(q));
        });
    });

    // Show popup (blocks until user closes it)
    await callGenericPopup($popup, POPUP_TYPE.DISPLAY, '', {
        large: true,
        wide: true,
        allowVerticalScrolling: true,
        allowHorizontalScrolling: false,
    });

    // When popup closes, refresh sidebar UI
    loadLorebookUI(bookName);
    populateLorebookDropdown();
}

// ─── Version History (Tree Editor) ────────────────────────────────

function buildVersionHistoryElement(versions) {
    const $panel = $('<div class="tv-version-history" style="display:none"></div>');
    const $header = $('<div class="tv-version-history-header"><i class="fa-solid fa-clock-rotate-left"></i> Version History</div>');
    $panel.append($header);

    for (const ver of [...versions].reverse()) {
        const $item = $('<div class="tv-version-history-item"></div>');
        const time = new Date(ver.timestamp);
        const timeStr = time.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

        const $meta = $('<div class="tv-version-history-meta"></div>');
        $meta.append($(`<span class="tv-version-history-source"></span>`).text(ver.source || 'unknown'));
        $meta.append($(`<span class="tv-version-history-time"></span>`).text(timeStr));
        $item.append($meta);

        if (ver.previousTitle) {
            const $titleRow = $('<div class="tv-version-history-title"></div>');
            $titleRow.append('<span class="tv-version-history-label">Title: </span>');
            $titleRow.append($('<span></span>').text(ver.previousTitle));
            $item.append($titleRow);
        }

        if (ver.previousContent) {
            const $content = $('<div class="tv-version-history-content"></div>');
            $content.text(ver.previousContent);
            $item.append($content);
        }

        $panel.append($item);
    }

    return $panel;
}

// ─── Tree Editor Helpers ─────────────────────────────────────────

function getUnassignedEntries(bookData, tree) {
    if (!bookData?.entries || !tree?.root) return [];
    const indexedUids = new Set(getAllEntryUids(tree.root));
    const unassigned = [];
    for (const key of Object.keys(bookData.entries)) {
        const entry = bookData.entries[key];
        if (entry.disable) continue;
        if (!indexedUids.has(entry.uid)) unassigned.push(entry);
    }
    return unassigned;
}

// ─── Import Sanitization ─────────────────────────────────────────

/**
 * Recursively sanitize an imported tree node.
 * Ensures all fields are the expected types, strips unexpected properties,
 * and prevents prototype pollution via __proto__ / constructor keys.
 * @param {Object} node
 */
function sanitizeImportedNode(node) {
    if (!node || typeof node !== 'object') return;

    // Enforce expected field types
    if (typeof node.id !== 'string' || !node.id) node.id = `tv_import_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    if (typeof node.label !== 'string') node.label = 'Unnamed';
    if (typeof node.summary !== 'string') node.summary = '';
    if (!Array.isArray(node.entryUids)) node.entryUids = [];
    if (!Array.isArray(node.children)) node.children = [];

    // Sanitize entryUids — must be numbers
    node.entryUids = node.entryUids.filter(uid => typeof uid === 'number' && Number.isFinite(uid));

    // Strip any unexpected/dangerous keys (prototype pollution vectors)
    const allowed = new Set(['id', 'label', 'summary', 'entryUids', 'children', 'collapsed', 'isArc']);
    for (const key of Object.keys(node)) {
        if (!allowed.has(key)) delete node[key];
    }

    // Recurse children
    for (const child of node.children) {
        sanitizeImportedNode(child);
    }
}

// ─── Export / Import ─────────────────────────────────────────────

function onExportTree() {
    if (!currentLorebook) return;
    const tree = getTree(currentLorebook);
    if (!tree) {
        toastr.warning('No tree to export.', 'TunnelVision');
        return;
    }
    const blob = new Blob([JSON.stringify(tree, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tunnelvision_${currentLorebook.replace(/[^a-z0-9]/gi, '_')}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toastr.info('Tree exported.', 'TunnelVision');
}

function onImportTree(e) {
    if (!currentLorebook) return;
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
        try {
            const tree = JSON.parse(ev.target.result);
            if (!tree.root || !Array.isArray(tree.root.children)) {
                throw new Error('Invalid tree structure.');
            }
            // Sanitize imported tree to prevent injection of unexpected properties
            sanitizeImportedNode(tree.root);
            tree.lorebookName = currentLorebook;
            tree.lastBuilt = Date.now();
            // Strip any unexpected top-level keys
            const cleanTree = {
                lorebookName: tree.lorebookName,
                root: tree.root,
                version: Number(tree.version) || 1,
                lastBuilt: tree.lastBuilt,
            };
            saveTree(currentLorebook, cleanTree);
            toastr.success('Tree imported.', 'TunnelVision');
            loadLorebookUI(currentLorebook);
            registerTools();
        } catch (err) {
            toastr.error(`Import failed: ${err.message}`, 'TunnelVision');
        }
    };
    reader.readAsText(file);
    // Reset file input so same file can be re-imported
    $(e.target).val('');
}

// ─── Tree Status ─────────────────────────────────────────────────

function updateTreeStatus(bookName, tree) {
    const $info = $('#tv_tree_info');
    if (!tree) {
        $info.text('No tree built yet.');
        return;
    }
    const totalEntries = getAllEntryUids(tree.root).length;
    const categories = (tree.root.children || []).length;
    const date = new Date(tree.lastBuilt).toLocaleString();
    $info.text(`${categories} categories, ${totalEntries} indexed entries. Last built: ${date}`);
}

// ─── Tree Editor Rendering ───────────────────────────────────────

async function renderTreeEditor(bookName, tree) {
    const $container = $('#tv_tree_editor_container');

    if (!tree || !tree.root || ((tree.root.children || []).length === 0 && (tree.root.entryUids || []).length === 0)) {
        $container.hide();
        return;
    }

    $container.show();
    const totalEntries = getAllEntryUids(tree.root).length;
    const $count = $('#tv_tree_entry_count');
    if (totalEntries > 0) {
        $count.text(totalEntries).show();
    } else {
        $count.hide();
    }

    // Mini-kanban overview in sidebar
    const $overview = $('#tv_mini_kanban_overview');
    $overview.empty();
    const categories = [];
    if ((tree.root.entryUids || []).length > 0) {
        categories.push({
            label: 'Root',
            summary: 'Entries stored directly on the root node.',
            entryUids: tree.root.entryUids,
            children: [],
        });
    }
    categories.push(...(tree.root.children || []));
    const colors = ['#e84393', '#f0946c', '#6c5ce7', '#00b894', '#fdcb6e'];
    for (let i = 0; i < categories.length; i++) {
        const cat = categories[i];
        const count = getAllEntryUids(cat).length;
        const color = colors[i % colors.length];
        const $row = $(`<div class="tv-mini-cat">
            <div class="tv-mini-cat-stripe" style="background:${color}"></div>
            <div class="tv-mini-cat-info">
                <div class="tv-mini-cat-name"></div>
                <div class="tv-mini-cat-summary"></div>
            </div>
            <div class="tv-mini-cat-count">${count}</div>
        </div>`);
        $row.find('.tv-mini-cat-name').text(cat.label || 'Unnamed');
        $row.find('.tv-mini-cat-summary').text(cat.summary || '');
        $overview.append($row);
    }
}

// ─── Unassigned Entries ──────────────────────────────────────────

async function renderUnassignedEntries(bookName, tree, bookData = null) {
    const $container = $('#tv_unassigned_container');
    const $count = $('#tv_unassigned_count');
    const $list = $('#tv_unassigned_list');

    if (!tree || !tree.root) {
        $list.empty();
        $container.hide();
        return;
    }

    const resolvedBookData = bookData || await loadWorldInfo(bookName);
    if (!resolvedBookData || !resolvedBookData.entries) {
        $list.empty();
        $container.hide();
        return;
    }

    const unassigned = getUnassignedEntries(resolvedBookData, tree);
    $count.text(unassigned.length);
    $list.empty();

    for (const entry of unassigned) {
        const label = entry.comment || entry.key?.[0] || `#${entry.uid}`;
        const $chip = $('<button type="button" class="tv-unassigned-chip"></button>');
        $chip.append($('<span class="tv-unassigned-chip-label"></span>').text(label));
        $chip.append($(`<span class="tv-unassigned-chip-uid">#${entry.uid}</span>`));
        $chip.append($('<span class="tv-unassigned-chip-action"><i class="fa-solid fa-arrow-turn-down"></i> Root</span>'));
        $chip.on('click', async () => {
            addEntryToNode(tree.root, entry.uid);
            saveTree(bookName, tree);
            toastr.success(`Assigned "${label}" to Root.`, 'TunnelVision');
            await loadLorebookUI(bookName);
            populateLorebookDropdown();
            registerTools();
        });
        $list.append($chip);
    }

    if (unassigned.length === 0) {
        $container.hide();
    } else {
        $container.show();
    }
}

// ─── Diagnostics ─────────────────────────────────────────────────

async function onRunDiagnostics() {
    const $btn = $('#tv_run_diagnostics');
    const $output = $('#tv_diagnostics_output');

    $btn.prop('disabled', true).html('<span class="tv_loading"></span> Running...');
    $output.empty().show();

    try {
        const results = await runDiagnostics();
        for (const result of results) {
            const icon = result.status === 'pass' ? 'fa-check' : result.status === 'warn' ? 'fa-triangle-exclamation' : 'fa-xmark';
            const cssClass = `tv_diag_${result.status}`;
            $output.append(`<div class="tv_diag_item ${cssClass}"><i class="fa-solid ${icon}"></i> ${escapeHtml(result.message)}</div>`);
        }
    } catch (e) {
        $output.append(`<div class="tv_diag_item tv_diag_fail"><i class="fa-solid fa-xmark"></i> Diagnostics error: ${escapeHtml(e.message)}</div>`);
    } finally {
        $btn.prop('disabled', false).html('<i class="fa-solid fa-stethoscope"></i> Run Diagnostics');
    }
}

// ─── Import / Export Hub ─────────────────────────────────────────

function downloadFile(filename, content, mimeType = 'text/plain') {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function onExportWorldState() {
    const text = getWorldStateText();
    if (!text) {
        toastr.warning('No world state available. Enable and refresh the rolling world state first.', 'TunnelVision');
        return;
    }
    const chatId = getContext().chatId || 'unknown';
    downloadFile(`worldstate_${chatId}.md`, text, 'text/markdown');
    toastr.success('World state exported.', 'TunnelVision');
}

function onExportNotebook() {
    const context = getContext();
    const notes = context.chatMetadata?.tunnelvision_notebook;
    if (!notes || notes.length === 0) {
        toastr.warning('Notebook is empty. The AI has not written any notes yet.', 'TunnelVision');
        return;
    }
    const chatId = context.chatId || 'unknown';
    const json = JSON.stringify(notes, null, 2);
    downloadFile(`notebook_${chatId}.json`, json, 'application/json');
    toastr.success(`Exported ${notes.length} notebook note(s).`, 'TunnelVision');
}

async function onExportTimeline() {
    const $btn = $('#tv_export_timeline');
    $btn.prop('disabled', true);

    try {
        const groups = await loadTimelineEntries();
        if (!groups || groups.length === 0) {
            toastr.warning('No facts or summaries to export. The lorebook is empty or has no timestamped entries.', 'TunnelVision');
            return;
        }

        const lines = ['# TunnelVision Timeline Export', ''];
        let totalEntries = 0;

        for (const group of groups) {
            const dayLabel = group.day != null ? `Day ${group.day}` : 'Undated';
            lines.push(`## ${dayLabel}`, '');

            for (const entry of group.entries) {
                totalEntries++;
                const prefix = entry.isSummary ? '[Summary]' : '[Fact]';
                const time = entry.timeLabel ? ` *(${entry.timeLabel})*` : '';
                lines.push(`### ${prefix} ${entry.title}${time}`, '');
                if (entry.content) {
                    lines.push(entry.content, '');
                }
            }
        }

        const chatId = getContext().chatId || 'unknown';
        downloadFile(`timeline_${chatId}.md`, lines.join('\n'), 'text/markdown');
        toastr.success(`Exported ${totalEntries} entries across ${groups.length} group(s).`, 'TunnelVision');
    } catch (err) {
        console.error('[TunnelVision] Timeline export failed:', err);
        toastr.error(`Export failed: ${err.message}`, 'TunnelVision');
    } finally {
        $btn.prop('disabled', false);
    }
}

async function onImportFacts(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    // Reset so the same file can be re-selected
    event.target.value = '';

    if (!currentLorebook) {
        toastr.warning('Select a lorebook first.', 'TunnelVision');
        return;
    }

    const bookName = currentLorebook;
    const tree = getTree(bookName);
    if (!tree || !tree.root) {
        toastr.warning('The selected lorebook has no tree. Build a tree first.', 'TunnelVision');
        return;
    }

    const $status = $('#tv_import_facts_status');
    $status.show().text('Reading file...');

    try {
        const text = await file.text();
        const rawLines = text.split(/\r?\n/);

        // Filter: skip empty lines, comment lines starting with #
        const factLines = rawLines
            .map(l => l.trim())
            .filter(l => l.length > 0 && !l.startsWith('#'));

        if (factLines.length === 0) {
            $status.text('No importable lines found. Make sure the file has non-empty, non-comment lines.');
            return;
        }

        $status.text(`Importing ${factLines.length} fact(s)...`);

        const { createEntry } = await import('./entry-manager.js');
        let created = 0;
        let failed = 0;

        for (const line of factLines) {
            try {
                let title, content;

                // "Title: Content" format — split on first colon
                const colonIdx = line.indexOf(':');
                if (colonIdx > 0 && colonIdx < 80) {
                    title = line.substring(0, colonIdx).trim();
                    content = line.substring(colonIdx + 1).trim();
                    if (!content) content = title;
                } else {
                    const words = line.split(/\s+/).slice(0, 6).join(' ');
                    title = words.length < line.length ? words + '…' : words;
                    content = line;
                }

                await createEntry(bookName, {
                    content,
                    comment: title,
                    background: true,
                });
                created++;
                $status.text(`Imported ${created}/${factLines.length}...`);
            } catch (err) {
                console.warn(`[TunnelVision] Failed to import line: ${line.substring(0, 60)}`, err);
                failed++;
            }
        }

        const msg = `Import complete: ${created} created` + (failed > 0 ? `, ${failed} failed` : '');
        $status.text(msg);
        toastr.success(msg, 'TunnelVision');

        // Refresh UI to show new entries
        await loadLorebookUI(bookName);
        populateLorebookDropdown();
        registerTools();
    } catch (err) {
        console.error('[TunnelVision] Fact import failed:', err);
        $status.text(`Import failed: ${err.message}`);
        toastr.error(`Import failed: ${err.message}`, 'TunnelVision');
    }
}

// ─── Utilities ───────────────────────────────────────────────────

function buildEntryLookup(bookData) {
    const lookup = {};
    if (!bookData || !bookData.entries) return lookup;
    for (const key of Object.keys(bookData.entries)) {
        const entry = bookData.entries[key];
        lookup[entry.uid] = entry;
    }
    return lookup;
}
