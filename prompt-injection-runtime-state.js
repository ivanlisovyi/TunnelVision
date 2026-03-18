import { getContext } from '../../../st-context.js';
import { getSmartContextRuntimeSnapshot } from './smart-context.js';

const installState = {
    installedPlanEpoch: 0,
    installedPlanSignature: null,
    installedPlanChatLength: 0,
    installedPlanChatFingerprint: null,
    installedPlanSmartContextCacheKey: null,
    installedPlanSmartContextCachedAt: 0,
    installedPlanSmartContextCacheFresh: false,
};

export function buildPromptRuntimeChatFingerprint(context = getContext()) {
    try {
        const chat = context?.chat || [];
        const lastMsg = chat[chat.length - 1] || null;
        return JSON.stringify({
            chatLength: chat.length,
            lastMessage: lastMsg
                ? {
                    is_user: !!lastMsg.is_user,
                    name: lastMsg.name || '',
                    mes: lastMsg.mes || '',
                    toolInvocations: Array.isArray(lastMsg?.extra?.tool_invocations)
                        ? lastMsg.extra.tool_invocations.length
                        : 0,
                }
                : null,
        });
    } catch {
        return null;
    }
}

export function getPromptInjectionInstallState() {
    return { ...installState };
}

export function recordAppliedPromptPlanRuntimeState({
    planEpoch = 0,
    planSignature = null,
    payload = null,
    getSmartContextRuntimeSnapshotImpl,
} = {}) {
    const smartContextSnapshot = typeof getSmartContextRuntimeSnapshotImpl === 'function'
        ? getSmartContextRuntimeSnapshotImpl()
        : getSmartContextRuntimeSnapshot();

    installState.installedPlanEpoch = Number.isFinite(planEpoch) ? planEpoch : 0;
    installState.installedPlanSignature = planSignature || null;
    installState.installedPlanChatLength = payload?.auditContext?.currentChatLength || 0;
    installState.installedPlanChatFingerprint = payload?.auditContext?.currentChatFingerprint || null;
    installState.installedPlanSmartContextCacheKey = smartContextSnapshot?.cacheKey || null;
    installState.installedPlanSmartContextCachedAt = smartContextSnapshot?.preWarmCachedAt || 0;
    installState.installedPlanSmartContextCacheFresh = smartContextSnapshot?.cacheFresh === true;
}

export function resetPromptInjectionInstallState() {
    installState.installedPlanEpoch = 0;
    installState.installedPlanSignature = null;
    installState.installedPlanChatLength = 0;
    installState.installedPlanChatFingerprint = null;
    installState.installedPlanSmartContextCacheKey = null;
    installState.installedPlanSmartContextCachedAt = 0;
    installState.installedPlanSmartContextCacheFresh = false;
}