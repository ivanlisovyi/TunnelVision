import { collectRuntimeAudits, runRuntimeAuditDiagnosticsDetailed } from './runtime-diagnostics.js';
import { countRuntimeFindingsBySeverity } from './runtime-health.js';
import { getRuntimeEvents, clearRuntimeEvents } from './runtime-events-log.js';
import { formatShortDateTime } from './shared-utils.js';
import { getContext } from '../../../st-context.js';
import { el, addHealthStat, buildIssueSection } from './health-view-utils.js';

const RUNTIME_DASHBOARD_METADATA_KEY = 'tunnelvision_runtime_dashboard';
const VALID_SEVERITIES = new Set(['all', 'error', 'warn', 'info']);

function normalizeRuntimeFilters(filters = {}, categoryOptions = ['all']) {
    const severity = VALID_SEVERITIES.has(filters?.severity) ? filters.severity : 'all';
    const requestedCategory = typeof filters?.category === 'string' && filters.category.trim().length > 0
        ? filters.category.trim()
        : 'all';
    const category = categoryOptions.includes(requestedCategory) ? requestedCategory : 'all';
    return { severity, category };
}

function loadRuntimeDashboardFilters(categoryOptions) {
    try {
        const context = getContext();
        const stored = context?.chatMetadata?.[RUNTIME_DASHBOARD_METADATA_KEY];
        return normalizeRuntimeFilters(stored?.filters || stored, categoryOptions);
    } catch {
        return normalizeRuntimeFilters({}, categoryOptions);
    }
}

function persistRuntimeDashboardFilters(filters) {
    try {
        const context = getContext();
        if (!context?.chatMetadata) return;
        const existing = context.chatMetadata[RUNTIME_DASHBOARD_METADATA_KEY] || {};
        context.chatMetadata[RUNTIME_DASHBOARD_METADATA_KEY] = {
            ...existing,
            filters: { ...filters },
            updatedAt: Date.now(),
        };
        context.saveMetadataDebounced?.();
    } catch {
        // Metadata persistence is optional for this view.
    }
}

function buildRuntimeOverviewSection(runtimeAudits, runtimeEvents) {
    const section = el('div', 'tv-health-section');
    section.appendChild(el('div', 'tv-health-section-title', 'Runtime Overview'));

    const counts = runtimeAudits.reduce((acc, audit) => {
        const severityCounts = countRuntimeFindingsBySeverity(audit?.findings || []);
        acc.errors += severityCounts.error;
        acc.warns += severityCounts.warn;
        acc.info += severityCounts.info;
        return acc;
    }, { errors: 0, warns: 0, info: 0 });

    const grid = el('div', 'tv-health-type-grid');
    addHealthStat(grid, 'Audit Groups', runtimeAudits.length, '#74b9ff');
    addHealthStat(grid, 'Errors', counts.errors, counts.errors > 0 ? '#ef4444' : '#4ade80');
    addHealthStat(grid, 'Warnings', counts.warns, counts.warns > 0 ? '#fdcb6e' : '#4ade80');
    addHealthStat(grid, 'Event Log', runtimeEvents.length, '#a29bfe');
    section.appendChild(grid);

    const latestEvent = runtimeEvents[0] || null;
    const summary = el('div', 'tv-health-avg');
    summary.textContent = latestEvent
        ? `Latest runtime event: ${latestEvent.title} at ${formatShortDateTime(latestEvent.timestamp)}`
        : 'No runtime events recorded for this chat yet.';
    section.appendChild(summary);

    return section;
}

function buildRuntimeIssues(runtimeAudits) {
    return runtimeAudits
        .filter(audit => Array.isArray(audit?.findings) && audit.findings.some(finding => finding?.severity === 'error' || finding?.severity === 'warn'))
        .map(audit => {
            const severityCounts = countRuntimeFindingsBySeverity(audit.findings || []);
            const topSeverity = severityCounts.error > 0 ? 'error' : 'warn';
            const reasons = Array.isArray(audit.reasonCodes) && audit.reasonCodes.length > 0
                ? audit.reasonCodes.join(', ')
                : 'No explicit reason codes';
            return {
                category: audit.group || 'runtime-integrity',
                severity: topSeverity,
                title: audit.summary || audit.group || 'Runtime audit issue',
                icon: topSeverity === 'error' ? 'fa-triangle-exclamation' : 'fa-circle-exclamation',
                color: topSeverity === 'error' ? '#ef4444' : '#fdcb6e',
                desc: `Group: ${audit.group || 'runtime-integrity'}. Reasons: ${reasons}.`,
                items: (audit.findings || [])
                    .filter(finding => finding?.severity === 'error' || finding?.severity === 'warn')
                    .map((finding, index) => ({
                        uid: index + 1,
                        title: `${finding.severity.toUpperCase()}: ${finding.reasonCode || 'unspecified'}`,
                    })),
            };
        });
}

function buildRuntimeEventsSection(runtimeEvents) {
    const section = el('div', 'tv-health-section');
    section.appendChild(el('div', 'tv-health-section-title', 'Recent Runtime Events'));

    if (!runtimeEvents.length) {
        section.appendChild(el('div', 'tv-health-avg', 'No runtime events match the current filters.'));
        return section;
    }

    const list = el('div', 'tv-runtime-events-list');
    for (const event of runtimeEvents.slice(0, 8)) {
        const item = el('div', 'tv-runtime-event');
        const header = el('div', 'tv-runtime-event-header');
        const badge = el('span', `tv-runtime-event-badge tv-runtime-event-${event.severity}`, event.severity.toUpperCase());
        const title = el('span', 'tv-runtime-event-title', event.title);
        const time = el('span', 'tv-runtime-event-time', formatShortDateTime(event.timestamp));
        header.appendChild(badge);
        header.appendChild(title);
        header.appendChild(time);
        item.appendChild(header);

        if (event.summary) {
            item.appendChild(el('div', 'tv-runtime-event-summary', event.summary));
        }

        const details = [...(Array.isArray(event.details) ? event.details.slice(0, 3) : [])];
        if (event.correlationId) {
            details.push(`Correlation: ${event.correlationId}`);
        }

        if (details.length > 0) {
            const detailList = el('div', 'tv-runtime-event-details');
            for (const detail of details) {
                detailList.appendChild(el('span', 'tv-runtime-event-detail', detail));
            }
            item.appendChild(detailList);
        }

        list.appendChild(item);
    }

    section.appendChild(list);
    return section;
}

function buildRuntimeIssuesSection(runtimeIssues) {
    const section = el('div', 'tv-health-section');
    section.appendChild(el('div', 'tv-health-section-title', 'Runtime Audit Findings'));

    if (!runtimeIssues.length) {
        section.appendChild(el('div', 'tv-health-avg', 'No runtime audit findings match the current filters.'));
        return section;
    }

    for (const issue of runtimeIssues) {
        section.appendChild(buildIssueSection(issue));
    }

    return section;
}

function collectCategoryOptions(runtimeAudits, runtimeEvents) {
    const categories = new Set(['all']);
    for (const audit of runtimeAudits) {
        if (audit?.group) categories.add(audit.group);
    }
    for (const event of runtimeEvents) {
        if (event?.category) categories.add(event.category);
    }
    return [...categories];
}

function buildSelectField({ label, value, options, onChange }) {
    const wrapper = el('label', 'tv-runtime-filter');
    wrapper.appendChild(el('span', 'tv-runtime-filter-label', label));

    const select = document.createElement('select');
    select.className = 'tv-runtime-filter-select';
    for (const optionValue of options) {
        const option = document.createElement('option');
        option.value = optionValue;
        option.textContent = optionValue === 'all' ? 'All' : optionValue;
        option.selected = optionValue === value;
        select.appendChild(option);
    }
    select.addEventListener('change', event => onChange(event.target.value));
    wrapper.appendChild(select);
    return wrapper;
}

function buildFilterSection({ runtimeAudits, runtimeEvents, filters, onChange, categoryOptions }) {
    const section = el('div', 'tv-health-section');
    section.appendChild(el('div', 'tv-health-section-title', 'Runtime Filters'));

    const row = el('div', 'tv-runtime-filters');
    row.appendChild(buildSelectField({
        label: 'Severity',
        value: filters.severity,
        options: ['all', 'error', 'warn', 'info'],
        onChange: value => onChange({ ...filters, severity: value }),
    }));
    row.appendChild(buildSelectField({
        label: 'Category',
        value: filters.category,
        options: categoryOptions || collectCategoryOptions(runtimeAudits, runtimeEvents),
        onChange: value => onChange({ ...filters, category: value }),
    }));
    section.appendChild(row);

    return section;
}

function filterRuntimeEvents(runtimeEvents, filters) {
    return runtimeEvents.filter(event => {
        if (filters.severity !== 'all' && event?.severity !== filters.severity) return false;
        if (filters.category !== 'all' && event?.category !== filters.category) return false;
        return true;
    });
}

function filterRuntimeIssues(runtimeIssues, filters) {
    return runtimeIssues.filter(issue => {
        if (filters.severity !== 'all' && issue?.severity !== filters.severity) return false;
        if (filters.category !== 'all' && issue?.category !== filters.category) return false;
        return true;
    });
}

function buildActionSection({ runtimeEvents, onRefresh }) {
    const section = el('div', 'tv-health-section');
    section.appendChild(el('div', 'tv-health-section-title', 'Runtime Actions'));

    const row = el('div', 'tv-runtime-actions');
    const runAuditBtn = el('button', 'tv-float-panel-btn', 'Run Runtime Audit');
    runAuditBtn.addEventListener('click', async () => {
        const originalText = runAuditBtn.textContent;
        runAuditBtn.disabled = true;
        runAuditBtn.textContent = 'Running...';
        try {
            const results = await runRuntimeAuditDiagnosticsDetailed({ repair: true });
            const failCount = results.filter(result => result?.status === 'fail').length;
            const warnCount = results.filter(result => result?.status === 'warn').length;
            toastr.info(`Runtime audit complete: ${failCount} fail, ${warnCount} warn`, 'TunnelVision');
        } catch (error) {
            toastr.error(`Runtime audit failed: ${error?.message || 'Unknown error'}`, 'TunnelVision');
        } finally {
            runAuditBtn.disabled = false;
            runAuditBtn.textContent = originalText;
            await onRefresh?.();
        }
    });
    row.appendChild(runAuditBtn);

    const clearBtn = el('button', 'tv-float-panel-btn', 'Clear Event Log');
    clearBtn.disabled = runtimeEvents.length === 0;
    clearBtn.addEventListener('click', async () => {
        const cleared = clearRuntimeEvents();
        if (cleared) {
            toastr.info('Runtime event log cleared', 'TunnelVision');
        } else {
            toastr.warning('Could not clear runtime event log', 'TunnelVision');
        }
        await onRefresh?.();
    });
    row.appendChild(clearBtn);

    section.appendChild(row);
    return section;
}

export async function buildRuntimeDashboard({ onRefresh = null } = {}) {
    const runtimeAudits = await collectRuntimeAudits();
    const runtimeEvents = getRuntimeEvents({ limit: 12, newestFirst: true });
    const runtimeIssues = buildRuntimeIssues(runtimeAudits);
    const categoryOptions = collectCategoryOptions(runtimeAudits, runtimeEvents);
    const filters = loadRuntimeDashboardFilters(categoryOptions);

    const container = el('div', 'tv-runtime-dashboard');
    const issuesHost = el('div', 'tv-runtime-issues-host');
    const eventsHost = el('div', 'tv-runtime-events-host');

    const renderFilteredSections = () => {
        issuesHost.replaceChildren(buildRuntimeIssuesSection(filterRuntimeIssues(runtimeIssues, filters)));
        eventsHost.replaceChildren(buildRuntimeEventsSection(filterRuntimeEvents(runtimeEvents, filters)));
    };

    container.appendChild(buildActionSection({ runtimeEvents, onRefresh }));
    container.appendChild(buildFilterSection({
        runtimeAudits,
        runtimeEvents,
        filters,
        categoryOptions,
        onChange: nextFilters => {
            const normalized = normalizeRuntimeFilters(nextFilters, categoryOptions);
            filters.severity = normalized.severity;
            filters.category = normalized.category;
            persistRuntimeDashboardFilters(filters);
            renderFilteredSections();
        },
    }));
    container.appendChild(buildRuntimeOverviewSection(runtimeAudits, runtimeEvents));
    container.appendChild(issuesHost);
    container.appendChild(eventsHost);

    renderFilteredSections();
    return container;
}