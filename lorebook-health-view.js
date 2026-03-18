import { truncate } from './feed-helpers.js';
import { buildHealthReport } from './entry-scoring.js';
import { getCachedWorldInfo } from './entry-manager.js';
import { el, icon, addHealthStat, buildIssueSection } from './health-view-utils.js';

async function buildMergedHealthReport(activeBooks) {
    const mergedReport = {
        totalEntries: 0,
        facts: 0,
        summaries: 0,
        trackers: 0,
        disabled: 0,
        categoryDistribution: [],
        staleEntries: [],
        orphanedEntries: [],
        noTimestamp: [],
        avgLength: 0,
        outlierEntries: [],
        duplicateCandidates: [],
        growthRate: 0,
        duplicateDensity: 0,
        compressionRatio: 1.0,
        neverReferencedCount: 0,
        metadataSizes: [],
    };
    let totalLength = 0;
    let totalDupUids = 0;
    let totalForDensity = 0;
    let compressionSum = 0;
    let compressionCount = 0;

    for (const bookName of activeBooks) {
        try {
            const bookData = await getCachedWorldInfo(bookName);
            if (!bookData?.entries) continue;
            const report = buildHealthReport(bookName, bookData);
            mergedReport.totalEntries += report.totalEntries;
            mergedReport.facts += report.facts;
            mergedReport.summaries += report.summaries;
            mergedReport.trackers += report.trackers;
            mergedReport.disabled += report.disabled;
            mergedReport.categoryDistribution.push(...report.categoryDistribution);
            mergedReport.staleEntries.push(...report.staleEntries);
            mergedReport.orphanedEntries.push(...report.orphanedEntries);
            mergedReport.noTimestamp.push(...report.noTimestamp);
            mergedReport.outlierEntries.push(...report.outlierEntries);
            mergedReport.duplicateCandidates.push(...report.duplicateCandidates);
            totalLength += report.avgLength * report.totalEntries;
            mergedReport.neverReferencedCount += report.neverReferencedCount || 0;

            if (report.growthRate > mergedReport.growthRate) mergedReport.growthRate = report.growthRate;
            if (report.duplicateDensity > 0) {
                totalDupUids += report.duplicateDensity * report.totalEntries;
                totalForDensity += report.totalEntries;
            }
            if (report.compressionRatio !== 1.0) {
                compressionSum += report.compressionRatio;
                compressionCount += 1;
            }
            if (report.metadataSizes?.length > 0 && mergedReport.metadataSizes.length === 0) {
                mergedReport.metadataSizes = report.metadataSizes;
            }
        } catch {
            // Skip unavailable lorebooks.
        }
    }

    mergedReport.avgLength = mergedReport.totalEntries > 0 ? Math.round(totalLength / mergedReport.totalEntries) : 0;
    mergedReport.categoryDistribution.sort((a, b) => b.count - a.count);
    mergedReport.duplicateCandidates.sort((a, b) => b.similarity - a.similarity);
    mergedReport.outlierEntries.sort((a, b) => b.length - a.length);
    if (totalForDensity > 0) mergedReport.duplicateDensity = Math.round((totalDupUids / totalForDensity) * 100) / 100;
    if (compressionCount > 0) mergedReport.compressionRatio = Math.round((compressionSum / compressionCount) * 100) / 100;

    return mergedReport;
}

function buildEmptyLorebookSection() {
    const section = el('div', 'tv-health-section');
    section.appendChild(el('div', 'tv-health-section-title', 'Lorebook Health'));
    const emptyEl = el('div', 'tv-float-empty');
    emptyEl.style.cssText = 'min-height: 160px;';
    emptyEl.appendChild(icon('fa-book-open'));
    emptyEl.appendChild(el('span', null, 'No active lorebooks'));
    emptyEl.appendChild(el('span', 'tv-float-empty-sub', 'Enable a lorebook in TunnelVision settings to see lorebook-specific health metrics'));
    section.appendChild(emptyEl);
    return section;
}

export async function buildLorebookHealthDashboard({ activeBooks = [] } = {}) {
    const container = el('div', 'tv-lorebook-health-dashboard');
    if (!Array.isArray(activeBooks) || activeBooks.length === 0) {
        container.appendChild(buildEmptyLorebookSection());
        return container;
    }

    const mergedReport = await buildMergedHealthReport(activeBooks);

    const typeSection = el('div', 'tv-health-section');
    typeSection.appendChild(el('div', 'tv-health-section-title', 'Lorebook Entry Breakdown'));
    const typeGrid = el('div', 'tv-health-type-grid');
    addHealthStat(typeGrid, 'Total', mergedReport.totalEntries, '#a29bfe');
    addHealthStat(typeGrid, 'Facts', mergedReport.facts, '#6c5ce7');
    addHealthStat(typeGrid, 'Summaries', mergedReport.summaries, '#fdcb6e');
    addHealthStat(typeGrid, 'Trackers', mergedReport.trackers, '#00b894');
    if (mergedReport.disabled > 0) addHealthStat(typeGrid, 'Disabled', mergedReport.disabled, '#636e72');
    typeSection.appendChild(typeGrid);
    typeSection.appendChild(el('div', 'tv-health-avg', `Average entry length: ${mergedReport.avgLength} chars`));
    container.appendChild(typeSection);

    const scaleSection = el('div', 'tv-health-section');
    scaleSection.appendChild(el('div', 'tv-health-section-title', 'Scalability Metrics'));
    const scaleGrid = el('div', 'tv-health-type-grid');
    addHealthStat(scaleGrid, 'Growth', `${mergedReport.growthRate}`, '#a29bfe');
    scaleGrid.lastElementChild.title = `${mergedReport.growthRate} entries per100 chat turns`;
    scaleGrid.lastElementChild.querySelector('.tv-health-stat-label').textContent = '/100 turns';

    const dupPctNum = mergedReport.duplicateDensity * 100;
    const dupPct = dupPctNum.toFixed(0);
    addHealthStat(scaleGrid, 'Dup Density', `${dupPct}%`, dupPctNum > 15 ? '#e17055' : dupPctNum > 5 ? '#fdcb6e' : '#00b894');
    scaleGrid.lastElementChild.title = `${dupPct}% of entries share >70% similarity with another entry`;

    const compRatio = mergedReport.compressionRatio;
    const compLabel = `${(compRatio * 100).toFixed(0)}%`;
    addHealthStat(scaleGrid, 'Compression', compLabel, compRatio < 0.8 ? '#00b894' : compRatio > 1.2 ? '#e17055' : '#fdcb6e');
    scaleGrid.lastElementChild.title = `Current avg length is ${compLabel} of original avg length`;

    addHealthStat(
        scaleGrid,
        'Never Ref\'d',
        String(mergedReport.neverReferencedCount),
        mergedReport.neverReferencedCount > 20 ? '#e17055' : mergedReport.neverReferencedCount > 5 ? '#fdcb6e' : '#636e72',
    );
    scaleGrid.lastElementChild.title = `${mergedReport.neverReferencedCount} entries have been injected but never referenced by the AI`;
    scaleSection.appendChild(scaleGrid);

    if (mergedReport.metadataSizes?.length > 0) {
        const metaRow = el('div', 'tv-health-meta-sizes');
        const metaLabel = el('div', 'tv-health-avg');
        const totalMeta = mergedReport.metadataSizes.reduce((sum, item) => sum + item.size, 0);
        metaLabel.textContent = `Metadata: ${(totalMeta / 1024).toFixed(1)} KB total`;
        metaRow.appendChild(metaLabel);

        const metaColors = ['#e84393', '#6c5ce7', '#00b894', '#fdcb6e', '#0984e3', '#e17055', '#a29bfe'];
        const metaBar = el('div', 'tv-budget-bar');
        metaBar.style.marginTop = '4px';
        for (let index = 0; index < mergedReport.metadataSizes.length; index++) {
            const item = mergedReport.metadataSizes[index];
            const pct = Math.max((item.size / totalMeta) * 100, 2);
            const seg = el('div', 'tv-budget-seg');
            seg.style.width = `${pct}%`;
            seg.style.background = metaColors[index % metaColors.length];
            seg.title = `${item.key}: ${(item.size / 1024).toFixed(1)} KB`;
            metaBar.appendChild(seg);
        }
        metaRow.appendChild(metaBar);

        const metaLegend = el('div', 'tv-budget-legend');
        metaLegend.style.marginTop = '2px';
        for (let index = 0; index < mergedReport.metadataSizes.length; index++) {
            const item = mergedReport.metadataSizes[index];
            const legendItem = el('span', 'tv-budget-legend-item');
            const dot = el('span', 'tv-budget-legend-dot');
            dot.style.background = metaColors[index % metaColors.length];
            legendItem.appendChild(dot);
            legendItem.appendChild(document.createTextNode(`${item.key} ${(item.size / 1024).toFixed(1)}K`));
            metaLegend.appendChild(legendItem);
        }
        metaRow.appendChild(metaLegend);
        scaleSection.appendChild(metaRow);
    }
    container.appendChild(scaleSection);

    if (mergedReport.categoryDistribution.length > 0) {
        const catSection = el('div', 'tv-health-section');
        catSection.appendChild(el('div', 'tv-health-section-title', 'Category Distribution'));
        const maxCount = mergedReport.categoryDistribution[0]?.count || 1;
        const catList = el('div', 'tv-health-cat-list');
        for (const cat of mergedReport.categoryDistribution.slice(0, 12)) {
            const catRow = el('div', 'tv-health-cat-row');
            catRow.appendChild(el('span', 'tv-health-cat-label', truncate(cat.label, 25)));
            const barWrap = el('div', 'tv-health-cat-bar-wrap');
            const bar = el('div', 'tv-health-cat-bar');
            bar.style.width = `${(cat.count / maxCount) * 100}%`;
            barWrap.appendChild(bar);
            catRow.appendChild(barWrap);
            catRow.appendChild(el('span', 'tv-health-cat-count', String(cat.count)));
            catList.appendChild(catRow);
        }
        if (mergedReport.categoryDistribution.length > 12) {
            catList.appendChild(el('div', 'tv-health-more', `+${mergedReport.categoryDistribution.length - 12} more categories`));
        }
        catSection.appendChild(catList);
        container.appendChild(catSection);
    }

    const issues = [];
    if (mergedReport.staleEntries.length > 0) {
        issues.push({
            title: `${mergedReport.staleEntries.length} Stale Entries`,
            icon: 'fa-ghost',
            color: '#e17055',
            desc: 'Injected 3+ times but never referenced by the AI',
            items: mergedReport.staleEntries.slice(0, 10),
        });
    }
    if (mergedReport.orphanedEntries.length > 0) {
        issues.push({
            title: `${mergedReport.orphanedEntries.length} Orphaned Entries`,
            icon: 'fa-link-slash',
            color: '#fdcb6e',
            desc: 'Not assigned to any tree category',
            items: mergedReport.orphanedEntries.slice(0, 10),
        });
    }
    if (mergedReport.noTimestamp.length > 0) {
        issues.push({
            title: `${mergedReport.noTimestamp.length} Without Timestamps`,
            icon: 'fa-calendar-xmark',
            color: '#74b9ff',
            desc: 'Fact entries missing [Day X] prefix',
            items: mergedReport.noTimestamp.slice(0, 10),
        });
    }
    if (mergedReport.outlierEntries.length > 0) {
        issues.push({
            title: `${mergedReport.outlierEntries.length} Oversized Entries`,
            icon: 'fa-weight-hanging',
            color: '#a29bfe',
            desc: `Significantly longer than average (${mergedReport.avgLength} chars)`,
            items: mergedReport.outlierEntries.slice(0, 10).map(item => ({
                ...item,
                title: `${item.title} (${item.length} chars)`,
            })),
        });
    }
    if (mergedReport.duplicateCandidates.length > 0) {
        issues.push({
            title: `${mergedReport.duplicateCandidates.length} Duplicate Candidates`,
            icon: 'fa-clone',
            color: '#e84393',
            desc: 'Entries with high content similarity',
            items: mergedReport.duplicateCandidates.slice(0, 10).map(item => ({
                uid: item.uidA,
                title: `${truncate(item.titleA, 20)} ↔ ${truncate(item.titleB, 20)} (${(item.similarity * 100).toFixed(0)}%)`,
                bookName: item.bookName,
            })),
        });
    }

    if (issues.length === 0) {
        const healthyEl = el('div', 'tv-health-healthy');
        healthyEl.appendChild(icon('fa-circle-check'));
        healthyEl.appendChild(el('span', null, 'Lorebook looks healthy!'));
        healthyEl.appendChild(el('span', 'tv-float-empty-sub', 'No stale entries, orphans, or duplicates detected'));
        container.appendChild(healthyEl);
    } else {
        for (const issue of issues) {
            container.appendChild(buildIssueSection(issue, {
                formatItemTitle: item => truncate(item.title, 45),
            }));
        }
    }

    return container;
}