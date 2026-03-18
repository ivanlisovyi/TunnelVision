import { beforeEach, describe, expect, it } from 'vitest';

import {
    beginInitialization,
    completeInitialization,
    recordOrchestrationEvent,
    consumePendingInvalidationState,
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
            snapshot.lastGenerationContext.pendingInvalidationReasons.push('generation_started');
            snapshot.lastGenerationContext.pendingInvalidationCounts.chat_changed = 42;
            snapshot.lastGenerationContext.consumedInvalidationReasons.push('worldinfo_updated');
            snapshot.lastGenerationContext.consumedInvalidationCounts.chat_changed = 77;
            snapshot.lastGenerationContext.preflightSummary.failureReasons.push('mutated');

            const freshSnapshot = getOrchestrationRuntimeSnapshot();

            expect(freshSnapshot.pendingInvalidationReasons).toEqual(['chat_changed']);
            expect(freshSnapshot.pendingInvalidationCounts).toEqual({ chat_changed: 1 });
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