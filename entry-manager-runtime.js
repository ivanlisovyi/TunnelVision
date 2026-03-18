import {
    RUNTIME_AUDIT_GROUPS,
    RUNTIME_AUDIT_SEVERITIES,
    RUNTIME_REASON_CODES,
    RUNTIME_REPAIR_CLASSES,
    createRuntimeAuditResult,
    createRuntimeFinding,
    createRuntimeRepair,
} from './runtime-health.js';
import { entryManagerRuntimeState } from './entry-manager-runtime-state.js';

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function getEntryManagerRuntimeSnapshot({ runtimeState = entryManagerRuntimeState } = {}) {
    return {
        cacheKeys: [...runtimeState.worldInfoCache.keys()],
        dirtyBooks: [...runtimeState.dirtyBooks],
        cachedEntries: [...runtimeState.worldInfoCache.entries()],
        bookEpochs: [...runtimeState.bookEpochs.entries()],
        cachedBookEpochs: [...runtimeState.cachedBookEpochs.entries()],
    };
}

export function auditEntryManagerRuntime(snapshot = getEntryManagerRuntimeSnapshot()) {
    const findings = [];
    const safeRepairs = [];
    const { cacheKeys, dirtyBooks, cachedEntries, bookEpochs = [], cachedBookEpochs = [] } = snapshot;
    const liveEpochs = new Map(bookEpochs);
    const cachedEpochs = new Map(cachedBookEpochs);

    for (const [bookName, bookData] of cachedEntries) {
        if (typeof bookName !== 'string' || !bookName.trim()) {
            findings.push(createRuntimeFinding({
                id: 'entrymanager-invalid-cache-key',
                subsystem: 'entry-manager',
                severity: RUNTIME_AUDIT_SEVERITIES.ERROR,
                message: 'World-info cache contains an invalid ownership key.',
                reasonCode: RUNTIME_REASON_CODES.CACHE_OWNER_CONFLICT,
                repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
                repairActionId: 'reset-entry-manager-cache',
                context: { bookName },
            }));
            continue;
        }

        if (!isPlainObject(bookData)) {
            findings.push(createRuntimeFinding({
                id: 'entrymanager-invalid-cache-value',
                subsystem: 'entry-manager',
                severity: RUNTIME_AUDIT_SEVERITIES.ERROR,
                message: `World-info cache entry for "${bookName}" is malformed.`,
                reasonCode: RUNTIME_REASON_CODES.STALE_CACHE_EPOCH,
                repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
                repairActionId: 'reset-entry-manager-cache',
                context: { bookName, valueType: typeof bookData },
            }));
            continue;
        }

        if (!isPlainObject(bookData.entries)) {
            findings.push(createRuntimeFinding({
                id: 'entrymanager-missing-entries-map',
                subsystem: 'entry-manager',
                severity: RUNTIME_AUDIT_SEVERITIES.WARN,
                message: `World-info cache entry for "${bookName}" does not expose a valid entries map.`,
                reasonCode: RUNTIME_REASON_CODES.DERIVED_CONTEXT_MISMATCH,
                repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
                repairActionId: 'reset-entry-manager-cache',
                context: { bookName },
            }));
        }

        if ((cachedEpochs.get(bookName) || 0) !== (liveEpochs.get(bookName) || 0)) {
            findings.push(createRuntimeFinding({
                id: 'entrymanager-stale-cache-epoch',
                subsystem: 'entry-manager',
                severity: RUNTIME_AUDIT_SEVERITIES.WARN,
                message: `World-info cache entry for "${bookName}" was built against a stale cache epoch.`,
                reasonCode: RUNTIME_REASON_CODES.STALE_CACHE_EPOCH,
                repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
                repairActionId: 'reset-entry-manager-cache',
                context: {
                    bookName,
                    cachedEpoch: cachedEpochs.get(bookName) || 0,
                    currentEpoch: liveEpochs.get(bookName) || 0,
                },
            }));
        }
    }

    for (const bookName of dirtyBooks.values()) {
        if (typeof bookName !== 'string' || !bookName.trim()) {
            findings.push(createRuntimeFinding({
                id: 'entrymanager-invalid-dirty-book',
                subsystem: 'entry-manager',
                severity: RUNTIME_AUDIT_SEVERITIES.ERROR,
                message: 'Dirty-book invalidation state contains an invalid ownership entry.',
                reasonCode: RUNTIME_REASON_CODES.CACHE_OWNER_CONFLICT,
                repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
                repairActionId: 'reset-entry-manager-cache',
                context: { bookName },
            }));
            continue;
        }

        if (cacheKeys.includes(bookName)) {
            findings.push(createRuntimeFinding({
                id: 'entrymanager-dirty-book-still-cached',
                subsystem: 'entry-manager',
                severity: RUNTIME_AUDIT_SEVERITIES.WARN,
                message: `Dirty lorebook "${bookName}" is still present in the active cache.`,
                reasonCode: RUNTIME_REASON_CODES.CACHE_OWNER_CONFLICT,
                repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
                repairActionId: 'invalidate-dirty-worldinfo-cache',
                context: { bookName },
            }));
        }
    }

    if (findings.length > 0) {
        safeRepairs.push(createRuntimeRepair({
            id: 'invalidate-dirty-worldinfo-cache',
            label: 'Invalidate dirty world-info cache entries',
            repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
            reasonCode: RUNTIME_REASON_CODES.CACHE_OWNER_CONFLICT,
            context: { dirtyBooks },
        }));

        safeRepairs.push(createRuntimeRepair({
            id: 'reset-entry-manager-cache',
            label: 'Reset all entry-manager world-info caches',
            repairClass: RUNTIME_REPAIR_CLASSES.SAFE_AUTO,
            reasonCode: findings[0]?.reasonCode || RUNTIME_REASON_CODES.STALE_CACHE_EPOCH,
            context: { cacheKeys, dirtyBooks },
        }));
    } else {
        findings.push(createRuntimeFinding({
            id: 'entrymanager-runtime-valid',
            subsystem: 'entry-manager',
            severity: RUNTIME_AUDIT_SEVERITIES.INFO,
            message: 'Entry-manager cache ownership and dirty-book invalidation state validated.',
            context: {
                cacheKeys,
                dirtyBooks,
                cachedBookCount: cacheKeys.length,
                dirtyBookCount: dirtyBooks.length,
                bookEpochs,
                cachedBookEpochs,
            },
        }));
    }

    return createRuntimeAuditResult({
        group: RUNTIME_AUDIT_GROUPS.METADATA,
        ok: findings.every(finding => finding.severity !== RUNTIME_AUDIT_SEVERITIES.ERROR),
        summary: findings.some(finding => finding.severity === RUNTIME_AUDIT_SEVERITIES.ERROR)
            ? 'Entry-manager audit found integrity issues.'
            : findings.some(finding => finding.severity === RUNTIME_AUDIT_SEVERITIES.WARN)
                ? 'Entry-manager audit found coordination issues.'
                : 'Entry-manager audit passed.',
        findings,
        safeRepairs,
        requiresConfirmation: [],
        context: {
            ...snapshot,
            cachedBookCount: cacheKeys.length,
            dirtyBookCount: dirtyBooks.length,
        },
    });
}