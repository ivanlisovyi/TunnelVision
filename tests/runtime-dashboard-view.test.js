/* @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = {
    audits: [],
    events: [],
    clearResult: true,
    context: {
        chatMetadata: {},
        saveMetadataDebounced: vi.fn(),
    },
};

vi.mock('../../../st-context.js', () => ({
    getContext: vi.fn(() => mockState.context),
}));

vi.mock('../runtime-diagnostics.js', () => ({
    collectRuntimeAudits: vi.fn(async () => mockState.audits),
    runRuntimeAuditDiagnosticsDetailed: vi.fn(async () => [
        { status: 'pass', message: 'ok' },
    ]),
}));

vi.mock('../runtime-health.js', () => ({
    countRuntimeFindingsBySeverity: vi.fn((findings = []) => {
        const counts = { info: 0, warn: 0, error: 0 };
        for (const finding of findings) {
            const severity = finding?.severity || 'info';
            counts[severity] += 1;
        }
        return counts;
    }),
}));

vi.mock('../runtime-events-log.js', () => ({
    getRuntimeEvents: vi.fn(() => mockState.events),
    clearRuntimeEvents: vi.fn(() => mockState.clearResult),
}));

vi.mock('../shared-utils.js', () => ({
    formatShortDateTime: vi.fn(() => 'formatted-time'),
}));

import { buildRuntimeDashboard } from '../runtime-dashboard-view.js';
import { clearRuntimeEvents } from '../runtime-events-log.js';
import { runRuntimeAuditDiagnosticsDetailed } from '../runtime-diagnostics.js';

async function flushMicrotasks(times = 3) {
    for (let index = 0; index < times; index++) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
    }
}

describe('runtime-dashboard-view', () => {
    beforeEach(() => {
        mockState.context.chatMetadata = {};
        mockState.context.saveMetadataDebounced.mockClear();
        mockState.audits = [
            {
                group: 'orchestration-integrity',
                summary: 'Orchestration audit found coordination issues.',
                findings: [
                    { severity: 'warn', reasonCode: 'lost_invalidation_reason' },
                ],
                reasonCodes: ['lost_invalidation_reason'],
            },
        ];
        mockState.events = [
            {
                severity: 'error',
                category: 'world-state',
                title: 'World state update failed',
                summary: 'network timeout',
                timestamp: Date.now(),
                details: ['Task ID: 7'],
                correlationId: 'bg-task-7',
            },
            {
                severity: 'info',
                category: 'runtime-audit',
                title: 'Runtime diagnostics',
                summary: '0 fail, 0 warn, 7 pass',
                timestamp: Date.now(),
                details: [],
            },
        ];
        mockState.clearResult = true;
        globalThis.toastr = {
            info: vi.fn(),
            error: vi.fn(),
            warning: vi.fn(),
        };
        vi.clearAllMocks();
    });

    it('renders runtime overview, action buttons, and recent runtime events', async () => {
        const dashboard = await buildRuntimeDashboard();

        expect(dashboard.textContent).toContain('Runtime Actions');
        expect(dashboard.textContent).toContain('Runtime Overview');
        expect(dashboard.textContent).toContain('Recent Runtime Events');
        expect(dashboard.textContent).toContain('World state update failed');
        expect(dashboard.textContent).toContain('Correlation: bg-task-7');
    });

    it('runs runtime diagnostics from the action row and refreshes afterward', async () => {
        const onRefresh = vi.fn(async () => {});
        const dashboard = await buildRuntimeDashboard({ onRefresh });

        const runButton = Array.from(dashboard.querySelectorAll('button'))
            .find(button => button.textContent === 'Run Runtime Audit');

        runButton.click();
        await flushMicrotasks();

        expect(runRuntimeAuditDiagnosticsDetailed).toHaveBeenCalledWith({ repair: true });
        expect(onRefresh).toHaveBeenCalled();
        expect(globalThis.toastr.info).toHaveBeenCalled();
    });

    it('clears the runtime event log from the action row and refreshes afterward', async () => {
        const onRefresh = vi.fn(async () => {});
        const dashboard = await buildRuntimeDashboard({ onRefresh });

        const clearButton = Array.from(dashboard.querySelectorAll('button'))
            .find(button => button.textContent === 'Clear Event Log');

        clearButton.click();
        await flushMicrotasks();

        expect(clearRuntimeEvents).toHaveBeenCalled();
        expect(onRefresh).toHaveBeenCalled();
        expect(globalThis.toastr.info).toHaveBeenCalledWith('Runtime event log cleared', 'TunnelVision');
    });

    it('filters runtime issues and events by severity and category', async () => {
        const dashboard = await buildRuntimeDashboard();
        const selects = Array.from(dashboard.querySelectorAll('select'));
        const severitySelect = selects[0];
        const categorySelect = selects[1];

        severitySelect.value = 'error';
        severitySelect.dispatchEvent(new Event('change'));
        await flushMicrotasks();
        expect(dashboard.textContent).toContain('World state update failed');
        expect(dashboard.textContent).not.toContain('Runtime diagnostics');

        severitySelect.value = 'all';
        severitySelect.dispatchEvent(new Event('change'));
        await flushMicrotasks();

        categorySelect.value = 'orchestration-integrity';
        categorySelect.dispatchEvent(new Event('change'));
        await flushMicrotasks();
        expect(dashboard.textContent).toContain('No runtime events match the current filters.');
        expect(dashboard.textContent).toContain('Orchestration audit found coordination issues.');
    });

    it('restores persisted filter state and saves changes back to chat metadata', async () => {
        mockState.context.chatMetadata.tunnelvision_runtime_dashboard = {
            filters: {
                severity: 'error',
                category: 'world-state',
            },
        };

        const dashboard = await buildRuntimeDashboard();
        const selects = Array.from(dashboard.querySelectorAll('select'));
        const severitySelect = selects[0];
        const categorySelect = selects[1];

        expect(severitySelect.value).toBe('error');
        expect(categorySelect.value).toBe('world-state');
        expect(dashboard.textContent).toContain('World state update failed');
        expect(dashboard.textContent).not.toContain('Runtime diagnostics');

        categorySelect.value = 'all';
        categorySelect.dispatchEvent(new Event('change'));
        await flushMicrotasks();

        expect(mockState.context.chatMetadata.tunnelvision_runtime_dashboard).toEqual(expect.objectContaining({
            filters: {
                severity: 'error',
                category: 'all',
            },
        }));
        expect(mockState.context.saveMetadataDebounced).toHaveBeenCalled();
    });
});