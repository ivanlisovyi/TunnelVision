/**
 * TunnelVision Background Events
 *
 * Lightweight event bus for background operations (post-turn processing,
 * world-state updates, auto-summary, lifecycle maintenance).
 *
 * Extracted from activity-feed.js to break circular dependencies:
 * modules that produce background events no longer need to import
 * from the activity-feed (which imports back from them for UI).
 *
 * activity-feed.js registers its UI callbacks during init via
 * _registerFeedCallbacks(), wiring the visual side without a cycle.
 */

// ── UI Callbacks (registered by activity-feed.js at init) ────────

/** @type {((items: Object[]) => void) | null} */
let _addFeedItems = null;
/** @type {((active: boolean) => void) | null} */
let _setTriggerActive = null;
/** @type {(() => void) | null} */
let _refreshTasksUI = null;

/**
 * Called once by activity-feed.js during initActivityFeed().
 * @param {{ addFeedItems: Function, setTriggerActive: Function, refreshTasksUI: Function }} cbs
 */
export function _registerFeedCallbacks({ addFeedItems, setTriggerActive, refreshTasksUI }) {
    _addFeedItems = addFeedItems;
    _setTriggerActive = setTriggerActive;
    _refreshTasksUI = refreshTasksUI;
}

// ── Background Active Count ──────────────────────────────────────

let _activeBackgroundCount = 0;

function setBackgroundActive(active) {
    _activeBackgroundCount += active ? 1 : -1;
    if (_activeBackgroundCount < 0) _activeBackgroundCount = 0;
    _setTriggerActive?.(_activeBackgroundCount > 0);
}

// ── Background Events ────────────────────────────────────────────

let _bgEventId = 1_000_000;

/**
 * Log a background agent event to the activity feed.
 * @param {Object} opts
 * @param {string} opts.icon - FontAwesome icon class (e.g. 'fa-brain')
 * @param {string} opts.verb - Action label (e.g. 'Scene archived')
 * @param {string} opts.color - CSS color for the label
 * @param {string} [opts.summary] - Short description text
 * @param {string[]} [opts.details] - Extra detail tags
 * @param {Object} [opts.action] - Optional action button config
 */
export function addBackgroundEvent({ icon, verb, color, summary = '', details = [], action = null }) {
    const item = {
        id: _bgEventId++,
        type: 'background',
        icon,
        verb,
        color,
        summary,
        timestamp: Date.now(),
        details: details.filter(Boolean),
    };
    if (action) item.action = action;
    _addFeedItems?.([item]);
}

/**
 * Mark the start of a background operation (shows spinner on trigger button).
 * Returns a function to call when the operation completes.
 * @returns {() => void}
 */
export function markBackgroundStart() {
    setBackgroundActive(true);
    let ended = false;
    return () => {
        if (ended) return;
        ended = true;
        setBackgroundActive(false);
    };
}

// ── Cancellable Background Tasks ─────────────────────────────────

/** @type {Map<number, BackgroundTask>} */
const _activeTasks = new Map();
let _nextTaskId = 0;

/**
 * @typedef {Object} BackgroundTask
 * @property {number} id
 * @property {string} label
 * @property {string} icon
 * @property {string} color
 * @property {number} startedAt
 * @property {boolean} cancelled - Check this at async boundaries to abort early
 * @property {() => void} end - Call when the task finishes (success, error, or cancel)
 */

/**
 * Register a cancellable background task. Shows a live indicator in the feed
 * with a cancel button. The caller should check `task.cancelled` at each async
 * boundary and bail out if true.
 *
 * @param {Object} opts
 * @param {string} opts.label - Display label (e.g. 'Post-turn processing')
 * @param {string} [opts.icon='fa-gear'] - FontAwesome icon class
 * @param {string} [opts.color='#6c5ce7'] - CSS color
 * @returns {BackgroundTask}
 */
export function registerBackgroundTask({ label, icon: taskIcon = 'fa-gear', color = '#6c5ce7' }) {
    const id = _nextTaskId++;
    const task = {
        id,
        label,
        icon: taskIcon,
        color,
        startedAt: Date.now(),
        cancelled: false,
        _ended: false,
        end() {
            if (task._ended) return;
            task._ended = true;
            _activeTasks.delete(id);
            setBackgroundActive(false);
            _refreshTasksUI?.();
        },
    };

    _activeTasks.set(id, task);
    setBackgroundActive(true);
    _refreshTasksUI?.();
    return task;
}

/**
 * Cancel a running background task by ID.
 * Sets the cancelled flag — the processor is responsible for checking it.
 */
export function cancelBackgroundTask(id) {
    const task = _activeTasks.get(id);
    if (task && !task.cancelled) {
        task.cancelled = true;
        console.log(`[TunnelVision] Background task cancelled by user: ${task.label}`);
        _refreshTasksUI?.();
    }
}

/** @returns {ReadonlyMap<number, BackgroundTask>} */
export function getActiveTasks() {
    return _activeTasks;
}
