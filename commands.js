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
 */

import { generateQuietPrompt, setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { loadWorldInfo } from '../../../world-info.js';
import { getSettings, getSelectedLorebook, ensureSummariesNode } from './tree-store.js';
import { getActiveTunnelVisionBooks } from './tool-registry.js';
import { ingestChatMessages } from './tree-builder.js';
import { createEntry, forgetEntry, mergeEntries, splitEntry, findEntry, findEntryByUid } from './entry-manager.js';
import { markAutoSummaryComplete } from './auto-summary.js';

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
                description: 'Summary title (optional — AI generates one if omitted)',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
        helpString: 'Summarize recent events into a TunnelVision lorebook entry. Runs in the background without interrupting the conversation.',
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

    console.log('[TunnelVision] Registered slash commands: /tv-summarize, /tv-remember, /tv-search, /tv-forget, /tv-merge, /tv-split, /tv-ingest');
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

    const title = String(unnamedArgs || '').trim();
    const settings = getSettings();
    const messageCount = Math.min(chat.length, settings.autoSummaryInterval || 20);

    toastr.info('Summarizing in background...', 'TunnelVision');

    try {
        const result = await runQuietSummarize(lorebook, chat, messageCount, title);
        toastr.success(`Summary saved: "${result.title}"`, 'TunnelVision');
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
        ].filter(Boolean).join('\n');

        const response = await generateQuietPrompt({ quietPrompt, skipWIAN: true });
        const parsed = parseJsonResponse(response);

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
        const results = await searchEntries(query, activeBooks);
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

        // Search by name
        const results = await searchEntries(query, activeBooks, 5);
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
        const results = await searchEntries(arg, activeBooks, 10);
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

        const response = await generateQuietPrompt({ quietPrompt, skipWIAN: true });
        const parsed = parseJsonResponse(response);

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
            const results = await searchEntries(arg, activeBooks, 1);
            if (results.length === 0) return showWarning(`No entry found matching "${arg}".`);
            const r = results[0];
            targetBook = r.book;
            const bookData = await loadWorldInfo(r.book);
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

        const response = await generateQuietPrompt({ quietPrompt, skipWIAN: true });
        const parsed = parseJsonResponse(response);

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
export async function runQuietSummarize(lorebook, chat, messageCount, titleHint = '') {
    const recentContext = formatChatExcerpt(chat, messageCount);

    const titleInstruction = titleHint
        ? `Use this as the title: "${titleHint}".`
        : 'Create a short, descriptive title for the summary.';

    const quietPrompt = [
        'You are a summarization assistant for a roleplay.',
        'Summarize the following conversation excerpt into a lorebook entry for long-term memory.',
        titleInstruction,
        'Write the summary in past tense, third person, capturing key actions, participants, outcomes, and emotional beats.',
        'Be concise but thorough.',
        '\nRespond with ONLY a JSON object (no markdown, no code fences):',
        '{"title": "short descriptive title", "summary": "the summary text", "participants": ["name1", "name2"]}',
        `\nConversation to summarize:\n${recentContext}`,
    ].join('\n');

    const response = await generateQuietPrompt({ quietPrompt, skipWIAN: true });
    const parsed = parseJsonResponse(response);

    if (!parsed.title || !parsed.summary) {
        throw new Error('Model returned invalid summary format.');
    }

    const summariesNodeId = ensureSummariesNode(lorebook);
    const participants = Array.isArray(parsed.participants) ? parsed.participants : [];
    const content = `[Scene Summary — moderate]\nParticipants: ${participants.join(', ') || '(unspecified)'}\n\n${parsed.summary.trim()}`;
    const keys = [...participants.map(p => String(p).trim()).filter(Boolean), 'summary:moderate'];

    const result = await createEntry(lorebook, {
        content,
        comment: `[Summary] ${parsed.title}`,
        keys,
        nodeId: summariesNodeId,
    });

    markAutoSummaryComplete();
    console.log(`[TunnelVision] Background summary created: "${parsed.title}" (UID ${result.uid})`);
    return { title: parsed.title, uid: result.uid };
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
function formatChatExcerpt(chat, count) {
    return chat.slice(-count).map(m => {
        const name = m.is_user ? 'User' : m.name || 'Assistant';
        return `${name}: ${m.mes}`;
    }).join('\n');
}

/**
 * Search lorebook entries by keyword across active books.
 * @param {string} query
 * @param {string[]} activeBooks
 * @param {number} [maxResults=10]
 * @returns {Promise<Array<{uid: number, title: string, book: string, preview: string}>>}
 */
async function searchEntries(query, activeBooks, maxResults = 10) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const results = [];

    for (const bookName of activeBooks) {
        const bookData = await loadWorldInfo(bookName);
        if (!bookData?.entries) continue;

        for (const key of Object.keys(bookData.entries)) {
            const entry = bookData.entries[key];
            if (entry.disable) continue;

            const title = (entry.comment || '').toLowerCase();
            const keys = (entry.key || []).join(' ').toLowerCase();
            const content = (entry.content || '').toLowerCase();
            if (!terms.every(t => `${title} ${keys} ${content}`.includes(t))) continue;

            results.push({
                uid: entry.uid,
                title: entry.comment || entry.key?.[0] || `#${entry.uid}`,
                book: bookName,
                preview: (entry.content || '').substring(0, 150).replace(/\n/g, ' '),
            });
            if (results.length >= maxResults) return results;
        }
    }
    return results;
}

async function findEntryInBooks(uid, activeBooks) {
    const numUid = Number(uid);
    if (!isFinite(numUid)) return null;
    for (const bookName of activeBooks) {
        const bookData = await loadWorldInfo(bookName);
        if (!bookData?.entries) continue;
        const entry = findEntryByUid(bookData.entries, numUid);
        if (entry) return { entry, bookName };
    }
    return null;
}

function parseJsonResponse(text) {
    if (!text) return {};
    let cleaned = text.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    try {
        return JSON.parse(cleaned);
    } catch {
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) {
            try { return JSON.parse(match[0]); } catch { /* fall through */ }
        }
        return {};
    }
}

function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
