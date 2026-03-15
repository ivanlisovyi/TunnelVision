/**
 * TunnelVision Rolling World State
 *
 * Maintains a living "world state" document that captures the current story state:
 * current scene, recent events, active story threads, and key character states.
 *
 * Updated periodically via background LLM calls (every N messages) and injected
 * into the AI's context every turn so it always knows where the story stands.
 *
 * Unlike auto-summary (which creates individual historical records), the world state
 * is a single continuously-updated document — a living snapshot, not an archive.
 *
 * Data lives in chat_metadata.tunnelvision_worldstate (per-chat).
 */

import { eventSource, event_types, generateQuietPrompt } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { getSettings, isSummaryTitle, isTrackerTitle } from './tree-store.js';
import { getActiveTunnelVisionBooks } from './tool-registry.js';
import { getCachedWorldInfo } from './entry-manager.js';
import { getChatId, formatChatExcerpt, callWithRetry } from './agent-utils.js';
import { addBackgroundEvent, registerBackgroundTask } from './activity-feed.js';

const METADATA_KEY = 'tunnelvision_worldstate';
const MAX_EXCERPT_CHARS = 20_000;

/** Default injection header wrapping the world state text in the AI's context. */
export const DEFAULT_WS_INJECTION_PROMPT = [
    '[Rolling World State — Your maintained memory of the current story.',
    'This is automatically kept up-to-date. Use it to stay grounded and maintain consistency.',
    '',
    '- Check Unresolved Threads — consider advancing or acknowledging one when natural.',
    '- Check New Pending Threads — weave external events into the scene when appropriate.',
    '- Check Cliché Check — consciously evaluate the obvious path before defaulting to it.',
    '- Check Off-Screen — characters exist beyond the current scene; reference their activities when relevant.',
    '',
    'Do NOT repeat this information verbatim. Let it inform your writing naturally.]',
].join('\n');

/** Default LLM instructions for generating/updating the world state document. */
export const DEFAULT_WS_UPDATE_PROMPT = [
    'You are a narrative state tracker for an ongoing roleplay. Maintain a concise "World State" document capturing the current state of the story.',
    '',
    'Follow this exact format:',
    '',
    '## Current Scene',
    'Day: [simulation day number]',
    'Date: [calendar date with year]',
    'Time: [exact in-world time; track elapsed time between updates]',
    'Location: [enforce hierarchy: Country > Region > City > Place]',
    'Present: [characters currently in the scene]',
    'Situation: [1-2 sentences of what is actively happening right now]',
    '',
    '## Recollection',
    '[Summarize recent events, recording important developments, character states, dynamics, and anything noteworthy. 3-5 sentences.]',
    '',
    '## Off-Screen',
    '[Characters not in the current scene. Format: "- **Name**: location / activity (since when)". Only include established characters.]',
    '',
    '## Pending',
    '[Near-term events, promises, appointments, and deadlines. Format: "- event/obligation (when)". Remove once resolved.]',
    '',
    '## Active Threads',
    '[Ongoing storylines. Format: "- **Thread Name** [status]: current state". Label status: active, suspended, ongoing, concluded.]',
    '',
    '## Unresolved Threads',
    '[Loose ends, NPC developments, plots that haven\'t been followed up on. Check for things that were established but dropped. If truly no longer relevant, mention once then drop.]',
    '',
    '## New Pending Threads',
    '[External threads NOT involving the main characters in the current scene — events brewing in the background, peripheral stakeholders, concurrent unrelated developments that may eventually come to the forefront. 1-3 items. These must be grounded in the established world — reference named locations, factions, or NPCs. Generic events like "a stranger arrives" are not useful.]',
    '',
    '## Key Character States',
    '[For each active character: "- **Name**: mood, current goal, notable status".]',
    '',
    '## Cliché Check',
    '[Identify the most obvious narrative path from here. Note it so it can be consciously evaluated rather than defaulted to. Reference specific established facts or patterns from the story so far. Name the trope if applicable. A good cliché check is specific to this story, not generic.]',
    '',
    'Be concise — the entire document should be under 1200 words. This replaces the previous version entirely.',
    'Respond with ONLY the world state content. No JSON, no code fences, no commentary.',
].join('\n');

let _updateRunning = false;
const _chatRef = { lastChatLength: 0 };

// ── Persistence ──────────────────────────────────────────────────

function getWorldState() {
    try {
        return getContext().chatMetadata?.[METADATA_KEY] || null;
    } catch {
        return null;
    }
}

function setWorldState(state) {
    try {
        const context = getContext();
        if (!context.chatMetadata) return;
        context.chatMetadata[METADATA_KEY] = state;
        context.saveMetadataDebounced?.();
    } catch { /* metadata not available */ }
}

// ── Structural Validation ────────────────────────────────────────

const EXPECTED_SECTIONS = [
    '## Current Scene',
    '## Recollection',
    '## Off-Screen',
    '## Pending',
    '## Active Threads',
    '## Unresolved Threads',
    '## New Pending Threads',
    '## Key Character States',
    '## Cliché Check',
];

/**
 * Basic structural check to reject degenerate LLM responses.
 * @param {string} text
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateWorldStateStructure(text) {
    if (!text || text.length < 200) {
        return { valid: false, reason: `too short (${text?.length || 0} chars, need ≥200)` };
    }
    if (/^[\s]*[\[{]/.test(text) || /```/.test(text)) {
        return { valid: false, reason: 'contains JSON or code fences' };
    }
    const matched = EXPECTED_SECTIONS.filter(h => text.includes(h));
    if (matched.length < 4) {
        return { valid: false, reason: `only ${matched.length}/9 expected ## headers found (need ≥4)` };
    }
    return { valid: true };
}

// ── Section Parsing ──────────────────────────────────────────────

const SECTION_HEADER_RE = /^##\s+(.+)$/gm;

const CORE_SECTIONS = new Set(['Current Scene', 'Recollection', 'Cliché Check']);
const ALWAYS_INCLUDE_SECTIONS = new Set(['Pending', 'Active Threads', 'New Pending Threads']);

/**
 * Parse a world state document into a { header: body } map.
 * @param {string} text
 * @returns {Record<string, string>}
 */
function parseWorldStateSections(text) {
    const sections = {};
    const headers = [];
    let match;
    SECTION_HEADER_RE.lastIndex = 0;
    while ((match = SECTION_HEADER_RE.exec(text)) !== null) {
        headers.push({ name: match[1].trim(), start: match.index });
    }
    for (let i = 0; i < headers.length; i++) {
        const end = i + 1 < headers.length ? headers[i + 1].start : text.length;
        const body = text.substring(headers[i].start, end).trim();
        sections[headers[i].name] = body;
    }
    return sections;
}

const BOLD_NAME_RE = /\*\*([^*]+)\*\*/g;

/**
 * Extract bold **Name** tokens from a section body.
 * @param {string} body
 * @returns {string[]}
 */
function extractBoldNames(body) {
    const names = [];
    let m;
    BOLD_NAME_RE.lastIndex = 0;
    while ((m = BOLD_NAME_RE.exec(body)) !== null) {
        names.push(m[1].trim().toLowerCase());
    }
    return names;
}

/**
 * Score an Extended section against recent chat text.
 * Returns a relevance score (0 = no match, higher = more relevant).
 * @param {string} sectionName
 * @param {string} sectionBody
 * @param {string} recentText - lowercased recent messages
 * @returns {number}
 */
function scoreSectionRelevance(sectionName, sectionBody, recentText) {
    if (ALWAYS_INCLUDE_SECTIONS.has(sectionName)) return 100;

    const names = extractBoldNames(sectionBody);
    if (names.length === 0) return 50;

    let hits = 0;
    for (const name of names) {
        if (name.length >= 2 && recentText.includes(name)) hits++;
    }
    return hits > 0 ? 50 + hits * 20 : 10;
}

// ── Prompt Building ──────────────────────────────────────────────

/**
 * Build the world state string for injection into the AI's context.
 * Uses section-aware assembly when sections are available, falling back
 * to the flat text for backward compatibility.
 * @returns {string}
 */
export function buildWorldStatePrompt() {
    const state = getWorldState();
    if (!state?.text) return '';

    const settings = getSettings();
    const maxChars = settings.worldStateMaxChars || 3000;
    const header = settings.worldStateInjectionOverride?.trim() || DEFAULT_WS_INJECTION_PROMPT;
    const headerLen = header.length + 2; // +2 for \n\n separator

    const sections = state.sections;
    if (!sections || Object.keys(sections).length === 0) {
        let text = state.text;
        if (text.length > maxChars) {
            const cutoff = text.lastIndexOf('\n', maxChars);
            text = text.substring(0, cutoff > maxChars * 0.5 ? cutoff : maxChars) + '\n[...truncated]';
        }
        return header + '\n\n' + text;
    }

    const recentText = getRecentChatText(3);
    const budget = maxChars - headerLen;

    // Phase 1: always include Core sections
    const included = [];
    let usedChars = 0;
    for (const name of Object.keys(sections)) {
        if (CORE_SECTIONS.has(name)) {
            included.push({ name, body: sections[name], score: Infinity });
            usedChars += sections[name].length + 2;
        }
    }

    // Phase 2: score and sort Extended sections
    const candidates = [];
    for (const name of Object.keys(sections)) {
        if (CORE_SECTIONS.has(name)) continue;
        const score = scoreSectionRelevance(name, sections[name], recentText);
        candidates.push({ name, body: sections[name], score });
    }
    candidates.sort((a, b) => b.score - a.score);

    // Phase 3: fill remaining budget with highest-scoring Extended sections
    for (const c of candidates) {
        const needed = c.body.length + 2;
        if (usedChars + needed <= budget) {
            included.push(c);
            usedChars += needed;
        }
    }

    // Re-sort to match document order
    const orderedNames = Object.keys(sections);
    included.sort((a, b) => orderedNames.indexOf(a.name) - orderedNames.indexOf(b.name));

    const assembled = included.map(s => s.body).join('\n\n');
    return header + '\n\n' + assembled;
}

/**
 * Get lowercased text from the last N chat messages for relevance scoring.
 * @param {number} count
 * @returns {string}
 */
function getRecentChatText(count) {
    try {
        const chat = getContext().chat;
        if (!chat || chat.length === 0) return '';
        const start = Math.max(0, chat.length - count);
        const parts = [];
        for (let i = start; i < chat.length; i++) {
            const msg = chat[i];
            if (msg?.mes) parts.push(msg.mes);
        }
        return parts.join(' ').toLowerCase();
    } catch {
        return '';
    }
}

// ── Story History ────────────────────────────────────────────────

/**
 * Fetch recent fact and summary titles from active lorebooks
 * to ground the world state update LLM.
 * @returns {Promise<string|null>}
 */
async function buildStoryHistoryBlock() {
    try {
        const activeBooks = getActiveTunnelVisionBooks();
        if (activeBooks.length === 0) return null;

        const factTitles = [];
        const summaryTitles = [];

        for (const bookName of activeBooks) {
            const bookData = await getCachedWorldInfo(bookName);
            if (!bookData?.entries) continue;

            for (const key of Object.keys(bookData.entries)) {
                const e = bookData.entries[key];
                if (e.disable) continue;
                const title = (e.comment || '').trim();
                if (!title) continue;

                if (isSummaryTitle(title)) {
                    summaryTitles.push(title);
                } else if (!isTrackerTitle(title)) {
                    factTitles.push(title);
                }
            }
        }

        if (factTitles.length === 0 && summaryTitles.length === 0) return null;

        const lines = ['[Recent Story History — for reference, do NOT re-extract]'];
        if (factTitles.length > 0) {
            const recent = factTitles.slice(-15);
            lines.push('Facts: ' + recent.map(t => `"${t}"`).join(', '));
        }
        if (summaryTitles.length > 0) {
            const recent = summaryTitles.slice(-5);
            lines.push('Summaries: ' + recent.map(t => `"${t}"`).join(', '));
        }

        return lines.join('\n');
    } catch (e) {
        console.warn('[TunnelVision] Failed to build story history block:', e);
        return null;
    }
}

// ── Update Decision ──────────────────────────────────────────────

function shouldUpdate() {
    const settings = getSettings();
    if (!settings.worldStateEnabled || settings.globalEnabled === false) return false;
    if (getActiveTunnelVisionBooks().length === 0) return false;

    const context = getContext();
    const chatLength = context.chat?.length || 0;
    if (chatLength < 6) return false;

    const state = getWorldState();
    const lastIdx = state?.lastUpdateMsgIdx ?? -1;
    const interval = settings.worldStateInterval || 10;

    return (chatLength - 1 - lastIdx) >= interval;
}

// (formatChatExcerpt imported from agent-utils.js)

// ── LLM Prompt ───────────────────────────────────────────────────

async function buildUpdatePrompt(previousState, recentExcerpt, priorityContext = null) {
    const hasPrevious = previousState && previousState.trim().length > 0;
    const settings = getSettings();
    const instructions = settings.worldStateUpdateOverride?.trim() || DEFAULT_WS_UPDATE_PROMPT;

    const parts = [];

    if (hasPrevious) {
        parts.push(
            '[Previous World State]',
            previousState,
            '',
            '[Recent Messages Since Last Update]',
        );
    } else {
        parts.push(
            '[Recent Conversation]',
        );
    }

    parts.push(
        recentExcerpt,
        '',
    );

    // Priority update context from post-turn processor
    if (priorityContext) {
        const ctxLines = ['[Priority Update Context]'];
        if (priorityContext.sceneArchived && priorityContext.sceneTitle) {
            ctxLines.push(`A scene was just archived: "${priorityContext.sceneTitle}" (${priorityContext.sceneChangeType || 'transition'}).`);
        } else if (priorityContext.sceneArchived) {
            ctxLines.push(`A scene was just archived (${priorityContext.sceneChangeType || 'transition'}).`);
        }
        if (priorityContext.factsCreated > 0) {
            ctxLines.push(`${priorityContext.factsCreated} new fact(s) were recorded this turn.`);
        }
        if (ctxLines.length > 1) {
            parts.push(ctxLines.join('\n'), '');
        }
    }

    // Story history from lorebook
    const historyBlock = await buildStoryHistoryBlock();
    if (historyBlock) {
        parts.push(historyBlock, '');
    }

    if (hasPrevious) {
        parts.push(
            'Update the World State based on what happened in these messages.',
            '',
            'CONTINUITY RULES:',
            '- Review EVERY item in the previous world state (threads, characters, pending items).',
            '- Carry forward all items that are still relevant, even if not mentioned in recent messages.',
            '- If a thread, character, or pending item is no longer relevant, include it one final time marked [concluded] or [resolved] before dropping it in subsequent updates.',
            '- Never silently remove items. Forgetting is a continuity error.',
            '- New Pending Threads: always generate 1-3 new external events. These MUST be different from previous ones unless still pending.',
        );
    } else {
        parts.push(
            'No previous world state exists. Create an initial World State based on this conversation.',
        );
    }

    parts.push('', instructions);

    return parts.join('\n');
}

// ── Core Update Logic ────────────────────────────────────────────

/**
 * Run a background LLM call to update the world state.
 * @param {boolean} [forceUpdate=false] - Skip the interval check
 * @param {Object}  [priorityContext=null] - Context from requestPriorityUpdate
 * @returns {Promise<Object|null>} The new state object, or null if skipped/failed
 */
export async function updateWorldState(forceUpdate = false, priorityContext = null) {
    if (_updateRunning) return null;
    if (!forceUpdate && !shouldUpdate()) return null;

    const settings = getSettings();
    if (!settings.worldStateEnabled || settings.globalEnabled === false) return null;

    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length < 6) return null;

    const chatId = getChatId();
    const currentState = getWorldState();
    const lastIdx = currentState?.lastUpdateMsgIdx ?? -1;
    const messagesSinceUpdate = Math.max(chat.length - 1 - lastIdx, 0);
    const excerptCount = Math.min(messagesSinceUpdate + 4, chat.length, 40);

    let recentExcerpt = formatChatExcerpt(chat, excerptCount);
    if (!recentExcerpt.trim()) return null;

    if (recentExcerpt.length > MAX_EXCERPT_CHARS) {
        recentExcerpt = recentExcerpt.slice(-MAX_EXCERPT_CHARS);
        const firstNewline = recentExcerpt.indexOf('\n');
        if (firstNewline > 0 && firstNewline < 500) {
            recentExcerpt = recentExcerpt.slice(firstNewline + 1);
        }
    }

    _updateRunning = true;
    const task = registerBackgroundTask({ label: 'World state', icon: 'fa-globe', color: '#00b894' });
    console.log(`[TunnelVision] World state update triggered (${messagesSinceUpdate} new messages)`);

    try {
        if (getChatId() !== chatId || task.cancelled) {
            console.log('[TunnelVision] World state update aborted');
            return null;
        }

        const previousState = currentState?.text || '';
        const quietPrompt = await buildUpdatePrompt(previousState, recentExcerpt, priorityContext);

        const response = await callWithRetry(
            () => generateQuietPrompt({ quietPrompt, skipWIAN: true }),
            { label: 'World state update' },
        );

        if (getChatId() !== chatId || task.cancelled) {
            console.log('[TunnelVision] World state update aborted after generation');
            return null;
        }

        if (!response || !response.trim()) {
            console.warn('[TunnelVision] World state update returned empty response');
            return null;
        }

        let cleaned = response.trim();
        cleaned = cleaned.replace(/^```(?:markdown)?\s*/i, '').replace(/\s*```$/i, '');

        const validation = validateWorldStateStructure(cleaned);
        if (!validation.valid) {
            console.warn(`[TunnelVision] World state update rejected: ${validation.reason}`);
            addBackgroundEvent({
                icon: 'fa-triangle-exclamation',
                verb: 'World state rejected',
                color: '#e17055',
                summary: validation.reason,
            });
            return null;
        }

        const sections = parseWorldStateSections(cleaned);

        const newState = {
            lastUpdated: Date.now(),
            lastUpdateMsgIdx: chat.length - 1,
            text: cleaned,
            previousText: currentState?.text || '',
            sections,
        };

        setWorldState(newState);
        console.log(`[TunnelVision] World state updated (${cleaned.length} chars)`);
        addBackgroundEvent({
            icon: 'fa-globe',
            verb: 'World state updated',
            color: '#00b894',
            summary: `${cleaned.length} chars`,
        });
        return newState;
    } catch (e) {
        console.error('[TunnelVision] World state update failed:', e);
        toastr.error(`World state update failed: ${e.message || 'Unknown error'}`, 'TunnelVision');
        addBackgroundEvent({
            icon: 'fa-triangle-exclamation',
            verb: 'World state failed',
            color: '#d63031',
            summary: e.message || 'Unknown error',
        });
        return null;
    } finally {
        _updateRunning = false;
        task.end();
    }
}

// ── Priority Update ──────────────────────────────────────────────

let _priorityRequested = false;
let _priorityContext = null;

/**
 * Request an out-of-band world state update (debounced).
 * Called by post-turn-processor after significant events.
 * @param {Object} [reason] - Context about what triggered the update
 * @param {boolean} [reason.sceneArchived]
 * @param {string}  [reason.sceneTitle]
 * @param {number}  [reason.factsCreated]
 * @param {string}  [reason.sceneChangeType]
 */
export function requestPriorityUpdate(reason) {
    if (_priorityRequested || _updateRunning) return;
    const settings = getSettings();
    if (!settings.worldStateEnabled || settings.globalEnabled === false) return;

    _priorityRequested = true;
    _priorityContext = reason || null;
    setTimeout(() => {
        _priorityRequested = false;
        const ctx = _priorityContext;
        _priorityContext = null;
        updateWorldState(true, ctx).catch(e => {
            console.error('[TunnelVision] Priority world state update failed:', e);
        });
    }, 2000);
}

// ── Event Handlers ───────────────────────────────────────────────

function onAiMessageReceived() {
    const settings = getSettings();
    if (!settings.worldStateEnabled || settings.globalEnabled === false) return;

    // Skip tool-call recursion
    try {
        const context = getContext();
        const lastMsg = context.chat?.[context.chat.length - 1];
        if (Array.isArray(lastMsg?.extra?.tool_invocations) && lastMsg.extra.tool_invocations.length > 0) return;
    } catch { /* proceed */ }

    const chatLength = getContext().chat?.length || 0;
    const isSwipe = chatLength > 0 && chatLength <= _chatRef.lastChatLength;

    if (isSwipe) {
        _chatRef.lastChatLength = chatLength;
        // If the world state was last updated on the swiped message, invalidate it
        const state = getWorldState();
        if (state && state.lastUpdateMsgIdx >= chatLength - 1) {
            setWorldState({ ...state, lastUpdateMsgIdx: Math.max(state.lastUpdateMsgIdx - 1, -1) });
            console.log('[TunnelVision] World state invalidated after swipe — will re-update');
        }
        if (shouldUpdate()) {
            updateWorldState().catch(e => {
                console.error('[TunnelVision] World state re-update (swipe) failed:', e);
            });
        }
        return;
    }

    _chatRef.lastChatLength = chatLength;

    if (shouldUpdate()) {
        updateWorldState().catch(e => {
            console.error('[TunnelVision] Background world state update failed:', e);
        });
    }
}

function onChatChanged() {
    try {
        _chatRef.lastChatLength = getContext().chat?.length || 0;
    } catch {
        _chatRef.lastChatLength = 0;
    }
}

// ── Init ─────────────────────────────────────────────────────────

let _initialized = false;

export function initWorldState() {
    if (_initialized) return;
    _initialized = true;

    if (event_types.MESSAGE_RECEIVED) {
        eventSource.on(event_types.MESSAGE_RECEIVED, onAiMessageReceived);
    }
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    }

    console.log('[TunnelVision] World state module initialized');
}

// ── Public API ───────────────────────────────────────────────────

/** Get the raw world state text, or empty string if none. */
export function getWorldStateText() {
    return getWorldState()?.text || '';
}

/**
 * Get the parsed sections map from the world state, or null if unavailable.
 * Each key is the section name (e.g. "Current Scene", "Active Threads"),
 * and the value is the raw section body text.
 * @returns {Record<string, string> | null}
 */
export function getWorldStateSections() {
    const state = getWorldState();
    if (!state?.sections || Object.keys(state.sections).length === 0) {
        if (!state?.text) return null;
        return parseWorldStateSections(state.text);
    }
    return state.sections;
}

/** Get the message index of the last update, or -1 if never updated. */
export function getWorldStateLastIndex() {
    return getWorldState()?.lastUpdateMsgIdx ?? -1;
}

/** Clear the world state for the current chat. */
export function clearWorldState() {
    try {
        const context = getContext();
        if (context.chatMetadata) {
            delete context.chatMetadata[METADATA_KEY];
            context.saveMetadataDebounced?.();
        }
    } catch { /* ignore */ }
}

/** Check if a world state update is currently in progress. */
export function isWorldStateUpdating() {
    return _updateRunning;
}

/** Whether a previous world state version is available for reverting. */
export function hasPreviousWorldState() {
    return !!(getWorldState()?.previousText);
}

/**
 * Revert to the previous world state version.
 * @returns {boolean} true if reverted, false if no previous version exists
 */
export function revertWorldState() {
    const state = getWorldState();
    if (!state?.previousText) return false;
    const reverted = state.previousText;
    setWorldState({
        ...state,
        text: reverted,
        previousText: '',
        sections: parseWorldStateSections(reverted),
        lastUpdated: Date.now(),
    });
    console.log('[TunnelVision] World state reverted to previous version');
    return true;
}
