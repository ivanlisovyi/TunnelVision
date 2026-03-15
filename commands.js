/**
 * TunnelVision Commands
 * Registers slash commands with SillyTavern's SlashCommandParser.
 * Commands run via generateQuietPrompt (background) or direct execution,
 * avoiding the continuation problem of the old !command system.
 *
 * Available commands:
 *   /tv-summarize [title]  — Background summarization via quiet prompt
 *   /tv-remember [content] — Background entry creation via quiet prompt
 *   /tv-search [query]     — Direct lorebook keyword search (popup results)
 *   /tv-forget [name|UID]  — Direct entry lookup + disable
 *   /tv-merge [desc]       — Background merge via quiet prompt
 *   /tv-split [name|UID]   — Background split via quiet prompt
 *   /tv-ingest [book]      — Direct chat ingestion (no generation)
 *   /tv-worldstate [action]— View, refresh, or clear the rolling world state
 *   /tv-maintain            — Run memory lifecycle maintenance now
 */

import { generateQuietPrompt, setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { generateAnalytical, getStoryContext } from './agent-utils.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { getSettings, getSelectedLorebook, ensureSummariesNode, getTree, findNodeById, createTreeNode, saveTree } from './tree-store.js';
import { getActiveTunnelVisionBooks } from './tool-registry.js';
import { ingestChatMessages } from './tree-builder.js';
import { createEntry, forgetEntry, mergeEntries, splitEntry, findEntry, findEntryByUid, searchEntriesAcrossBooks, escapeHtml, parseJsonFromLLM, getCachedWorldInfo } from './entry-manager.js';
import { getWorldStateText, updateWorldState, clearWorldState } from './world-state.js';
import { runLifecycleMaintenance } from './memory-lifecycle.js';
import { markAutoSummaryComplete, getAutoSummaryCount, setAutoSummaryCount } from './auto-summary.js';
import { hideSummarizedMessages, setWatermark } from './tools/summarize.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Extension prompt key for legacy cleanup. */
const TV_CMD_PROMPT_KEY = 'tunnelvision_command';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let _commandsInitialized = false;

/**
 * Register TunnelVision slash commands with SillyTavern.
 * Safe to call multiple times — idempotency guard prevents duplicate registration.
 */
export function initCommands() {
    if (_commandsInitialized) return;
    _commandsInitialized = true;

    // Clear any stale prompt left by the old !command system
    try {
        setExtensionPrompt(TV_CMD_PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 1, false, extension_prompt_roles.SYSTEM);
    } catch { /* ignore if prompt system isn't ready */ }

    registerSlashCommands();
}

// ---------------------------------------------------------------------------
// Slash command registration
// ---------------------------------------------------------------------------

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tv-summarize',
        callback: handleSummarizeCommand,
        aliases: ['tvsummarize'],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Message range (e.g. "27-47") and/or title. Range summarizes those specific messages; title is optional.',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
        helpString: 'Summarize events into a TunnelVision lorebook entry. Use /tv-summarize 27-47 to summarize a specific message range, or /tv-summarize to summarize recent messages. Optionally add a title after the range: /tv-summarize 27-47 The Big Battle',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tv-remember',
        callback: handleRememberCommand,
        aliases: ['tvremember'],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'What to remember (facts, details, observations)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: 'Save information to TunnelVision lorebook memory. AI structures and titles the entry automatically.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tv-search',
        callback: handleSearchCommand,
        aliases: ['tvsearch'],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Keyword or phrase to search for',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: 'Search across all active TunnelVision lorebooks by keyword. Shows results in a popup.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tv-forget',
        callback: handleForgetCommand,
        aliases: ['tvforget'],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Entry name or UID to forget (disable)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: 'Forget (disable) a TunnelVision lorebook entry by name or UID.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tv-merge',
        callback: handleMergeCommand,
        aliases: ['tvmerge'],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Description of which entries to merge (e.g. "character Alice entries")',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: 'Merge two TunnelVision lorebook entries. AI identifies the best pair and consolidates content.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tv-split',
        callback: handleSplitCommand,
        aliases: ['tvsplit'],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Entry name or UID to split',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: 'Split a TunnelVision lorebook entry into two. AI decides the best split point.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tv-ingest',
        callback: handleIngestCommand,
        aliases: ['tvingest'],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Lorebook name (optional if only one is active)',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
        helpString: 'Ingest recent chat messages into a TunnelVision lorebook. Does not trigger generation.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tv-counter',
        callback: handleCounterCommand,
        aliases: ['tvcounter'],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'New counter value (number). Omit to view current count.',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
        ],
        helpString: 'View or set the auto-summary message counter. Usage: /tv-counter (view) or /tv-counter 10 (set to 10) or /tv-counter 0 (reset).',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tv-worldstate',
        callback: handleWorldStateCommand,
        aliases: ['tvworldstate', 'tvws'],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Action: "view" (default), "refresh" (force update), or "clear" (reset)',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
        helpString: 'View, refresh, or clear the rolling world state. Usage: /tv-worldstate (view) | /tv-worldstate refresh | /tv-worldstate clear',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tv-maintain',
        callback: handleMaintainCommand,
        aliases: ['tvmaintain'],
        helpString: 'Run memory lifecycle maintenance now — detects duplicates and compresses verbose entries.',
    }));

    console.log('[TunnelVision] Registered slash commands: /tv-summarize, /tv-remember, /tv-search, /tv-forget, /tv-merge, /tv-split, /tv-ingest, /tv-counter, /tv-worldstate, /tv-maintain');
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleSummarizeCommand(_namedArgs, unnamedArgs) {
    const check = preflight();
    if (check) return check;

    const lorebook = resolveCurrentLorebook();
    if (!lorebook) return showWarning('Multiple lorebooks active. Select one in TunnelVision settings first.');

    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length < 3) return showWarning('Not enough chat messages to summarize.');

    const rawArg = String(unnamedArgs || '').trim();

    // Parse optional range (e.g. "27-47" or "27-47 The Big Battle")
    const rangeMatch = rawArg.match(/^(\d+)\s*-\s*(\d+)(?:\s+(.*))?$/);

    let targetChat, messageCount, title;

    if (rangeMatch) {
        const rangeStart = parseInt(rangeMatch[1], 10);
        const rangeEnd = parseInt(rangeMatch[2], 10);
        title = (rangeMatch[3] || '').trim();

        if (rangeStart >= rangeEnd) return showWarning('Invalid range: start must be less than end.');
        if (rangeEnd >= chat.length) return showWarning(`Range end ${rangeEnd} exceeds chat length (${chat.length - 1} is the last message).`);
        if (rangeStart < 0) return showWarning('Range start cannot be negative.');

        targetChat = chat.slice(rangeStart, rangeEnd + 1);
        messageCount = targetChat.length;

        const nonSystem = targetChat.filter(m => !m.is_system).length;
        if (nonSystem < 2) return showWarning('Not enough non-system messages in that range to summarize.');

        toastr.info(`Summarizing messages ${rangeStart}-${rangeEnd} in background...`, 'TunnelVision');
    } else {
        title = rawArg;
        targetChat = chat;
        const settings = getSettings();
        messageCount = Math.min(chat.length, settings.autoSummaryInterval || 50);

        toastr.info('Summarizing in background...', 'TunnelVision');
    }

    try {
        const result = await runQuietSummarize(lorebook, targetChat, messageCount, title, {
            skipAutoHide: !!rangeMatch,
        });
        const factsMsg = result.factsCreated > 0 ? ` + ${result.factsCreated} fact(s) saved` : '';
        toastr.success(`Summary saved: "${result.title}"${factsMsg}`, 'TunnelVision');
    } catch (e) {
        console.error('[TunnelVision] /tv-summarize failed:', e);
        toastr.error(`Summary failed: ${e.message}`, 'TunnelVision');
    }
    return '';
}

async function handleRememberCommand(_namedArgs, unnamedArgs) {
    const check = preflight();
    if (check) return check;

    const lorebook = resolveCurrentLorebook();
    if (!lorebook) return showWarning('Multiple lorebooks active. Select one in TunnelVision settings first.');

    const content = String(unnamedArgs || '').trim();
    if (!content) return showWarning('Please provide content to remember.');

    toastr.info('Saving to memory...', 'TunnelVision');

    try {
        const context = getContext();
        const chat = context.chat || [];
        const recentContext = formatChatExcerpt(chat, 10);

        const quietPrompt = [
            'You are a knowledge extraction assistant for a roleplay lorebook.',
            `The user wants to save the following to memory:\n"${content}"`,
            recentContext ? `\nRecent conversation for context:\n${recentContext}` : '',
            '\nCreate a structured lorebook entry. Respond with ONLY a JSON object (no markdown, no code fences):',
            '{"title": "short descriptive title", "content": "the entry content, well-formatted and organized", "keys": ["keyword1", "keyword2"]}',
            '\nFor keys: provide 4-10 short keywords for cross-referencing. Always include character names involved (canonical form — "Elena" not "she"). Add location names when relevant, topic/theme words (e.g. "curse", "betrayal", "promotion"), and synonyms or related terms. Think: what would someone search to find this entry?',
        ].filter(Boolean).join('\n');

        const storyCtx = getStoryContext();
        const response = await generateAnalytical({ prompt: storyCtx + quietPrompt });
        const parsed = parseJsonFromLLM(response);

        if (!parsed.title || !parsed.content) throw new Error('Model returned invalid format.');

        const result = await createEntry(lorebook, {
            content: parsed.content,
            comment: parsed.title,
            keys: parsed.keys || [],
        });

        toastr.success(`Remembered: "${parsed.title}" (UID ${result.uid})`, 'TunnelVision');
    } catch (e) {
        console.error('[TunnelVision] /tv-remember failed:', e);
        toastr.error(`Remember failed: ${e.message}`, 'TunnelVision');
    }
    return '';
}

async function handleSearchCommand(_namedArgs, unnamedArgs) {
    const check = preflight();
    if (check) return check;

    const query = String(unnamedArgs || '').trim();
    if (!query) return showWarning('Please provide a search query.');

    try {
        const activeBooks = getActiveTunnelVisionBooks();
        const results = await searchEntriesAcrossBooks(query, activeBooks);
        if (results.length === 0) {
            toastr.info(`No entries found for "${query}".`, 'TunnelVision');
            return '';
        }

        const html = results.map(r =>
            `<div style="margin-bottom:8px;"><strong>${escapeHtml(r.title)}</strong> <small>(UID ${r.uid}, ${escapeHtml(r.book)})</small><br><span style="opacity:0.8">${escapeHtml(r.preview)}</span></div>`,
        ).join('');

        const { callGenericPopup, POPUP_TYPE } = await import('../../../popup.js');
        await callGenericPopup(
            `<div style="max-height:400px;overflow-y:auto;"><h3>Search: "${escapeHtml(query)}" — ${results.length} result(s)</h3>${html}</div>`,
            POPUP_TYPE.TEXT,
        );
    } catch (e) {
        console.error('[TunnelVision] /tv-search failed:', e);
        toastr.error(`Search failed: ${e.message}`, 'TunnelVision');
    }
    return '';
}

async function handleForgetCommand(_namedArgs, unnamedArgs) {
    const check = preflight();
    if (check) return check;

    const query = String(unnamedArgs || '').trim();
    if (!query) return showWarning('Please provide an entry name or UID to forget.');

    try {
        const activeBooks = getActiveTunnelVisionBooks();

        // Try as UID first
        const uid = Number(query);
        if (isFinite(uid)) {
            for (const bookName of activeBooks) {
                const found = await findEntry(bookName, uid);
                if (found) {
                    const result = await forgetEntry(bookName, uid);
                    toastr.success(`Forgotten: "${result.comment}" (UID ${uid})`, 'TunnelVision');
                    return '';
                }
            }
        }

        const results = await searchEntriesAcrossBooks(query, activeBooks, { maxResults: 5 });
        if (results.length === 0) return showWarning(`No entries found matching "${query}".`);

        if (results.length === 1) {
            const r = results[0];
            const result = await forgetEntry(r.book, r.uid);
            toastr.success(`Forgotten: "${result.comment}" (UID ${r.uid})`, 'TunnelVision');
            return '';
        }

        // Multiple matches — show them so the user can pick by UID
        const html = results.map(r =>
            `<div style="margin-bottom:8px;"><strong>${escapeHtml(r.title)}</strong> <small>(UID ${r.uid}, ${escapeHtml(r.book)})</small><br><span style="opacity:0.8">${escapeHtml(r.preview)}</span></div>`,
        ).join('');

        const { callGenericPopup, POPUP_TYPE } = await import('../../../popup.js');
        await callGenericPopup(
            `<div><h3>Multiple matches for "${escapeHtml(query)}"</h3>${html}<p>Use <code>/tv-forget &lt;UID&gt;</code> with a specific UID number.</p></div>`,
            POPUP_TYPE.TEXT,
        );
    } catch (e) {
        console.error('[TunnelVision] /tv-forget failed:', e);
        toastr.error(`Forget failed: ${e.message}`, 'TunnelVision');
    }
    return '';
}

async function handleMergeCommand(_namedArgs, unnamedArgs) {
    const check = preflight();
    if (check) return check;

    const lorebook = resolveCurrentLorebook();
    if (!lorebook) return showWarning('Multiple lorebooks active. Select one in TunnelVision settings first.');

    const arg = String(unnamedArgs || '').trim();
    if (!arg) return showWarning('Please describe which entries to merge.');

    toastr.info('Analyzing entries for merge...', 'TunnelVision');

    try {
        const activeBooks = getActiveTunnelVisionBooks();
        const results = await searchEntriesAcrossBooks(arg, activeBooks, { maxResults: 10 });
        if (results.length < 2) return showWarning(`Need at least 2 matching entries to merge. Found ${results.length}.`);

        const entryList = results.map(r => `[UID ${r.uid}] "${r.title}" (${r.book}): ${r.preview}`).join('\n');

        const quietPrompt = [
            'You are a lorebook management assistant.',
            `The user wants to merge entries matching: "${arg}"`,
            `\nAvailable entries:\n${entryList}`,
            '\nPick the two best entries to merge and produce the merged content.',
            'Respond with ONLY a JSON object (no markdown, no code fences):',
            '{"keep_uid": <number>, "remove_uid": <number>, "merged_title": "new title", "merged_content": "combined content"}',
        ].join('\n');

        const response = await generateAnalytical({ prompt: quietPrompt });
        const parsed = parseJsonFromLLM(response);

        if (!parsed.keep_uid || !parsed.remove_uid || !parsed.merged_content) {
            throw new Error('Model returned invalid merge instructions.');
        }

        const keepEntry = await findEntryInBooks(parsed.keep_uid, activeBooks);
        if (!keepEntry) throw new Error(`Entry UID ${parsed.keep_uid} not found.`);

        const result = await mergeEntries(keepEntry.bookName, parsed.keep_uid, parsed.remove_uid, {
            mergedContent: parsed.merged_content,
            mergedTitle: parsed.merged_title,
        });

        toastr.success(`Merged: "${result.comment}" (absorbed UID ${result.removedUid})`, 'TunnelVision');
    } catch (e) {
        console.error('[TunnelVision] /tv-merge failed:', e);
        toastr.error(`Merge failed: ${e.message}`, 'TunnelVision');
    }
    return '';
}

async function handleSplitCommand(_namedArgs, unnamedArgs) {
    const check = preflight();
    if (check) return check;

    const lorebook = resolveCurrentLorebook();
    if (!lorebook) return showWarning('Multiple lorebooks active. Select one in TunnelVision settings first.');

    const arg = String(unnamedArgs || '').trim();
    if (!arg) return showWarning('Please provide an entry name or UID to split.');

    toastr.info('Analyzing entry for split...', 'TunnelVision');

    try {
        const activeBooks = getActiveTunnelVisionBooks();

        // Find the target entry
        let targetEntry = null;
        let targetBook = null;
        const uid = Number(arg);
        if (isFinite(uid)) {
            const found = await findEntryInBooks(uid, activeBooks);
            if (found) { targetEntry = found.entry; targetBook = found.bookName; }
        }
        if (!targetEntry) {
            const results = await searchEntriesAcrossBooks(arg, activeBooks, { maxResults: 1 });
            if (results.length === 0) return showWarning(`No entry found matching "${arg}".`);
            const r = results[0];
            targetBook = r.book;
            const bookData = await getCachedWorldInfo(r.book);
            targetEntry = findEntryByUid(bookData.entries, r.uid);
        }
        if (!targetEntry) return showWarning('Entry not found.');

        const quietPrompt = [
            'You are a lorebook management assistant.',
            `The user wants to split this entry into two:`,
            `Title: "${targetEntry.comment}"`,
            `Content:\n${targetEntry.content}`,
            '\nDecide how to split this entry into two focused entries.',
            'Respond with ONLY a JSON object (no markdown, no code fences):',
            '{"keep_title": "title for part staying in original", "keep_content": "content for original entry", "new_title": "title for new entry", "new_content": "content for new entry"}',
        ].join('\n');

        const response = await generateAnalytical({ prompt: quietPrompt });
        const parsed = parseJsonFromLLM(response);

        if (!parsed.keep_content || !parsed.new_content || !parsed.new_title) {
            throw new Error('Model returned invalid split instructions.');
        }

        const result = await splitEntry(targetBook, targetEntry.uid, {
            keepContent: parsed.keep_content,
            keepTitle: parsed.keep_title,
            newContent: parsed.new_content,
            newTitle: parsed.new_title,
        });

        toastr.success(`Split: "${result.originalTitle}" + new "${result.newTitle}" (UID ${result.newUid})`, 'TunnelVision');
    } catch (e) {
        console.error('[TunnelVision] /tv-split failed:', e);
        toastr.error(`Split failed: ${e.message}`, 'TunnelVision');
    }
    return '';
}

async function handleIngestCommand(_namedArgs, unnamedArgs) {
    const check = preflight();
    if (check) return check;

    const activeBooks = getActiveTunnelVisionBooks();
    const requestedBook = String(unnamedArgs || '').trim();
    const lorebook = resolveIngestLorebook(activeBooks, requestedBook);

    if (!lorebook) {
        return showWarning('Multiple lorebooks active. Specify which one: /tv-ingest <lorebook name>');
    }

    const context = getContext();
    if (!context?.chat?.length) return showWarning('No chat is open.');

    const settings = getSettings();
    const contextMessages = Number(settings.commandContextMessages) || 50;
    const from = Math.max(0, context.chat.length - contextMessages);
    const to = context.chat.length - 1;

    toastr.info(`Ingesting messages ${from}–${to} into "${lorebook}"…`, 'TunnelVision');

    try {
        const result = await ingestChatMessages(lorebook, {
            from, to,
            progress: (msg) => toastr.info(msg, 'TunnelVision'),
            detail: () => {},
        });
        toastr.success(
            `Ingested ${result.created} entr${result.created === 1 ? 'y' : 'ies'} (${result.errors} error${result.errors === 1 ? '' : 's'}).`,
            'TunnelVision',
        );
    } catch (e) {
        console.error('[TunnelVision] /tv-ingest failed:', e);
        toastr.error(`Ingest failed: ${e.message}`, 'TunnelVision');
    }
    return '';
}

async function handleCounterCommand(_namedArgs, unnamedArgs) {
    const arg = typeof unnamedArgs === 'string' ? unnamedArgs.trim() : '';

    if (arg === '') {
        const count = getAutoSummaryCount();
        toastr.info(`Auto-summary counter: ${count}`, 'TunnelVision');
        return '';
    }

    const value = Number(arg);
    if (!isFinite(value) || value < 0) {
        toastr.warning('Provide a non-negative number, e.g. /tv-counter 0', 'TunnelVision');
        return '';
    }

    setAutoSummaryCount(value);
    toastr.success(`Auto-summary counter set to ${Math.round(value)}`, 'TunnelVision');
    return '';
}

async function handleWorldStateCommand(_namedArgs, unnamedArgs) {
    const action = (typeof unnamedArgs === 'string' ? unnamedArgs.trim() : '').toLowerCase() || 'view';

    if (action === 'clear') {
        clearWorldState();
        toastr.info('World state cleared', 'TunnelVision');
        return '';
    }

    if (action === 'refresh') {
        const check = preflight();
        if (check) return check;

        toastr.info('Updating world state...', 'TunnelVision');
        try {
            const result = await updateWorldState(true);
            if (result) {
                toastr.success('World state updated', 'TunnelVision');

                const { callGenericPopup, POPUP_TYPE } = await import('../../../popup.js');
                await callGenericPopup(
                    `<div style="max-height:500px;overflow-y:auto;"><h3>Rolling World State</h3><pre style="white-space:pre-wrap;font-size:0.9em;">${escapeHtml(result.text)}</pre></div>`,
                    POPUP_TYPE.TEXT,
                );
            } else {
                toastr.warning('World state update returned no result. Make sure you have enough messages in the chat.', 'TunnelVision');
            }
        } catch (e) {
            toastr.error(`World state update failed: ${e.message}`, 'TunnelVision');
        }
        return '';
    }

    // Default: view
    const text = getWorldStateText();
    if (!text) {
        toastr.info('No world state yet. Use "/tv-worldstate refresh" to generate one, or enable auto-updates in settings.', 'TunnelVision');
        return '';
    }

    const { callGenericPopup, POPUP_TYPE } = await import('../../../popup.js');
    await callGenericPopup(
        `<div style="max-height:500px;overflow-y:auto;"><h3>Rolling World State</h3><pre style="white-space:pre-wrap;font-size:0.9em;">${escapeHtml(text)}</pre></div>`,
        POPUP_TYPE.TEXT,
    );
    return '';
}

async function handleMaintainCommand() {
    const check = preflight();
    if (check) return check;

    toastr.info('Running memory lifecycle maintenance...', 'TunnelVision');
    try {
        const result = await runLifecycleMaintenance(true);
        if (result) {
            const parts = [];
            if (result.entriesCompressed > 0) parts.push(`${result.entriesCompressed} entries compressed`);
            if (result.duplicatesFound > 0) parts.push(`${result.duplicatesFound} duplicate pairs found (see console)`);
            if (result.errors > 0) parts.push(`${result.errors} error(s)`);
            const summary = parts.length > 0 ? parts.join(', ') : 'no changes needed';
            toastr.success(`Maintenance complete: ${summary}`, 'TunnelVision');
        } else {
            toastr.warning('Lifecycle maintenance returned no result. Ensure you have an active chat with lorebook entries.', 'TunnelVision');
        }
    } catch (e) {
        toastr.error(`Maintenance failed: ${e.message}`, 'TunnelVision');
    }
    return '';
}

// ---------------------------------------------------------------------------
// Quiet summarization (shared with auto-summary.js)
// ---------------------------------------------------------------------------

/**
 * Run a background summarization via generateQuietPrompt.
 * Exported so auto-summary.js can use the same logic.
 * @param {string} lorebook - Target lorebook name
 * @param {Array} chat - Chat array from context
 * @param {number} messageCount - How many recent messages to summarize
 * @param {string} [titleHint] - Optional title hint
 * @returns {Promise<{title: string, uid: number}>}
 */
export async function runQuietSummarize(lorebook, chat, messageCount, titleHint = '', { background = false, skipAutoHide = false } = {}) {
    const recentContext = formatChatExcerpt(chat, messageCount);

    const titleInstruction = titleHint
        ? `Use this as the title: "${titleHint}".`
        : 'Create a short, descriptive title for the summary.';

    // Include world state for better contextual awareness
    const worldStateText = getWorldStateText();
    const worldStateSection = worldStateText
        ? `\n[Current Story Context — use this to understand the broader narrative when writing your summary]\n${worldStateText}\n`
        : '';

    const quietPrompt = [
        'You are a summarization assistant for a roleplay lorebook. This is a PRIVATE memory document for story continuity, not a public-facing text.',
        'Analyze the following conversation excerpt and produce TWO things:',
        '1. A concise SUMMARY of the scene (what happened, narrative arc)',
        '2. A list of discrete FACTS that emerged (new information, state changes, relationship shifts, decisions made)',
        '',
        titleInstruction,
        'For the summary: write in past tense, third person. Capture ALL important actions, outcomes, emotional beats, physical interactions, intimate moments, conflicts, and character dynamics faithfully and without sanitizing or omitting anything. This summary replaces re-reading the scene — if you skip or censor what happened, continuity is lost. Be concise but thorough.',
        'For "when": estimate the in-world date/time from story context (e.g. "Late evening, Day 3", "Morning after the festival"). Use whatever granularity the story supports. If no time cues exist, write "unspecified".',
        'For significance: "minor" = flavor/ambiance, "moderate" = plot-relevant, "major" = changes character/world state, "critical" = turning point.',
        'For facts: extract ONLY facts significant enough to matter for long-term story continuity. Facts are persistent state changes — relationship shifts, relocations, status changes, revelations, consequential decisions, world-state changes, new character traits. Skip mundane actions ("asked about X", "poured tea"), fleeting emotions, and anything the summary already covers narratively. Fewer high-quality facts are better than many trivial ones.',
        'For keys on each fact: provide 4-10 short keywords for cross-referencing. Always include character names involved (canonical form — "Elena" not "she"). Add location names when relevant, topic/theme words (e.g. "curse", "betrayal", "promotion"), and synonyms or related terms. Think: what would someone search to find this fact?',
        '',
        'For arc: if the events belong to an ongoing storyline or narrative thread, provide a short arc name (e.g. "The Curse Investigation", "Elena & Ren\'s Romance"). If this is a standalone scene with no clear thread, omit the field or set it to null.',
        '',
        'Respond with ONLY a JSON object (no markdown, no code fences):',
        '{',
        '  "title": "short descriptive title",',
        '  "when": "in-world date/time estimate",',
        '  "summary": "the scene summary text",',
        '  "participants": ["name1", "name2"],',
        '  "significance": "minor|moderate|major|critical",',
        '  "arc": "narrative thread name or null",',
        '  "facts": [',
        '    {"title": "short fact title", "content": "factual description in third person", "keys": ["keyword1", "keyword2"]}',
        '  ]',
        '}',
        worldStateSection,
        `Conversation to summarize:\n${recentContext}`,
    ].join('\n');

    let response = await generateQuietPrompt({ quietPrompt, skipWIAN: true });
    let parsed = parseJsonFromLLM(response);

    if (!parsed.title || !parsed.summary) {
        // Retry once with a shorter, more direct prompt
        console.warn('[TunnelVision] Summary parse failed, retrying with simplified prompt. Raw response:', response?.substring?.(0, 300));
        const retryPrompt = [
            'Summarize this roleplay excerpt as JSON. Respond with ONLY valid JSON, no other text.',
            '{"title": "short title", "summary": "what happened", "participants": ["name1"], "significance": "moderate", "facts": []}',
            `\n${recentContext}`,
        ].join('\n');
        response = await generateQuietPrompt({ quietPrompt: retryPrompt, skipWIAN: true });
        parsed = parseJsonFromLLM(response);

        if (!parsed.title || !parsed.summary) {
            console.error('[TunnelVision] Summary retry also failed. Raw response:', response?.substring?.(0, 500));
            throw new Error('Model returned invalid summary format after retry.');
        }
    }

    const summariesNodeId = ensureSummariesNode(lorebook);
    const participants = Array.isArray(parsed.participants) ? parsed.participants : [];
    const significance = ['minor', 'moderate', 'major', 'critical'].includes(parsed.significance)
        ? parsed.significance : 'moderate';
    const whenLine = parsed.when && parsed.when !== 'unspecified' ? `When: ${parsed.when}\n` : '';

    // Resolve arc — find existing or create new
    let targetNodeId = summariesNodeId;
    if (parsed.arc && typeof parsed.arc === 'string' && parsed.arc.trim()) {
        const arcName = parsed.arc.trim();
        const tree = getTree(lorebook);
        if (tree?.root) {
            const summNode = findNodeById(tree.root, summariesNodeId);
            if (summNode) {
                const existing = (summNode.children || []).find(
                    c => c.label?.toLowerCase() === arcName.toLowerCase(),
                );
                if (existing) {
                    targetNodeId = existing.id;
                } else {
                    const arcNode = createTreeNode(arcName, '');
                    arcNode.isArc = true;
                    summNode.children = summNode.children || [];
                    summNode.children.push(arcNode);
                    saveTree(lorebook, tree);
                    targetNodeId = arcNode.id;
                    console.log(`[TunnelVision] Auto-created arc "${arcName}" (${arcNode.id})`);
                }
            }
        }
    }

    const content = `[Scene Summary — ${significance}]\n${whenLine}Participants: ${participants.join(', ') || '(unspecified)'}\n\n${parsed.summary.trim()}`;
    const keys = [...participants.map(p => String(p).trim()).filter(Boolean), `summary:${significance}`];

    const result = await createEntry(lorebook, {
        content,
        comment: `[Summary] ${parsed.title}`,
        keys,
        nodeId: targetNodeId,
        background,
    });

    // Create separate Remember entries for extracted facts
    const factsCreated = [];
    if (Array.isArray(parsed.facts)) {
        for (const fact of parsed.facts) {
            if (!fact?.title || !fact?.content) continue;
            try {
                const factKeys = Array.isArray(fact.keys)
                    ? fact.keys.map(k => String(k).trim()).filter(Boolean)
                    : [];
                const factResult = await createEntry(lorebook, {
                    content: fact.content.trim(),
                    comment: fact.title.trim(),
                    keys: factKeys,
                    background,
                });
                factsCreated.push(factResult.uid);
            } catch (e) {
                console.warn(`[TunnelVision] Failed to create fact entry "${fact.title}":`, e);
            }
        }
    }

    markAutoSummaryComplete();

    if (!skipAutoHide) {
        // Always advance the watermark so the scene archiver knows what's been covered,
        // regardless of whether messages are visually hidden.
        try {
            const currentMsgId = (chat?.length || 1) - 1;
            const coveredEnd = Math.max(0, currentMsgId - 1);
            setWatermark(coveredEnd);
        } catch { /* metadata not available */ }

        // Hide summarized messages if the setting is enabled
        try {
            await hideSummarizedMessages(messageCount);
        } catch (e) {
            console.warn('[TunnelVision] Failed to hide summarized messages:', e);
        }
    }

    const factsMsg = factsCreated.length > 0 ? ` + ${factsCreated.length} fact(s)` : '';
    console.log(`[TunnelVision] Background summary created: "${parsed.title}" (UID ${result.uid})${factsMsg}`);
    return { title: parsed.title, uid: result.uid, factsCreated: factsCreated.length };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function preflight() {
    const settings = getSettings();
    if (settings.globalEnabled === false) {
        toastr.warning('TunnelVision is disabled.', 'TunnelVision');
        return '';
    }
    if (settings.commandsEnabled === false) {
        toastr.warning('Slash commands are disabled in TunnelVision settings.', 'TunnelVision');
        return '';
    }
    if (getActiveTunnelVisionBooks().length === 0) {
        toastr.warning('No active TunnelVision lorebooks.', 'TunnelVision');
        return '';
    }
    return null;
}

function showWarning(msg) {
    toastr.warning(msg, 'TunnelVision');
    return '';
}

function resolveCurrentLorebook() {
    const activeBooks = getActiveTunnelVisionBooks();
    const selected = getSelectedLorebook();
    if (selected && activeBooks.includes(selected)) return selected;
    return activeBooks.length === 1 ? activeBooks[0] : null;
}

function resolveIngestLorebook(activeBooks, requested) {
    if (requested) {
        return activeBooks.find(b => b.toLowerCase() === requested.toLowerCase()) || null;
    }
    return resolveCurrentLorebook();
}

/**
 * Format recent chat messages as a text excerpt for quiet prompts.
 * @param {Array} chat
 * @param {number} count
 * @returns {string}
 */
function formatChatExcerpt(chat, count, maxChars = 15000) {
    const formatted = chat.slice(-count).map(m => {
        const name = m.is_user ? 'User' : m.name || 'Assistant';
        const ts = m.send_date ? `[${formatTimestamp(m.send_date)}] ` : '';
        return `${ts}${name}: ${m.mes}`;
    }).join('\n');
    if (formatted.length > maxChars) {
        return formatted.substring(formatted.length - maxChars);
    }
    return formatted;
}

/**
 * Format a SillyTavern send_date into a compact timestamp.
 * ST stores send_date as a numeric string like "20260313142215" (YYYYMMDDHHmmss)
 * or sometimes as an ISO string.
 * @param {string|number} raw
 * @returns {string}
 */
function formatTimestamp(raw) {
    const s = String(raw).trim();
    // Numeric format: YYYYMMDDHHmmss (14 digits)
    if (/^\d{14}$/.test(s)) {
        return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}`;
    }
    // Try parsing as a date
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    return s;
}

/**
 * Search lorebook entries by keyword across active books.
 * @param {string} query
 * @param {string[]} activeBooks
 * @param {number} [maxResults=10]
 * @returns {Promise<Array<{uid: number, title: string, book: string, preview: string}>>}
 */
async function findEntryInBooks(uid, activeBooks) {
    const numUid = Number(uid);
    if (!isFinite(numUid)) return null;
    for (const bookName of activeBooks) {
        const bookData = await getCachedWorldInfo(bookName);
        if (!bookData?.entries) continue;
        const entry = findEntryByUid(bookData.entries, numUid);
        if (entry) return { entry, bookName };
    }
    return null;
}
