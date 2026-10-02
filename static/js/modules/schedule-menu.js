import { pageResources } from './lifecycle.js';
import { resetScheduleActionGesture, hideScheduleActions } from './schedule-gestures.js';
const resources = pageResources('schedule');

export function mountScheduleMenu() {
    const page = document.getElementById('page-schedule');
    const trigger = document.getElementById('schedule-mobile-more');
    if (!page || !trigger) return;
    const root = document.documentElement;
    const narrow = window.matchMedia('(max-width: 1099px)');
    const mobile = window.matchMedia('(max-width: 768px)');
    const sources = Array.from(document.querySelectorAll('[data-schedule-action]'));
    const originalControls = trigger.getAttribute('aria-controls');
    const originalPopup = trigger.getAttribute('aria-haspopup');
    const menu = document.createElement('dialog');
    menu.id = 'schedule-action-menu';
    menu.className = 'schedule-action-menu';
    menu.setAttribute('aria-labelledby', 'schedule-action-menu-title');
    menu.innerHTML = `<div class="schedule-action-menu-heading"><h2 id="schedule-action-menu-title">日程表操作</h2><button type="button" class="schedule-action-menu-close">关闭</button></div><div class="schedule-action-menu-list" role="group" aria-label="日程表操作"></div>`;
    document.body.append(menu);
    const list = menu.querySelector('.schedule-action-menu-list');
    const copies = new Map();
    let enabled = false;
    let restoreOnClose = true;

    function isEnabled() {
        return enabled && root.dataset.uiTemplate === 'glass' && narrow.matches;
    }

    function restoreFocus() {
        if (!page.classList.contains('active') || document.querySelector('dialog[open], .modal.active')) return;
        const desktopTrigger = document.getElementById('schedule-more')?.querySelector('summary');
        const target = [trigger, desktopTrigger].find(element => element?.getClientRects().length);
        target?.focus({ preventScroll: true });
    }

    function close({ restoreFocus: shouldRestore = true } = {}) {
        if (!menu.open) return;
        restoreOnClose = shouldRestore;
        menu.close();
        trigger.setAttribute('aria-expanded', 'false');
        document.body.classList.remove('schedule-action-menu-open');
    }

    function renderActions() {
        list.replaceChildren();
        copies.clear();
        sources.forEach(source => {
            // The mobile update button is already directly available beside More.
            if (source.dataset.scheduleAction === 'update' && mobile.matches) return;
            const action = document.createElement('button');
            action.type = 'button';
            action.className = 'schedule-action-menu-item';
            action.dataset.scheduleCommand = source.dataset.scheduleAction;
            action.textContent = source.textContent.trim();
            action.disabled = source.disabled;
            copies.set(source, action);
            resources.listen(action, 'click', () => {
                if (source.disabled) return;
                close({ restoreFocus: false });
                trigger.focus({ preventScroll: true });
                source.click();
            });
            list.append(action);
        });
    }

    function positionMenu() {
        const anchor = trigger.getBoundingClientRect();
        const bounds = menu.getBoundingClientRect();
        const inset = 12;
        const left = Math.max(inset, Math.min(anchor.right - bounds.width, innerWidth - bounds.width - inset));
        const below = anchor.bottom + 8;
        const above = anchor.top - bounds.height - 8;
        const top = below + bounds.height <= innerHeight - inset ? below
            : above >= inset ? above : Math.max(inset, innerHeight - bounds.height - inset);
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
        menu.dataset.placement = top < anchor.top ? 'above' : 'below';
    }

    function open() {
        if (!isEnabled() || !page.classList.contains('active') || menu.open) return;
        renderActions();
        restoreOnClose = true;
        menu.showModal();
        positionMenu();
        trigger.setAttribute('aria-expanded', 'true');
        document.body.classList.add('schedule-action-menu-open');
        (list.querySelector('button:not(:disabled)') || menu.querySelector('.schedule-action-menu-close')).focus();
    }

    window.ScheduleActionsMenu = { isEnabled, open, close, toggle() { if (menu.open) close(); else open(); } };

    const sourceObserver = resources.observe(new MutationObserver(() => {
        copies.forEach((action, source) => {
            action.textContent = source.textContent.trim();
            action.disabled = source.disabled;
        });
    }));
    sources.forEach(source => sourceObserver.observe(source, { attributes: true, attributeFilter: ['disabled'], childList: true, characterData: true, subtree: true }));

    function syncMode() {
        close();
        const next = root.dataset.uiTemplate === 'glass' && narrow.matches;
        // Collapse the old panel through its normal path before enabling the new presentation.
        enabled = false;
        resetScheduleActionGesture();
        if (next) hideScheduleActions(false);
        enabled = next;
        page.classList.toggle('has-glass-action-menu', enabled);
        trigger.setAttribute('aria-controls', enabled ? menu.id : originalControls);
        if (enabled) trigger.setAttribute('aria-haspopup', 'dialog');
        else if (originalPopup) trigger.setAttribute('aria-haspopup', originalPopup);
        else trigger.removeAttribute('aria-haspopup');
    }

    resources.listen(menu.querySelector('.schedule-action-menu-close'), 'click', () => close());
    resources.listen(menu, 'click', event => {
        if (event.target !== menu) return;
        const bounds = menu.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right
            || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    });
    resources.listen(menu, 'close', () => {
        if (menu.open) return;
        trigger.setAttribute('aria-expanded', 'false');
        document.body.classList.remove('schedule-action-menu-open');
        if (restoreOnClose) restoreFocus();
    });
    resources.listen(menu, 'keydown', event => {
        event.stopPropagation();
        const buttons = Array.from(menu.querySelectorAll('button:not(:disabled)'));
        if (event.key === 'Tab') {
            if (event.shiftKey && document.activeElement === buttons[0]) {
                event.preventDefault();
                buttons[buttons.length - 1].focus();
            } else if (!event.shiftKey && document.activeElement === buttons[buttons.length - 1]) {
                event.preventDefault();
                buttons[0].focus();
            }
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const index = buttons.indexOf(document.activeElement);
            buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }
    });
    resources.observe(new MutationObserver(syncMode)).observe(root, { attributes: true, attributeFilter: ['data-ui-template'] });
    resources.listen(narrow, 'change', syncMode);
    resources.listen(mobile, 'change', syncMode);
    resources.listen(window, 'resize', () => close());
    resources.listen(window.visualViewport, 'resize', () => close());
    resources.addCleanup(() => {
        close({ restoreFocus: false });
        copies.clear();
        menu.remove();
        page.classList.remove('has-glass-action-menu');
        trigger.setAttribute('aria-controls', originalControls);
        if (originalPopup) trigger.setAttribute('aria-haspopup', originalPopup);
        else trigger.removeAttribute('aria-haspopup');
        delete window.ScheduleActionsMenu;
    });
    syncMode();
}

