export function el(tag, cls, text) {
    const element = document.createElement(tag);
    if (cls) element.className = cls;
    if (text) element.textContent = text;
    return element;
}

export function icon(iconClass) {
    const element = document.createElement('i');
    element.className = `fa-solid ${iconClass}`;
    return element;
}

export function addHealthStat(container, label, value, color) {
    const stat = el('div', 'tv-health-stat');
    const valueEl = el('div', 'tv-health-stat-value');
    valueEl.textContent = String(value);
    valueEl.style.color = color;
    stat.appendChild(valueEl);
    stat.appendChild(el('div', 'tv-health-stat-label', label));
    container.appendChild(stat);
}

export function buildIssueSection(issue, { formatItemTitle = item => item?.title || '' } = {}) {
    const section = el('div', 'tv-health-issue');

    const header = el('div', 'tv-health-issue-header');
    const issueIcon = icon(issue.icon);
    issueIcon.style.color = issue.color;
    header.appendChild(issueIcon);
    header.appendChild(el('span', 'tv-health-issue-title', issue.title));
    section.appendChild(header);

    section.appendChild(el('div', 'tv-health-issue-desc', issue.desc));

    const list = el('div', 'tv-health-issue-list');
    for (const item of issue.items) {
        const row = el('div', 'tv-health-issue-item');
        row.appendChild(el('span', 'tv-health-issue-uid', `#${item.uid}`));
        row.appendChild(el('span', 'tv-health-issue-name', formatItemTitle(item)));
        list.appendChild(row);
    }

    section.appendChild(list);
    section.classList.add('tv-feed-clickable');
    list.style.display = 'none';
    section.addEventListener('click', () => {
        const expanded = section.classList.toggle('expanded');
        list.style.display = expanded ? '' : 'none';
    });

    return section;
}