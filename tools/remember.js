/**
 * TunnelVision_Remember Tool
 * Allows the model to create new lorebook entries mid-generation.
 * The entry is saved to the lorebook and automatically assigned to a tree node.
 *
 * When the AI provides raw content, it is run through the canonical fact extraction
 * prompt (shared with post-turn processor and /tv-remember command) so that all
 * fact creation paths produce consistently structured, normalized entries.
 *
 * Duplicate detection uses trigram similarity — fast character n-gram overlap
 * that catches morphological variants and near-duplicates without needing vectors.
 * The warning is non-blocking: the entry is always saved regardless of duplicates found.
 */

import { getSettings } from '../tree-store.js';
import { createEntry, getCachedWorldInfo, parseJsonFromLLM, KEYWORD_RULES, FACT_EXTRACTION_PROMPT } from '../entry-manager.js';
import { getActiveTunnelVisionBooks, resolveTargetBook, getBookListWithDescriptions } from '../tool-registry.js';
import { trigramSimilarity, callWithRetry, generateAnalytical, getStoryContext } from '../agent-utils.js';
import { collectActiveEntryTitles } from '../shared-utils.js';

export const TOOL_NAME = 'TunnelVision_Remember';

// ─── Dedup ──────────────────────────────────────────────────────

/**
 * Find similar entries in a lorebook using trigram similarity.
 * @param {string} bookName
 * @param {string} newContent
 * @param {string} newTitle
 * @param {number} threshold - 0-1 similarity threshold
 * @returns {Promise<Array<{uid: number, comment: string, similarity: number}>>}
 */
async function findSimilarEntries(bookName, newContent, newTitle, threshold) {
    const bookData = await getCachedWorldInfo(bookName);
    if (!bookData?.entries) return [];

    const newText = `${newTitle} ${newContent}`;
    const matches = [];

    for (const key of Object.keys(bookData.entries)) {
        const entry = bookData.entries[key];
        if (entry.disable) continue;

        const existingText = `${entry.comment || ''} ${entry.content || ''}`;
        const sim = trigramSimilarity(newText, existingText);

        if (sim >= threshold) {
            matches.push({
                uid: entry.uid,
                comment: entry.comment || `Entry #${entry.uid}`,
                similarity: Math.round(sim * 100),
            });
        }
    }

    matches.sort((a, b) => b.similarity - a.similarity);
    return matches.slice(0, 3);
}

// ─── Canonical Fact Extraction ───────────────────────────────────

/**
 * Run the AI's raw input through the canonical fact extraction prompt.
 * Returns an array of structured fact objects: [{ title, content, when, keys }]
 * Returns null on parse failure (caller should fall back to storing raw input).
 *
 * @param {string} rawInput - The content the AI wants to remember
 * @param {string} lorebook - Target lorebook name (used to build existing-facts dedup list)
 * @returns {Promise<Array<{title: string, content: string, when: string, keys: string[]}>|null>}
 */
async function extractFactsFromInput(rawInput, lorebook) {
    // Build a small list of existing entry titles for dedup context
    let existingFactsSection = '';
    try {
        const bookData = await getCachedWorldInfo(lorebook);
        if (bookData?.entries) {
            const titles = collectActiveEntryTitles(bookData.entries)
                .slice(0, 30);
            if (titles.length > 0) {
                existingFactsSection = '[Already Known Facts — do NOT re-extract these]\n' + titles.map(t => `- ${t}`).join('\n') + '\n';
            }
        }
    } catch { /* proceed without dedup context */ }

    const prompt = FACT_EXTRACTION_PROMPT
        .replace('{existingFactsSection}', existingFactsSection)
        .replace('{temporalContext}', '')
        .replace('{inputSection}', `[Information to store]\n${rawInput}`);

    try {
        const storyCtx = getStoryContext();
        const response = await callWithRetry(
            () => generateAnalytical({ prompt: storyCtx + prompt }),
            { label: 'Remember extraction' },
        );
        const parsed = parseJsonFromLLM(response, { type: 'array' });
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (e) {
        console.warn('[TunnelVision] Remember: fact extraction LLM call failed:', e);
    }
    return null;
}

// ─── Tool Definition ────────────────────────────────────────────

/**
 * Returns the tool definition for ToolManager.registerFunctionTool().
 * @returns {Object}
 */
export function getDefinition() {
    const bookDesc = getBookListWithDescriptions();

    return {
        name: TOOL_NAME,
        displayName: 'TunnelVision Remember',
        description: `Save new information to long-term memory. Use this when important new facts, events, character developments, relationship changes, or world details emerge in the conversation that should be remembered for future scenes.

Available lorebooks:
${bookDesc}

Provide the content to remember and a descriptive title. Optionally include keywords for cross-referencing and a tree node_id to file it under (omit to auto-classify).`,
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                lorebook: {
                    type: 'string',
                    description: `Which lorebook to save to. Choose based on content type:\n${bookDesc}`,
                },
                title: {
                    type: 'string',
                    description: 'A short, descriptive title for this memory (e.g. "Elena learned about the curse", "Tavern layout").',
                },
                content: {
                    type: 'string',
                    description: 'The information to store. Write in third person, factual style. Include relevant names, places, and details.',
                },
                keys: {
                    type: 'array',
                    items: { type: 'string' },
                    description: KEYWORD_RULES,
                },
                node_id: {
                    type: 'string',
                    description: 'Optional tree node ID to file this entry under. Omit to auto-classify.',
                },
            },
            required: ['lorebook', 'title', 'content'],
        },
        action: async (args) => {
            if (!args?.title || !args?.content) {
                return 'Missing required fields: title and content are required.';
            }

            const { book: lorebook, error } = resolveTargetBook(args.lorebook);
            if (error) return error;

            const settings = getSettings();

            // ── Run through canonical fact extraction prompt ──
            const facts = await extractFactsFromInput(
                `${args.title}\n${args.content}`,
                lorebook,
            );

            if (!facts || facts.length === 0) {
                // Extraction returned nothing — fall back to storing exactly what the AI provided
                console.warn('[TunnelVision] Remember: extraction returned no facts, storing raw input as-is');
                try {
                    const result = await createEntry(lorebook, {
                        content: args.content,
                        comment: args.title,
                        keys: args.keys || [],
                        nodeId: args.node_id || null,
                    });
                    return `Saved memory: "${result.comment}" (UID ${result.uid}) → "${result.nodeLabel}" in "${lorebook}".`;
                } catch (e) {
                    console.error('[TunnelVision] Remember failed:', e);
                    return `Failed to save memory: ${e.message}`;
                }
            }

            // Store each extracted fact
            const created = [];
            const dedupWarnings = [];
            const dedupThreshold = settings.vectorDedupThreshold || 0.85;

            for (const fact of facts) {
                if (!fact?.title || !fact?.content) continue;

                // Dedup check (non-blocking — warns but still saves)
                if (settings.enableVectorDedup) {
                    const matches = await findSimilarEntries(lorebook, fact.content, fact.title, dedupThreshold);
                    if (matches.length > 0) {
                        const lines = matches.map(m => `  - "${m.comment}" (UID ${m.uid}, ${m.similarity}% match)`);
                        dedupWarnings.push(`\n⚠ "${fact.title}" may duplicate:\n${lines.join('\n')}`);
                        console.log(`[TunnelVision] Dedup: ${matches.length} similar entries for "${fact.title}"`);
                    }
                }

                try {
                    let factContent = String(fact.content).trim();
                    const when = fact.when ? String(fact.when).trim() : '';
                    if (when && when.toLowerCase() !== 'unknown') {
                        factContent = `[${when}] ${factContent}`;
                    }

                    const result = await createEntry(lorebook, {
                        content: factContent,
                        comment: String(fact.title).trim(),
                        keys: Array.isArray(fact.keys)
                            ? fact.keys.map(k => String(k).trim()).filter(Boolean)
                            : (args.keys || []),
                        nodeId: args.node_id || null,
                    });
                    created.push(result);
                } catch (e) {
                    console.error(`[TunnelVision] Remember: failed to create fact "${fact.title}":`, e);
                }
            }

            if (created.length === 0) {
                return 'No facts were saved. The content may have been filtered as non-significant, or an error occurred.';
            }

            const summary = created.length === 1
                ? `Saved memory: "${created[0].comment}" (UID ${created[0].uid}) → "${created[0].nodeLabel}" in "${lorebook}".`
                : `Saved ${created.length} memory entries to "${lorebook}": ${created.map(r => `"${r.comment}" (UID ${r.uid})`).join(', ')}.`;

            return summary + dedupWarnings.join('');
        },
        formatMessage: async () => 'Saving to long-term memory...',
        shouldRegister: async () => {
            const settings = getSettings();
            if (settings.globalEnabled === false) return false;
            return getActiveTunnelVisionBooks().length > 0;
        },
        stealth: false,
    };
}
