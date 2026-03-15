/**
 * TunnelVision_Summarize Tool
 * Model-driven scene/event summarization. The AI decides when something is
 * worth summarizing — this is NOT interval-based or automatic.
 *
 * Creates temporal summary entries (what happened) as distinct from Remember's
 * entity/fact entries (what exists). Summaries capture scenes, events, and
 * narrative beats that the AI determines are significant enough to persist.
 *
 * Summaries are filed under a dedicated "Summaries" category node in the tree,
 * auto-created if it doesn't exist. This keeps temporal knowledge separate from
 * referential knowledge (characters, locations, rules, etc.).
 */

import { getTree, findNodeById, createTreeNode, saveTree, getSettings, ensureSummariesNode } from '../tree-store.js';
import { createEntry, buildSummaryKeys, KEYWORD_RULES } from '../entry-manager.js';
import { getActiveTunnelVisionBooks, resolveTargetBook, getBookListWithDescriptions } from '../tool-registry.js';
import { markAutoSummaryComplete } from '../auto-summary.js';
import { getContext } from '../../../../st-context.js';
import { hideChatMessageRange } from '../../../../chats.js';

export const TOOL_NAME = 'TunnelVision_Summarize';

const WATERMARK_KEY = 'tunnelvision_summary_watermark';

/**
 * Get the last-summarized message ID watermark for the current chat.
 * @returns {number} The message ID after which no summary has covered, or -1 if none.
 */
export function getWatermark() {
    const context = getContext();
    const val = context.chatMetadata?.[WATERMARK_KEY];
    return typeof val === 'number' ? val : -1;
}

/**
 * Set the last-summarized message ID watermark for the current chat.
 * @param {number} messageId
 */
export function setWatermark(messageId) {
    const context = getContext();
    if (!context.chatMetadata) return;
    context.chatMetadata[WATERMARK_KEY] = messageId;
    context.saveMetadataDebounced?.();
}

/**
 * Hide messages covered by a summary, using either messages_back or the watermark.
 * Exported so auto-summary and scene archiver can also call it.
 * @param {number|undefined} messagesBack - How many messages back the summary covers.
 * @param {Object} [opts]
 * @param {number} [opts.endIndex] - Explicit end index for the hide range (overrides
 *   the default of currentMsgId - 1). Used by the scene archiver to hide only the old
 *   scene, not the new-scene messages that exist at the tail of the full chat.
 * @returns {Promise<string|null>} Status message or null if nothing was hidden.
 */
export async function hideSummarizedMessages(messagesBack, { endIndex } = {}) {
    const settings = getSettings();
    if (!settings.autoHideSummarized) return null;

    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length < 2) return null;

    const currentMsgId = chat.length - 1;
    let hideStart, hideEnd;

    if (typeof endIndex === 'number' && endIndex >= 0) {
        const watermark = getWatermark();
        hideStart = watermark + 1;
        hideEnd = endIndex;
    } else if (typeof messagesBack === 'number' && messagesBack > 0) {
        hideEnd = currentMsgId - 1;
        hideStart = Math.max(0, currentMsgId - messagesBack);
    } else {
        const watermark = getWatermark();
        hideStart = watermark + 1;
        hideEnd = currentMsgId - 1;
    }

    // Sanity checks
    if (hideStart > hideEnd || hideStart < 0 || hideEnd < 0) return null;
    // Don't hide message 0 (first message / greeting)
    if (hideStart === 0) hideStart = 1;
    if (hideStart > hideEnd) return null;

    // Don't re-hide already hidden messages — count only visible ones
    let visibleCount = 0;
    for (let i = hideStart; i <= hideEnd; i++) {
        if (chat[i] && !chat[i].is_system) visibleCount++;
    }
    if (visibleCount === 0) return null;

    try {
        await hideChatMessageRange(hideStart, hideEnd, false);
        setWatermark(hideEnd);
        console.log(`[TunnelVision] Hid messages ${hideStart}-${hideEnd} (${visibleCount} visible) after summary`);
        return `Hidden ${visibleCount} summarized messages (${hideStart}-${hideEnd}).`;
    } catch (e) {
        console.error('[TunnelVision] Failed to hide summarized messages:', e);
        return null;
    }
}

/**
 * Returns the tool definition for ToolManager.registerFunctionTool().
 * @returns {Object}
 */
export function getDefinition() {
    const bookDesc = getBookListWithDescriptions();

    return {
        name: TOOL_NAME,
        displayName: 'TunnelVision Summarize',
        description: `Create a summary of a significant scene, event, or narrative beat for long-term memory. Use this when something important happens that should be remembered as a discrete event — a major conversation, a battle, a discovery, an emotional turning point, or any scene transition worth recording.

Write the summary as concise narration beats — past tense, third person, like a story outline. Each sentence should carry narrative weight. Capture key actions, decisions, outcomes, emotional turning points, and relationship shifts. Preserve specifics that matter for continuity (names, places, promises, injuries, revelations). Omit filler like greetings, small talk, and moment-to-moment reactions. A good scene summary is 3-8 tight sentences, not a transcript.

Always estimate WHEN the event occurred in-story using the "when" field. Infer from context clues — time of day, how many days have passed, season, calendar references, or relative timing ("the morning after the ambush"). Use whatever granularity the story supports.

To save discrete facts (relationship changes, revelations, status changes, etc.), use TunnelVision_Remember — fact creation is handled separately from summarization.

Available lorebooks:
${bookDesc}

Provide messages_back to indicate roughly how many messages this summary covers (counting back from current). Summarized messages may be hidden from chat to save tokens — the summary preserves them.

When you notice related events forming a pattern or storyline, group them into "arcs" (narrative threads). Proactively create a new arc with create_arc when a new story thread emerges, and assign subsequent related summaries to it with arc_node_id. You can also use TunnelVision_Reorganize to move earlier summaries into an arc retroactively.`,
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                lorebook: {
                    type: 'string',
                    description: `Which lorebook to save the summary to. Choose based on content type:\n${bookDesc}`,
                },
                title: {
                    type: 'string',
                    description: 'A short, descriptive title for this event/scene (e.g. "The Ambush at Thornfield Bridge", "Sable confesses her fears to Ren").',
                },
                summary: {
                    type: 'string',
                    description: 'The scene/event summary as concise narration beats. Past tense, third person. Capture key actions, decisions, outcomes, and turning points — not a transcript. 3-8 tight sentences for a typical scene.',
                },
                when: {
                    type: 'string',
                    description: 'In-world date/time when this event occurred. Infer from story context (e.g. "Late evening, Day 3", "Morning after the festival", "Year 412, Autumn"). Use whatever granularity the story supports.',
                },
                participants: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Names of characters/entities involved in this event.',
                },
                keys: {
                    type: 'array',
                    items: { type: 'string' },
                    description: KEYWORD_RULES,
                },
                significance: {
                    type: 'string',
                    enum: ['minor', 'moderate', 'major', 'critical'],
                    description: 'How significant is this event? Helps with future retrieval priority. "minor" = flavor/ambiance, "moderate" = plot-relevant, "major" = changes character/world state, "critical" = turning point.',
                },
                arc_node_id: {
                    type: 'string',
                    description: 'Optional: Assign this summary to an existing arc (narrative thread). Provide the arc node ID.',
                },
                create_arc: {
                    type: 'string',
                    description: 'Optional: Create a new arc (narrative thread) with this name. The summary will be the first entry in the arc. Use this when a new story thread begins.',
                },
                messages_back: {
                    type: 'number',
                    description: 'How many messages back this summary covers (from the current message). E.g. 15 means this summary covers the last 15 messages. Used to hide summarized messages from chat context.',
                },
            },
            required: ['lorebook', 'title', 'summary'],
        },
        action: async (args) => {
            if (!args?.title || !args?.summary) {
                return 'Missing required fields: title and summary are required.';
            }

            const { book: lorebook, error } = resolveTargetBook(args.lorebook);
            if (error) return error;

            // Ensure the Summaries category exists
            const summariesNodeId = ensureSummariesNode(lorebook);

            // Determine target node (summaries, arc, or new arc)
            let targetNodeId = summariesNodeId;
            let arcLabel = null;

            if (args.create_arc) {
                // Create a new arc node under Summaries
                const tree = getTree(lorebook);
                if (tree && tree.root) {
                    const summNode = findNodeById(tree.root, summariesNodeId);
                    if (summNode) {
                        const arcNode = createTreeNode(args.create_arc, '');
                        arcNode.isArc = true;
                        summNode.children = summNode.children || [];
                        summNode.children.push(arcNode);
                        saveTree(lorebook, tree);
                        targetNodeId = arcNode.id;
                        arcLabel = args.create_arc;
                        console.log(`[TunnelVision] Created arc "${args.create_arc}" (${arcNode.id})`);
                    }
                }
            } else if (args.arc_node_id) {
                // Assign to existing arc
                const tree = getTree(lorebook);
                if (tree && tree.root) {
                    const arcNode = findNodeById(tree.root, args.arc_node_id);
                    if (arcNode) {
                        targetNodeId = args.arc_node_id;
                        arcLabel = arcNode.label;
                    }
                }
            }

            // Build content with metadata prefix
            const significance = args.significance || 'moderate';
            const participantList = Array.isArray(args.participants) && args.participants.length > 0
                ? args.participants.join(', ')
                : '(unspecified)';
            const whenLine = args.when ? `When: ${args.when}\n` : '';

            const content = `[Scene Summary — ${significance}]\n${whenLine}Participants: ${participantList}\n\n${args.summary.trim()}`;

            const participants = Array.isArray(args.participants)
                ? args.participants.map(p => String(p).trim()).filter(Boolean)
                : [];
            const keysInput = { ...args, arc: arcLabel || args.create_arc || null };
            const keys = buildSummaryKeys(keysInput, participants, significance);

            try {
                const result = await createEntry(lorebook, {
                    content,
                    comment: `[Summary] ${args.title}`,
                    keys,
                    nodeId: targetNodeId,
                });
                markAutoSummaryComplete();
                let response = `Summarized: "${args.title}" (UID ${result.uid}) → "${result.nodeLabel}" in "${lorebook}". Significance: ${significance}.`;
                if (arcLabel) {
                    response += ` Arc: "${arcLabel}".`;
                }

                // Hide summarized messages if enabled
                const hideResult = await hideSummarizedMessages(args.messages_back);
                if (hideResult) {
                    response += ` ${hideResult}`;
                }

                return response;
            } catch (e) {
                console.error('[TunnelVision] Summarize failed:', e);
                return `Failed to save summary: ${e.message}`;
            }
        },
        formatMessage: async () => 'Summarizing scene for long-term memory...',
        shouldRegister: async () => {
            const settings = getSettings();
            if (settings.globalEnabled === false) return false;
            return getActiveTunnelVisionBooks().length > 0;
        },
        stealth: false,
    };
}
