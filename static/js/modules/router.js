import { state } from './store.js';
import { pageResources } from './lifecycle.js';
import { closeUiModal, openUiModal, toggleUiClass, urpUi } from './ui.js';
import { isDesktopWorkspace, isMobileWorkspace } from './navigation.js';
import { showLoginModal } from './auth.js';
import { mountExams } from './exams.js';
const registeredPages = new Map();

export function registerPage(name, hooks) {
    registeredPages.set(name, hooks);
}

export function unmountCurrentPage() {
    const name = state.currentPage;
    if (!name) return;
    try { registeredPages.get(name)?.unmount?.(); }
    finally {
        pageResources(name).dispose();
        state.currentPage = null;
    }
}


export function getAvailablePageNames() {
    const pageElements = document.querySelectorAll('.page');
    const fromDom = Array.from(pageElements || [])
        .map(page => page.id || '')
        .filter(id => id.startsWith('page-'))
        .map(id => id.slice(5));
    if (fromDom.length > 0) return fromDom;

    return [
        'home', 'schedule', 'exams', 'grades', 'evaluation',
        'service-status', 'feedback', 'shortcut-api', 'member',
    ].filter(pageName => document.getElementById(`page-${pageName}`));
}

export function switchPage(pageName, params = {}) {
    const { scheduleWeek = null } = params;
    if (pageName === 'exams') {
        openScheduleExams();
        return;
    }
    let targetPage = document.getElementById(`page-${pageName}`);
    if (!targetPage) {
        pageName = 'home';
        targetPage = document.getElementById('page-home');
    }

    const availablePages = getAvailablePageNames();
    if (urpUi && availablePages.length > 0) {
        pageName = urpUi.normalizePageName(pageName, availablePages, 'home');
        targetPage = document.getElementById(`page-${pageName}`)
            || document.getElementById('page-home');
    }

    // Unmount before hiding DOM, so focus and resource cleanup still see the old page.
    unmountCurrentPage();
    const modal = state.uiModalState.activeModal;
    if (modal && !['login-modal', 'password-disclaimer-modal', 'announcement-modal'].includes(modal.id)) {
        closeUiModal(modal, { restoreFocus: false, animate: false });
    }
    state.currentPage = pageName;
    pageResources(pageName).activate();

    // 隐藏所有页面
    const pages = document.querySelectorAll('.page');
    pages.forEach(page => page.classList.remove('active'));

    // 显示目标页面
    if (targetPage) {
        targetPage.classList.add('active');
    }

    // 更新页面标题
    const titles = {
        'home': '首页',
        'schedule': '日程表',
        'exams': '考试安排',
        'grades': '成绩查询',
        'evaluation': '教学评估',
        'service-status': '找我做事',
        'feedback': '反馈建议',
        'shortcut-api': '快捷指令 API',
        'lab': '实验提交',
        'member': '会员购买',
    };
    document.getElementById('page-title').textContent = titles[pageName] || '首页';

    // 更新导航项激活状态
    const navItems = document.querySelectorAll('.nav-item');
    const selectedNavPage = pageName === 'exams' ? 'schedule' : pageName;
    navItems.forEach(nav => {
        if (nav.getAttribute('data-page') === selectedNavPage) {
            nav.classList.add('active');
            if (typeof nav.setAttribute === 'function') {
                nav.setAttribute('aria-current', 'page');
            }
        } else {
            nav.classList.remove('active');
            if (typeof nav.removeAttribute === 'function') {
                nav.removeAttribute('aria-current');
            }
        }
    });

    const more = document.getElementById('mobile-nav-more');
    if (more) {
        const isMorePage = !['home', 'schedule', 'grades'].includes(selectedNavPage);
        toggleUiClass(more, 'active', isMorePage);
        if (isMorePage) more.setAttribute('aria-current', 'true');
        else more.removeAttribute('aria-current');
    }

    // 保存当前页面到 localStorage
    localStorage.setItem('current_page', pageName);

    // 加载对应页面的数据
    const mounted = loadPageData(pageName, { ...params, scheduleWeek });
    Promise.resolve(mounted).catch(error => {
        if (error.name !== 'AbortError') console.error('页面加载失败:', error);
    });
}

export function openHomeShortcut(pageName) {
    if (pageName === 'exams') {
        openScheduleExams();
        return;
    }
    switchPage(pageName);
    focusCurrentPage(pageName);
}

export function focusCurrentPage(pageName) {
    if (isDesktopWorkspace() || isMobileWorkspace()) {
        const page = document.getElementById(`page-${pageName}`);
        const heading = Array.from(page?.querySelectorAll?.('h1, h2') || [])
            .find(element => element.getClientRects().length > 0);
        const target = heading || page;
        if (target) {
            target.setAttribute('tabindex', '-1');
            if (!heading) target.setAttribute('aria-label', document.getElementById('page-title')?.textContent || pageName);
            target.focus({ preventScroll: isDesktopWorkspace() });
        }
        return;
    }
    const title = document.getElementById('page-title');
    if (title && typeof title.focus === 'function') title.focus();
}

export function openScheduleExams() {
    if (state.isGuestMode) {
        showLoginModal();
        return;
    }
    const modal = document.getElementById('exams-modal');
    openUiModal(modal, { initialFocusSelector: '#exams-close-btn' });
    document.getElementById('exams-content').scrollTop = 0;
    mountExams(modal);
}

export function setPageAccessLock(pageName, locked) {
    const page = document.getElementById(`page-${pageName}`);
    const gate = page && typeof page.querySelector === 'function'
        ? page.querySelector('[data-page-access-gate]')
        : null;
    if (!page || !gate) return;

    toggleUiClass(page, 'is-access-locked', locked);
    gate.hidden = !locked;
    if (locked) {
        const copy = urpUi
            ? urpUi.getGuestAccessCopy(pageName)
            : {
                title: '登录教务账号后继续',
                description: '请先登录教务账号，再使用此功能。',
                button: '立即登录',
            };
        gate.innerHTML = `
            <div class="page-access-gate-icon" aria-hidden="true">锁</div>
            <h2>${escapeHtml(copy.title)}</h2>
            <p>${escapeHtml(copy.description)}</p>
            <button class="btn-primary" type="button" onclick="showLoginModal()">${escapeHtml(copy.button)}</button>`;
    } else if (typeof gate.replaceChildren === 'function') {
        gate.replaceChildren();
    } else {
        gate.innerHTML = '';
    }
}

export function loadPageData(pageName, params = {}) {
    const gatedPages = ['schedule', 'exams', 'grades', 'evaluation', 'shortcut-api', 'lab'];
    if (gatedPages.includes(pageName)) {
        setPageAccessLock(pageName, state.isGuestMode);
        if (state.isGuestMode) return;
    }
    const hooks = registeredPages.get(pageName);
    if (!hooks) return;
    return hooks.mount(document.getElementById(`page-${pageName}`), params);
}
