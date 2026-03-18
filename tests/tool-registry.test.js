import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
    settings: {
        disabledTools: {},
        confirmTools: {},
        toolPromptOverrides: {},
    },
    selectedWorldInfo: [],
    worldInfo: { charLore: [] },
    loadedWorldInfo: new Map(),
    characters: [{ data: { extensions: {} } }],
    chatMetadata: {},
    enabledBooks: new Set(),
    trackerUids: new Map(),
    treeOverview: '',
    toolManager: {
        tools: [],
        registerCalls: [],
        unregisterCalls: [],
        recurseLimit: 5,
        supported: true,
    },
}));

function makeToolDefinition(name, displayName) {
    return {
        name,
        displayName,
        description: `${displayName} description`,
        parameters: { type: 'object', properties: {} },
        action: async () => `${name}:ok`,
        shouldRegister: async () => true,
    };
}

vi.mock('../../../tool-calling.js', () => {
    class ToolManager {}

    Object.defineProperty(ToolManager, 'tools', {
        get() {
            return mockState.toolManager.tools;
        },
        set(value) {
            mockState.toolManager.tools = value;
        },
    });

    Object.defineProperty(ToolManager, 'RECURSE_LIMIT', {
        get() {
            return mockState.toolManager.recurseLimit;
        },
        set(value) {
            mockState.toolManager.recurseLimit = value;
        },
    });

    ToolManager.registerFunctionTool = vi.fn((definition) => {
        mockState.toolManager.registerCalls.push(definition.name);
        const tool = {
            ...definition,
            toFunctionOpenAI: () => ({ function: { name: definition.name } }),
            shouldRegister: definition.shouldRegister || (async () => true),
        };
        mockState.toolManager.tools = mockState.toolManager.tools.filter((existingTool) => existingTool.toFunctionOpenAI().function.name !== definition.name);
        mockState.toolManager.tools.push(tool);
    });

    ToolManager.unregisterFunctionTool = vi.fn((name) => {
        mockState.toolManager.unregisterCalls.push(name);
        mockState.toolManager.tools = mockState.toolManager.tools.filter((tool) => tool.toFunctionOpenAI().function.name !== name);
    });

    ToolManager.isToolCallingSupported = vi.fn(() => mockState.toolManager.supported);

    return { ToolManager };
});

vi.mock('../../../world-info.js', () => ({
    loadWorldInfo: vi.fn(async (bookName) => mockState.loadedWorldInfo.get(bookName) || { entries: {} }),
    selected_world_info: mockState.selectedWorldInfo,
    world_info: mockState.worldInfo,
    METADATA_KEY: 'world_info',
}));

vi.mock('../../../../script.js', () => ({
    characters: mockState.characters,
    this_chid: 0,
    chat_metadata: mockState.chatMetadata,
}));

vi.mock('../tree-store.js', () => ({
    isLorebookEnabled: vi.fn((bookName) => mockState.enabledBooks.has(bookName)),
    getSettings: vi.fn(() => mockState.settings),
    getTree: vi.fn(() => null),
    getBookDescription: vi.fn(() => ''),
    syncTrackerUidsForLorebook: vi.fn(async (bookName) => mockState.trackerUids.get(bookName) || []),
}));

vi.mock('../entry-manager.js', () => ({
    escapeHtml: vi.fn((value) => String(value ?? '')),
}));

vi.mock('../tools/search.js', () => ({
    TOOL_NAME: 'tv_search',
    getTreeOverview: vi.fn(() => mockState.treeOverview),
    getDefinition: vi.fn(() => makeToolDefinition('tv_search', 'Search')),
}));

vi.mock('../tools/remember.js', () => ({
    TOOL_NAME: 'tv_remember',
    getDefinition: vi.fn(() => makeToolDefinition('tv_remember', 'Remember')),
}));

vi.mock('../tools/update.js', () => ({
    TOOL_NAME: 'tv_update',
    getDefinition: vi.fn(() => makeToolDefinition('tv_update', 'Update')),
}));

vi.mock('../tools/forget.js', () => ({
    TOOL_NAME: 'tv_forget',
    getDefinition: vi.fn(() => makeToolDefinition('tv_forget', 'Forget')),
}));

vi.mock('../tools/reorganize.js', () => ({
    TOOL_NAME: 'tv_reorganize',
    getDefinition: vi.fn(() => makeToolDefinition('tv_reorganize', 'Reorganize')),
}));

vi.mock('../tools/summarize.js', () => ({
    TOOL_NAME: 'tv_summarize',
    getDefinition: vi.fn(() => makeToolDefinition('tv_summarize', 'Summarize')),
}));

vi.mock('../tools/merge-split.js', () => ({
    TOOL_NAME: 'tv_merge_split',
    getDefinition: vi.fn(() => makeToolDefinition('tv_merge_split', 'Merge Split')),
}));

vi.mock('../tools/notebook.js', () => ({
    TOOL_NAME: 'tv_notebook',
    getDefinition: vi.fn(() => makeToolDefinition('tv_notebook', 'Notebook')),
}));

function resetMockState() {
    mockState.settings = {
        disabledTools: {},
        confirmTools: {},
        toolPromptOverrides: {},
    };
    mockState.selectedWorldInfo.splice(0, mockState.selectedWorldInfo.length);
    mockState.worldInfo.charLore = [];
    mockState.loadedWorldInfo.clear();
    mockState.characters.splice(0, mockState.characters.length, { data: { extensions: {} } });
    for (const key of Object.keys(mockState.chatMetadata)) {
        delete mockState.chatMetadata[key];
    }
    mockState.enabledBooks.clear();
    mockState.trackerUids.clear();
    mockState.treeOverview = '';
    mockState.toolManager.tools = [];
    mockState.toolManager.registerCalls = [];
    mockState.toolManager.unregisterCalls = [];
    mockState.toolManager.recurseLimit = 5;
    mockState.toolManager.supported = true;
}

async function loadRegistryModule() {
    vi.resetModules();
    return await import('../tool-registry.js');
}

describe('tool-registry runtime', () => {
    beforeEach(() => {
        resetMockState();
        vi.clearAllMocks();
    });

    it('registers expected tools and exposes registration epochs in the runtime snapshot', async () => {
        mockState.selectedWorldInfo.push('Book A');
        mockState.enabledBooks.add('Book A');

        const registry = await loadRegistryModule();
        await registry.registerTools();

        const snapshot = await registry.getToolRegistrationRuntimeSnapshot();

        expect(snapshot.activeBooks).toEqual(['Book A']);
        expect(snapshot.expectedToolNames.slice().sort()).toEqual(registry.ALL_TOOL_NAMES.slice().sort());
        expect(snapshot.registeredToolNames.slice().sort()).toEqual(registry.ALL_TOOL_NAMES.slice().sort());
        expect(snapshot.missingToolNames).toEqual([]);
        expect(snapshot.lastAppliedRegistrationSignature).toBeTruthy();
        expect(snapshot.lastComputedRegistrationSignature).toBe(snapshot.lastAppliedRegistrationSignature);
        expect(snapshot.registrationEpoch).toBe(snapshot.lastAppliedRegistrationEpoch);
        expect(snapshot.lastAppliedRegistrationEpoch).toBeGreaterThan(snapshot.lastComputedRegistrationEpoch);
    });

    it('skips unregister and re-register when the computed registration signature is unchanged', async () => {
        mockState.selectedWorldInfo.push('Book A');
        mockState.enabledBooks.add('Book A');

        const registry = await loadRegistryModule();
        await registry.registerTools();

        const firstRegisterCount = mockState.toolManager.registerCalls.length;
        const firstUnregisterCount = mockState.toolManager.unregisterCalls.length;

        await registry.registerTools();

        const snapshot = await registry.getToolRegistrationRuntimeSnapshot();

        expect(mockState.toolManager.registerCalls).toHaveLength(firstRegisterCount);
        expect(mockState.toolManager.unregisterCalls).toHaveLength(firstUnregisterCount);
        expect(snapshot.lastAppliedRegistrationSignature).toBe(snapshot.lastComputedRegistrationSignature);
        expect(snapshot.lastAppliedRegistrationEpoch).toBe(snapshot.lastComputedRegistrationEpoch);
        expect(snapshot.missingToolNames).toEqual([]);
    });

    it('reports missing tool registrations as runtime audit errors', async () => {
        mockState.selectedWorldInfo.push('Book A');
        mockState.enabledBooks.add('Book A');

        const registry = await loadRegistryModule();
        const audit = await registry.auditToolRegistrationRuntime({ repair: false });

        expect(audit.ok).toBe(false);
        expect(audit.summary).toContain('runtime issue');
        expect(audit.findings).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'registration-missing-tools',
                severity: 'error',
                reasonCode: 'missing_registration',
            }),
        ]));
        expect(audit.safeRepairs).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'rebuild-tool-registration' }),
        ]));
    });

    it('reports idle registration state when no TunnelVision lorebooks are active', async () => {
        const registry = await loadRegistryModule();
        const audit = await registry.auditToolRegistrationRuntime({ repair: false });

        expect(audit.ok).toBe(true);
        expect(audit.summary).toContain('idle');
        expect(audit.findings).toEqual([
            expect.objectContaining({
                id: 'registration-idle',
                severity: 'info',
            }),
        ]);
    });
});