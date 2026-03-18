/**
 * TunnelVision Tool Registry
 * Registers and unregisters all TunnelVision tools with ST's ToolManager.
 * Each tool lives in its own file under tools/ and exports getDefinition().
 * This file is the single point of contact with ToolManager.
 */

import { ToolManager } from '../../../tool-calling.js';
import { selected_world_info, world_info, loadWorldInfo, METADATA_KEY } from '../../../world-info.js';
import { characters, this_chid, chat_metadata } from '../../../../script.js';
import { getCharaFilename } from '../../../utils.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { isLorebookEnabled, getSettings, getTree, getBookDescription, syncTrackerUidsForLorebook } from './tree-store.js';
import { escapeHtml } from './entry-manager.js';
import {
    RUNTIME_AUDIT_GROUPS,
    RUNTIME_AUDIT_SEVERITIES,
    RUNTIME_REASON_CODES,
    RUNTIME_REPAIR_CLASSES,
    createRuntimeAuditResult,
    createRuntimeFinding,
    createRuntimeRepair,
} from './runtime-health.js';

import { getDefinition as getSearchDef, getTreeOverview, TOOL_NAME as SEARCH_NAME } from './tools/search.js';
import { getDefinition as getRememberDef, TOOL_NAME as REMEMBER_NAME } from './tools/remember.js';
import { getDefinition as getUpdateDef, TOOL_NAME as UPDATE_NAME } from './tools/update.js';
import { getDefinition as getForgetDef, TOOL_NAME as FORGET_NAME } from './tools/forget.js';
import { getDefinition as getReorganizeDef, TOOL_NAME as REORGANIZE_NAME } from './tools/reorganize.js';
import { getDefinition as getSummarizeDef, TOOL_NAME as SUMMARIZE_NAME } from './tools/summarize.js';
import { getDefinition as getMergeSplitDef, TOOL_NAME as MERGESPLIT_NAME } from './tools/merge-split.js';
import { getDefinition as getNotebookDef, TOOL_NAME as NOTEBOOK_NAME } from './tools/notebook.js';

/** All tool names for bulk unregister. */
const ALL_TOOL_NAMES = [SEARCH_NAME, REMEMBER_NAME, UPDATE_NAME, FORGET_NAME, REORGANIZE_NAME, SUMMARIZE_NAME, MERGESPLIT_NAME, NOTEBOOK_NAME];

/**
 * Delimiter that separates user-editable prompt text from dynamically injected content
 * (tree overview, tracker list). Everything after this marker is regenerated on each
 * registerTools() call, so user edits above the line persist across chat switches.
 */
export const DYNAMIC_DELIMITER = '\n\n---TV_DYNAMIC_BELOW---\n';

/**
 * Strip dynamic content (tree overview, tracker list) from a description string.
 * Returns only the user-editable portion above the delimiter.
 * Also handles legacy format where tree overview was baked in without a delimiter.
 * @param {string} text
 * @returns {string}
 */
export function stripDynamicContent(text) {
    if (!text) return text;
    // New delimiter
    let idx = text.indexOf('---TV_DYNAMIC_BELOW---');
    // Legacy: tree overview baked in before delimiter existed
    if (idx < 0) idx = text.indexOf('\n\nFull tree index:\n');
    if (idx < 0) idx = text.indexOf('\n\nTop-level tree:\n');
    return idx >= 0 ? text.substring(0, idx).trimEnd() : text;
}

/** Tools that can be gated with per-tool confirmation. Only destructive/mutating tools. */
const CONFIRMABLE_TOOLS = new Set([REMEMBER_NAME, UPDATE_NAME, FORGET_NAME, SUMMARIZE_NAME, REORGANIZE_NAME, MERGESPLIT_NAME]);

/** Cached tracker list string — refreshed on each registerTools() call. */
let _trackerListCache = '';
let _lastAppliedRegistrationSignature = null;
let _lastComputedRegistrationSignature = null;

function getAllToolDefinitions() {
    return [
        { def: getSearchDef(), name: SEARCH_NAME },
        { def: getRememberDef(), name: REMEMBER_NAME },
        { def: getUpdateDef(), name: UPDATE_NAME },
        { def: getForgetDef(), name: FORGET_NAME },
        { def: getReorganizeDef(), name: REORGANIZE_NAME },
        { def: getSummarizeDef(), name: SUMMARIZE_NAME },
        { def: getMergeSplitDef(), name: MERGESPLIT_NAME },
        { def: getNotebookDef(), name: NOTEBOOK_NAME },
    ];
}

function getToolDefinitionName(tool) {
    return tool?.toFunctionOpenAI?.()?.function?.name || '';
}

function buildRegistrationSignature(preparedTools, activeBooks) {
    const payload = {
        activeBooks: [...activeBooks].sort(),
        tools: preparedTools.map(({ name, registrationDef, confirmWrapped }) => ({
            name,
            displayName: registrationDef.displayName || '',
            description: registrationDef.description || '',
            parameters: registrationDef.parameters || null,
            stealth: registrationDef.stealth === true,
            confirmWrapped,
        })),
    };

    return JSON.stringify(payload);
}

function getRegisteredTunnelVisionTools() {
    return ToolManager.tools.filter(tool => ALL_TOOL_NAMES.includes(getToolDefinitionName(tool)));
}

/** Get cached tracker list string. Updated during registerTools(). */
function getTrackerListString() {
    return _trackerListCache;
}

/**
 * Get the names/comments of entries flagged as trackers.
 * Returns a formatted string for injection into tool descriptions.
 * @returns {Promise<string>}
 */
async function getTrackerList() {
    const trackerNames = [];

    for (const bookName of getActiveTunnelVisionBooks()) {
        try {
            const bookData = await loadWorldInfo(bookName);
            if (!bookData?.entries) continue;
            const bookTrackers = await syncTrackerUidsForLorebook(bookName, bookData.entries);
            if (!bookTrackers.length) continue;

            for (const key of Object.keys(bookData.entries)) {
                const entry = bookData.entries[key];
                if (bookTrackers.includes(entry.uid) && !entry.disable) {
                    const name = entry.comment || entry.key?.[0] || `#${entry.uid}`;
                    trackerNames.push(name);
                }
            }
        } catch {
            // Lorebook might not be loadable — skip silently
        }
    }

    return trackerNames.length > 0
        ? `\n\nTracked entries (check/update these when relevant): ${trackerNames.join(', ')}`
        : '';
}

// ── Active Book Cache ────────────────────────────────────────────

let _activeBookCache = null;
let _activeBookCacheDirty = true;

/**
 * Invalidate the active lorebook cache. Called on chat change, WI update,
 * and at the start of registerTools().
 */
export function invalidateActiveBookCache() {
    _activeBookCacheDirty = true;
    _activeBookCache = null;
}

/**
 * Get all active lorebooks that have TunnelVision enabled.
 * Checks global, character-attached (primary + extraBooks), and chat-attached lorebooks.
 * Results are cached and invalidated on chat/WI changes.
 * Shared by all tools via import from this module.
 * @returns {string[]}
 */
export function getActiveTunnelVisionBooks() {
    if (!_activeBookCacheDirty && _activeBookCache !== null) {
        return _activeBookCache;
    }

    const candidates = new Set();

    if (Array.isArray(selected_world_info)) {
        for (const name of selected_world_info) candidates.add(name);
    }

    if (this_chid !== undefined && this_chid !== null) {
        const character = characters[this_chid];
        const primaryBook = character?.data?.extensions?.world;
        if (primaryBook) candidates.add(primaryBook);

        const charFilename = getCharaFilename(this_chid);
        const charLore = world_info?.charLore || [];
        const charEntry = charLore.find(e => e.name === charFilename);
        if (charEntry?.extraBooks) {
            for (const name of charEntry.extraBooks) candidates.add(name);
        }
    }

    const chatWorld = chat_metadata?.[METADATA_KEY];
    if (chatWorld) candidates.add(chatWorld);
    if (Array.isArray(chat_metadata?.carrot_chat_books)) {
        for (const name of chat_metadata.carrot_chat_books) candidates.add(name);
    }

    const active = [];
    for (const bookName of candidates) {
        if (isLorebookEnabled(bookName)) active.push(bookName);
    }

    _activeBookCache = active;
    _activeBookCacheDirty = false;
    return active;
}

async function inspectToolRuntimeState() {
    const settings = getSettings();
    const disabled = settings.disabledTools || {};
    const activeBooks = getActiveTunnelVisionBooks();
    const disabledToolNames = ALL_TOOL_NAMES.filter(name => disabled[name]);
    const expectedToolNames = ALL_TOOL_NAMES.filter(name => !disabled[name]);
    const registeredTools = getRegisteredTunnelVisionTools();
    const registeredToolNames = registeredTools.map(getToolDefinitionName);
    const missingToolNames = expectedToolNames.filter(name => !registeredToolNames.includes(name));
    const stealthToolNames = registeredTools
        .filter(tool => tool.stealth)
        .map(getToolDefinitionName);
    const eligibleToolNames = [];
    const eligibilityErrors = [];

    for (const tool of registeredTools) {
        const name = getToolDefinitionName(tool);
        try {
            if (await tool.shouldRegister()) {
                eligibleToolNames.push(name);
            }
        } catch (error) {
            eligibilityErrors.push(`${name}: ${error?.message || String(error)}`);
        }
    }

    return {
        activeBooks,
        disabledToolNames,
        expectedToolNames,
        registeredToolNames,
        missingToolNames,
        stealthToolNames,
        eligibleToolNames,
        eligibilityErrors,
        lastAppliedRegistrationSignature: _lastAppliedRegistrationSignature,
        lastComputedRegistrationSignature: _lastComputedRegistrationSignature,
        registrationEpoch: _registrationEpoch,
        lastAppliedRegistrationEpoch: _lastAppliedRegistrationEpoch,
        lastComputedRegistrationEpoch: _lastComputedRegistrationEpoch,
        registerVersion: _registerVersion,
        hasRegisterLock: Boolean(_registerLock),
        trackerListCached: Boolean(_trackerListCache),
        trackerListLength: _trackerListCache.length,
    };
}

function logToolRuntimeSnapshot(snapshot, reason = 'runtime') {
    const parts = [
        `active=[${snapshot.activeBooks.join(', ') || '(none)'}]`,
        `registered=[${snapshot.registeredToolNames.join(', ') || '(none)'}]`,
        `missing=[${snapshot.missingToolNames.join(', ') || '(none)'}]`,
        `stealth=[${snapshot.stealthToolNames.join(', ') || '(none)'}]`,
        `eligible=[${snapshot.eligibleToolNames.join(', ') || '(none)'}]`,
        `repaired=${snapshot.repairApplied ? 'yes' : 'no'}`,
    ];

    if (snapshot.eligibilityErrors?.length) {
        parts.push(`eligibilityErrors=[${snapshot.eligibilityErrors.join('; ')}]`);
    }

    const message = `[TunnelVision] Tool preflight (${reason}) ${parts.join(' | ')}`;
    if (snapshot.failureReasons?.length) {
        console.warn(`${message} | failures=[${snapshot.failureReasons.join('; ')}]`);
    } else {
        console.log(message);
    }
}

export async function getToolRegistrationRuntimeSnapshot() {
    return await inspectToolRuntimeState();
}

export async function preflightToolRuntimeState({ repair = true, reason = 'generation', log = true } = {}) {
    let snapshot = await getToolRegistrationRuntimeSnapshot();
    let repairApplied = false;

    if (
        repair
        && snapshot.activeBooks.length > 0
        && (snapshot.missingToolNames.length > 0 || snapshot.stealthToolNames.length > 0)
    ) {
        await registerTools();
        repairApplied = true;
        snapshot = await getToolRegistrationRuntimeSnapshot();
    }

    const failureReasons = [];
    if (snapshot.activeBooks.length > 0 && snapshot.expectedToolNames.length > 0) {
        if (snapshot.registeredToolNames.length === 0) {
            failureReasons.push('no_registered_tools');
        }
        if (snapshot.missingToolNames.length > 0) {
            failureReasons.push(`missing_tools:${snapshot.missingToolNames.join(', ')}`);
        }
        if (snapshot.stealthToolNames.length > 0) {
            failureReasons.push(`stealth_tools:${snapshot.stealthToolNames.join(', ')}`);
        }
        if (snapshot.eligibilityErrors.length > 0) {
            failureReasons.push(`eligibility_errors:${snapshot.eligibilityErrors.join(' | ')}`);
        }
        if (snapshot.eligibleToolNames.length === 0) {
            failureReasons.push('no_eligible_tools');
        }
    }

    const result = { ...snapshot, repairApplied, failureReasons };
    if (log) {
        logToolRuntimeSnapshot(result, reason);
    }
    return result;
}

export async function auditToolRegistrationRuntime({ repair = false, reason = 'diagnostics' } = {}) {
    const snapshot = await preflightToolRuntimeState({ repair, reason, log: false });
    const findings = [];
    const safeRepairs = [];

    if (snapshot.activeBooks.length === 0) {
        return createRuntimeAuditResult({
            group: RUNTIME_AUDIT_GROUPS.REGISTRATION,
            ok: true,
            summary: 'No active TunnelVision lorebooks; registration state is idle.',
            findings: [
                createRuntimeFinding({
                    id: 'registration-idle',
                    subsystem: 'tool-registry',
                    severity: RUNTIME_AUDIT_SEVERITIES.INFO,
                    message: 'No active TunnelVision lorebooks are selected, so no registration is required.',
                    context: {
                        activeBooks: snapshot.activeBooks,
                    },
                }),
            ],
            context: snapshot,
        });
    }

    if (snapshot.expectedToolNames.length === 0) {
        findings.push(createRuntimeFinding({
            id: 'registration-no-enabled-tools',
            subsystem: 'tool-registry',
            severity: RUNTIME_AUDIT_SEVERITIES.WARN,
            message: 'All TunnelVision tools are disabled in settings, so none are expected to be registered.',
            reasonCode: RUNTIME_REASON_CODES.ELIGIBILITY_MISMATCH,
            context: {
                disabledToolNames: snapshot.disabledToolNames,
                expectedToolNames: snapshot.expectedToolNames,
            },
        }));
    }

    if (
        snapshot.lastComputedRegistrationSignature
        && snapshot.lastAppliedRegistrationSignature
        && snapshot.lastComputedRegistrationSignature === snapshot.lastAppliedRegistrationSignature
        && snapshot.lastComputedRegistrationEpoch > snapshot.lastAppliedRegistrationEpoch
    ) {
        findings.push(createRuntimeFinding({
            id: 'registration-stale-applied-epoch',
            subsystem: 'tool-registry',
            severity: RUNTIME_AUDIT_SEVERITIES.WARN,
            message: 'Registered tool state is using a stale applied epoch for the current registration signature.',
            reasonCode: RUNTIME_REASON_CODES.REDUNDANT_REGISTRATION,
            repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
            repairActionId: 'rebuild-tool-registration',
            context: {
                registrationEpoch: snapshot.registrationEpoch,
                lastAppliedRegistrationEpoch: snapshot.lastAppliedRegistrationEpoch,
                lastComputedRegistrationEpoch: snapshot.lastComputedRegistrationEpoch,
            },
        }));

        if (!safeRepairs.some(repairAction => repairAction.id === 'rebuild-tool-registration')) {
            safeRepairs.push(createRuntimeRepair({
                id: 'rebuild-tool-registration',
                label: 'Rebuild active tool registration',
                repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
                reasonCode: RUNTIME_REASON_CODES.REDUNDANT_REGISTRATION,
                context: {
                    reason,
                },
            }));
        }
    }

    if (snapshot.missingToolNames.length > 0) {
        findings.push(createRuntimeFinding({
            id: 'registration-missing-tools',
            subsystem: 'tool-registry',
            severity: snapshot.registeredToolNames.length === 0 ? RUNTIME_AUDIT_SEVERITIES.ERROR : RUNTIME_AUDIT_SEVERITIES.WARN,
            message: `Missing registered TunnelVision tools: ${snapshot.missingToolNames.join(', ')}`,
            reasonCode: RUNTIME_REASON_CODES.MISSING_REGISTRATION,
            repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
            repairActionId: 'rebuild-tool-registration',
            context: {
                missingToolNames: snapshot.missingToolNames,
                expectedToolNames: snapshot.expectedToolNames,
                registeredToolNames: snapshot.registeredToolNames,
            },
        }));
        safeRepairs.push(createRuntimeRepair({
            id: 'rebuild-tool-registration',
            label: 'Rebuild active tool registration',
            repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
            reasonCode: RUNTIME_REASON_CODES.MISSING_REGISTRATION,
            context: {
                reason,
            },
        }));
    }

    if (snapshot.stealthToolNames.length > 0) {
        findings.push(createRuntimeFinding({
            id: 'registration-stealth-tools',
            subsystem: 'tool-registry',
            severity: RUNTIME_AUDIT_SEVERITIES.ERROR,
            message: `TunnelVision tools unexpectedly marked as stealth: ${snapshot.stealthToolNames.join(', ')}`,
            reasonCode: RUNTIME_REASON_CODES.STEALTH_REGISTRATION,
            repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
            repairActionId: 'rebuild-tool-registration',
            context: {
                stealthToolNames: snapshot.stealthToolNames,
            },
        }));
        if (!safeRepairs.some(repairAction => repairAction.id === 'rebuild-tool-registration')) {
            safeRepairs.push(createRuntimeRepair({
                id: 'rebuild-tool-registration',
                label: 'Rebuild active tool registration',
                repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
                reasonCode: RUNTIME_REASON_CODES.STEALTH_REGISTRATION,
                context: {
                    reason,
                },
            }));
        }
    }

    if (snapshot.eligibilityErrors.length > 0) {
        findings.push(createRuntimeFinding({
            id: 'registration-eligibility-errors',
            subsystem: 'tool-registry',
            severity: RUNTIME_AUDIT_SEVERITIES.ERROR,
            message: `Tool eligibility checks failed: ${snapshot.eligibilityErrors.join(' | ')}`,
            reasonCode: RUNTIME_REASON_CODES.ELIGIBILITY_MISMATCH,
            context: {
                eligibilityErrors: snapshot.eligibilityErrors,
            },
        }));
    }

    if (snapshot.expectedToolNames.length > 0 && snapshot.eligibleToolNames.length === 0) {
        findings.push(createRuntimeFinding({
            id: 'registration-no-eligible-tools',
            subsystem: 'tool-registry',
            severity: RUNTIME_AUDIT_SEVERITIES.WARN,
            message: 'No TunnelVision tools are currently eligible for the next generation despite active lorebooks.',
            reasonCode: RUNTIME_REASON_CODES.ELIGIBILITY_MISMATCH,
            context: {
                activeBooks: snapshot.activeBooks,
                expectedToolNames: snapshot.expectedToolNames,
                eligibleToolNames: snapshot.eligibleToolNames,
            },
        }));
    }

    if (
        snapshot.lastAppliedRegistrationSignature
        && snapshot.lastComputedRegistrationSignature
        && snapshot.lastAppliedRegistrationSignature === snapshot.lastComputedRegistrationSignature
        && snapshot.missingToolNames.length === 0
        && snapshot.stealthToolNames.length === 0
    ) {
        findings.push(createRuntimeFinding({
            id: 'registration-signature-stable',
            subsystem: 'tool-registry',
            severity: RUNTIME_AUDIT_SEVERITIES.INFO,
            message: 'Tool registration signature is stable for the current runtime inputs.',
            context: {
                registrationSignature: snapshot.lastAppliedRegistrationSignature,
            },
        }));
    }

    return createRuntimeAuditResult({
        group: RUNTIME_AUDIT_GROUPS.REGISTRATION,
        ok: findings.every(finding => finding.severity !== RUNTIME_AUDIT_SEVERITIES.ERROR),
        summary: snapshot.failureReasons.length > 0
            ? `Tool registration audit found ${snapshot.failureReasons.length} runtime issue(s).`
            : findings.some(finding => finding.severity === RUNTIME_AUDIT_SEVERITIES.WARN)
                ? 'Tool registration audit found coordination issues.'
                : 'Tool registration audit passed.',
        findings,
        safeRepairs,
        context: snapshot,
    });
}

/**
 * Resolve which lorebook to write to. Auto-corrects when only one book is active.
 * @param {string|undefined} requestedBook - The lorebook name the AI provided.
 * @returns {{ book: string, error: string|null }} The resolved book name, or an error message.
 */
export function resolveTargetBook(requestedBook) {
    const activeBooks = getActiveTunnelVisionBooks();
    if (activeBooks.length === 0) {
        return { book: '', error: 'No active TunnelVision lorebooks.' };
    }

    // Single book: always use it, regardless of what the AI typed
    if (activeBooks.length === 1) {
        return { book: activeBooks[0], error: null };
    }

    // Multiple books: validate the AI's choice
    if (!requestedBook) {
        const desc = getBookListWithDescriptions();
        return { book: '', error: `Multiple lorebooks active. You must specify which one.\n${desc}` };
    }
    if (!activeBooks.includes(requestedBook)) {
        const desc = getBookListWithDescriptions();
        return { book: '', error: `Lorebook "${requestedBook}" is not active.\n${desc}` };
    }
    return { book: requestedBook, error: null };
}

/**
 * Build a descriptive list of active lorebooks for tool descriptions.
 * Uses user-set description, falls back to tree root summary, falls back to top-level labels.
 * @returns {string} Formatted multi-line description of available lorebooks.
 */
export function getBookListWithDescriptions() {
    const activeBooks = getActiveTunnelVisionBooks();
    if (activeBooks.length === 0) return '(none active)';

    const lines = [];
    for (const bookName of activeBooks) {
        const userDesc = getBookDescription(bookName);
        if (userDesc) {
            lines.push(`- "${bookName}": ${userDesc}`);
            continue;
        }

        // Fall back to tree root summary
        const tree = getTree(bookName);
        if (tree?.root?.summary && tree.root.summary !== `Top-level index for ${bookName}`) {
            lines.push(`- "${bookName}": ${tree.root.summary}`);
            continue;
        }

        // Fall back to listing top-level category labels
        if (tree?.root?.children?.length > 0) {
            const labels = tree.root.children.map(c => c.label).slice(0, 6).join(', ');
            const more = tree.root.children.length > 6 ? ` (+${tree.root.children.length - 6} more)` : '';
            lines.push(`- "${bookName}": Contains: ${labels}${more}`);
            continue;
        }

        lines.push(`- "${bookName}"`);
    }

    return lines.join('\n');
}

/**
 * Returns the default (built-in) description for every tool.
 * Used by the UI to show defaults and allow reset.
 * @returns {{ [toolName: string]: string }}
 */
export function getDefaultToolDescriptions() {
    const result = {};
    for (const { def, name } of getAllToolDefinitions()) {
        if (def) {
            result[name] = def.description;
        }
    }
    return result;
}

function formatConfirmArgs(args) {
    if (!args || typeof args !== 'object') return '';
    const lines = [];
    for (const [key, value] of Object.entries(args)) {
        let display;
        if (Array.isArray(value)) {
            display = escapeHtml(value.join(', '));
        } else if (typeof value === 'string' && value.length > 200) {
            display = escapeHtml(value.substring(0, 200)) + '...';
        } else {
            display = escapeHtml(value ?? '');
        }
        lines.push(`<div><strong>${escapeHtml(key)}:</strong> ${display}</div>`);
    }
    return lines.join('');
}

/**
 * Show a confirmation popup for a tool action.
 * @param {string} displayName - Human-readable tool name
 * @param {Object} args - Tool arguments from the AI
 * @returns {Promise<boolean>} True if user approved
 */
async function showToolConfirmation(displayName, args) {
    const html = `<div class="tv-confirm-popup">
    <div class="tv-confirm-title">TunnelVision wants to: <strong>${displayName}</strong></div>
    <div class="tv-confirm-args">${formatConfirmArgs(args)}</div>
    <div class="tv-confirm-hint">Approve this action?</div>
</div>`;
    const result = await callGenericPopup(html, POPUP_TYPE.CONFIRM);
    return result === POPUP_RESULT.AFFIRMATIVE;
}

/**
 * Wrap a tool's action with a confirmation gate.
 * @param {Function} originalAction - The tool's original action function
 * @param {string} displayName - Human-readable tool name
 * @returns {Function} Wrapped action that shows confirmation first
 */
function wrapWithConfirmation(originalAction, displayName) {
    return async function (args) {
        const approved = await showToolConfirmation(displayName, args);
        if (!approved) {
            return 'Action denied by user. The user chose not to allow this operation. Try a different approach or ask the user what they want.';
        }
        return originalAction(args);
    };
}

/** Guard against overlapping registerTools() calls — concurrent callers are
 *  coalesced so only the latest request actually runs after the lock is freed. */
let _registerLock = null;
let _registerVersion = 0;
let _registrationEpoch = 0;
let _lastAppliedRegistrationEpoch = 0;
let _lastComputedRegistrationEpoch = 0;

function bumpRegistrationEpoch() {
    _registrationEpoch += 1;
    return _registrationEpoch;
}

/**
 * Register all TunnelVision tools with ToolManager.
 * Each tool's getDefinition() may return null if preconditions aren't met
 * (e.g. Search returns null if no valid trees exist).
 */
export async function registerTools() {
    invalidateActiveBookCache();
    const myVersion = ++_registerVersion;

    while (_registerLock) {
        await _registerLock;
    }

    // A newer caller arrived while we waited — let it handle registration
    if (myVersion !== _registerVersion) return;

    let unlock;
    _registerLock = new Promise(r => { unlock = r; });

    try {
        await _doRegisterTools();
    } finally {
        _registerLock = null;
        unlock();
    }
}

async function _doRegisterTools() {
    const activeBooks = getActiveTunnelVisionBooks();
    if (activeBooks.length === 0) {
        _trackerListCache = '';
        unregisterTools();
        return;
    }

    // Pre-fetch tracker list BEFORE unregistering so tools remain available during async I/O
    _trackerListCache = await getTrackerList();

    const settings = getSettings();
    const disabled = settings.disabledTools || {};

    const allDefs = getAllToolDefinitions();

    const confirmTools = settings.confirmTools || {};
    const promptOverrides = settings.toolPromptOverrides || {};
    const preparedTools = [];

    for (const { def, name } of allDefs) {
        if (disabled[name]) {
            continue;
        }
        if (!def) continue;

        // Clone def to avoid mutating the original
        let registrationDef = { ...def };

        // Apply user prompt override (description only), stripping any stale dynamic content
        if (promptOverrides[name] && typeof promptOverrides[name] === 'string') {
            registrationDef.description = stripDynamicContent(promptOverrides[name]);
        }

        // Build dynamic suffix (tree overview + tracker list) — injected after delimiter
        let dynamicSuffix = '';
        if (name === SEARCH_NAME) {
            const treeOverview = getTreeOverview();
            if (treeOverview) dynamicSuffix += treeOverview;
        }
        if (_trackerListCache && (name === SEARCH_NAME || name === UPDATE_NAME)) {
            dynamicSuffix += _trackerListCache;
        }
        if (dynamicSuffix) {
            registrationDef.description = registrationDef.description + DYNAMIC_DELIMITER + dynamicSuffix;
        }

        // Wrap action with confirmation gate for confirmable tools
        const confirmWrapped = !!(CONFIRMABLE_TOOLS.has(name) && confirmTools[name]);
        if (CONFIRMABLE_TOOLS.has(name) && confirmTools[name]) {
            registrationDef.action = wrapWithConfirmation(registrationDef.action, registrationDef.displayName || name);
        }

        preparedTools.push({ name, registrationDef, confirmWrapped });
    }

    const signature = buildRegistrationSignature(preparedTools, activeBooks);
    _lastComputedRegistrationSignature = signature;
    _lastComputedRegistrationEpoch = bumpRegistrationEpoch();
    if (signature === _lastAppliedRegistrationSignature) {
        _lastAppliedRegistrationEpoch = _lastComputedRegistrationEpoch;
        console.debug('[TunnelVision] Tool registration skipped: definitions unchanged');
        return;
    }

    // Unregister right before the synchronous re-registration loop to minimize
    // the window where tools are absent.
    unregisterTools({ preserveRegistrationState: true });

    let registered = 0;
    for (const { registrationDef } of preparedTools) {
        try {
            ToolManager.registerFunctionTool(registrationDef);
            registered++;
        } catch (e) {
            console.error(`[TunnelVision] Failed to register tool "${registrationDef.name}":`, e);
        }
    }

    _lastAppliedRegistrationSignature = signature;
    _lastAppliedRegistrationEpoch = bumpRegistrationEpoch();

    const eligible = allDefs.filter(({ def, name }) => def && !disabled[name]).length;
    const snapshot = await inspectToolRuntimeState();
    console.log(`[TunnelVision] Registered ${registered}/${eligible} tools for ${activeBooks.length} lorebook(s)`);
    logToolRuntimeSnapshot({ ...snapshot, repairApplied: false, failureReasons: [] }, 'register');
}

/**
 * Unregister all TunnelVision tools.
 */
export function unregisterTools({ preserveRegistrationState = false } = {}) {
    for (const name of ALL_TOOL_NAMES) {
        try {
            ToolManager.unregisterFunctionTool(name);
        } catch {
            // Tool may not be registered — that's fine
        }
    }
    if (preserveRegistrationState) {
        return;
    }

    _lastAppliedRegistrationSignature = null;
    _lastComputedRegistrationSignature = null;
    _lastAppliedRegistrationEpoch = bumpRegistrationEpoch();
    _lastComputedRegistrationEpoch = _lastAppliedRegistrationEpoch;
}

/**
 * Check whether the Search tool is actually registered and tool calling is
 * supported by the current API. Used by WI suppression to avoid removing
 * entries when the model has no way to retrieve them via tools.
 * @returns {boolean}
 */
export function isSearchToolAvailable() {
    if (typeof ToolManager.isToolCallingSupported === 'function' && !ToolManager.isToolCallingSupported()) {
        return false;
    }
    return ToolManager.tools.some(tool => {
        try { return getToolDefinitionName(tool) === SEARCH_NAME; }
        catch { return false; }
    });
}

// ── Recurse Limit ────────────────────────────────────────────────

const ST_DEFAULT_RECURSE_LIMIT = 5;

/**
 * Apply the user's RECURSE_LIMIT override to ToolManager.
 * Clamps to 1–50. Called from init and when the UI setting changes.
 * @param {Object} settings
 */
export function applyRecurseLimit(settings) {
    const limit = Number(settings.recurseLimit);
    if (!isFinite(limit) || limit < 1) {
        ToolManager.RECURSE_LIMIT = ST_DEFAULT_RECURSE_LIMIT;
        return;
    }
    ToolManager.RECURSE_LIMIT = Math.min(Math.max(Math.round(limit), 1), 50);
}

// Re-export tool names and constants for diagnostics/UI
export { SEARCH_NAME, REMEMBER_NAME, UPDATE_NAME, FORGET_NAME, REORGANIZE_NAME, SUMMARIZE_NAME, MERGESPLIT_NAME, NOTEBOOK_NAME, ALL_TOOL_NAMES, CONFIRMABLE_TOOLS };
