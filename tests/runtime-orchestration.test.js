import { beforeEach, describe, expect, it } from 'vitest';

import {
    beginInitialization,
    completeInitialization,
    recordOrchestrationEvent,
    consumePendingInvalidationState,
    requestRuntimeSync,
    beginRuntimeSyncPlan,
    completeRuntimeSyncPlan,
    hasPendingRuntimeSync,
    beginSync,
    completeSync,
    updateLastGenerationContext,
    recordGenerationPreflightSummary,
    getOrchestrationRuntimeSnapshot,
    __orchestrationDebug,
} from '../runtime-orchestration.js';

describe('runtime-orchestration', () => {
    beforeEach(() => {
        __orchestrationDebug.reset();
    });

    describe('initialization lifecycle', () => {
        it('starts with an empty orchestration snapshot', () => {
            expect(getOrchestrationRuntimeSnapshot()).toEqual({
                initialized: false,
                initStartedAt: 0,
                initCompletedAt: 0,
                lastEvent: null,
                lastEventAt: 0,
                pendingInvalidationReasons: [],
                pendingInvalidationCounts: {},
                lastSyncReason: null,
                lastSyncAt: 0,
                syncInFlight: false,
                syncCount: 0,
                pendingSyncReasons: [],
                pendingSyncCounts: {},
                pendingSyncEffects: {
                    invalidateActiveBookCache: false,
                    invalidateWorldInfoCache: false,
                    invalidatePreWarmCache: false,
                    refreshUI: false,
                },
                pendingSyncRequestedAt: 0,
                hasPendingSync: false,
                activeSyncPlan: null,
                lastSyncPlan: null,
                lastGenerationStartedAt: 0,
                lastGenerationContext: null,
            });
        });

        it('records initialization start and completion timestamps', () => {
            beginInitialization(100);
            completeInitialization(200);

            expect(getOrchestrationRuntimeSnapshot()).toMatchObject({
                initialized: true,
                initStartedAt: 100,
                initCompletedAt: 200,
            });
        });
    });

    describe('event and invalidation tracking', () => {
        it('records invalidation reasons and their counts', () => {
            recordOrchestrationEvent('chat-changed', { invalidationReason: 'chat_changed' }, 1000);
            recordOrchestrationEvent('worldinfo-updated', { invalidationReason: 'worldinfo_updated' }, 1100);
            recordOrchestrationEvent('chat-changed', { invalidationReason: 'chat_changed' }, 1200);

            expect(getOrchestrationRuntimeSnapshot()).toMatchObject({
                lastEvent: 'chat-changed',
                lastEventAt: 1200,
                pendingInvalidationReasons: ['chat_changed', 'worldinfo_updated', 'chat_changed'],
                pendingInvalidationCounts: {
                    chat_changed: 2,
                    worldinfo_updated: 1,
                },
            });
        });

        it('coalesces adjacent duplicate invalidation reasons while preserving counts', () => {
            recordOrchestrationEvent('chat-changed', { invalidationReason: 'chat_changed' }, 1000);
            recordOrchestrationEvent('chat-changed', { invalidationReason: 'chat_changed' }, 1100);
            recordOrchestrationEvent('worldinfo-updated', { invalidationReason: 'worldinfo_updated' }, 1200);

            expect(getOrchestrationRuntimeSnapshot()).toMatchObject({
                pendingInvalidationReasons: ['chat_changed', 'worldinfo_updated'],
                pendingInvalidationCounts: {
                    chat_changed: 2,
                    worldinfo_updated: 1,
                },
            });
        });

        it('consumes and clears pending invalidation state', () => {
            recordOrchestrationEvent('chat-changed', { invalidationReason: 'chat_changed' }, 1000);
            recordOrchestrationEvent('worldinfo-updated', { invalidationReason: 'worldinfo_updated' }, 1100);

            const consumed = consumePendingInvalidationState();

            expect(consumed).toEqual({
                reasons: ['chat_changed', 'worldinfo_updated'],
                counts: {
                    chat_changed: 1,
                    worldinfo_updated: 1,
                },
            });

            expect(getOrchestrationRuntimeSnapshot()).toMatchObject({
                pendingInvalidationReasons: [],
                pendingInvalidationCounts: {},
            });
        });

        it('captures generation-start context from current pending invalidations', () => {
            recordOrchestrationEvent('chat-changed', { invalidationReason: 'chat_changed' }, 1000);
            recordOrchestrationEvent('worldinfo-updated', { invalidationReason: 'worldinfo_updated' }, 1100);

            recordOrchestrationEvent('generation-started', {
                generationType: 'normal',
                hasOptions: true,
                consumedInvalidationReasons: ['chat_changed', 'worldinfo_updated'],
                consumedInvalidationCounts: {
                    chat_changed: 1,
                    worldinfo_updated: 1,
                },
            }, 2000);

            expect(getOrchestrationRuntimeSnapshot()).toMatchObject({
                lastEvent: 'generation-started',
                lastGenerationStartedAt: 2000,
                lastGenerationContext: {
                    generationType: 'normal',
                    hasOptions: true,
                    pendingInvalidationReasons: ['chat_changed', 'worldinfo_updated'],
                    pendingInvalidationCounts: {
                        chat_changed: 1,
                        worldinfo_updated: 1,
                    },
                    consumedInvalidationReasons: ['chat_changed', 'worldinfo_updated'],
                    consumedInvalidationCounts: {
                        chat_changed: 1,
                        worldinfo_updated: 1,
                    },
                },
            });
        });
    });

    describe('sync tracking', () => {
        it('tracks sync reason, timestamp, in-flight state, and sync count', () => {
            beginSync('init', 100);
            expect(getOrchestrationRuntimeSnapshot()).toMatchObject({
                lastSyncReason: 'init',
                lastSyncAt: 100,
                syncInFlight: true,
                syncCount: 1,
            });

            completeSync();
            expect(getOrchestrationRuntimeSnapshot()).toMatchObject({
                lastSyncReason: 'init',
                syncInFlight: false,
                syncCount: 1,
            });

            beginSync('app-ready', 200);
            expect(getOrchestrationRuntimeSnapshot()).toMatchObject({
                lastSyncReason: 'app-ready',
                lastSyncAt: 200,
                syncInFlight: true,
                syncCount: 2,
            });
        });

        it('queues runtime sync work and begins one canonical sync plan', () => {
            requestRuntimeSync({
                eventName: 'chat-changed',
                invalidationReason: 'chat_changed',
                syncReason: 'chat-changed',
                now: 100,
                effects: {
                    invalidateActiveBookCache: true,
                    invalidateWorldInfoCache: true,
                    invalidatePreWarmCache: true,
                    refreshUI: true,
                },
            });
            requestRuntimeSync({
                eventName: 'worldinfo-updated',
                invalidationReason: 'worldinfo_updated',
                syncReason: 'worldinfo-updated',
                now: 150,
                effects: {
                    invalidateActiveBookCache: true,
                    invalidateWorldInfoCache: true,
                    invalidatePreWarmCache: true,
                    refreshUI: true,
                },
            });

            const plan = beginRuntimeSyncPlan(200);

            expect(plan).toEqual({
                id: 1,
                syncReason: 'coalesced:chat-changed+worldinfo-updated',
                syncReasons: ['chat-changed', 'worldinfo-updated'],
                syncReasonCounts: {
                    'chat-changed': 1,
                    'worldinfo-updated': 1,
                },
                invalidationReasons: ['chat_changed', 'worldinfo_updated'],
                invalidationCounts: {
                    chat_changed: 1,
                    worldinfo_updated: 1,
                },
                effects: {
                    invalidateActiveBookCache: true,
                    invalidateWorldInfoCache: true,
                    invalidatePreWarmCache: true,
                    refreshUI: true,
                },
                requestedAt: 100,
            });

            expect(getOrchestrationRuntimeSnapshot()).toMatchObject({
                lastSyncReason: 'coalesced:chat-changed+worldinfo-updated',
                syncInFlight: true,
                syncCount: 1,
                pendingSyncReasons: [],
                hasPendingSync: false,
                activeSyncPlan: plan,
                lastSyncPlan: plan,
            });
        });

        it('coalesces adjacent sync requests while preserving their counts', () => {
            requestRuntimeSync({
                eventName: 'chat-changed',
                invalidationReason: 'chat_changed',
                syncReason: 'chat-changed',
                now: 100,
                effects: { refreshUI: true },
            });
            requestRuntimeSync({
                eventName: 'chat-changed',
                invalidationReason: 'chat_changed',
                syncReason: 'chat-changed',
                now: 110,
                effects: { refreshUI: true },
            });

            expect(getOrchestrationRuntimeSnapshot()).toMatchObject({
                pendingSyncReasons: ['chat-changed'],
                pendingSyncCounts: {
                    'chat-changed': 2,
                },
                pendingSyncRequestedAt: 100,
                hasPendingSync: true,
            });
        });

        it('requeues an active sync plan when completion requests retry', () => {
            requestRuntimeSync({
                eventName: 'chat-changed',
                invalidationReason: 'chat_changed',
                syncReason: 'chat-changed',
                now: 100,
                effects: {
                    invalidateActiveBookCache: true,
                    refreshUI: true,
                },
            });

            const plan = beginRuntimeSyncPlan(200);
            completeRuntimeSyncPlan({ requeue: true });

            expect(plan?.syncReason).toBe('chat-changed');
            expect(getOrchestrationRuntimeSnapshot()).toMatchObject({
                syncInFlight: false,
                pendingSyncReasons: ['chat-changed'],
                pendingSyncCounts: {
                    'chat-changed': 1,
                },
                pendingSyncEffects: {
                    invalidateActiveBookCache: true,
                    invalidateWorldInfoCache: false,
                    invalidatePreWarmCache: false,
                    refreshUI: true,
                },
                hasPendingSync: true,
                activeSyncPlan: null,
            });
        });
    });

    describe('generation context updates', () => {
        it('updates last generation context incrementally', () => {
            recordOrchestrationEvent('generation-started', {
                generationType: 'normal',
                hasOptions: false,
            }, 1000);

            updateLastGenerationContext({
                promptInjectionPrepared: true,
                isRecursiveToolPass: false,
                mandatoryToolsEnabled: true,
                globalEnabled: true,
            });

            expect(getOrchestrationRuntimeSnapshot()).toMatchObject({
                lastGenerationContext: {
                    generationType: 'normal',
                    hasOptions: false,
                    promptInjectionPrepared: true,
                    isRecursiveToolPass: false,
                    mandatoryToolsEnabled: true,
                    globalEnabled: true,
                },
            });
        });

        it('records a structured preflight summary from runtime state', () => {
            recordOrchestrationEvent('generation-started', {
                generationType: 'normal',
                hasOptions: true,
            }, 1000);

            recordGenerationPreflightSummary({
                activeBooks: ['Book A', 'Book B'],
                expectedToolNames: ['Search', 'Remember', 'Update'],
                eligibleToolNames: ['Search', 'Remember'],
                repairApplied: true,
                failureReasons: ['missing_tools:Update'],
            });

            expect(getOrchestrationRuntimeSnapshot()).toMatchObject({
                lastGenerationContext: {
                    generationType: 'normal',
                    hasOptions: true,
                    preflightCompleted: true,
                    preflightSummary: {
                        activeBooks: 2,
                        expectedTools: 3,
                        eligibleTools: 2,
                        repairApplied: true,
                        failureReasons: ['missing_tools:Update'],
                    },
                },
            });
        });
    });

    describe('snapshot cloning and debug helpers', () => {
        it('returns cloned nested snapshot data so consumers cannot mutate internal state', () => {
            __orchestrationDebug.setRuntimeState({
                pendingInvalidationReasons: ['chat_changed'],
                pendingInvalidationCounts: { chat_changed: 1 },
                pendingSyncReasons: ['chat-changed'],
                pendingSyncCounts: { 'chat-changed': 1 },
                pendingSyncEffects: {
                    refreshUI: true,
                },
                pendingSyncRequestedAt: 12,
                lastGenerationContext: {
                    pendingInvalidationReasons: ['chat_changed'],
                    pendingInvalidationCounts: { chat_changed: 1 },
                    consumedInvalidationReasons: ['chat_changed'],
                    consumedInvalidationCounts: { chat_changed: 1 },
                    preflightSummary: {
                        activeBooks: 1,
                        expectedTools: 2,
                        eligibleTools: 2,
                        repairApplied: false,
                        failureReasons: ['example_failure'],
                    },
                },
            });

            const snapshot = getOrchestrationRuntimeSnapshot();

            snapshot.pendingInvalidationReasons.push('worldinfo_updated');
            snapshot.pendingInvalidationCounts.chat_changed = 99;
            snapshot.pendingSyncReasons.push('worldinfo-updated');
            snapshot.pendingSyncCounts['chat-changed'] = 42;
            snapshot.pendingSyncEffects.refreshUI = false;
            snapshot.lastGenerationContext.pendingInvalidationReasons.push('generation_started');
            snapshot.lastGenerationContext.pendingInvalidationCounts.chat_changed = 42;
            snapshot.lastGenerationContext.consumedInvalidationReasons.push('worldinfo_updated');
            snapshot.lastGenerationContext.consumedInvalidationCounts.chat_changed = 77;
            snapshot.lastGenerationContext.preflightSummary.failureReasons.push('mutated');

            const freshSnapshot = getOrchestrationRuntimeSnapshot();

            expect(freshSnapshot.pendingInvalidationReasons).toEqual(['chat_changed']);
            expect(freshSnapshot.pendingInvalidationCounts).toEqual({ chat_changed: 1 });
            expect(freshSnapshot.pendingSyncReasons).toEqual(['chat-changed']);
            expect(freshSnapshot.pendingSyncCounts).toEqual({ 'chat-changed': 1 });
            expect(freshSnapshot.pendingSyncEffects).toEqual({
                invalidateActiveBookCache: false,
                invalidateWorldInfoCache: false,
                invalidatePreWarmCache: false,
                refreshUI: true,
            });
            expect(freshSnapshot.lastGenerationContext.pendingInvalidationReasons).toEqual(['chat_changed']);
            expect(freshSnapshot.lastGenerationContext.pendingInvalidationCounts).toEqual({ chat_changed: 1 });
            expect(freshSnapshot.lastGenerationContext.consumedInvalidationReasons).toEqual(['chat_changed']);
            expect(freshSnapshot.lastGenerationContext.consumedInvalidationCounts).toEqual({ chat_changed: 1 });
            expect(freshSnapshot.lastGenerationContext.preflightSummary.failureReasons).toEqual(['example_failure']);
        });

        it('debug setter seeds orchestration state for focused tests', () => {
            __orchestrationDebug.setRuntimeState({
                initialized: true,
                initStartedAt: 10,
                initCompletedAt: 20,
                lastEvent: 'app-ready',
                lastEventAt: 30,
                pendingInvalidationReasons: ['chat_changed', 'chat_changed'],
                pendingInvalidationCounts: { chat_changed: 2 },
                lastSyncReason: 'app-ready',
                lastSyncAt: 40,
                syncInFlight: true,
                syncCount: 3,
                pendingSyncReasons: ['chat-changed', 'worldinfo-updated'],
                pendingSyncCounts: { 'chat-changed': 2, 'worldinfo-updated': 1 },
                pendingSyncEffects: {
                    invalidateActiveBookCache: true,
                    invalidateWorldInfoCache: true,
                    invalidatePreWarmCache: true,
                    refreshUI: true,
                },
                pendingSyncRequestedAt: 35,
                activeSyncPlan: {
                    id: 7,
                    syncReason: 'coalesced:chat-changed+worldinfo-updated',
                    syncReasons: ['chat-changed', 'worldinfo-updated'],
                    syncReasonCounts: { 'chat-changed': 2, 'worldinfo-updated': 1 },
                    invalidationReasons: ['chat_changed', 'worldinfo_updated'],
                    invalidationCounts: { chat_changed: 2, worldinfo_updated: 1 },
                    effects: {
                        invalidateActiveBookCache: true,
                        invalidateWorldInfoCache: true,
                        invalidatePreWarmCache: true,
                        refreshUI: true,
                    },
                    requestedAt: 35,
                },
                lastSyncPlan: {
                    id: 6,
                    syncReason: 'chat-changed',
                    syncReasons: ['chat-changed'],
                    syncReasonCounts: { 'chat-changed': 1 },
                    invalidationReasons: ['chat_changed'],
                    invalidationCounts: { chat_changed: 1 },
                    effects: {
                        invalidateActiveBookCache: true,
                        invalidateWorldInfoCache: true,
                        invalidatePreWarmCache: true,
                        refreshUI: true,
                    },
                    requestedAt: 20,
                },
                lastGenerationStartedAt: 50,
                lastGenerationContext: {
                    generationType: 'normal',
                    hasOptions: true,
                    pendingInvalidationReasons: ['chat_changed'],
                    pendingInvalidationCounts: { chat_changed: 1 },
                    consumedInvalidationReasons: ['chat_changed'],
                    consumedInvalidationCounts: { chat_changed: 1 },
                    promptInjectionPrepared: true,
                    preflightCompleted: false,
                    preflightSummary: {
                        activeBooks: 1,
                        expectedTools: 2,
                        eligibleTools: 1,
                        repairApplied: false,
                        failureReasons: ['missing_tools:Remember'],
                    },
                },
            });

            expect(getOrchestrationRuntimeSnapshot()).toEqual({
                initialized: true,
                initStartedAt: 10,
                initCompletedAt: 20,
                lastEvent: 'app-ready',
                lastEventAt: 30,
                pendingInvalidationReasons: ['chat_changed', 'chat_changed'],
                pendingInvalidationCounts: { chat_changed: 2 },
                lastSyncReason: 'app-ready',
                lastSyncAt: 40,
                syncInFlight: true,
                syncCount: 3,
                pendingSyncReasons: ['chat-changed', 'worldinfo-updated'],
                pendingSyncCounts: { 'chat-changed': 2, 'worldinfo-updated': 1 },
                pendingSyncEffects: {
                    invalidateActiveBookCache: true,
                    invalidateWorldInfoCache: true,
                    invalidatePreWarmCache: true,
                    refreshUI: true,
                },
                pendingSyncRequestedAt: 35,
                hasPendingSync: true,
                activeSyncPlan: {
                    id: 7,
                    syncReason: 'coalesced:chat-changed+worldinfo-updated',
                    syncReasons: ['chat-changed', 'worldinfo-updated'],
                    syncReasonCounts: { 'chat-changed': 2, 'worldinfo-updated': 1 },
                    invalidationReasons: ['chat_changed', 'worldinfo_updated'],
                    invalidationCounts: { chat_changed: 2, worldinfo_updated: 1 },
                    effects: {
                        invalidateActiveBookCache: true,
                        invalidateWorldInfoCache: true,
                        invalidatePreWarmCache: true,
                        refreshUI: true,
                    },
                    requestedAt: 35,
                },
                lastSyncPlan: {
                    id: 6,
                    syncReason: 'chat-changed',
                    syncReasons: ['chat-changed'],
                    syncReasonCounts: { 'chat-changed': 1 },
                    invalidationReasons: ['chat_changed'],
                    invalidationCounts: { chat_changed: 1 },
                    effects: {
                        invalidateActiveBookCache: true,
                        invalidateWorldInfoCache: true,
                        invalidatePreWarmCache: true,
                        refreshUI: true,
                    },
                    requestedAt: 20,
                },
                lastGenerationStartedAt: 50,
                lastGenerationContext: {
                    generationType: 'normal',
                    hasOptions: true,
                    pendingInvalidationReasons: ['chat_changed'],
                    pendingInvalidationCounts: { chat_changed: 1 },
                    consumedInvalidationReasons: ['chat_changed'],
                    consumedInvalidationCounts: { chat_changed: 1 },
                    preflightSummary: {
                        activeBooks: 1,
                        expectedTools: 2,
                        eligibleTools: 1,
                        repairApplied: false,
                        failureReasons: ['missing_tools:Remember'],
                    },
                    promptInjectionPrepared: true,
                    preflightCompleted: false,
                },
            });
        });
    });
});