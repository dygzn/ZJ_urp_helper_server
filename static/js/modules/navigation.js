import { pageResources } from './lifecycle.js';
import { state, store } from './store.js';
import { focusUiElement, syncUiOverlay, toggleUiClass } from './ui.js';
import { focusCurrentPage, switchPage } from './router.js';
const resources = pageResources('navigation');

export function isDesktopWorkspace() {
    return Boolean(window.matchMedia?.('(min-width: 1100px)').matches);
}

export function isMobileWorkspace() {
    return Boolean(window.matchMedia?.('(max-width: 768px)').matches);
}

export function getSidebarTrigger() {
    return document.getElementById(isMobileWorkspace() ? 'mobile-nav-more' : 'menu-trigger');
}

export function initMobileWorkspaceLayout() {
    const query = window.matchMedia?.('(max-width: 768px)');
    const announcement = document.getElementById('announcement-trigger');
    const announcementSlot = document.getElementById('mobile-announcement-slot');
    const moreUsername = document.getElementById('more-account-name');
    const header = announcement?.parentElement;
    if (!query || !header) return;
    const sync = () => {
        closeSidebar({ restoreFocus: false });
        if (query.matches) {
            if (announcement && announcementSlot) announcementSlot.append(announcement);
        } else {
            if (announcement) header.append(announcement);
        }
    };
    query.addEventListener?.('change', sync);
    sync();
    const syncAccount = () => {
        const loggedIn = Boolean(state.currentUsername && !state.isGuestMode);
        const displayName = loggedIn
            ? `${state.currentUsername}${state.temporarySessionExpiresAt ? ' · 临时' : ''}`
            : '访客';
        if (moreUsername) moreUsername.textContent = displayName;
        const desktopAccount = document.querySelector?.('.desktop-account');
        if (desktopAccount) {
            desktopAccount.textContent = loggedIn ? displayName : '登录账号';
            desktopAccount.setAttribute('title', loggedIn ? `当前账号：${displayName}（点击换绑）` : '点击登录教务账号');
        }
        const rebindBtn = document.querySelector?.('.sidebar-footer .rebind-btn');
        if (rebindBtn) {
            rebindBtn.textContent = loggedIn ? '换绑账号' : '登录账号';
        }
    };
    syncAccount();
    resources.addCleanup(store.subscribe((value, key) => {
        if (['currentUsername', 'temporarySessionExpiresAt', 'isGuestMode'].includes(key)) syncAccount();
    }));
}

export function createDesktopWorkspaceLayout(scope = resources) {
    if (typeof document.querySelector !== 'function') return () => {};
    const sidebar = document.getElementById('sidebar');
    const nav = sidebar?.querySelector('.sidebar-nav');
    const host = document.getElementById('desktop-navigation');
    const navMore = document.getElementById('desktop-nav-more');
    const actions = document.querySelector('.schedule-data-actions');
    const more = document.getElementById('schedule-more');
    if (!nav || !host || !navMore || !actions || !more) return () => {};
    const links = Array.from(nav.querySelectorAll('.nav-item'));
    const buttons = Array.from(actions.querySelectorAll(':scope > button'));
    const menus = [navMore, more];
    menus.forEach(menu => {
        scope.listen(menu, 'click', event => {
            if (event.target.closest('button, a')) menu.querySelector('summary').focus();
        }, true);
        scope.listen(menu, 'click', event => {
            if (event.target.closest('button, a')) menu.open = false;
        });
        scope.listen(menu, 'keydown', event => {
            if (event.key === 'Escape' && menu.open) {
                menu.open = false;
                menu.querySelector('summary').focus();
                event.stopPropagation();
            }
        });
    });
    scope.listen(document, 'click', event => {
        menus.forEach(menu => { if (!menu.contains(event.target)) menu.open = false; });
    });
    return desktop => {
        menus.forEach(menu => { menu.open = false; });
        if (desktop) {
            host.append(nav);
            links.slice(5).forEach(link => navMore.querySelector('.desktop-menu-items').append(link));
            buttons.forEach(button => more.querySelector('.desktop-menu-items').append(button));
        } else {
            links.forEach(link => nav.append(link));
            sidebar.insertBefore(nav, sidebar.querySelector('.sidebar-footer'));
            buttons.forEach(button => actions.insertBefore(button, more));
        }
    };
}

export function openSidebar() {
    if (isMobileWorkspace()) {
        switchPage('more');
        focusCurrentPage('more');
        return;
    }
    if (isDesktopWorkspace()) return;
    const sidebar = document.getElementById('sidebar');
    const trigger = getSidebarTrigger();
    toggleUiClass(sidebar, 'active', true);
    sidebar?.setAttribute('aria-hidden', 'false');
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
    syncUiOverlay();
    const closeButton = sidebar && sidebar.querySelector
        ? sidebar.querySelector('.close-btn')
        : null;
    focusUiElement(closeButton);
}

export function closeSidebar({ restoreFocus = true } = {}) {
    const sidebar = document.getElementById('sidebar');
    const trigger = getSidebarTrigger();
    if (sidebar?.contains?.(document.activeElement)) document.activeElement?.blur?.();
    toggleUiClass(sidebar, 'active', false);
    sidebar?.setAttribute('aria-hidden', 'true');
    ['menu-trigger'].forEach(id => {
        document.getElementById(id)?.setAttribute('aria-expanded', 'false');
    });
    syncUiOverlay();
    if (restoreFocus && !isDesktopWorkspace()) focusUiElement(trigger);
}

export function initializeNavigation() {
    initMobileWorkspaceLayout();
    const desktopQuery = window.matchMedia?.('(min-width: 1100px)');
    const sync = () => syncDesktopWorkspaceLayout(Boolean(desktopQuery?.matches));
    resources.listen(desktopQuery, 'change', sync);
    sync();
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', function(event) {
            event.preventDefault();
            const pageName = this.getAttribute('data-page');
            switchPage(pageName);
            closeSidebar({ restoreFocus: false });
            focusCurrentPage(pageName);
        });
    });
}

let desktopLayoutSync = null;
export function syncDesktopWorkspaceLayout(desktop) {
    if (!desktopLayoutSync) desktopLayoutSync = createDesktopWorkspaceLayout();
    desktopLayoutSync(desktop);
}
