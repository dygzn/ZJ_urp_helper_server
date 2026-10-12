import { state } from './store.js';
import { closeUiModal, focusUiElement, openUiModal } from './ui.js';

const miniAppNoticeDismissKey = 'urp_miniapp_notice_dismissed_v1';
let miniAppNoticeDismissed = false;

export function initializeMiniAppPromo() {
    try {
        miniAppNoticeDismissed = localStorage.getItem(miniAppNoticeDismissKey) === '1';
    } catch {
        // 存储不可用时，仍保留本页已经关闭的状态。
    }
    const notice = document.getElementById('miniapp-notice');
    if (notice) notice.hidden = miniAppNoticeDismissed;
    for (const id of ['more-miniapp-trigger', 'sidebar-miniapp-trigger', 'desktop-miniapp-trigger']) {
        const trigger = document.getElementById(id);
        if (trigger) trigger.disabled = false;
    }
}

export function dismissMiniAppNotice({ restoreFocus = true } = {}) {
    const notice = document.getElementById('miniapp-notice');
    const focusWasInside = notice?.contains(document.activeElement);
    miniAppNoticeDismissed = true;
    if (notice) notice.hidden = true;
    try {
        localStorage.setItem(miniAppNoticeDismissKey, '1');
    } catch {
        // 禁用存储不阻止关闭提示或查看小程序码。
    }
    if (restoreFocus && focusWasInside) {
        const heading = document.getElementById('home-page-heading');
        heading?.setAttribute('tabindex', '-1');
        focusUiElement(heading);
    }
}

export function openMiniAppDialog() {
    const modal = document.getElementById('miniapp-dialog');
    if (!modal) return;
    const fromNotice = document.getElementById('miniapp-notice')?.contains(document.activeElement);
    dismissMiniAppNotice({ restoreFocus: false });
    openUiModal(modal, { initialFocusSelector: '#miniapp-dialog-close' });
    if (fromNotice) {
        const heading = document.getElementById('home-page-heading');
        heading?.setAttribute('tabindex', '-1');
        state.uiModalState.returnFocus = heading;
    }
}

export function closeMiniAppDialog() {
    closeUiModal(document.getElementById('miniapp-dialog'));
}
