/**
 * TunnelVision UI Controller
 * Handles tree editor rendering, drag-and-drop, settings panel, and all user interactions.
 */

import { saveSettingsDebounced } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { world_names, loadWorldInfo } from '../../../world-info.js';
import { getAutoSummaryCount, resetAutoSummaryCount, setAutoSummaryCount } from './auto-summary.js';
import { getWorldStateText, getWorldStateLastIndex, updateWorldState, clearWorldState, isWorldStateUpdating, hasPreviousWorldState, revertWorldState, DEFAULT_WS_INJECTION_PROMPT, DEFAULT_WS_UPDATE_PROMPT } from './world-state.js';
import { getLastProcessingResult, getLastProcessedIndex } from './post-turn-processor.js';
import { getLastLifecycleResult, getLastLifecycleRunIndex } from './memory-lifecycle.js';
import { getActiveTunnelVisionBooks } from './tool-registry.js';
import { loadTimelineEntries } from './activity-feed.js';
import {
    getTree,
    isLorebookEnabled,
    setLorebookEnabled,
    getSettings,
    getBookDescription,
    setBookDescription,
    getSelectedLorebook,
    setSelectedLorebook,
    getConnectionProfileId,
    setConnectionProfileId,
    listConnectionProfiles,
    syncTrackerUidsForLorebook,
    SETTING_DEFAULTS,
} from './tree-store.js';
import { buildTreeFromMetadata, buildTreeWithLLM, ingestChatMessages } from './tree-builder.js';
import { registerTools, unregisterTools, getDefaultToolDescriptions, stripDynamicContent } from './tool-registry.js';
import { runDiagnostics } from './diagnostics.js';
import { applyRecurseLimit } from './tool-registry.js';
import { refreshHiddenToolCallMessages } from './activity-feed.js';

import { escapeHtml } from './entry-manager.js';
import { getMaxContextTokens } from './agent-utils.js';
import { CHARS_PER_TOKEN, BUDGET_RECOMMENDATION_RATIO, BUDGET_RECOMMENDATION_MAX, BUDGET_RECOMMENDATION_ROUND_TO } from './constants.js';
import {
    openTreeEditor,
    registerTreeEditorCallbacks,
    renderTreeEditor,
    renderUnassignedEntries,
    updateTreeStatus,
    onImportTree,
} from './tree-editor.js';


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
    $('#tv_open_tree_editor').on('click', () => openTreeEditor(currentLorebook));
    $('#tv_import_file').on('change', (e) => onImportTree(e, currentLorebook));

    // Register callbacks so tree-editor module can call back into ui-controller
    registerTreeEditorCallbacks({ loadLorebookUI, populateLorebookDropdown });

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

    // Sidecar background model
    $('#tv_sidecar_enabled').on('change', onSidecarToggle);
    $('#tv_sidecar_format').on('change', onSidecarSettingChange);
    $('#tv_sidecar_endpoint').on('change', onSidecarSettingChange);
    $('#tv_sidecar_api_key').on('change', onSidecarSettingChange);
    $('#tv_sidecar_model').on('change', onSidecarSettingChange);
    $('#tv_sidecar_max_tokens').on('change', onSidecarSettingChange);
    $('#tv_sidecar_temperature').on('change', onSidecarSettingChange);
    $('#tv_sidecar_test').on('click', onSidecarTest);
    $('#tv_sidecar_clear').on('click', onSidecarClear);

    // Embedding model
    $('#tv_embedding_enabled').on('change', onEmbeddingToggle);
    $('#tv_embedding_format').on('change', onEmbeddingSettingChange);
    $('#tv_embedding_endpoint').on('change', onEmbeddingSettingChange);
    $('#tv_embedding_api_key').on('change', onEmbeddingSettingChange);
    $('#tv_embedding_model').on('change', onEmbeddingSettingChange);
    $('#tv_embedding_test').on('click', onEmbeddingTest);
    $('#tv_embedding_clear').on('click', onEmbeddingClear);

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

    // Sync sidecar settings
    loadSidecarSettingsToUI(settings);

    // Sync embedding settings
    loadEmbeddingSettingsToUI(settings);

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
    const maxChars = maxTokens * CHARS_PER_TOKEN;
    const recommended = Math.min(Math.round(maxChars * BUDGET_RECOMMENDATION_RATIO / BUDGET_RECOMMENDATION_ROUND_TO) * BUDGET_RECOMMENDATION_ROUND_TO, BUDGET_RECOMMENDATION_MAX);
    $('#tv_total_injection_budget').val(recommended).trigger('change');
    toastr.info(`Recommended ${recommended} chars (~${Math.round(recommended / CHARS_PER_TOKEN)} tokens) for a ${maxTokens.toLocaleString()}-token context window`, 'TunnelVision');
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

    const maxChars = maxTokens * CHARS_PER_TOKEN;
    const pct = ((budget / maxChars) * 100).toFixed(1);
    const tokens = Math.round(budget / CHARS_PER_TOKEN);
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

// ─── Sidecar Background Model ────────────────────────────────────

function loadSidecarSettingsToUI(settings) {
    const profile = settings.sidecarProfile || {};
    const enabled = !!profile.enabled;
    $('#tv_sidecar_enabled').prop('checked', enabled);
    $('#tv_sidecar_fields').toggle(enabled);
    $('#tv_sidecar_format').val(profile.format || 'openai');
    $('#tv_sidecar_endpoint').val(profile.endpoint || '');
    $('#tv_sidecar_api_key').val(profile.apiKey || '');
    $('#tv_sidecar_model').val(profile.model || '');
    $('#tv_sidecar_max_tokens').val(profile.maxTokens || 1000);
    $('#tv_sidecar_temperature').val(profile.temperature ?? 0.3);
}

function saveSidecarSettings() {
    const settings = getSettings();
    const enabled = $('#tv_sidecar_enabled').is(':checked');

    if (!enabled) {
        settings.sidecarProfile = null;
    } else {
        settings.sidecarProfile = {
            enabled: true,
            format: $('#tv_sidecar_format').val() || 'openai',
            endpoint: $('#tv_sidecar_endpoint').val()?.trim() || '',
            apiKey: $('#tv_sidecar_api_key').val()?.trim() || '',
            model: $('#tv_sidecar_model').val()?.trim() || '',
            maxTokens: Math.max(100, parseInt($('#tv_sidecar_max_tokens').val(), 10) || 1000),
            temperature: Math.min(2, Math.max(0, parseFloat($('#tv_sidecar_temperature').val()) || 0.3)),
        };
    }
    saveSettingsDebounced();
}

function onSidecarToggle() {
    const enabled = $('#tv_sidecar_enabled').is(':checked');
    $('#tv_sidecar_fields').toggle(enabled);
    saveSidecarSettings();
    if (!enabled) {
        try {
            import('./llm-sidecar.js').then(m => m.resetCircuitBreaker());
        } catch { /* ignore */ }
    }
}

function onSidecarSettingChange() {
    saveSidecarSettings();
    try {
        import('./llm-sidecar.js').then(m => m.resetCircuitBreaker());
    } catch { /* ignore */ }
}

async function onSidecarTest() {
    const $btn = $('#tv_sidecar_test');
    const $status = $('#tv_sidecar_status');
    $btn.prop('disabled', true).find('i').removeClass('fa-plug').addClass('fa-spinner fa-spin');
    $status.text('Testing...').css('color', '');

    try {
        saveSidecarSettings();
        const { testSidecarConnectivity } = await import('./llm-sidecar.js');
        const result = await testSidecarConnectivity();
        $status.text(result.message).css('color', result.ok ? '#00b894' : '#d63031');
    } catch (e) {
        $status.text('Failed: ' + e.message).css('color', '#d63031');
    } finally {
        $btn.prop('disabled', false).find('i').removeClass('fa-spinner fa-spin').addClass('fa-plug');
    }
}

function onSidecarClear() {
    const settings = getSettings();
    settings.sidecarProfile = null;
    saveSettingsDebounced();
    $('#tv_sidecar_enabled').prop('checked', false);
    loadSidecarSettingsToUI(settings);
    $('#tv_sidecar_status').text('Cleared.').css('color', '');
    try {
        import('./llm-sidecar.js').then(m => m.resetCircuitBreaker());
    } catch { /* ignore */ }
}

// ─── Embedding Model ─────────────────────────────────────────────

function loadEmbeddingSettingsToUI(settings) {
    const profile = settings.embeddingProfile || {};
    const enabled = !!profile.enabled;
    $('#tv_embedding_enabled').prop('checked', enabled);
    $('#tv_embedding_fields').toggle(enabled);
    $('#tv_embedding_format').val(profile.format || 'openai');
    $('#tv_embedding_endpoint').val(profile.endpoint || '');
    $('#tv_embedding_api_key').val(profile.apiKey || '');
    $('#tv_embedding_model').val(profile.model || '');
}

function saveEmbeddingSettings() {
    const settings = getSettings();
    const enabled = $('#tv_embedding_enabled').is(':checked');

    if (!enabled) {
        settings.embeddingProfile = null;
    } else {
        settings.embeddingProfile = {
            enabled: true,
            format: $('#tv_embedding_format').val() || 'openai',
            endpoint: $('#tv_embedding_endpoint').val()?.trim() || '',
            apiKey: $('#tv_embedding_api_key').val()?.trim() || '',
            model: $('#tv_embedding_model').val()?.trim() || '',
        };
    }
    saveSettingsDebounced();
}

function onEmbeddingToggle() {
    const enabled = $('#tv_embedding_enabled').is(':checked');
    $('#tv_embedding_fields').toggle(enabled);
    saveEmbeddingSettings();
    if (!enabled) {
        try {
            import('./embedding-cache.js').then(m => m.clearEmbeddingCache());
        } catch { /* ignore */ }
    }
}

function onEmbeddingSettingChange() {
    saveEmbeddingSettings();
}

async function onEmbeddingTest() {
    const $btn = $('#tv_embedding_test');
    const $status = $('#tv_embedding_status');
    $btn.prop('disabled', true).find('i').removeClass('fa-plug').addClass('fa-spinner fa-spin');
    $status.text('Testing...').css('color', '');

    try {
        saveEmbeddingSettings();
        const { testEmbeddingConnectivity } = await import('./llm-sidecar.js');
        const result = await testEmbeddingConnectivity();
        $status.text(result.message).css('color', result.ok ? '#00b894' : '#d63031');
    } catch (e) {
        $status.text('Failed: ' + e.message).css('color', '#d63031');
    } finally {
        $btn.prop('disabled', false).find('i').removeClass('fa-spinner fa-spin').addClass('fa-plug');
    }
}

function onEmbeddingClear() {
    const settings = getSettings();
    settings.embeddingProfile = null;
    saveSettingsDebounced();
    $('#tv_embedding_enabled').prop('checked', false);
    loadEmbeddingSettingsToUI(settings);
    $('#tv_embedding_status').text('Cleared.').css('color', '');
    try {
        import('./embedding-cache.js').then(m => m.clearEmbeddingCache());
    } catch { /* ignore */ }
}

// ─── Tree Management ─────────────────────────────────────────────

/**
 * Open the tree editor for a specific lorebook. Exported for use by the activity feed.
 * Sets currentLorebook so internal state stays consistent.
 * @param {string} bookName
 */
export async function openTreeEditorForBook(bookName) {
    selectCurrentLorebook(bookName);
    await openTreeEditor(bookName);
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

