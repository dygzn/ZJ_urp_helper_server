import { pageResources } from './lifecycle.js';
import { state } from './store.js';
import { closePasswordDisclaimer } from './auth.js';
import { closeSidebar } from './navigation.js';
import { setServiceContactPopoverOpen } from './service.js';
const resources = pageResources('ui');

export const urpUi = typeof URPUI !== 'undefined' ? URPUI : null;

const modalCleanups = new Map();
export function registerModalCleanup(id, cleanup) { modalCleanups.set(id, cleanup); }

export function toggleUiClass(element, className, force) {
    if (!element || !element.classList) return false;
    if (typeof element.classList.toggle === 'function') {
        return element.classList.toggle(className, force);
    }
    if (force) element.classList.add(className);
    else element.classList.remove(className);
    return force;
}

export function syncUiOverlay() {
    const overlay = document.getElementById('overlay');
    const sidebar = document.getElementById('sidebar');
    const activeModal = state.uiModalState.activeModal;
    const modalIsOpen = Boolean(
        (activeModal && activeModal.classList && activeModal.classList.contains('active'))
        || (document.querySelector && document.querySelector('.modal.active')),
    );
    const sidebarIsOpen = Boolean(
        sidebar && sidebar.classList && sidebar.classList.contains('active'),
    );
    const shouldShow = modalIsOpen || sidebarIsOpen;

    toggleUiClass(overlay, 'active', shouldShow);
    if (document.body && document.body.classList) {
        toggleUiClass(document.body, 'ui-locked', shouldShow);
    }
}

export function focusUiElement(element) {
    if (!element || typeof element.focus !== 'function') return;
    try {
        element.focus({ preventScroll: true });
    } catch (error) {
        if (error?.name === 'AbortError') return;
        element.focus();
    }
}

export function getUiFocusable(container) {
    if (urpUi && typeof urpUi.getFocusableElements === 'function') {
        return urpUi.getFocusableElements(container);
    }
    if (!container || typeof container.querySelectorAll !== 'function') return [];
    return Array.from(container.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )).filter(element => !element.disabled && !element.hidden);
}

export function openUiModal(modal, { initialFocusSelector = '' } = {}) {
    if (!modal) return;

    if (state.uiModalState.activeModal && state.uiModalState.activeModal !== modal) {
        closeUiModal(state.uiModalState.activeModal, { restoreFocus: false });
    }

    if (!state.uiModalState.activeModal) {
        state.uiModalState.returnFocus = document.activeElement || null;
    }
    state.uiModalState.activeModal = modal;
    toggleUiClass(modal, 'active', true);
    if (typeof modal.setAttribute === 'function') {
        modal.setAttribute('aria-hidden', 'false');
    }
    syncUiOverlay();

    let initialFocus = null;
    if (initialFocusSelector && typeof modal.querySelector === 'function') {
        initialFocus = modal.querySelector(initialFocusSelector);
    }
    const focusable = getUiFocusable(modal);
    focusUiElement(initialFocus || focusable[0]);
}

export function closeUiModal(modal, { restoreFocus = true, animate = true } = {}) {
    if (!modal) return;

    modalCleanups.get(modal.id)?.();

    const transition = typeof window !== 'undefined' && window.courseDetailTransition;
    if (transition && modal.id === 'course-detail-modal') {
        if (animate && restoreFocus && transition.close(modal, () => closeUiModal(modal, { restoreFocus, animate: false }))) return;
        transition.reset(modal);
    }

    toggleUiClass(modal, 'active', false);
    if (typeof modal.setAttribute === 'function') {
        modal.setAttribute('aria-hidden', 'true');
    }
    if (state.uiModalState.activeModal === modal) {
        state.uiModalState.activeModal = null;
        const focusTarget = state.uiModalState.returnFocus;
        state.uiModalState.returnFocus = null;
        if (restoreFocus && focusTarget && focusTarget.isConnected !== false) {
            focusUiElement(focusTarget);
        }
    }
    syncUiOverlay();
}

export function showUiToast(message, type = 'info') {
    const region = document.getElementById('ui-toast-region');
    if (!region) return;

    if (typeof region.replaceChildren === 'function') region.replaceChildren();
    else region.innerHTML = '';

    const toast = document.createElement('div');
    toast.className = `ui-toast ui-toast-${type}`;
    toast.setAttribute('role', 'status');
    toast.textContent = String(message || '');
    region.appendChild(toast);

    const removeToast = () => {
        if (toast.isConnected) toast.remove();
    };
    const schedule = (typeof window !== 'undefined' && window.setTimeout)
        ? window.setTimeout.bind(window)
        : setTimeout;
    schedule(removeToast, 3200);
}

export function resolveUiConfirmation(confirmed) {
    const resolver = state.uiModalState.confirmationResolve;
    state.uiModalState.confirmationResolve = null;
    closeUiModal(document.getElementById('ui-confirm-modal'));
    if (resolver) resolver(Boolean(confirmed));
}

export function requestUiConfirmation({
    title,
    message,
    confirmText = '确认',
    cancelText = '取消',
    danger = false,
} = {}) {
    const modal = document.getElementById('ui-confirm-modal');
    if (!modal) return Promise.resolve(false);

    if (state.uiModalState.confirmationResolve) {
        state.uiModalState.confirmationResolve(false);
        state.uiModalState.confirmationResolve = null;
    }

    const titleElement = document.getElementById('ui-confirm-title');
    const messageElement = document.getElementById('ui-confirm-message');
    const confirmButton = document.getElementById('ui-confirm-confirm');
    const cancelButton = document.getElementById('ui-confirm-cancel');
    if (titleElement) titleElement.textContent = title || '请确认';
    if (messageElement) messageElement.textContent = message || '';
    if (confirmButton) {
        confirmButton.textContent = confirmText;
        toggleUiClass(confirmButton, 'btn-danger', danger);
    }
    if (cancelButton) cancelButton.textContent = cancelText;

    return new Promise(resolve => {
        state.uiModalState.confirmationResolve = resolve;
        openUiModal(modal, { initialFocusSelector: '#ui-confirm-cancel' });
    });
}

export function handleOverlayClick(event) {
    if (!event || event.target !== event.currentTarget) return;

    const modal = state.uiModalState.activeModal;
    if (modal && (!urpUi || urpUi.isModalDismissible(modal))) {
        if (modal.id === 'ui-confirm-modal') resolveUiConfirmation(false);
        else if (modal.id === 'password-disclaimer-modal') closePasswordDisclaimer();
        else closeUiModal(modal);
        return;
    }
    closeSidebar();
}

export function handleModalBackdropClick(event) {
    const modal = event?.target;
    if (!modal || !modal.classList?.contains('modal') || modal !== state.uiModalState.activeModal) {
        return;
    }
    if (modal.id === 'ui-confirm-modal') resolveUiConfirmation(false);
    else if (modal.id === 'password-disclaimer-modal') closePasswordDisclaimer();
    else if (!urpUi || urpUi.isModalDismissible(modal)) closeUiModal(modal);
}

export function handleUiKeydown(event) {
    const modal = state.uiModalState.activeModal;
    if (event.key === 'Escape') {
        if (modal) {
            if (modal.id === 'ui-confirm-modal') resolveUiConfirmation(false);
            else if (modal.id === 'password-disclaimer-modal') closePasswordDisclaimer();
            else if (!urpUi || urpUi.isModalDismissible(modal)) closeUiModal(modal);
            return;
        }

        const sidebar = document.getElementById('sidebar');
        if (sidebar && sidebar.classList && sidebar.classList.contains('active')) {
            closeSidebar();
            return;
        }

        const trigger = document.getElementById('service-contact-trigger');
        const popover = document.getElementById('service-contact-popover');
        if (trigger && popover && !popover.hidden) {
            setServiceContactPopoverOpen(false);
            focusUiElement(trigger);
        }
        return;
    }

    const sidebar = document.getElementById('sidebar');
    const focusContainer = modal || (sidebar?.classList.contains('active') ? sidebar : null);
    if (event.key !== 'Tab' || !focusContainer) return;
    const focusable = getUiFocusable(focusContainer);
    if (focusable.length === 0) {
        event.preventDefault();
        return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        focusUiElement(last);
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        focusUiElement(first);
    }
}

export function setUiFocusInput(input) {
    document.body?.setAttribute?.('data-focus-input', input);
}

export function handleUiFocusKeyDown(event) {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (['Tab', 'Enter', ' ', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
        setUiFocusInput('keyboard');
    }
}

export function initializeUI() {
document.addEventListener('pointerdown', () => setUiFocusInput('pointer'), true);
document.addEventListener('keydown', handleUiFocusKeyDown, true);
document.addEventListener('keydown', handleUiKeydown);
document.addEventListener('click', handleModalBackdropClick);
}
