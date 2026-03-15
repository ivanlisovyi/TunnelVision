import { describe, it, expect, beforeEach } from 'vitest';
import { _registerFeedCallbacks, getTrackerSuggestionNames } from '../background-events.js';

describe('getTrackerSuggestionNames', () => {
    beforeEach(() => {
        _registerFeedCallbacks({
            addFeedItems: () => {},
            setTriggerActive: () => {},
            refreshTasksUI: () => {},
            getFeedItems: () => [],
        });
    });

    it('returns empty array when feed has no items', () => {
        expect(getTrackerSuggestionNames()).toEqual([]);
    });

    it('returns lowercased character names from create-tracker suggestions', () => {
        _registerFeedCallbacks({
            addFeedItems: () => {},
            setTriggerActive: () => {},
            refreshTasksUI: () => {},
            getFeedItems: () => [
                { type: 'background', action: { type: 'create-tracker', characterName: 'Elena Blackwood' } },
                { type: 'background', action: { type: 'create-tracker', characterName: 'John Wald' } },
            ],
        });

        const names = getTrackerSuggestionNames();
        expect(names).toEqual(['elena blackwood', 'john wald']);
    });

    it('includes completed and dismissed suggestions', () => {
        _registerFeedCallbacks({
            addFeedItems: () => {},
            setTriggerActive: () => {},
            refreshTasksUI: () => {},
            getFeedItems: () => [
                { type: 'background', completedAt: 123, action: { type: 'create-tracker', characterName: 'Created' } },
                { type: 'background', dismissedAt: 456, action: { type: 'create-tracker', characterName: 'Dismissed' } },
                { type: 'background', action: { type: 'create-tracker', characterName: 'Pending' } },
            ],
        });

        const names = getTrackerSuggestionNames();
        expect(names).toHaveLength(3);
        expect(names).toContain('created');
        expect(names).toContain('dismissed');
        expect(names).toContain('pending');
    });

    it('excludes non-create-tracker background items', () => {
        _registerFeedCallbacks({
            addFeedItems: () => {},
            setTriggerActive: () => {},
            refreshTasksUI: () => {},
            getFeedItems: () => [
                { type: 'background', action: { type: 'open-tree-editor' } },
                { type: 'background', verb: 'Tracker created', color: '#00b894' },
                { type: 'tool', action: { type: 'create-tracker', characterName: 'WrongType' } },
            ],
        });

        expect(getTrackerSuggestionNames()).toEqual([]);
    });

    it('skips items with missing characterName', () => {
        _registerFeedCallbacks({
            addFeedItems: () => {},
            setTriggerActive: () => {},
            refreshTasksUI: () => {},
            getFeedItems: () => [
                { type: 'background', action: { type: 'create-tracker' } },
                { type: 'background', action: { type: 'create-tracker', characterName: '' } },
            ],
        });

        expect(getTrackerSuggestionNames()).toEqual([]);
    });
});
