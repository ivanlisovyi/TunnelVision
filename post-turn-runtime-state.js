export const postTurnRuntimeState = {
  processorRunning: false,
  currentTask: null,
  swipePending: false,
  chatRef: { lastChatLength: 0, lastChatId: null },
  lastArchivedAt: 0,
  liveRollback: null,
};