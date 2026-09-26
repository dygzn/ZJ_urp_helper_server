const pendingInvitationTokenKey = 'pending_invitation_token';
const ownInvitationTokenKey = 'own_invitation_token';

function capturePendingInvitationToken() {
    try {
        const token = (new URLSearchParams(window.location.search).get('invite') || '').trim();
        const ownToken = (sessionStorage.getItem(ownInvitationTokenKey) || '').trim();
        if (token && token.length <= 128 && token !== ownToken) {
            sessionStorage.setItem(pendingInvitationTokenKey, token);
        }
    } catch (error) {
        // 隐私模式或禁用存储时不影响普通登录。
    }
}

function getPendingInvitationToken() {
    try {
        const token = (sessionStorage.getItem(pendingInvitationTokenKey) || '').trim();
        return token.length > 0 && token.length <= 128 ? token : '';
    } catch (error) {
        return '';
    }
}

function clearPendingInvitationToken() {
    try {
        sessionStorage.removeItem(pendingInvitationTokenKey);
    } catch (error) {
        // 存储不可用时无需阻断登录结果。
    }
}

function sanitizeIndexUrl() {
    try {
        const currentUrl = new URL(window.location.href);
        const cleanParams = new URLSearchParams();
        ['page', 'invite'].forEach(key => {
            const value = currentUrl.searchParams.get(key);
            if (value) cleanParams.set(key, value);
        });

        const cleanSearch = cleanParams.toString();
        const cleanUrl = `${currentUrl.pathname || '/'}${cleanSearch ? `?${cleanSearch}` : ''}${currentUrl.hash || ''}`;
        const currentPath = `${currentUrl.pathname || '/'}${currentUrl.search}${currentUrl.hash || ''}`;
        if (cleanUrl !== currentPath && window.history && typeof window.history.replaceState === 'function') {
            window.history.replaceState(window.history.state || null, '', cleanUrl);
        }
    } catch (error) {
        // 地址栏清理失败时不影响正常使用。
    }
}

function setOwnInvitationTokenInUrl(token) {
    const normalizedToken = String(token || '').trim();
    if (!normalizedToken || normalizedToken.length > 128) return false;

    try {
        const currentUrl = new URL(window.location.href);
        const cleanParams = new URLSearchParams();
        const page = currentUrl.searchParams.get('page');
        if (page) cleanParams.set('page', page);
        cleanParams.set('invite', normalizedToken);

        const query = cleanParams.toString();
        const cleanUrl = `${currentUrl.pathname || '/'}${query ? `?${query}` : ''}${currentUrl.hash || ''}`;
        if (window.history && typeof window.history.replaceState === 'function') {
            window.history.replaceState(window.history.state || null, '', cleanUrl);
            return true;
        }
    } catch (error) {
        // 地址栏同步失败时不影响正常使用。
    }
    return false;
}

async function ensureOwnInvitationTokenInUrl() {
    try {
        const response = await fetch('/api/invitation/link', {
            method: 'POST',
            headers: { 'X-Device-ID': getDeviceId() },
        });
        const data = await response.json().catch(() => ({ success: false }));
        if (!response.ok || !data.success || !data.data || !data.data.invite_url) {
            return false;
        }

        const inviteUrl = new URL(data.data.invite_url, window.location.origin);
        const token = inviteUrl.searchParams.get('invite');
        const updated = setOwnInvitationTokenInUrl(token);
        if (!updated) return false;

        try {
            sessionStorage.setItem(ownInvitationTokenKey, token);
            if (getPendingInvitationToken() === token) {
                clearPendingInvitationToken();
            }
        } catch (error) {
            // 存储不可用时不影响地址栏同步。
        }
        return true;
    } catch (error) {
        return false;
    }
}

// ==================== 全局变量 ====================
let currentWeek = parseInt(localStorage.getItem('current_week')) || 1;
let currentUsername = null;
let currentMemberStatus = null;
let shortcutApiPlainKey = '';
let shortcutApiHasKey = false;
let isCheckingLoginStatus = false;
let cachedSchedule = null;
let cachedExams = null;
let semesterStart = null;   // 学期第1周星期一的日期
let academicCacheUsername = null;
let academicCacheGeneration = 0;
let calendarExportKind = null;
let calendarExportData = null;
let calendarExportAccount = '';
let isGuestMode = false;    // 访客模式（未绑定账号）

// ==================== 标题栏广告位 ====================
const headerAdNeverShowKey = 'urp_header_ad_never_show';
const headerAdDismissedKey = 'urp_header_ad_dismissed';
const boundUsernameStorageKey = 'urp_bound_username';
let headerAdImpressionTracked = false;

function rememberBoundUsername(username) {
    const normalized = String(username || '').trim();
    if (academicCacheUsername !== normalized) {
        academicCacheGeneration++;
        if (calendarExportKind) closeCalendarExport();
        cachedSchedule = null;
        cachedExams = null;
        semesterStart = null;
        otherMajorScheduleData = null;
        calendarExportData = null;
        calendarExportAccount = '';
        academicCacheUsername = normalized;
        if (typeof document.querySelectorAll === 'function') {
            document.querySelectorAll('.schedule-week-panel .schedule-days').forEach(el => { el.innerHTML = ''; });
            document.querySelectorAll('[data-schedule-date]').forEach(el => { el.textContent = ''; });
            document.querySelectorAll('.schedule-day-today').forEach(el => el.classList.remove('schedule-day-today'));
            const examsContent = document.getElementById('exams-content');
            if (examsContent) examsContent.innerHTML = '<div class="loading">加载中...</div>';
        }
    }
    try {
        if (normalized) {
            localStorage.setItem(boundUsernameStorageKey, normalized);
        } else {
            localStorage.removeItem(boundUsernameStorageKey);
        }
    } catch (error) {
        // 本地存储不可用时不影响登录和广告浏览。
    }
}

function trackHeaderAdEvent(eventName) {
    fetch('/api/ad/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: eventName }),
        keepalive: true,
    }).catch(() => {});
}

function headerAdStorageHas(storage, key) {
    try {
        return storage.getItem(key) === '1';
    } catch (error) {
        return false;
    }
}

function renderHeaderAd() {
    const slot = document.getElementById('header-ad-slot');
    const card = document.getElementById('header-ad-card');
    const detail = document.getElementById('header-ad-detail');
    const optionsButton = document.querySelector('.header-ad-options');
    const restoreButton = document.getElementById('header-ad-restore');
    if (!slot || !card || !detail || !optionsButton || !restoreButton) return;

    const neverShow = headerAdStorageHas(localStorage, headerAdNeverShowKey);
    const dismissed = !neverShow && headerAdStorageHas(sessionStorage, headerAdDismissedKey);

    slot.hidden = neverShow;
    card.hidden = dismissed;
    restoreButton.hidden = !dismissed;
    detail.hidden = true;
    optionsButton.setAttribute('aria-expanded', 'false');

    if (!neverShow && !dismissed && !headerAdImpressionTracked) {
        headerAdImpressionTracked = true;
        trackHeaderAdEvent('impression');
    }
}

function handleHeaderAdAction(action) {
    const detail = document.getElementById('header-ad-detail');
    const optionsButton = document.querySelector('.header-ad-options');
    if (!detail || !optionsButton) return;

    if (action === 'options' || action === 'detail') {
        const isExpanded = !detail.hidden;
        detail.hidden = isExpanded;
        optionsButton.setAttribute('aria-expanded', String(!isExpanded));
        return;
    }

    if (action === 'dismiss') {
        trackHeaderAdEvent('dismiss');
        try {
            sessionStorage.setItem(headerAdDismissedKey, '1');
        } catch (error) {
            // 存储不可用时仍允许当前页面关闭广告。
        }
        renderHeaderAd();
        return;
    }

    if (action === 'never-show') {
        trackHeaderAdEvent('dismiss');
        try {
            localStorage.setItem(headerAdNeverShowKey, '1');
            sessionStorage.removeItem(headerAdDismissedKey);
        } catch (error) {
            // 存储不可用时不阻断网站其他功能。
        }
        renderHeaderAd();
        return;
    }

    if (action === 'restore') {
        try {
            sessionStorage.removeItem(headerAdDismissedKey);
        } catch (error) {
            // 存储不可用时无需阻断恢复按钮。
        }
        renderHeaderAd();
    }
}

function initializeHeaderAd() {
    const slot = document.getElementById('header-ad-slot');
    if (!slot) return;

    slot.addEventListener('click', function(event) {
        const target = event.target instanceof Element
            ? event.target.closest('[data-ad-action]')
            : null;
        if (!target) return;
        handleHeaderAdAction(target.dataset.adAction);
    });
    renderHeaderAd();
}

// ==================== 通用 UI 状态 ====================
const urpUi = typeof URPUI !== 'undefined' ? URPUI : null;
const uiModalState = {
    activeModal: null,
    returnFocus: null,
    confirmationResolve: null,
};

function toggleUiClass(element, className, force) {
    if (!element || !element.classList) return false;
    if (typeof element.classList.toggle === 'function') {
        return element.classList.toggle(className, force);
    }
    if (force) element.classList.add(className);
    else element.classList.remove(className);
    return force;
}

function syncUiOverlay() {
    const overlay = document.getElementById('overlay');
    const sidebar = document.getElementById('sidebar');
    const activeModal = uiModalState.activeModal;
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

function focusUiElement(element) {
    if (!element || typeof element.focus !== 'function') return;
    try {
        element.focus({ preventScroll: true });
    } catch (error) {
        element.focus();
    }
}

function getUiFocusable(container) {
    if (urpUi && typeof urpUi.getFocusableElements === 'function') {
        return urpUi.getFocusableElements(container);
    }
    if (!container || typeof container.querySelectorAll !== 'function') return [];
    return Array.from(container.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )).filter(element => !element.disabled && !element.hidden);
}

function openUiModal(modal, { initialFocusSelector = '' } = {}) {
    if (!modal) return;

    if (uiModalState.activeModal && uiModalState.activeModal !== modal) {
        closeUiModal(uiModalState.activeModal, { restoreFocus: false });
    }

    if (!uiModalState.activeModal) {
        uiModalState.returnFocus = document.activeElement || null;
    }
    uiModalState.activeModal = modal;
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

function closeUiModal(modal, { restoreFocus = true } = {}) {
    if (!modal) return;

    toggleUiClass(modal, 'active', false);
    if (typeof modal.setAttribute === 'function') {
        modal.setAttribute('aria-hidden', 'true');
    }
    if (uiModalState.activeModal === modal) {
        uiModalState.activeModal = null;
        const focusTarget = uiModalState.returnFocus;
        uiModalState.returnFocus = null;
        if (restoreFocus && focusTarget && focusTarget.isConnected !== false) {
            focusUiElement(focusTarget);
        }
    }
    syncUiOverlay();
}

function showUiToast(message, type = 'info') {
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

function resolveUiConfirmation(confirmed) {
    const resolver = uiModalState.confirmationResolve;
    uiModalState.confirmationResolve = null;
    closeUiModal(document.getElementById('ui-confirm-modal'));
    if (resolver) resolver(Boolean(confirmed));
}

function requestUiConfirmation({
    title,
    message,
    confirmText = '确认',
    cancelText = '取消',
    danger = false,
} = {}) {
    const modal = document.getElementById('ui-confirm-modal');
    if (!modal) return Promise.resolve(false);

    if (uiModalState.confirmationResolve) {
        uiModalState.confirmationResolve(false);
        uiModalState.confirmationResolve = null;
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
        uiModalState.confirmationResolve = resolve;
        openUiModal(modal, { initialFocusSelector: '#ui-confirm-cancel' });
    });
}

function handleOverlayClick(event) {
    if (!event || event.target !== event.currentTarget) return;

    const modal = uiModalState.activeModal;
    if (modal && (!urpUi || urpUi.isModalDismissible(modal))) {
        if (modal.id === 'ui-confirm-modal') resolveUiConfirmation(false);
        else if (modal.id === 'password-disclaimer-modal') closePasswordDisclaimer();
        else closeUiModal(modal);
        return;
    }
    closeSidebar();
}

function handleModalBackdropClick(event) {
    const modal = event?.target;
    if (!modal || !modal.classList?.contains('modal') || modal !== uiModalState.activeModal) {
        return;
    }
    if (modal.id === 'ui-confirm-modal') resolveUiConfirmation(false);
    else if (modal.id === 'password-disclaimer-modal') closePasswordDisclaimer();
    else if (!urpUi || urpUi.isModalDismissible(modal)) closeUiModal(modal);
}

function handleUiKeydown(event) {
    const modal = uiModalState.activeModal;
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

    if (event.key !== 'Tab' || !modal) return;
    const focusable = getUiFocusable(modal);
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

document.addEventListener('keydown', handleUiKeydown);
document.addEventListener('click', handleModalBackdropClick);

// ==================== 设备ID管理 ====================
function getDeviceId() {
    /**
     * 获取或生成设备ID
     * 设备ID存储在 localStorage 中，确保同一浏览器在不同网络环境下ID相同
     */
    let deviceId = localStorage.getItem('device_id');
    if (!deviceId) {
        // 生成新的UUID
        deviceId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
        localStorage.setItem('device_id', deviceId);
        console.log('生成新的设备ID:', deviceId);
    }
    return deviceId;
}

// ==================== 页面初始化 ====================
document.addEventListener('DOMContentLoaded', function() {
    // 确保设备ID已生成
    getDeviceId();

    // 初始化标题栏广告位，不影响登录状态检查
    initializeHeaderAd();

    // 先暂存邀请链接 token，等待首次绑定时随登录请求发送
    capturePendingInvitationToken();

    // 清除支付平台等第三方追加的未知参数
    sanitizeIndexUrl();

    // 检查用户绑定状态
    checkBindStatus();
});

// ==================== 登录状态检查 ====================
async function checkLoginStatus() {
    // 防止重复检查
    if (isCheckingLoginStatus) {
        return;
    }

    isCheckingLoginStatus = true;
    const statusDot = document.querySelector('.status-dot');
    const statusText = document.querySelector('.status-text');

    // 显示检查中状态
    statusDot.className = 'status-dot status-checking';
    statusText.textContent = '检查中';

    try {
        const response = await fetch('/api/check_login_status', {
            headers: {
                'X-Device-ID': getDeviceId()
            }
        });
        const data = await response.json();

        if (data.success && data.logged_in) {
            // 登录状态正常
            statusDot.className = 'status-dot status-online';
            statusText.textContent = 'Online';
        } else {
            // 登录失效或未登录
            statusDot.className = 'status-dot status-offline';
            statusText.textContent = 'Offline';
        }
    } catch (error) {
        console.error('检查登录状态失败:', error);
        statusDot.className = 'status-dot status-offline';
        statusText.textContent = 'Error';
    } finally {
        isCheckingLoginStatus = false;
    }
}

// ==================== API请求：检查绑定状态 ====================
async function checkBindStatus() {
    const generation = academicCacheGeneration;
    try {
        const response = await fetch('/api/check_bind', {
            headers: {
                'X-Device-ID': getDeviceId()
            }
        });
        const data = await response.json();

        if (generation !== academicCacheGeneration) return;
        if (data.rebind_notifications && data.rebind_notifications.length > 0) {
            showRebindNotifications(data.rebind_notifications);
        }

        if (data.success && data.bound) {
            currentUsername = data.username;
            rememberBoundUsername(currentUsername);
            document.getElementById('sidebar-username').textContent = currentUsername;
            ensureOwnInvitationTokenInUrl();

            const urlPage = new URLSearchParams(window.location.search).get('page');
            let lastPage = urlPage || localStorage.getItem('current_page') || 'home';
            if (lastPage === 'tools') lastPage = 'home';
            switchPage(lastPage);
            loadAndShowAnnouncements();
        } else {
            currentUsername = null;
            rememberBoundUsername(null);
            showLoginModal();
        }
    } catch (error) {
        console.error('检查绑定状态失败:', error);
        showLoginModal();
    }
}

// ==================== 登录相关 ====================
function showLoginModal() {
    const modal = document.getElementById('login-modal');
    openUiModal(modal, { initialFocusSelector: '#username' });
}

function hideLoginModal() {
    const modal = document.getElementById('login-modal');
    closeUiModal(modal);
}

let passwordDisclaimerReturnToLogin = false;

function showPasswordDisclaimer() {
    const modal = document.getElementById('password-disclaimer-modal');
    if (!modal) return;

    const loginModal = document.getElementById('login-modal');
    passwordDisclaimerReturnToLogin = Boolean(
        loginModal && loginModal.classList && loginModal.classList.contains('active'),
    );
    if (passwordDisclaimerReturnToLogin) {
        closeUiModal(loginModal, { restoreFocus: false });
    }
    openUiModal(modal, { initialFocusSelector: '#password-disclaimer-close' });
}

function closePasswordDisclaimer() {
    const modal = document.getElementById('password-disclaimer-modal');
    closeUiModal(modal, { restoreFocus: false });

    const shouldReturnToLogin = passwordDisclaimerReturnToLogin;
    passwordDisclaimerReturnToLogin = false;
    if (shouldReturnToLogin) {
        openUiModal(document.getElementById('login-modal'), {
            initialFocusSelector: '#bind-account',
        });
    }
}

function skipBind() {
    isGuestMode = true;
    currentUsername = null;
    rememberBoundUsername(null);
    hideLoginModal();
    document.getElementById('sidebar-username').textContent = '访客';
    switchPage('home');
    loadAndShowAnnouncements();
}

async function handleLogin(event) {
    event.preventDefault();

    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const bindControl = document.getElementById('bind-account');
    // 没有控件时按旧版客户端处理，避免旧页面升级期间意外失去绑定能力。
    const bindAccount = bindControl ? Boolean(bindControl.checked) : true;
    const invitationToken = bindAccount ? getPendingInvitationToken() : null;
    const errorDiv = document.getElementById('login-error');

    errorDiv.textContent = '';

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Device-ID': getDeviceId()
            },
            body: JSON.stringify({
                username,
                password,
                bind_account: bindAccount,
                invitation_token: invitationToken,
            })
        });

        const data = await response.json();

        if (data.success) {
            const isBound = data.bound !== false;
            hideLoginModal();

            if (isBound) {
                currentUsername = data.username;
                rememberBoundUsername(currentUsername);
                isGuestMode = false;
                clearPendingInvitationToken();
                ensureOwnInvitationTokenInUrl();
                document.getElementById('sidebar-username').textContent = currentUsername;
                const availablePages = getAvailablePageNames();
                const storedPage = localStorage.getItem('current_page') || 'home';
                const currentPage = urpUi
                    ? urpUi.normalizePageName(storedPage, availablePages, 'home')
                    : (availablePages.includes(storedPage) ? storedPage : 'home');
                switchPage(currentPage);
            } else {
                currentUsername = null;
                rememberBoundUsername(null);
                isGuestMode = true;
                document.getElementById('sidebar-username').textContent = '访客';
                switchPage('home');
                loadAndShowAnnouncements();
                showUiToast(data.message || '登录成功，本次未绑定账号；下次使用需重新登录', 'info');
            }
        } else {
            errorDiv.textContent = data.message || '登录失败';
        }
    } catch (error) {
        console.error('登录失败:', error);
        errorDiv.textContent = '网络错误，请重试';
    }
}

// ==================== 换绑相关 ====================
async function showRebindDialog() {
    const confirmed = await requestUiConfirmation({
        title: '重新绑定账号',
        message: '解绑后需要重新输入新账号密码，确定继续吗？',
        confirmText: '继续解绑',
        danger: true,
    });
    if (!confirmed) {
        return;
    }
    await unbindForRebind();
}

function closeRebindDialog() {
    const modal = document.getElementById('rebind-modal');
    closeUiModal(modal);
}

async function handleRebind(event) {
    event.preventDefault();
    await unbindForRebind();
}

async function unbindForRebind() {
    const errorDiv = document.getElementById('rebind-error');
    if (errorDiv) errorDiv.textContent = '';

    try {
        const response = await fetch('/api/request_rebind', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Device-ID': getDeviceId()
            },
            body: JSON.stringify({})
        });
        const data = await response.json();

        if (!data.success) {
            if (errorDiv) errorDiv.textContent = data.message || '解绑失败';
            else showUiToast(data.message || '解绑失败', 'error');
            return;
        }

        currentUsername = null;
        rememberBoundUsername(null);
        isGuestMode = false;
        document.getElementById('sidebar-username').textContent = '未绑定';
        closeRebindDialog();
        showLoginModal();
        showUiToast(data.message || '当前设备已解绑，请重新绑定新账号', 'success');
    } catch (error) {
        console.error('解绑失败:', error);
        if (errorDiv) errorDiv.textContent = '网络错误，请重试';
        else showUiToast('网络错误，请重试', 'error');
    }
}

function showRebindNotifications(notifications) {
    const messages = notifications.map(n => {
        if (n.status === 'approved') {
            return `你的换绑申请（${n.old_username} → ${n.new_username}）已通过，请重新登录绑定新账号`;
        }
        if (n.status === 'rejected') {
            return `你的换绑申请（${n.old_username} → ${n.new_username}）已被拒绝`;
        }
        return `你的换绑申请（${n.old_username} → ${n.new_username}）状态已更新`;
    });
    showUiToast(messages.join('；'), 'info');

    const requestIds = notifications.map(n => n.request_id);
    fetch('/api/rebind_notified', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Device-ID': getDeviceId()
        },
        body: JSON.stringify({ request_ids: requestIds })
    }).catch(() => {});
}

// ==================== 侧边栏控制 ====================
function openSidebar() {
    const sidebar = document.getElementById('sidebar');
    const trigger = document.getElementById('menu-trigger');
    toggleUiClass(sidebar, 'active', true);
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
    syncUiOverlay();
    const closeButton = sidebar && sidebar.querySelector
        ? sidebar.querySelector('.close-btn')
        : null;
    focusUiElement(closeButton);
}

function closeSidebar({ restoreFocus = true } = {}) {
    const sidebar = document.getElementById('sidebar');
    const trigger = document.getElementById('menu-trigger');
    toggleUiClass(sidebar, 'active', false);
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    syncUiOverlay();
    if (restoreFocus) focusUiElement(trigger);
}

// ==================== 页面切换 ====================
// 监听导航项点击
document.addEventListener('DOMContentLoaded', function() {
    const navItems = document.querySelectorAll('.nav-item');

    navItems.forEach(item => {
        item.addEventListener('click', function(e) {
            e.preventDefault();

            const pageName = this.getAttribute('data-page');
            switchPage(pageName);

            // 更新导航项激活状态
            navItems.forEach(nav => nav.classList.remove('active'));
            this.classList.add('active');

            // 关闭侧边栏
            closeSidebar();
        });
    });
});

function getAvailablePageNames() {
    const pageElements = document.querySelectorAll('.page');
    const fromDom = Array.from(pageElements || [])
        .map(page => page.id || '')
        .filter(id => id.startsWith('page-'))
        .map(id => id.slice(5));
    if (fromDom.length > 0) return fromDom;

    return [
        'home', 'schedule', 'exams', 'grades', 'evaluation',
        'announcements', 'service-status', 'feedback', 'shortcut-api', 'member',
    ].filter(pageName => document.getElementById(`page-${pageName}`));
}

function switchPage(pageName) {
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

    if (pageName !== 'schedule') {
        hideScheduleActions(false);
        resetQueuedScheduleSwipe();
    }

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
        'schedule': '课程表',
        'exams': '考试安排',
        'grades': '成绩查询',
        'evaluation': '教学评估',
        'announcements': '系统公告',
        'service-status': '找我做事',
        'feedback': '反馈建议',
        'shortcut-api': '快捷指令 API',
        'lab': '实验提交',
        'member': '会员购买',
    };
    document.getElementById('page-title').textContent = titles[pageName] || '首页';

    // 更新导航项激活状态
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(nav => {
        if (nav.getAttribute('data-page') === pageName) {
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

    // 保存当前页面到 localStorage
    localStorage.setItem('current_page', pageName);

    // 加载对应页面的数据
    loadPageData(pageName);
}

function setPageAccessLock(pageName, locked) {
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
            <h2>${escapeFeedbackHtml(copy.title)}</h2>
            <p>${escapeFeedbackHtml(copy.description)}</p>
            <button class="btn-primary" type="button" onclick="showLoginModal()">${escapeFeedbackHtml(copy.button)}</button>`;
    } else if (typeof gate.replaceChildren === 'function') {
        gate.replaceChildren();
    } else {
        gate.innerHTML = '';
    }
}

function loadPageData(pageName) {
    const gatedPages = ['schedule', 'exams', 'grades', 'evaluation', 'shortcut-api', 'lab'];
    if (gatedPages.includes(pageName)) {
        if (isGuestMode) {
            setPageAccessLock(pageName, true);
            return;
        }
        setPageAccessLock(pageName, false);
    }
    switch(pageName) {
        case 'home':
            loadUrgentEvent();
            break;
        case 'schedule':
            // 课程表页面自动加载
            refreshScheduleDisplay();
            break;
        case 'exams':
            loadExams();
            break;
        case 'grades':
            loadGrades();
            break;
        case 'evaluation':
            document.getElementById('evaluation-result').innerHTML = '';
            break;
        case 'announcements':
            loadAnnouncementsList();
            break;
        case 'service-status':
            loadServiceStatus();
            break;
        case 'feedback':
            loadFeedbackPage();
            break;
        case 'shortcut-api':
            loadShortcutApiPage();
            break;
        case 'lab':
            if (typeof loadLabPage === 'function') loadLabPage();
            break;
        case 'member':
            loadMemberPage();
            break;
    }
}

// ==================== 找我做事 ====================
function setServiceContactPopoverOpen(isOpen) {
    const trigger = document.getElementById('service-contact-trigger');
    const popover = document.getElementById('service-contact-popover');
    if (!trigger || !popover) return;

    trigger.setAttribute('aria-expanded', String(isOpen));
    popover.hidden = !isOpen;
}

document.addEventListener('click', async function(event) {
    const element = event.target instanceof Element ? event.target : null;
    const trigger = element?.closest('#service-contact-trigger');
    if (trigger) {
        const isOpen = trigger.getAttribute('aria-expanded') === 'true';
        setServiceContactPopoverOpen(
            ServiceStatusUI.nextContactPopoverState(isOpen, 'toggle'),
        );
        return;
    }

    const option = element?.closest('.service-contact-option[data-copy-text]');
    if (option) {
        const feedback = option.querySelector('[data-copy-feedback]');
        const originalText = feedback?.textContent || '';
        setServiceContactPopoverOpen(
            ServiceStatusUI.nextContactPopoverState(true, 'select'),
        );
        const copied = await ServiceStatusUI.copyText(option.dataset.copyText);

        if (!copied) {
            console.warn('联系账号复制失败');
            return;
        }

        if (feedback) {
            feedback.textContent = '已复制';
            window.setTimeout(() => {
                if (feedback.isConnected) feedback.textContent = originalText;
            }, 1500);
        }
        return;
    }

    const control = document.querySelector('.service-contact-control');
    const popover = document.getElementById('service-contact-popover');
    if (control && popover && !popover.hidden && !control.contains(element)) {
        setServiceContactPopoverOpen(
            ServiceStatusUI.nextContactPopoverState(true, 'outside-click'),
        );
    }
});

async function loadServiceStatus() {
    const content = document.getElementById('service-status-content');
    if (!content) return;

    content.innerHTML = '<div class="loading">加载中...</div>';

    try {
        const response = await fetch('/api/service-status');
        const result = await response.json();
        if (!response.ok || !result.success) {
            throw new Error(result.message || '状态加载失败');
        }

        const view = ServiceStatusUI.buildServiceStatusViewModel(result.data);
        const statusText = document.createElement('div');
        statusText.className = 'service-status-text';
        statusText.textContent = view.statusText;

        const availability = document.createElement('div');
        availability.className = `service-availability ${view.acceptingOrders ? 'is-accepting' : 'is-unavailable'}`;
        const availabilityDot = document.createElement('span');
        availabilityDot.className = 'service-availability-dot';
        const availabilityText = document.createElement('span');
        availabilityText.textContent = view.availabilityText;
        availability.append(availabilityDot, availabilityText);

        const updated = document.createElement('div');
        updated.className = 'service-status-updated';
        updated.textContent = view.updatedText;

        content.replaceChildren(statusText, availability, updated);
    } catch (error) {
        console.error('加载接单状态失败:', error);
        content.innerHTML = '';
        const message = document.createElement('p');
        message.className = 'service-status-error';
        message.textContent = '状态加载失败，请稍后重试';
        const retry = document.createElement('button');
        retry.className = 'btn-secondary';
        retry.type = 'button';
        retry.textContent = '重新加载';
        retry.addEventListener('click', loadServiceStatus);
        content.append(message, retry);
    }
}

// ==================== 首页：加载紧急事件 ====================
async function loadUrgentEvent() {
    const generation = academicCacheGeneration;
    // 后台检查登录状态（不阻塞日程加载）
    checkLoginStatus();

    const contentDiv = document.getElementById('urgent-content');

    if (isGuestMode) {
        contentDiv.innerHTML = '<p style="text-align:center;color:var(--text-secondary);">登录教务账号后可查看今日课程和考试安排</p>';
        return;
    }

    contentDiv.innerHTML = '<div class="loading">加载中</div>';

    try {
        const response = await fetch('/api/urgent_event', {
            headers: {
                'X-Device-ID': getDeviceId()
            }
        });
        const data = await response.json();
        if (generation !== academicCacheGeneration) return;

        if (data.success && data.event) {
            updateScheduleTimeline(data.event.is_freshman);
            displayUrgentEvent(data.event);
            const staleParts = [];
            if (data.event.schedule_cache_stale) staleParts.push('更新课程表');
            if (data.event.exams_cache_stale) staleParts.push('更新考试安排');
            if (data.event.semester_start_invalid) staleParts.push('联系管理员校正学期起始日期');
            if (staleParts.length) {
                const notice = document.createElement('p');
                notice.className = 'calendar-cache-notice';
                notice.textContent = data.event.semester_start_invalid
                    ? '后台学期起始日期无效，请联系管理员校正后再查看或导出日程。'
                    : `后台已切换学期，请到对应页面${staleParts.join('、')}后查看日程。`;
                contentDiv.prepend(notice);
            }
        } else if (data.success) {
            updateScheduleTimeline(data.is_freshman);
            contentDiv.innerHTML = '<p style="text-align:center;color:var(--text-tertiary);">今天没有课程和考试，好好休息吧~</p>';
        } else {
            contentDiv.innerHTML = '<p style="text-align:center;color:var(--text-tertiary);">今天没有课程和考试，好好休息吧~</p>';
        }
    } catch (error) {
        if (generation !== academicCacheGeneration) return;
        console.error('加载紧急事件失败:', error);
        contentDiv.innerHTML = '<p style="text-align:center;color:var(--error);">加载失败</p>';
    }
}

// 倒计时定时器
let countdownTimer = null;
let nextCountdownTimer = null;

// ==================== 校区作息时间 ====================
let userIsFreshman = false;

const PERIOD_TIMES_DEFAULT = [
    { start: '08:20', end: '09:05' }, { start: '09:15', end: '10:00' },
    { start: '10:15', end: '11:00' }, { start: '11:10', end: '11:55' },
    { start: '14:10', end: '14:55' }, { start: '15:05', end: '15:50' },
    { start: '16:05', end: '16:50' }, { start: '17:00', end: '17:45' },
    { start: '19:00', end: '19:45' }, { start: '19:55', end: '20:40' },
];

const PERIOD_TIMES_FRESHMAN = [
    { start: '08:00', end: '08:45' }, { start: '08:55', end: '09:40' },
    { start: '09:55', end: '10:40' }, { start: '10:50', end: '11:35' },
    { start: '13:30', end: '14:15' }, { start: '14:25', end: '15:10' },
    { start: '15:25', end: '16:10' }, { start: '16:20', end: '17:05' },
    { start: '18:30', end: '19:15' }, { start: '19:25', end: '20:10' },
];

function updateScheduleTimeline(isFreshman, root = document) {
    userIsFreshman = !!isFreshman;
    const times = isFreshman ? PERIOD_TIMES_FRESHMAN : PERIOD_TIMES_DEFAULT;
    root.querySelectorAll('.timeline-item').forEach((item, i) => {
        if (!times[i]) return;
        item.querySelector('.timeline-time-start').textContent = times[i].start;
        item.querySelector('.timeline-time-end').textContent = times[i].end;
    });
}

function formatMinutes(minutes) {
    if (minutes >= 60) {
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        return m > 0 ? `${h}小时${m}分钟` : `${h}小时`;
    }
    return `${minutes}分钟`;
}

function displayUrgentEvent(eventData) {
    const contentDiv = document.getElementById('urgent-content');

    if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
    }
    if (nextCountdownTimer) {
        clearInterval(nextCountdownTimer);
        nextCountdownTimer = null;
    }

    const current = eventData.current;
    const next = eventData.next;

    const now = new Date();
    const todayStr = getCalendarChinaToday(now);

    function parseDateStr(timeStr) {
        return timeStr ? timeStr.split(' ')[0] : null;
    }

    function getStartTime(timeStr) {
        if (!timeStr) return '';
        const t = timeStr.split(' ')[1] || '';
        return t.split('-')[0];
    }

    function getTimeLabel(timeStr) {
        const datePart = parseDateStr(timeStr);
        if (!datePart) return timeStr;
        const startTime = getStartTime(timeStr);
        const eventDate = new Date(datePart + 'T00:00:00Z');
        const todayDate = new Date(todayStr + 'T00:00:00Z');
        const diffDays = Math.round((eventDate - todayDate) / 86400000);
        const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        const dayName = dayNames[eventDate.getUTCDay()];

        if (diffDays === 0) return `今天 ${startTime}`;
        if (diffDays === 1) return `明天 ${startTime}`;
        if (diffDays === 2) return `后天 ${startTime}`;
        if (diffDays <= 6) return `${dayName} ${startTime}`;
        if (diffDays <= 13) return `下周${dayName.slice(1)} ${startTime}`;
        const m = eventDate.getMonth() + 1;
        const d = eventDate.getDate();
        return `${m}月${d}日 ${startTime}`;
    }

    const nextDateStr = next ? parseDateStr(next.time) : null;
    const nextIsToday = nextDateStr === todayStr;
    const noMoreToday = !current && !nextIsToday;

    let html = '';

    // 今天没课或课程已结束时，显示关怀语
    if (noMoreToday) {
        const dow = new Date(`${todayStr}T00:00:00Z`).getUTCDay();
        const nextDiffDays = nextDateStr
            ? (Date.parse(`${nextDateStr}T00:00:00Z`) - Date.parse(`${todayStr}T00:00:00Z`)) / 86400000
            : 999;
        let restMsg;
        if (dow === 5 && nextDiffDays >= 3) {
            // 周五且下一节课不在本周末
            restMsg = '周末快乐！好好放松一下吧~';
        } else if (dow === 6 && nextDiffDays >= 2) {
            // 周六且下一节课不是周日
            restMsg = '周末愉快，充充电准备新的一周~';
        } else {
            restMsg = '今天没课了，好好休息~';
        }
        html += `<p class="rest-message">${restMsg}</p>`;
    }

    // 正在进行的课程（保留倒计时）
    if (current) {
        html += `
            <div class="event-card event-card-current">
                <div class="event-type">正在进行</div>
                <div class="event-title">${current.title}</div>
                <div class="event-location">${current.location}</div>
                <div class="event-time">${current.time}</div>
                <div class="countdown" id="current-remaining">${current.remaining}分钟</div>
                <div class="countdown-label">后下课</div>
            </div>
        `;
    }

    // 下一个事件
    if (next) {
        let typeText;
        if (next.type === 'exam') {
            typeText = '考试提醒';
        } else if (nextIsToday && current) {
            typeText = '接下来';
        } else if (nextIsToday) {
            typeText = '今天还有课';
        } else {
            typeText = '下一节课';
        }
        const seatHtml = next.seat ? `<div class="event-seat">座位号: ${next.seat}</div>` : '';
        const timeLabel = getTimeLabel(next.time);
        const nextCountdownHtml = (nextIsToday && next.countdown != null)
            ? `<div class="countdown${next.countdown <= 10 ? ' countdown-urgent' : ''}" id="next-remaining">${formatMinutes(next.countdown)}</div><div class="countdown-label">后上课</div>`
            : '';

        html += `
            <div class="event-card${current ? ' event-card-next' : ' event-card-upcoming'}">
                <div class="event-type">${typeText}</div>
                <div class="event-title">${next.title}</div>
                <div class="event-location">${next.location}</div>
                <div class="event-time-label">${timeLabel}</div>
                ${seatHtml}
                ${nextCountdownHtml}
            </div>
        `;
    } else if (!current) {
        html += '<p class="rest-message" style="margin-top:8px;font-size:13px;">近期没有更多课程安排</p>';
    }

    contentDiv.innerHTML = html;

    // 正在进行中的课程倒计时（每分钟更新）
    if (current) {
        let currentRemaining = current.remaining;
        countdownTimer = setInterval(() => {
            currentRemaining--;
            const el = document.getElementById('current-remaining');
            if (!el || currentRemaining <= 0) {
                clearInterval(countdownTimer);
                countdownTimer = null;
                loadUrgentEvent();
                return;
            }
            el.textContent = `${currentRemaining}分钟`;
        }, 60000);
    }

    // 下一节课倒计时（每分钟更新）
    if (next && nextIsToday && next.countdown != null) {
        let nextRemaining = next.countdown;
        nextCountdownTimer = setInterval(() => {
            nextRemaining--;
            const el = document.getElementById('next-remaining');
            if (!el || nextRemaining <= 0) {
                clearInterval(nextCountdownTimer);
                nextCountdownTimer = null;
                loadUrgentEvent();
                return;
            }
            el.textContent = formatMinutes(nextRemaining);
            if (nextRemaining <= 10) {
                el.classList.add('countdown-urgent');
            }
        }, 60000);
    }
}

function refreshUrgentEvent() {
    loadUrgentEvent();
}

// ==================== 课程表相关 ====================
// 其他班级课表功能
let otherMajorScheduleData = null;  // 临时存储其他班级课表，不覆盖 cachedSchedule
let gradeData = {};      // {grade: {major: [class_num, ...]}}，加载一次后缓存
let omSelected = { grade: null, major: null, class_num: null };  // 弹窗内当前选中状态
const SCHEDULE_MIN_WEEK = 1;
const SCHEDULE_MAX_WEEK = 25;
const scheduleSwipeGesture = {
    pointerId: null,
    pointerType: null,
    swipe: null,
    startX: 0,
    startY: 0,
    lastX: 0,
    startTime: 0,
    width: 1,
    dragging: false,
    cancelled: false,
    moved: false,
    obstacleType: null,
    crossedObstacle: false,
    airborne: false,
    crashed: false,
    crashFinished: false,
    releasedAfterCrash: false,
    lastMoveTime: 0,
};
let scheduleSwipeTransition = null;
let scheduleSwipeTransitionTimer = null;
let scheduleDinoHoldTimer = null;
let scheduleDinoAirborneTimer = null;
let scheduleDinoCrashTimer = null;
let suppressScheduleSwipeClick = false;
let scheduleSwipeFrame = null;
let scheduleSwipePendingEvent = null;
let scheduleQueuedSwipe = 0;
const scheduleQueuedPointer = {
    pointerId: null,
    startX: 0,
    startY: 0,
    lastX: 0,
    startTime: 0,
    width: 1,
    cancelled: false,
    captured: false,
};

function getScheduleSwipeElements() {
    const viewport = document.getElementById('schedule-content');
    const track = document.getElementById('schedule-swipe-track');
    if (!viewport || !track || typeof track.querySelectorAll !== 'function') return null;

    const dinoLane = viewport.querySelector('.schedule-dino-lane');
    const panels = Array.from(track.querySelectorAll('.schedule-week-panel'));
    const previous = panels.find(panel => panel.dataset.schedulePanel === 'previous');
    const current = panels.find(panel => panel.dataset.schedulePanel === 'current');
    const next = panels.find(panel => panel.dataset.schedulePanel === 'next');
    if (!previous || !current || !next) return null;

    return {
        viewport,
        track,
        panels,
        previous,
        current,
        next,
        dinoLane,
    };
}

function ensureScheduleSwipePanels() {
    const swipe = getScheduleSwipeElements();
    if (!swipe || !swipe.current) return swipe;

    [swipe.previous, swipe.next].forEach(panel => {
        if (panel.querySelector('.schedule-grid')) return;
        panel.innerHTML = swipe.current.innerHTML;
        panel.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
    });
    return swipe;
}

function getSchedulePanelElements(panel) {
    if (!panel) return {};
    return {
        scheduleDays: panel.querySelector('.schedule-days'),
        scheduleGrid: panel.querySelector('.schedule-grid'),
        scheduleHeader: panel.querySelector('.schedule-header'),
    };
}

function getScheduleDataSource(fallbackSchedule = {}) {
    if (otherMajorScheduleData) return otherMajorScheduleData;
    if (cachedSchedule) return cachedSchedule;
    return fallbackSchedule || {};
}

function getScheduleWeekPayload(source, week) {
    if (week < SCHEDULE_MIN_WEEK || week > SCHEDULE_MAX_WEEK) return {};
    const weekKey = String(week);
    if (!Object.prototype.hasOwnProperty.call(source || {}, weekKey)) return {};
    return { [weekKey]: source[weekKey] };
}

function setScheduleSwipeTransform(offset, { animate = false } = {}) {
    const swipe = getScheduleSwipeElements();
    if (!swipe) return;

    swipe.track.classList.toggle('is-animating', animate);
    swipe.track.style.transform = `translate3d(calc(-33.333333% + ${offset}px), 0, 0)`;
}

function applyScheduleSwipeResistance(deltaX) {
    const atFirstWeek = currentWeek <= SCHEDULE_MIN_WEEK && deltaX > 0;
    const atLastWeek = currentWeek >= SCHEDULE_MAX_WEEK && deltaX < 0;
    return atFirstWeek || atLastWeek ? deltaX * 0.24 : deltaX;
}

function getScheduleSwipeWidth(viewport) {
    if (!viewport) return 1;
    const rect = typeof viewport.getBoundingClientRect === 'function'
        ? viewport.getBoundingClientRect()
        : null;
    return Math.max(viewport.clientWidth || rect?.width || 1, 1);
}

function clearScheduleDinoGestureTimers({ includeCrash = true } = {}) {
    if (scheduleDinoHoldTimer !== null) {
        window.clearTimeout(scheduleDinoHoldTimer);
        scheduleDinoHoldTimer = null;
    }
    if (scheduleDinoAirborneTimer !== null) {
        window.clearTimeout(scheduleDinoAirborneTimer);
        scheduleDinoAirborneTimer = null;
    }
    if (includeCrash && scheduleDinoCrashTimer !== null) {
        window.clearTimeout(scheduleDinoCrashTimer);
        scheduleDinoCrashTimer = null;
    }
}

function finishScheduleDinoCrash(swipe = getScheduleSwipeElements()) {
    if (!swipe) return;
    clearScheduleDinoGestureTimers();
    swipe.viewport.classList.remove(
        'is-swiping',
        'is-settling',
        'is-dino-jumping',
        'is-dino-crashed',
        'has-dino-obstacle',
    );
    swipe.track.classList.remove('is-dragging', 'is-animating');
    swipe.track.style.setProperty('--schedule-swipe-direction', '0');
    swipe.track.style.setProperty('--schedule-swipe-progress', '0');
    if (swipe.dinoLane) {
        swipe.dinoLane.style.setProperty('--dino-obstacle-progress', '0');
        swipe.dinoLane.style.setProperty('--dino-obstacle-shift', '140px');
        swipe.dinoLane.style.setProperty('--dino-fireball-distance', '240px');
        swipe.dinoLane.style.setProperty('--dino-drag-lift', '0px');
        swipe.dinoLane.dataset.blocked = 'false';
    }
    setScheduleSwipeTransform(0);
    resetScheduleSwipeGesture();
}

function crashScheduleDino() {
    const swipe = getScheduleSwipeElements();
    if (!swipe || scheduleSwipeGesture.crashed) return;

    scheduleSwipeGesture.crashed = true;
    scheduleSwipeGesture.airborne = false;
    scheduleSwipeGesture.dragging = false;
    clearScheduleDinoGestureTimers({ includeCrash: false });
    if (swipe.dinoLane) swipe.dinoLane.style.setProperty('--dino-obstacle-shift', '-20px');
    swipe.viewport.classList.remove('is-swiping', 'is-dino-jumping');
    swipe.viewport.classList.add('is-dino-crashed');
    swipe.track.classList.remove('is-dragging');
    setScheduleSwipeTransform(0, { animate: true });

    scheduleDinoCrashTimer = window.setTimeout(() => {
        scheduleDinoCrashTimer = null;
        scheduleSwipeGesture.crashFinished = true;
        if (scheduleSwipeGesture.pointerId === null || scheduleSwipeGesture.releasedAfterCrash) {
            finishScheduleDinoCrash(swipe);
        }
    }, 800);
}

function armScheduleDinoHoldTimer() {
    if (scheduleDinoHoldTimer !== null) window.clearTimeout(scheduleDinoHoldTimer);
    scheduleSwipeGesture.lastMoveTime = Date.now();
    scheduleDinoHoldTimer = window.setTimeout(() => {
        scheduleDinoHoldTimer = null;
        if (shouldCrashScheduleDino({
            airborne: scheduleSwipeGesture.airborne,
            pointerDown: scheduleSwipeGesture.pointerId !== null,
            idleMs: Date.now() - scheduleSwipeGesture.lastMoveTime,
        })) {
            crashScheduleDino();
        }
    }, 610);
}

function resetScheduleSwipeGesture() {
    if (scheduleSwipeFrame !== null) window.cancelAnimationFrame(scheduleSwipeFrame);
    scheduleSwipeFrame = null;
    scheduleSwipePendingEvent = null;
    scheduleSwipeGesture.pointerId = null;
    scheduleSwipeGesture.pointerType = null;
    scheduleSwipeGesture.swipe = null;
    scheduleSwipeGesture.startX = 0;
    scheduleSwipeGesture.startY = 0;
    scheduleSwipeGesture.lastX = 0;
    scheduleSwipeGesture.startTime = 0;
    scheduleSwipeGesture.width = 1;
    scheduleSwipeGesture.dragging = false;
    scheduleSwipeGesture.cancelled = false;
    scheduleSwipeGesture.moved = false;
    scheduleSwipeGesture.obstacleType = null;
    scheduleSwipeGesture.crossedObstacle = false;
    scheduleSwipeGesture.airborne = false;
    scheduleSwipeGesture.crashed = false;
    scheduleSwipeGesture.crashFinished = false;
    scheduleSwipeGesture.releasedAfterCrash = false;
    scheduleSwipeGesture.lastMoveTime = 0;
}

function finishScheduleSwipeTransition() {
    const transition = scheduleSwipeTransition;
    const swipe = getScheduleSwipeElements();
    if (!transition || !swipe) return;

    // 轨道可能几乎没有剩余位移；不能用它的结束事件提前清除恐龙动画。
    const remaining = transition.finishNotBefore - performance.now();
    if (remaining > 0) {
        if (scheduleSwipeTransitionTimer !== null) window.clearTimeout(scheduleSwipeTransitionTimer);
        scheduleSwipeTransitionTimer = window.setTimeout(finishScheduleSwipeTransition, remaining);
        return;
    }

    scheduleSwipeTransition = null;
    if (scheduleSwipeTransitionTimer !== null) {
        window.clearTimeout(scheduleSwipeTransitionTimer);
        scheduleSwipeTransitionTimer = null;
    }
    swipe.track.removeEventListener('transitionend', transition.onTransitionEnd);
    swipe.track.classList.remove('is-animating', 'is-changing');
    swipe.viewport.classList.remove(
        'is-settling',
        'is-dino-jumping',
        'is-dino-reversing',
        'is-dino-fireball',
        'is-dino-completing',
        'is-dino-button-jump',
        'is-dino-crashed',
        'has-dino-obstacle',
    );
    swipe.track.style.setProperty('--schedule-swipe-direction', '0');
    swipe.track.style.setProperty('--schedule-swipe-progress', '0');
    if (swipe.dinoLane) {
        swipe.dinoLane.style.setProperty('--dino-obstacle-progress', '0');
        swipe.dinoLane.style.setProperty('--dino-obstacle-shift', '140px');
        swipe.dinoLane.style.setProperty('--dino-fireball-distance', '240px');
        swipe.dinoLane.style.setProperty('--dino-drag-lift', '0px');
        swipe.dinoLane.dataset.blocked = 'false';
    }

    if (!transition.shouldChange) {
        swipe.panels.forEach(panel => panel.classList.remove('is-swipe-target'));
        setScheduleSwipeTransform(0);
        flushQueuedScheduleSwipe();
        return;
    }

    currentWeek = transition.week;
    localStorage.setItem('current_week', currentWeek);
    updateScheduleDates(currentWeek);
    swipe.panels.forEach(panel => panel.classList.remove('is-swipe-target'));
    setScheduleSwipeTransform(0);

    if (otherMajorScheduleData) {
        displaySchedule(getScheduleWeekPayload(otherMajorScheduleData, currentWeek));
    } else {
        loadSchedule(currentWeek);
    }
    flushQueuedScheduleSwipe();
}

function animateScheduleSwipeTo(result, width, dinoReleaseAction = 'idle') {
    const swipe = getScheduleSwipeElements();
    if (!swipe) return;

    const targetPanel = result.direction > 0 ? swipe.next : swipe.previous;
    swipe.panels.forEach(panel => panel.classList.remove('is-swipe-target'));
    if (result.shouldChange && targetPanel) targetPanel.classList.add('is-swipe-target');

    const transition = {
        shouldChange: result.shouldChange,
        week: result.week,
        finishNotBefore: performance.now() + (
            window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 380
        ),
        onTransitionEnd: event => {
            if (event.target === swipe.track && event.propertyName === 'transform') {
                finishScheduleSwipeTransition();
            }
        },
    };
    scheduleSwipeTransition = transition;
    swipe.viewport.classList.remove('is-swiping', 'is-dino-fireball', 'is-dino-reversing', 'is-dino-completing');
    swipe.viewport.classList.add('is-settling');
    swipe.track.classList.toggle('is-changing', result.shouldChange);
    swipe.track.style.setProperty('--schedule-swipe-direction', String(result.direction));
    swipe.track.addEventListener('transitionend', transition.onTransitionEnd);
    if (dinoReleaseAction === 'fireball') {
        swipe.viewport.classList.remove('is-dino-jumping');
        swipe.viewport.classList.add('is-dino-fireball');
    } else if (dinoReleaseAction === 'reverse-jump') {
        swipe.viewport.classList.remove('is-dino-jumping');
        swipe.viewport.classList.add('is-dino-reversing');
    } else if (dinoReleaseAction === 'complete') {
        swipe.viewport.classList.add('is-dino-completing');
        if (!swipe.viewport.classList.contains('is-dino-jumping')) {
            if (swipe.dinoLane) {
                swipe.dinoLane.style.setProperty('--dino-obstacle-progress', '1');
                swipe.dinoLane.style.setProperty('--dino-obstacle-shift', '0px');
            }
            swipe.viewport.classList.add('is-dino-jumping');
        }
    } else {
        swipe.viewport.classList.remove('has-dino-obstacle', 'is-dino-jumping');
    }
    setScheduleSwipeTransform(result.direction * -width, { animate: true });
    scheduleSwipeTransitionTimer = window.setTimeout(finishScheduleSwipeTransition, 460);
}

function flushQueuedScheduleSwipe() {
    if (!scheduleQueuedSwipe || scheduleSwipeTransition || scheduleSwipeGesture.pointerId !== null
        || scheduleQueuedPointer.pointerId !== null) return;
    const direction = Math.sign(scheduleQueuedSwipe);
    scheduleQueuedSwipe -= direction;
    window.requestAnimationFrame(() => {
        if (scheduleSwipeTransition || scheduleSwipeGesture.pointerId !== null
            || scheduleQueuedPointer.pointerId !== null) {
            scheduleQueuedSwipe += direction;
            return;
        }
        changeWeek(direction, true);
    });
}

function resetQueuedScheduleSwipe() {
    if (scheduleQueuedPointer.captured) {
        const swipe = getScheduleSwipeElements();
        if (swipe && typeof swipe.viewport.releasePointerCapture === 'function') {
            try {
                swipe.viewport.releasePointerCapture(scheduleQueuedPointer.pointerId);
            } catch (error) {
                // 页面切换时指针可能已释放。
            }
        }
    }
    scheduleQueuedPointer.pointerId = null;
    scheduleQueuedPointer.captured = false;
    scheduleQueuedSwipe = 0;
}

function handleQueuedSchedulePointerMove(event) {
    if (event.pointerId !== scheduleQueuedPointer.pointerId) return false;
    scheduleQueuedPointer.lastX = event.clientX;
    const deltaX = event.clientX - scheduleQueuedPointer.startX;
    const deltaY = event.clientY - scheduleQueuedPointer.startY;
    if (Math.abs(deltaY) > 8 && Math.abs(deltaY) > Math.abs(deltaX)) {
        scheduleQueuedPointer.cancelled = true;
    } else if (!scheduleQueuedPointer.cancelled && Math.abs(deltaX) > 8) {
        if (!scheduleQueuedPointer.captured) {
            const swipe = getScheduleSwipeElements();
            if (swipe && typeof swipe.viewport.setPointerCapture === 'function') {
                swipe.viewport.setPointerCapture(event.pointerId);
                scheduleQueuedPointer.captured = true;
            }
        }
        if (event.cancelable) event.preventDefault();
    }
    return true;
}

function handleQueuedSchedulePointerEnd(event, cancelled = false) {
    if (event.pointerId !== scheduleQueuedPointer.pointerId) return false;
    const swipe = getScheduleSwipeElements();
    if (scheduleQueuedPointer.captured && swipe && typeof swipe.viewport.releasePointerCapture === 'function') {
        try {
            swipe.viewport.releasePointerCapture(event.pointerId);
        } catch (error) {
            // 浏览器可能已释放指针。
        }
    }
    const deltaX = (typeof event.clientX === 'number' ? event.clientX : scheduleQueuedPointer.lastX)
        - scheduleQueuedPointer.startX;
    const duration = Date.now() - scheduleQueuedPointer.startTime;
    const baseWeek = Math.min(SCHEDULE_MAX_WEEK, Math.max(SCHEDULE_MIN_WEEK,
        (scheduleSwipeTransition?.week ?? currentWeek) + scheduleQueuedSwipe));
    const result = cancelled || scheduleQueuedPointer.cancelled
        ? { shouldChange: false }
        : resolveScheduleSwipe({
            deltaX,
            duration,
            viewportWidth: scheduleQueuedPointer.width,
            currentWeek: baseWeek,
            minWeek: SCHEDULE_MIN_WEEK,
            maxWeek: SCHEDULE_MAX_WEEK,
        });
    scheduleQueuedPointer.pointerId = null;
    scheduleQueuedPointer.captured = false;
    if (result.shouldChange) {
        scheduleQueuedSwipe += result.direction;
        suppressScheduleSwipeClick = true;
        flushQueuedScheduleSwipe();
    }
    return true;
}

function handleSchedulePointerDown(event) {
    const swipe = getScheduleSwipeElements();
    if (!swipe || scheduleSwipeGesture.pointerId !== null || scheduleQueuedPointer.pointerId !== null) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (event.target.closest && event.target.closest('button, select, a, input, textarea')) return;

    if (scheduleSwipeTransition) {
        scheduleQueuedPointer.pointerId = event.pointerId;
        scheduleQueuedPointer.startX = event.clientX;
        scheduleQueuedPointer.startY = event.clientY;
        scheduleQueuedPointer.lastX = event.clientX;
        scheduleQueuedPointer.startTime = Date.now();
        scheduleQueuedPointer.width = getScheduleSwipeWidth(swipe.viewport);
        scheduleQueuedPointer.cancelled = false;
        scheduleQueuedPointer.captured = false;
        return;
    }

    scheduleSwipeGesture.pointerId = event.pointerId;
    scheduleSwipeGesture.pointerType = event.pointerType;
    scheduleSwipeGesture.swipe = swipe;
    scheduleSwipeGesture.startX = event.clientX;
    scheduleSwipeGesture.startY = event.clientY;
    scheduleSwipeGesture.lastX = event.clientX;
    scheduleSwipeGesture.startTime = Date.now();
    scheduleSwipeGesture.width = getScheduleSwipeWidth(swipe.viewport);
    scheduleSwipeGesture.dragging = false;
    scheduleSwipeGesture.cancelled = false;
    scheduleSwipeGesture.moved = false;
    scheduleSwipeGesture.obstacleType = null;
    scheduleSwipeGesture.crossedObstacle = false;
    scheduleSwipeGesture.airborne = false;
    scheduleSwipeGesture.crashed = false;
    scheduleSwipeGesture.crashFinished = false;
    scheduleSwipeGesture.releasedAfterCrash = false;
    scheduleSwipeGesture.lastMoveTime = Date.now();
    clearScheduleDinoGestureTimers();
    suppressScheduleSwipeClick = false;
    swipe.viewport.classList.remove(
        'is-dino-jumping',
        'is-dino-reversing',
        'is-dino-fireball',
        'is-dino-completing',
        'is-dino-button-jump',
        'is-dino-crashed',
        'has-dino-obstacle',
    );
    if (swipe.dinoLane) {
        swipe.dinoLane.style.setProperty('--dino-obstacle-progress', '0');
        swipe.dinoLane.style.setProperty('--dino-obstacle-shift', '140px');
        swipe.dinoLane.style.setProperty('--dino-fireball-distance', '240px');
        swipe.dinoLane.style.setProperty('--dino-drag-lift', '0px');
        swipe.dinoLane.dataset.blocked = 'false';
    }
}

function handleSchedulePointerMove(event) {
    if (handleQueuedSchedulePointerMove(event)) return;
    if (event.pointerId !== scheduleSwipeGesture.pointerId) return;
    if (scheduleSwipeGesture.dragging && event.cancelable) event.preventDefault();
    scheduleSwipePendingEvent = event;
    if (scheduleSwipeFrame !== null) return;
    scheduleSwipeFrame = window.requestAnimationFrame(() => {
        scheduleSwipeFrame = null;
        const pending = scheduleSwipePendingEvent;
        scheduleSwipePendingEvent = null;
        if (pending) renderSchedulePointerMove(pending);
    });
}

function renderSchedulePointerMove(event) {
    const swipe = scheduleSwipeGesture.swipe || getScheduleSwipeElements();
    if (!swipe || event.pointerId !== scheduleSwipeGesture.pointerId || scheduleSwipeTransition) return;

    if (scheduleSwipeGesture.crashed) {
        if (event.cancelable) event.preventDefault();
        return;
    }

    const deltaX = event.clientX - scheduleSwipeGesture.startX;
    const deltaY = event.clientY - scheduleSwipeGesture.startY;
    scheduleSwipeGesture.lastX = event.clientX;

    if (!scheduleSwipeGesture.dragging) {
        if (scheduleSwipeGesture.cancelled || (Math.abs(deltaX) < 8 && Math.abs(deltaY) < 8)) return;
        if (Math.abs(deltaY) > Math.abs(deltaX)) {
            scheduleSwipeGesture.cancelled = true;
            return;
        }

        scheduleSwipeGesture.dragging = true;
        scheduleSwipeGesture.moved = true;
        scheduleSwipeGesture.obstacleType = pickScheduleDinoObstacle();
        if (typeof swipe.viewport.setPointerCapture === 'function') {
            swipe.viewport.setPointerCapture(event.pointerId);
        }
        swipe.viewport.classList.add('is-swiping');
        swipe.viewport.classList.add('has-dino-obstacle');
        swipe.track.classList.add('is-dragging');
        if (swipe.dinoLane) swipe.dinoLane.dataset.obstacle = scheduleSwipeGesture.obstacleType;
    }

    if (!scheduleSwipeGesture.dragging) return;
    if (event.cancelable) event.preventDefault();

    const offset = applyScheduleSwipeResistance(deltaX);
    const dinoCue = resolveScheduleDinoCue({
        deltaX,
        viewportWidth: scheduleSwipeGesture.width,
        currentWeek,
        minWeek: SCHEDULE_MIN_WEEK,
        maxWeek: SCHEDULE_MAX_WEEK,
    });
    if (swipe.dinoLane) {
        const dinoDirection = dinoCue.direction < 0 ? 'previous' : 'next';
        const blocked = String(dinoCue.blocked);
        if (swipe.dinoLane.dataset.direction !== dinoDirection) swipe.dinoLane.dataset.direction = dinoDirection;
        if (swipe.dinoLane.dataset.blocked !== blocked) swipe.dinoLane.dataset.blocked = blocked;
        const obstacleShift = dinoCue.blocked
            ? Math.max(24, (1 - dinoCue.obstacleProgress) * 140)
            : (1 - dinoCue.obstacleProgress) * 140;
        // 同一位移决定起跳和落地；暂停、反向拖动也保持安全间距。
        const lift = resolveScheduleDinoLift(obstacleShift, dinoCue.blocked);
        swipe.dinoLane.style.setProperty('--dino-drag-lift', `${-lift}px`);
        scheduleSwipeGesture.airborne = lift > 0;
        if (scheduleSwipeGesture.airborne && scheduleSwipeGesture.pointerType === 'mouse') {
            armScheduleDinoHoldTimer();
        } else if (scheduleDinoHoldTimer !== null) {
            window.clearTimeout(scheduleDinoHoldTimer);
            scheduleDinoHoldTimer = null;
        }
        swipe.dinoLane.style.setProperty('--dino-obstacle-shift', `${obstacleShift}px`);
        swipe.dinoLane.style.setProperty('--dino-fireball-distance', `${100 + obstacleShift}px`);
    }
    scheduleSwipeGesture.crossedObstacle = dinoCue.crossedObstacle;
    swipe.track.style.transform = `translate3d(calc(-33.333333% + ${offset}px), 0, 0)`;
}

function handleSchedulePointerEnd(event, cancelled = false) {
    if (handleQueuedSchedulePointerEnd(event, cancelled)) return;
    if (event.pointerId === scheduleSwipeGesture.pointerId && scheduleSwipePendingEvent) {
        window.cancelAnimationFrame(scheduleSwipeFrame);
        scheduleSwipeFrame = null;
        const pending = scheduleSwipePendingEvent;
        scheduleSwipePendingEvent = null;
        renderSchedulePointerMove(pending);
    }
    const swipe = scheduleSwipeGesture.swipe || getScheduleSwipeElements();
    if (!swipe || event.pointerId !== scheduleSwipeGesture.pointerId) return;

    if (scheduleSwipeGesture.crashed) {
        if (typeof swipe.viewport.releasePointerCapture === 'function') {
            try {
                swipe.viewport.releasePointerCapture(event.pointerId);
            } catch (error) {
                // 撞击后指针可能已经由浏览器释放。
            }
        }
        scheduleSwipeGesture.pointerId = null;
        scheduleSwipeGesture.releasedAfterCrash = true;
        if (scheduleSwipeGesture.crashFinished) finishScheduleDinoCrash(swipe);
        return;
    }

    const wasDragging = scheduleSwipeGesture.dragging;
    const deltaX = (typeof event.clientX === 'number' ? event.clientX : scheduleSwipeGesture.lastX)
        - scheduleSwipeGesture.startX;
    const duration = Date.now() - scheduleSwipeGesture.startTime;
    const width = scheduleSwipeGesture.width;
    const hadObstacle = Boolean(scheduleSwipeGesture.obstacleType);
    const crossedObstacle = scheduleSwipeGesture.crossedObstacle;
    suppressScheduleSwipeClick = scheduleSwipeGesture.moved;
    clearScheduleDinoGestureTimers();

    if (typeof swipe.viewport.releasePointerCapture === 'function') {
        try {
            swipe.viewport.releasePointerCapture(event.pointerId);
        } catch (error) {
            // 指针已经释放时浏览器可能抛错，不影响周次切换。
        }
    }
    resetScheduleSwipeGesture();

    if (!wasDragging) {
        swipe.viewport.classList.remove('is-swiping', 'is-dino-jumping', 'has-dino-obstacle');
        return;
    }

    swipe.track.classList.remove('is-dragging');
    const result = cancelled
        ? { shouldChange: false, direction: 0, week: currentWeek }
        : resolveScheduleSwipe({
            deltaX,
            duration,
            viewportWidth: width,
            currentWeek,
            minWeek: SCHEDULE_MIN_WEEK,
            maxWeek: SCHEDULE_MAX_WEEK,
        });
    const dinoReleaseAction = resolveScheduleDinoRelease({
        hadObstacle,
        crossedObstacle,
        shouldChange: result.shouldChange,
    });
    // 松手后从拖动时的高度落地，避免快扫时回到地面重播起跳。
    animateScheduleSwipeTo(result, width, dinoReleaseAction);
}

function handleScheduleSwipeClick(event) {
    if (!suppressScheduleSwipeClick) return;
    suppressScheduleSwipeClick = false;
    event.preventDefault();
    event.stopPropagation();
}

function initScheduleSwipe() {
    const swipe = ensureScheduleSwipePanels();
    if (!swipe || swipe.viewport.dataset.scheduleSwipeReady === 'true') return;

    swipe.viewport.dataset.scheduleSwipeReady = 'true';
    swipe.viewport.addEventListener('pointerdown', handleSchedulePointerDown);
    swipe.viewport.addEventListener('pointermove', handleSchedulePointerMove);
    swipe.viewport.addEventListener('pointerup', event => handleSchedulePointerEnd(event));
    swipe.viewport.addEventListener('pointercancel', event => handleSchedulePointerEnd(event, true));
    swipe.viewport.addEventListener('click', handleScheduleSwipeClick, true);
}

const scheduleActionReveal = {
    distance: 0,
    touchId: null,
    touchStartX: 0,
    touchStartY: 0,
    lastTouchY: 0,
    trackingTouch: false,
    horizontalTouch: false,
    wheelTimer: null,
};

function isScheduleAtPageBottom() {
    if (typeof window === 'undefined' || !document.documentElement) return false;
    return (window.scrollY || window.pageYOffset || 0) + window.innerHeight
        >= document.documentElement.scrollHeight - 4;
}

function resetScheduleActionPull() {
    const pull = document.getElementById('schedule-actions-pull');
    scheduleActionReveal.distance = 0;
    if (scheduleActionReveal.wheelTimer !== null && typeof window !== 'undefined') {
        window.clearTimeout(scheduleActionReveal.wheelTimer);
        scheduleActionReveal.wheelTimer = null;
    }
    if (!pull) return;
    pull.style.transform = '';
    const fill = pull.querySelector('.schedule-actions-pull-fill');
    if (fill) fill.style.width = '0%';
    pull.classList.remove('is-pulling', 'is-ready');
    const label = pull.querySelector('.schedule-actions-pull-label');
    if (label) label.textContent = '继续上滑，展开课表操作';
}

function updateScheduleActionPull(distance) {
    const pull = document.getElementById('schedule-actions-pull');
    const panel = document.getElementById('schedule-actions');
    if (!pull || !panel || panel.classList.contains('is-open')) return;
    scheduleActionReveal.distance = Math.max(0, distance);
    const state = resolveScheduleActionPull(scheduleActionReveal.distance);
    if (state.shouldOpen) {
        showScheduleActions();
        return;
    }
    pull.style.transform = `translate3d(-50%, ${68 - state.offset}px, 0)`;
    const fill = pull.querySelector('.schedule-actions-pull-fill');
    if (fill) fill.style.width = `${Math.round(state.progress * 100)}%`;
    pull.classList.toggle('is-pulling', state.offset > 0);
    const label = pull.querySelector('.schedule-actions-pull-label');
    if (label) label.textContent = state.progress >= 0.8 ? '再向上滑一点' : '继续上滑，展开课表操作';
}

function showScheduleActions() {
    const panel = document.getElementById('schedule-actions');
    if (!panel || !panel.classList || panel.classList.contains('is-open')) return;
    resetScheduleActionPull();
    panel.classList.add('is-open');
    panel.removeAttribute('inert');
    panel.setAttribute('aria-hidden', 'false');
    const scrollToActions = () => {
        if (panel.classList.contains('is-open') && typeof panel.scrollIntoView === 'function') {
            panel.scrollIntoView({ behavior: 'smooth', block: 'end' });
        }
    };
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(scrollToActions);
    } else {
        scrollToActions();
    }
}

function hideScheduleActions(focusTimetable = true) {
    const panel = document.getElementById('schedule-actions');
    if (!panel || !panel.classList) return;
    if (focusTimetable && typeof panel.contains === 'function' && panel.contains(document.activeElement)) {
        const timetable = document.getElementById('schedule-content');
        if (timetable && typeof timetable.focus === 'function') timetable.focus();
    }
    panel.classList.remove('is-open');
    panel.setAttribute('inert', '');
    panel.setAttribute('aria-hidden', 'true');
    resetScheduleActionPull();
}

function scheduleActionTouch(event) {
    return Array.from(event.touches || []).find(touch => touch.identifier === scheduleActionReveal.touchId);
}

function handleScheduleActionTouchStart(event) {
    const panel = document.getElementById('schedule-actions');
    const touch = event.touches && event.touches[0];
    if (!panel || panel.classList.contains('is-open') || !touch || event.touches.length !== 1) return;
    scheduleActionReveal.touchId = touch.identifier;
    scheduleActionReveal.touchStartX = touch.clientX;
    scheduleActionReveal.touchStartY = touch.clientY;
    scheduleActionReveal.lastTouchY = touch.clientY;
    scheduleActionReveal.trackingTouch = isScheduleAtPageBottom();
    scheduleActionReveal.horizontalTouch = false;
}

function handleScheduleActionTouchMove(event) {
    const panel = document.getElementById('schedule-actions');
    const touch = scheduleActionTouch(event);
    if (!panel || panel.classList.contains('is-open') || !touch || scheduleActionReveal.horizontalTouch) return;
    const deltaX = touch.clientX - scheduleActionReveal.touchStartX;
    const deltaY = touch.clientY - scheduleActionReveal.touchStartY;
    if (Math.abs(deltaX) > 10 && Math.abs(deltaX) > Math.abs(deltaY)) {
        scheduleActionReveal.horizontalTouch = true;
        resetScheduleActionPull();
        return;
    }
    if (!scheduleActionReveal.trackingTouch) {
        scheduleActionReveal.lastTouchY = touch.clientY;
        if (!isScheduleAtPageBottom()) return;
        scheduleActionReveal.trackingTouch = true;
        return;
    }
    const step = scheduleActionReveal.lastTouchY - touch.clientY;
    scheduleActionReveal.lastTouchY = touch.clientY;
    updateScheduleActionPull(Math.max(0, scheduleActionReveal.distance + step));
}

function handleScheduleActionTouchEnd(event) {
    if (scheduleActionReveal.touchId === null || scheduleActionTouch(event)) return;
    scheduleActionReveal.touchId = null;
    scheduleActionReveal.trackingTouch = false;
    scheduleActionReveal.horizontalTouch = false;
    resetScheduleActionPull();
}

function handleScheduleActionWheel(event) {
    const panel = document.getElementById('schedule-actions');
    if (!panel || panel.classList.contains('is-open') || event.deltaY <= 0 || !isScheduleAtPageBottom()) return;
    if (event.cancelable) event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
    updateScheduleActionPull(scheduleActionReveal.distance + Math.min(event.deltaY * unit, 90));
    if (scheduleActionReveal.wheelTimer !== null) window.clearTimeout(scheduleActionReveal.wheelTimer);
    if (!panel.classList.contains('is-open')) {
        scheduleActionReveal.wheelTimer = window.setTimeout(resetScheduleActionPull, 700);
    }
}

function handleScheduleActionKeyDown(event) {
    const page = document.getElementById('page-schedule');
    const panel = document.getElementById('schedule-actions');
    if (!page || !page.classList.contains('active') || !panel
        || panel.classList.contains('is-open') || !isScheduleAtPageBottom()) return;
    if (event.key !== 'PageDown' && event.key !== 'ArrowDown') return;
    if (event.cancelable) event.preventDefault();
    updateScheduleActionPull(scheduleActionReveal.distance + (event.key === 'PageDown' ? 90 : 45));
}

function initScheduleActions() {
    const page = document.getElementById('page-schedule');
    const panel = document.getElementById('schedule-actions');
    if (!page || !panel || page.dataset.scheduleActionsReady === 'true') return;
    page.dataset.scheduleActionsReady = 'true';
    page.addEventListener('touchstart', handleScheduleActionTouchStart, { passive: true });
    page.addEventListener('touchmove', handleScheduleActionTouchMove, { passive: true });
    page.addEventListener('touchend', handleScheduleActionTouchEnd);
    page.addEventListener('touchcancel', handleScheduleActionTouchEnd);
    page.addEventListener('wheel', handleScheduleActionWheel, { passive: false });
    document.addEventListener('keydown', handleScheduleActionKeyDown);
}

if (typeof document !== 'undefined'
    && typeof document.addEventListener === 'function'
    && typeof document.getElementById === 'function') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initScheduleSwipe, { once: true });
        document.addEventListener('DOMContentLoaded', initScheduleActions, { once: true });
    } else {
        initScheduleSwipe();
        initScheduleActions();
    }
}

async function showOtherMajorModal() {
    const modal = document.getElementById('other-major-modal');
    const body = document.getElementById('other-major-modal-body');

    openUiModal(modal);

    if (Object.keys(gradeData).length > 0) {
        _renderOtherMajorModal();
        return;
    }

    body.innerHTML = '<div class="loading">加载中...</div>';
    try {
        const resp = await fetch('/api/schedule/other_majors', {
            headers: { 'X-Device-ID': getDeviceId() }
        });
        const data = await resp.json();
        if (!data.success || !Object.keys(data.data).length) {
            body.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:20px 0;">暂无其他班级的课表数据</p>';
            return;
        }
        gradeData = data.data;
        // 默认选第一个年级和专业
        omSelected.grade = Object.keys(gradeData)[0];
        omSelected.major = Object.keys(gradeData[omSelected.grade])[0];
        omSelected.class_num = gradeData[omSelected.grade][omSelected.major][0];
        _renderOtherMajorModal();
    } catch (e) {
        body.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:20px 0;">加载失败，请重试</p>';
    }
}

function _renderOtherMajorModal() {
    const grades = Object.keys(gradeData);
    const majors = omSelected.grade ? Object.keys(gradeData[omSelected.grade] || {}) : [];
    const classes = (omSelected.grade && omSelected.major)
        ? (gradeData[omSelected.grade][omSelected.major] || []) : [];

    document.getElementById('other-major-modal-body').innerHTML = `
        <p class="other-major-section-label">年级</p>
        <div class="other-major-chips">
            ${grades.map(g => `
                <button class="other-major-chip ${g === omSelected.grade ? 'selected' : ''}"
                        onclick="omSelectGrade('${g}')">${g}级</button>
            `).join('')}
        </div>
        <p class="other-major-section-label">专业</p>
        <div class="other-major-chips">
            ${majors.map(m => `
                <button class="other-major-chip ${m === omSelected.major ? 'selected' : ''}"
                        onclick="omSelectMajor('${m}')">${m}</button>
            `).join('')}
        </div>
        <p class="other-major-section-label">班级</p>
        <div class="other-major-chips">
            ${classes.map(c => `
                <button class="other-major-chip ${c === omSelected.class_num ? 'selected' : ''}"
                        onclick="omSelectClass('${c}')">${c}班</button>
            `).join('')}
        </div>
        <div class="other-major-confirm">
            <button class="btn-primary btn-full" onclick="loadOtherMajorSchedule()">查看该班课表</button>
        </div>
    `;
}

function omSelectGrade(grade) {
    omSelected.grade = grade;
    omSelected.major = Object.keys(gradeData[grade] || {})[0] || null;
    omSelected.class_num = omSelected.major ? (gradeData[grade][omSelected.major][0] || null) : null;
    _renderOtherMajorModal();
}

function omSelectMajor(major) {
    omSelected.major = major;
    omSelected.class_num = (gradeData[omSelected.grade][major] || [])[0] || null;
    _renderOtherMajorModal();
}

function omSelectClass(cls) {
    omSelected.class_num = cls;
    _renderOtherMajorModal();
}

function closeOtherMajorModal() {
    closeUiModal(document.getElementById('other-major-modal'));
}

async function loadOtherMajorSchedule() {
    const { grade, major, class_num } = omSelected;
    if (!grade || !major || !class_num) return;

    closeOtherMajorModal();

    const scheduleMsg = document.getElementById('schedule-message');
    scheduleMsg.style.display = 'block';
    scheduleMsg.textContent = '加载中...';
    scheduleMsg.classList.remove('schedule-message-detail');

    try {
        const resp = await fetch(`/api/schedule/other_major?grade=${encodeURIComponent(grade)}&major=${encodeURIComponent(major)}&class_num=${encodeURIComponent(class_num)}`, {
            headers: { 'X-Device-ID': getDeviceId() }
        });
        const data = await resp.json();
        if (!data.success) {
            scheduleMsg.textContent = data.message || '加载失败';
            return;
        }
        otherMajorScheduleData = data.data.schedule;
        if (data.data.semester_start && !semesterStart) {
            semesterStart = new Date(data.data.semester_start);
        }
        const backButton = document.createElement('button');
        backButton.type = 'button';
        backButton.className = 'in-page-back schedule-back-btn';
        backButton.textContent = '← 返回我的课表';
        backButton.addEventListener('click', backToMySchedule);
        const scheduleTitle = document.createElement('span');
        scheduleTitle.className = 'schedule-message-title';
        scheduleTitle.textContent = `${grade}级 专业${major} ${class_num}班（仅课程名与时间）`;
        scheduleMsg.replaceChildren(backButton, scheduleTitle);
        scheduleMsg.classList.add('schedule-message-detail');
        scheduleMsg.style.display = '';
        displaySchedule({ [currentWeek]: otherMajorScheduleData[String(currentWeek)] || [] });
    } catch (e) {
        scheduleMsg.textContent = '加载失败，请重试';
    }
}

let historicalScheduleRequestId = 0;

async function showHistoricalSchedule() {
    const modal = document.getElementById('historical-schedule-modal');
    if (!modal) return;

    openUiModal(modal);
    await loadHistoricalSchedule();
}

function closeHistoricalSchedule() {
    const modal = document.getElementById('historical-schedule-modal');
    closeUiModal(modal);
}

async function loadHistoricalSchedule(semester = '') {
    const body = document.getElementById('historical-schedule-body');
    const select = document.getElementById('historical-semester-select');
    if (!body || !select) return;

    const requestId = ++historicalScheduleRequestId;
    body.innerHTML = '<div class="loading">加载中...</div>';
    select.disabled = true;

    const url = semester
        ? `/api/historical_schedule?semester=${encodeURIComponent(semester)}`
        : '/api/historical_schedule';

    try {
        const response = await fetch(url, {
            headers: { 'X-Device-ID': getDeviceId() }
        });
        const data = await response.json();
        if (requestId !== historicalScheduleRequestId) return;

        if (!data.success || !data.data) {
            body.innerHTML = `<p class="historical-schedule-empty">${escapeGradeHtml(data.message || '历年课表加载失败')}</p>`;
            return;
        }

        const semesters = Array.isArray(data.data.semesters) ? data.data.semesters : [];
        select.innerHTML = semesters.length
            ? semesters.map(option => `<option value="${escapeGradeHtml(option.value)}">${escapeGradeHtml(option.label || option.value)}</option>`).join('')
            : '<option value="">暂无可选学期</option>';
        select.disabled = semesters.length === 0;
        if (data.data.semester && semesters.some(option => option.value === data.data.semester)) {
            select.value = data.data.semester;
        }

        renderHistoricalSchedule(data.data.courses || []);
    } catch (error) {
        if (requestId !== historicalScheduleRequestId) return;
        console.error('加载历年课表失败:', error);
        body.innerHTML = '<p class="historical-schedule-empty">加载失败，请检查网络连接</p>';
    }
}

function renderHistoricalSchedule(courses) {
    const body = document.getElementById('historical-schedule-body');
    if (!body) return;

    if (!Array.isArray(courses) || courses.length === 0) {
        body.innerHTML = '<p class="historical-schedule-empty">该学期暂无课程</p>';
        return;
    }

    body.innerHTML = buildHistoricalScheduleGridHtml(courses);
}

function backToMySchedule() {
    otherMajorScheduleData = null;
    const scheduleMsg = document.getElementById('schedule-message');
    scheduleMsg.style.display = 'none';
    scheduleMsg.classList.remove('schedule-message-detail');
    refreshScheduleDisplay();
}

// 更新课程表数据（从服务器获取最新数据）
async function updateScheduleData(event) {
    const generation = academicCacheGeneration;
    const btn = event?.currentTarget || event?.target || document.getElementById('update-schedule-btn');
    if (!btn) return;
    const originalText = btn.textContent;

    btn.disabled = true;
    btn.textContent = '更新中...';

    try {
        const response = await fetch('/api/update_schedule', {
            method: 'POST',
            headers: {
                'X-Device-ID': getDeviceId()
            }
        });
        const data = await response.json();
        if (generation !== academicCacheGeneration) return;

        if (data.success) {
            showUiToast('课程表更新成功', 'success');
            cachedSchedule = null;  // 清除缓存，重新拉取
            // 重新加载课程表
            loadSchedule();
        } else {
            showUiToast(data.message || '更新失败', 'error');
        }
    } catch (error) {
        if (generation !== academicCacheGeneration) return;
        console.error('更新课程表失败:', error);
        showUiToast('更新课程表失败，学校可能暂未开放查询', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

function resetScheduleDisplay() {
    clearScheduleDinoGestureTimers();
    resetScheduleSwipeGesture();
    const swipe = ensureScheduleSwipePanels();
    const panels = swipe?.panels || [document.querySelector('.schedule-week-panel')].filter(Boolean);

    panels.forEach(panel => {
        const { scheduleDays, scheduleGrid, scheduleHeader } = getSchedulePanelElements(panel);
        if (!scheduleDays || !scheduleGrid || !scheduleHeader) return;
        scheduleDays.innerHTML = '';
        panel.querySelectorAll('[data-schedule-date]').forEach(el => { el.textContent = ''; });
        panel.querySelectorAll('.schedule-day-today').forEach(el => el.classList.remove('schedule-day-today'));
        scheduleGrid.classList.remove('has-evening');
        setScheduleWeekendVisibility(false, scheduleGrid, scheduleHeader);
    });
    if (swipe) {
        swipe.track.classList.remove('is-dragging', 'is-animating', 'is-changing');
        swipe.viewport.classList.remove(
            'is-swiping',
            'is-settling',
            'is-dino-jumping',
            'is-dino-reversing',
            'is-dino-fireball',
            'is-dino-completing',
            'is-dino-button-jump',
            'is-dino-crashed',
            'has-dino-obstacle',
        );
        swipe.panels.forEach(panel => panel.classList.remove('is-swipe-target'));
        if (swipe.dinoLane) {
            swipe.dinoLane.style.setProperty('--dino-obstacle-progress', '0');
            swipe.dinoLane.style.setProperty('--dino-obstacle-shift', '140px');
            swipe.dinoLane.style.setProperty('--dino-fireball-distance', '240px');
        swipe.dinoLane.style.setProperty('--dino-drag-lift', '0px');
            swipe.dinoLane.dataset.blocked = 'false';
        }
        setScheduleSwipeTransform(0);
    }
}

function refreshScheduleDisplay() {
    cachedSchedule = null;
    return loadSchedule();
}

async function loadSchedule(week = null, autoFetched = false) {
    let generation = academicCacheGeneration;
    const messageDiv = document.getElementById('schedule-message');

    // 根据学期开始日期算出实际当前周
    function calcActualWeek() {
        const activeStart = currentSemesterStartValue();
        if (!activeStart) return null;
        const today = getCalendarChinaToday();
        const diffDays = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${activeStart}T00:00:00Z`)) / 86400000;
        if (diffDays < 0) return 1;
        return Math.min(Math.floor(diffDays / 7) + 1, 25);
    }

    // 没有指定周次时：优先用实际当前周，否则降级到上次记录
    if (week === null) {
        week = calcActualWeek() ?? currentWeek;
    }

    // 辅助函数：显示提示消息
    function showMessage(text, isError = false) {
        messageDiv.textContent = text;
        messageDiv.className = 'schedule-message' + (isError ? ' schedule-message-error' : '');
        messageDiv.style.display = 'block';
    }

    function hideMessage() {
        messageDiv.style.display = 'none';
    }

    // 从缓存渲染指定周次
    function renderFromCache(allSchedule, w) {
        currentWeek = w;
        localStorage.setItem('current_week', w);
        updateScheduleDates(w);

        const weekStr = String(w);
        const weekData = allSchedule[weekStr] ? { [weekStr]: allSchedule[weekStr] } : {};
        if (Object.keys(weekData).length > 0) {
            hideMessage();
            displaySchedule(weekData);
            if (!currentSemesterStartValue()) {
                showMessage('学期起始日期待核对，请管理员在后台设置后刷新显示。');
            }
        } else {
            resetScheduleDisplay();
            showMessage(`第${w}周没有课程`);
        }
    }

    // 如果有缓存，直接从缓存渲染
    if (cachedSchedule) {
        renderFromCache(cachedSchedule, week);
        return;
    }

    // 没有缓存，请求全量数据（不传 week 参数）
    try {
        const response = await fetch('/api/schedule', {
            headers: {
                'X-Device-ID': getDeviceId()
            }
        });
        const data = await response.json();
        if (generation !== academicCacheGeneration) return;

        if (data.success && data.account && data.account !== currentUsername) {
            currentUsername = data.account;
            rememberBoundUsername(currentUsername);
            generation = academicCacheGeneration;
            document.getElementById('sidebar-username').textContent = currentUsername;
        }
        if (data.success && data.data?.cache_stale) {
            resetScheduleDisplay();
            showMessage('后台已切换学期，请点击“更新课程表”获取本学期课程后再查看或导出。', true);
            return;
        }

        if (data.success && data.data) {
            const schedule = data.data.schedule || {};
            const hasData = Object.keys(schedule).length > 0;

            if (typeof data.data.is_freshman === 'boolean') {
                userIsFreshman = data.data.is_freshman;
            }

            if (data.data.semester_start) {
                semesterStart = new Date(data.data.semester_start + 'T00:00:00');
                // API 返回后重新算一次，覆盖之前的降级值
                if (week === currentWeek) {
                    week = calcActualWeek() ?? week;
                }
            }

            if (hasData) {
                cachedSchedule = schedule;
                renderFromCache(schedule, week);
            } else if (!autoFetched) {
                // 没有缓存数据，自动从教务系统获取
                resetScheduleDisplay();
                showMessage('正在从教务系统获取课表...');
                try {
                    const updateResp = await fetch('/api/update_schedule', {
                        method: 'POST',
                        headers: { 'X-Device-ID': getDeviceId() }
                    });
                    const updateData = await updateResp.json();
                    if (generation !== academicCacheGeneration) return;
                    if (updateData.success) {
                        loadSchedule(week, true);
                        return;
                    } else {
                        showMessage(updateData.message || '获取课表失败', true);
                    }
                } catch (e) {
                    if (generation !== academicCacheGeneration) return;
                    showMessage('获取课表失败，学校可能暂未开放查询', true);
                }
            } else {
                resetScheduleDisplay();
                showMessage(data.data.message || '暂无课程数据');
            }
        } else {
            resetScheduleDisplay();
            showMessage(data.message || '暂无课程数据');
        }
    } catch (error) {
        if (generation !== academicCacheGeneration) return;
        console.error('加载课程表失败:', error);
        resetScheduleDisplay();
        showMessage('加载失败，请检查网络连接', true);
    }
}

function renderScheduleWeek(schedule, panel, courseColorMap = buildScheduleCourseColorMap(schedule)) {
    const { scheduleDays, scheduleGrid, scheduleHeader } = getSchedulePanelElements(panel);
    if (!scheduleDays || !scheduleGrid || !scheduleHeader) return;

    // 为每个星期创建课程列表
    const daysCourses = {
        1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: []
    };

    let hasEvening = false;

    // 遍历所有周次的课程
    Object.values(schedule).forEach(weekCourses => {
        if (Array.isArray(weekCourses)) {
            weekCourses.forEach(course => {
                const dayNum = parseInt(course['星期']);
                const section = parseInt(course['节次']);
                const duration = parseInt(course['节数']) || 1;
                const location = course['位置'] || '';

                if (dayNum && section) {
                    if (section + duration - 1 >= 9) hasEvening = true;
                    daysCourses[dayNum].push(buildScheduleCourseCardData(course, dayNum));
                }
            });
        }
    });

    // 检测周末是否有课
    const hasWeekend = daysCourses[6].length > 0 || daysCourses[7].length > 0;

    // 生成课程卡片HTML
    let html = '';
    for (let day = 1; day <= 7; day++) {
        const weekendClass = day >= 6 ? ' schedule-day-weekend' : '';
        html += `<div class="schedule-day-column${weekendClass}">`;

        const courses = daysCourses[day];
        courses.forEach((course, index) => {
            const positionStyle = scheduleCourseGridPlacement(course.section, course.duration);

            const courseColor = courseColorMap.get(getScheduleCourseColorKey(course)) || 'hsl(208, 72%, 40%)';

            const courseData = encodeURIComponent(JSON.stringify(course));

            html += `
                <div class="course-card"
                     style="${positionStyle} background: ${courseColor};"
                     data-course="${courseData}"
                     data-day="${day}"
                     onclick="showCourseDetail(this)">
                    <div class="course-card-name">${escapeScheduleHtml(course.name)}</div>
                    ${course.location ? `<div class="course-card-location">${escapeScheduleHtml(course.location)}</div>` : ''}
                </div>
            `;
        });

        html += '</div>';
    }

    scheduleDays.innerHTML = html;
    scheduleGrid.classList.toggle('has-evening', hasEvening);
    setScheduleWeekendVisibility(hasWeekend, scheduleGrid, scheduleHeader);
    updateScheduleTimeline(userIsFreshman, panel);
}

function displaySchedule(schedule) {
    clearScheduleDinoGestureTimers();
    resetScheduleSwipeGesture();
    const source = getScheduleDataSource(schedule);
    const courseColorMap = buildScheduleCourseColorMap(source);
    const swipe = ensureScheduleSwipePanels();
    if (!swipe) {
        renderScheduleWeek(schedule, document.querySelector('.schedule-week-panel'), courseColorMap);
        return;
    }

    [
        [swipe.previous, currentWeek - 1],
        [swipe.current, currentWeek],
        [swipe.next, currentWeek + 1],
    ].forEach(([panel, week], index) => {
        panel.dataset.week = String(week);
        panel.classList.toggle('is-current', index === 1);
        panel.classList.toggle('is-swipe-adjacent', index !== 1);
        panel.classList.remove('is-swipe-target');
        panel.setAttribute('aria-hidden', index === 1 ? 'false' : 'true');
        renderScheduleWeek(getScheduleWeekPayload(source, week), panel, courseColorMap);
    });

    updateScheduleDates(currentWeek);
    swipe.track.classList.remove('is-dragging', 'is-animating', 'is-changing');
    swipe.viewport.classList.remove(
        'is-swiping',
        'is-settling',
        'is-dino-jumping',
        'is-dino-reversing',
        'is-dino-fireball',
        'is-dino-completing',
        'is-dino-button-jump',
        'is-dino-crashed',
        'has-dino-obstacle',
    );
    if (swipe.dinoLane) {
        swipe.dinoLane.style.setProperty('--dino-obstacle-progress', '0');
        swipe.dinoLane.style.setProperty('--dino-obstacle-shift', '140px');
        swipe.dinoLane.style.setProperty('--dino-fireball-distance', '240px');
        swipe.dinoLane.style.setProperty('--dino-drag-lift', '0px');
        swipe.dinoLane.dataset.blocked = 'false';
    }
    setScheduleSwipeTransform(0);
}

function getScheduleCourseColorKey(course = {}) {
    const source = course || {};
    const courseCode = String(source['课程号'] ?? source.code ?? '').trim();
    const courseName = String(source['课程名'] ?? source.name ?? '').trim();
    const teacher = String(source['教师'] ?? source.teacher ?? '').trim();
    return JSON.stringify(courseCode ? [courseCode, courseName] : [courseName, teacher]);
}

function buildScheduleCourseColorMap(schedule = {}) {
    const courseKeys = new Set();
    Object.values(schedule || {}).forEach(weekCourses => {
        if (!Array.isArray(weekCourses)) return;
        weekCourses.forEach(course => courseKeys.add(getScheduleCourseColorKey(course)));
    });

    const sortedCourseKeys = Array.from(courseKeys).sort();
    const colorMap = new Map();
    sortedCourseKeys.forEach((courseKey, index) => {
        const hue = (208 + (index * 360) / sortedCourseKeys.length) % 360;
        colorMap.set(courseKey, `hsl(${hue.toFixed(3)}, 72%, 40%)`);
    });
    return colorMap;
}

function showCourseDetail(el) {
    const course = JSON.parse(decodeURIComponent(el.dataset.course));
    const modal = document.getElementById('course-detail-modal');
    const week = Number.parseInt(el.closest('.schedule-week-panel')?.dataset.week, 10) || currentWeek;
    const date = getCalendarDate(currentSemesterStartValue(), week, el.dataset.day);
    const times = userIsFreshman ? PERIOD_TIMES_FRESHMAN : PERIOD_TIMES_DEFAULT;
    const clock = getCalendarPeriodTime(course.section, course.duration, times);

    document.getElementById('course-detail-name').textContent = course.name;
    document.getElementById('course-detail-body').innerHTML = buildScheduleCourseDetailHtml({
        ...course,
        week,
        date: date || '学期起始日期待核对',
        clockTime: clock ? `${clock.start}–${clock.end}` : '',
    });

    openUiModal(modal);
}

function closeCourseDetail() {
    closeUiModal(document.getElementById('course-detail-modal'));
}

function changeWeek(delta, animate = false) {
    const buttonSwipe = resolveScheduleButtonSwipe({
        delta,
        currentWeek,
        minWeek: SCHEDULE_MIN_WEEK,
        maxWeek: SCHEDULE_MAX_WEEK,
    });
    const newWeek = currentWeek + delta;

    if (animate) {
        const swipe = ensureScheduleSwipePanels();
        if (!buttonSwipe.shouldChange || !swipe || scheduleSwipeTransition || scheduleSwipeGesture.pointerId !== null) return;

        clearScheduleDinoGestureTimers();
        resetScheduleSwipeGesture();
        const obstacleType = pickScheduleDinoObstacle();
        if (swipe.dinoLane) {
            swipe.dinoLane.dataset.direction = buttonSwipe.direction < 0 ? 'previous' : 'next';
            swipe.dinoLane.dataset.obstacle = obstacleType;
            swipe.dinoLane.dataset.blocked = 'false';
            swipe.dinoLane.style.setProperty('--dino-obstacle-progress', '0');
            swipe.dinoLane.style.setProperty('--dino-obstacle-shift', '140px');
        }
        swipe.viewport.classList.add('has-dino-obstacle', 'is-dino-jumping', 'is-dino-button-jump');
        animateScheduleSwipeTo(buttonSwipe, getScheduleSwipeWidth(swipe.viewport), 'complete');
        return;
    }

    if (newWeek >= SCHEDULE_MIN_WEEK && newWeek <= SCHEDULE_MAX_WEEK) {
        if (otherMajorScheduleData) {
            currentWeek = newWeek;
            document.getElementById('week-select').value = newWeek;
            updateScheduleDates(newWeek);
            displaySchedule({ [newWeek]: otherMajorScheduleData[String(newWeek)] || [] });
        } else {
            loadSchedule(newWeek);
        }
    }
}

function updateScheduleDates(week) {
    // 同步下拉框
    const select = document.getElementById('week-select');
    if (select) {
        if (select.options.length === 0) {
            for (let w = 1; w <= 25; w++) {
                const opt = document.createElement('option');
                opt.value = w;
                opt.textContent = `第 ${w} 周`;
                select.appendChild(opt);
            }
        }
        select.value = week;
    }

    const activeStart = currentSemesterStartValue();
    const today = getCalendarChinaToday();

    const swipe = ensureScheduleSwipePanels();
    const panels = swipe?.panels || [document.querySelector('.schedule-week-panel')].filter(Boolean);
    panels.forEach(panel => {
        const panelWeek = Number.parseInt(panel.dataset.week, 10);
        if (!Number.isInteger(panelWeek) || panelWeek < SCHEDULE_MIN_WEEK || panelWeek > SCHEDULE_MAX_WEEK) return;

        for (let day = 1; day <= 7; day++) {
            const dateEl = panel.querySelector(`[data-schedule-date="${day}"]`);
            const dayEl = panel.querySelector(`[data-schedule-day="${day}"]`);
            if (!dateEl) continue;

            if (!activeStart) {
                dateEl.textContent = '';
                if (dayEl) dayEl.classList.remove('schedule-day-today');
                continue;
            }
            const date = getCalendarDate(activeStart, panelWeek, day);
            const [, month, dayOfMonth] = date.split('-');
            const m = Number(month);
            const d = Number(dayOfMonth);
            dateEl.textContent = `${m}月${d}日`;

            // 高亮今天
            if (dayEl) {
                dayEl.classList.toggle('schedule-day-today', date === today);
            }
        }
    });
}

function jumpToWeek(week) {
    if (otherMajorScheduleData) {
        currentWeek = week;
        updateScheduleDates(week);
        displaySchedule({ [week]: otherMajorScheduleData[String(week)] || [] });
    } else {
        loadSchedule(week);
    }
}

// ==================== 考试安排相关 ====================
// 更新考试安排数据（从服务器获取最新数据）
async function updateExamsData(event) {
    const generation = academicCacheGeneration;
    const btn = event?.currentTarget || event?.target || document.getElementById('update-exams-btn');
    if (!btn) return;
    const originalText = btn.textContent;

    btn.disabled = true;
    btn.textContent = '更新中...';

    try {
        const response = await fetch('/api/update_exams', {
            method: 'POST',
            headers: {
                'X-Device-ID': getDeviceId()
            }
        });
        const data = await response.json();
        if (generation !== academicCacheGeneration) return;

        if (data.success) {
            showUiToast('考试安排更新成功', 'success');
            cachedExams = null;
            // 重新加载考试安排
            loadExams();
        } else {
            showUiToast(data.message || '更新失败', 'error');
        }
    } catch (error) {
        if (generation !== academicCacheGeneration) return;
        console.error('更新考试安排失败:', error);
        showUiToast('更新考试安排失败，学校可能暂未开放查询', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

async function loadExams(autoFetched = false) {
    let generation = academicCacheGeneration;
    const contentDiv = document.getElementById('exams-content');
    cachedExams = null;
    contentDiv.innerHTML = '<div class="loading">加载中</div>';

    try {
        const response = await fetch('/api/exams', {
            headers: {
                'X-Device-ID': getDeviceId()
            }
        });
        const data = await response.json();
        if (generation !== academicCacheGeneration) return;

        if (data.success && data.account && data.account !== currentUsername) {
            currentUsername = data.account;
            rememberBoundUsername(currentUsername);
            generation = academicCacheGeneration;
            document.getElementById('sidebar-username').textContent = currentUsername;
        }
        if (data.success && data.cache_stale) {
            contentDiv.innerHTML = '<p style="text-align:center;color:var(--warning);">后台已切换学期，请点击“更新考试安排”获取本学期考试后再查看或导出。</p>';
            return;
        }

        if (data.success && data.semester_start) {
            semesterStart = new Date(`${data.semester_start}T00:00:00`);
        }
        if (data.success && data.exams && data.exams.length > 0) {
            cachedExams = data.exams;
            displayExams(data.exams);
        } else if (!autoFetched) {
            // 没有缓存数据，自动从教务系统获取
            contentDiv.innerHTML = '<p style="text-align:center;color:var(--text-tertiary);">正在从教务系统获取考试安排...</p>';
            try {
                const updateResp = await fetch('/api/update_exams', {
                    method: 'POST',
                    headers: { 'X-Device-ID': getDeviceId() }
                });
                const updateData = await updateResp.json();
                if (generation !== academicCacheGeneration) return;
                if (updateData.success) {
                    loadExams(true);
                    return;
                } else {
                    contentDiv.innerHTML = `<p style="text-align:center;color:var(--error);">${updateData.message || '获取考试安排失败'}</p>`;
                }
            } catch (e) {
                if (generation !== academicCacheGeneration) return;
                contentDiv.innerHTML = '<p style="text-align:center;color:var(--error);">获取考试安排失败，学校可能暂未开放查询</p>';
            }
        } else {
            contentDiv.innerHTML = '<p style="text-align:center;color:var(--text-tertiary);">暂无考试安排</p>';
        }
    } catch (error) {
        if (generation !== academicCacheGeneration) return;
        console.error('加载考试安排失败:', error);
        contentDiv.innerHTML = '<p style="text-align:center;color:var(--error);">加载失败</p>';
    }
}

function displayExams(exams) {
    const contentDiv = document.getElementById('exams-content');
    const examGroups = new Map();
    exams.forEach(exam => {
        const examName = exam.exam_name || '其他考试';
        if (!examGroups.has(examName)) examGroups.set(examName, []);
        examGroups.get(examName).push(exam);
    });
    let html = '';
    examGroups.forEach((examList, examName) => {
        html += `
            <div class="exam-group">
                <div class="exam-group-title">${escapeScheduleHtml(examName)}</div>
                <div class="exam-group-content">
        `;
        examList.forEach(exam => {
            const date = getCalendarDate(currentSemesterStartValue(), exam.week, exam.day);
            const dayNames = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
            const dayName = dayNames[Number(exam.day)] || `星期${exam.day || '待定'}`;
            const weekText = exam.week ? `第${exam.week}周 ${dayName}` : dayName;
            const location = exam.location || [exam.campus, exam.building, exam.room].filter(Boolean).join('');
            const row = (label, value) => value
                ? `<div class="exam-info-item"><strong>${label}：</strong><span>${escapeScheduleHtml(value)}</span></div>`
                : '';
            let urgencyClass = 'exam-normal';
            let countdownHtml = '';
            if (date) {
                const today = getCalendarChinaToday();
                const diffDays = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000;
                if (diffDays <= 3 && diffDays >= 0) {
                    urgencyClass = 'exam-urgent';
                    countdownHtml = `<div class="exam-countdown" style="color:var(--error);">${diffDays === 0 ? '今天考试' : `${diffDays}天后考试`}</div>`;
                } else if (diffDays <= 7 && diffDays > 3) {
                    urgencyClass = 'exam-soon';
                    countdownHtml = `<div class="exam-countdown" style="color:var(--warning);">${diffDays}天后考试</div>`;
                } else if (diffDays > 7) {
                    countdownHtml = `<div class="exam-countdown" style="color:var(--accent);">${diffDays}天后考试</div>`;
                }
            }

            html += `
                <div class="exam-card ${urgencyClass}">
                    <div class="exam-course">${escapeScheduleHtml(exam.course || '未命名课程')}</div>
                    <div class="exam-info">
                        ${row('日期', date ? `${date}（${weekText}）` : `学期起始日期待核对（${weekText}）`)}
                        ${row('时间', exam.time)}
                        ${row('考场', location)}
                        ${row('校区', exam.campus)}
                        ${row('教学楼', exam.building)}
                        ${row('教室', exam.room)}
                        ${row('座位号', exam.seat)}
                    </div>
                    ${countdownHtml}
                </div>
            `;
        });

        html += `
                </div>
            </div>
        `;
    });

    contentDiv.innerHTML = html;
}

function currentSemesterStartValue() {
    if (!(semesterStart instanceof Date) || Number.isNaN(semesterStart.getTime())) return '';
    const year = semesterStart.getFullYear();
    const month = String(semesterStart.getMonth() + 1).padStart(2, '0');
    const day = String(semesterStart.getDate()).padStart(2, '0');
    return getCurrentCalendarSemesterStart(`${year}-${month}-${day}`) || '';
}

async function openCalendarExport(kind) {
    if (kind !== 'schedule' && kind !== 'exams' && kind !== 'all') return;
    let generation = academicCacheGeneration;
    try {
        const endpoints = kind === 'all' ? ['/api/schedule', '/api/exams']
            : [kind === 'schedule' ? '/api/schedule' : '/api/exams'];
        const replies = await Promise.all(endpoints.map(async url => {
            const response = await fetch(url, { headers: { 'X-Device-ID': getDeviceId() } });
            return { url, response, payload: await response.json() };
        }));
        if (generation !== academicCacheGeneration) return;
        for (const { response, payload } of replies) {
            if (!response.ok || !payload.success) throw new Error(payload.message || '读取日程数据失败');
        }
        const schedulePayload = replies.find(reply => reply.url === '/api/schedule')?.payload;
        const examPayload = replies.find(reply => reply.url === '/api/exams')?.payload;
        if (schedulePayload?.account && examPayload?.account && schedulePayload.account !== examPayload.account) {
            throw new Error('课表与考试不属于同一账号，请重新登录后重试。');
        }
        const account = String(schedulePayload?.account || examPayload?.account || currentUsername || '').trim();
        if (account && account !== currentUsername) {
            currentUsername = account;
            rememberBoundUsername(account);
            generation = academicCacheGeneration;
            document.getElementById('sidebar-username').textContent = account;
        }
        const scheduleStale = !!schedulePayload?.data?.cache_stale;
        const examStale = !!examPayload?.cache_stale;
        if (kind === 'schedule' && scheduleStale) {
            throw new Error('后台已切换学期，请先更新课程表再导出。');
        }
        if (kind === 'exams' && examStale) {
            throw new Error('后台已切换学期，请先更新考试安排再导出。');
        }
        const scheduleSource = schedulePayload?.data?.schedule;
        const examSource = examPayload?.exams;
        const scheduleStart = schedulePayload?.data?.semester_start;
        const examStart = examPayload?.semester_start;
        const hasSchedule = !!scheduleSource && Object.values(scheduleSource)
            .some(courses => Array.isArray(courses) && courses.length);
        const hasExams = Array.isArray(examSource) && examSource.length > 0;
        const useSchedule = kind !== 'exams' && hasSchedule && !scheduleStale;
        const useExams = kind !== 'schedule' && hasExams && !examStale;
        if (!useSchedule && !useExams) {
            if (scheduleStale || examStale) {
                throw new Error('后台已切换学期，请先更新课程表或考试安排后再导出。');
            }
            throw new Error('暂无可导出的课程或考试安排');
        }
        if (scheduleStart && examStart && scheduleStart !== examStart) {
            throw new Error('课表与考试的学期日期不一致，请重试。');
        }
        const source = kind === 'all' ? {
            schedule: useSchedule ? scheduleSource : {},
            exams: useExams ? examSource : [],
        }
            : kind === 'schedule' ? scheduleSource : examSource;
        const start = useSchedule ? scheduleStart : examStart;
        semesterStart = start ? new Date(`${start}T00:00:00`) : null;
        if (typeof schedulePayload?.data?.is_freshman === 'boolean') {
            userIsFreshman = schedulePayload.data.is_freshman;
        }
        if (schedulePayload) cachedSchedule = scheduleStale ? null : scheduleSource;
        if (examPayload) cachedExams = examStale ? null : examSource;

        calendarExportKind = kind;
        calendarExportData = source;
        calendarExportAccount = account;
        document.getElementById('calendar-export-title').textContent = useSchedule && useExams
            ? '导出课表与考试到日历'
            : useSchedule ? '导出课程表到日历' : '导出考试安排到日历';
        const description = kind === 'schedule'
            ? '将全部已缓存的上课时段分别写入日历，并附上教师、地点和课程详情。'
            : kind === 'exams'
                ? '将全部已缓存的考试写入日历，并附上考场、座位号等详情。'
                : useSchedule && useExams
                    ? '将课程和考试写入同一个日历文件，并附上教师、教室、考场和座位号等详情。'
                    : useSchedule
                        ? `当前仅有可导出的课表，将导出课程详情。${examStale ? '考试安排需更新后才能导出。' : ''}`
                        : `当前仅有可导出的考试安排，将导出考场、座位号等详情。${scheduleStale ? '课程表需更新后才能导出。' : ''}`;
        const currentStart = currentSemesterStartValue();
        document.getElementById('calendar-export-description').textContent = currentStart
            ? description
            : `${description} 后台学期日期已过期或未设置，请联系管理员校正；本次导出也可手动输入实际首周星期一。`;
        document.getElementById('calendar-export-start').value = currentStart;
        const error = document.getElementById('calendar-export-error');
        error.textContent = '';
        error.hidden = true;
        openUiModal(document.getElementById('calendar-export-modal'), { initialFocusSelector: '#calendar-export-start' });
    } catch (error) {
        if (generation !== academicCacheGeneration) return;
        showUiToast(error.message || '读取日程数据失败', 'error');
    }
}

function closeCalendarExport() {
    closeUiModal(document.getElementById('calendar-export-modal'));
    calendarExportKind = null;
    calendarExportData = null;
    calendarExportAccount = '';
}

function downloadCalendarExport(event) {
    event.preventDefault();
    const start = document.getElementById('calendar-export-start').value;
    const error = document.getElementById('calendar-export-error');
    const showError = message => {
        error.textContent = message;
        error.hidden = false;
    };
    if (!getCalendarDate(start, 1, 1)) {
        showError('请选择有效的学期首周星期一。');
        return;
    }
    const combinedSchedule = calendarExportKind === 'all'
        && Object.values(calendarExportData.schedule || {}).some(courses => Array.isArray(courses) && courses.length);
    const combinedExams = calendarExportKind === 'all' && calendarExportData.exams?.length > 0;
    const name = calendarExportKind === 'schedule' || (combinedSchedule && !combinedExams) ? '课程表'
        : calendarExportKind === 'exams' || (combinedExams && !combinedSchedule) ? '考试安排' : '课表与考试';
    const periodTimes = userIsFreshman ? PERIOD_TIMES_FRESHMAN : PERIOD_TIMES_DEFAULT;
    let result;
    if (calendarExportKind === 'schedule') {
        result = buildScheduleCalendarEvents(calendarExportData, start, periodTimes);
    } else if (calendarExportKind === 'exams') {
        result = buildExamCalendarEvents(calendarExportData, start);
    } else {
        const courses = buildScheduleCalendarEvents(calendarExportData.schedule, start, periodTimes);
        const exams = buildExamCalendarEvents(calendarExportData.exams, start);
        result = {
            events: [...courses.events, ...exams.events]
                .sort((a, b) => `${a.date}${a.start}${a.summary}`.localeCompare(`${b.date}${b.start}${b.summary}`)),
            skipped: courses.skipped + exams.skipped,
        };
    }
    if (!result.events.length) {
        showError('没有可导出的日程，请检查记录中的日期、节次或时间。');
        return;
    }

    const ics = serializeCalendar(result.events, name, new Date(), calendarExportAccount);
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${name}-${start}.ics`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    closeCalendarExport();
    const skipped = result.skipped ? `，另有 ${result.skipped} 条时间不完整的记录未导出` : '';
    showUiToast(`已生成 ${result.events.length} 条日程${skipped}`, 'success');
}

// ==================== 成绩查询相关 ====================

let gradesReturnFocus = null;

function gradesBackToMenu({ restoreFocus = true } = {}) {
    const menu = document.getElementById('grades-menu');
    menu.style.display = '';
    document.getElementById('grades-result').style.display = 'none';
    const pageTitle = document.getElementById('grades-page-title');
    if (pageTitle) pageTitle.hidden = false;

    const focusTarget = gradesReturnFocus;
    gradesReturnFocus = null;
    if (restoreFocus && focusTarget?.isConnected !== false) {
        focusUiElement(focusTarget);
    }
}

function gradesShowResult(title) {
    const menu = document.getElementById('grades-menu');
    const activeElement = document.activeElement;
    gradesReturnFocus = menu.contains?.(activeElement)
        ? activeElement : menu.querySelector?.('.grade-action-btn') || null;
    menu.style.display = 'none';
    const pageTitle = document.getElementById('grades-page-title');
    if (pageTitle) pageTitle.hidden = true;
    const result = document.getElementById('grades-result');
    result.style.display = '';
    document.getElementById('grades-result-title').textContent = title;
    document.getElementById('grades-content').innerHTML = '<div class="loading">加载中</div>';
    result.scrollIntoView?.({ block: 'start' });
    focusUiElement(document.getElementById('grades-back-btn'));
}

function gradesEscape(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[ch]));
}

function gradesScoreClass(scoreValue) {
    const score = parseFloat(scoreValue);
    if (isNaN(score)) return 'score-medium';
    if (score >= 90) return 'score-high';
    if (score < 60) return 'score-low';
    return 'score-medium';
}

function gradesBuildSimpleTable(grades) {
    let html = '<table class="grades-table"><thead><tr><th>课程名称</th><th>成绩</th></tr></thead><tbody>';
    grades.forEach(grade => {
        const scoreClass = gradesScoreClass(grade.score);
        html += `<tr><td>${gradesEscape(grade.course || '-')}</td><td class="${scoreClass}">${gradesEscape(grade.score || '-')}</td></tr>`;
    });
    return html + '</tbody></table>';
}

function gradesFormatExamTime(value) {
    const s = String(value || '').trim();
    return s.length === 8 ? `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` : (s || '-');
}

function gradesBuildFailedTable(list) {
    let html = '<table class="grades-table"><thead><tr><th>课程名称</th><th>学分</th><th>成绩</th><th>考试时间</th></tr></thead><tbody>';
    list.forEach(g => {
        html += `<tr><td>${gradesEscape(g.course || '-')}</td><td>${gradesEscape(g.credit || '-')}</td><td class="score-low">${gradesEscape(g.score || '-')}</td><td>${gradesEscape(gradesFormatExamTime(g.exam_time))}</td></tr>`;
    });
    return html + '</tbody></table>';
}

async function gradesLoadLatestSummary() {
    await checkLoginStatus();
    gradesShowResult('一键查本学期成绩');
    try {
        const resp = await fetch('/api/grades/latest_summary', { headers: { 'X-Device-ID': getDeviceId() } });
        const data = await resp.json();
        if (!data.success) {
            document.getElementById('grades-content').innerHTML = `<p style="text-align:center;color:var(--error);">${gradesEscape(data.message || '查询失败')}</p>`;
            return;
        }

        const passed = data.passed || [];
        const failed = data.failed || {};
        const currentFailed = failed.current || [];
        const pastFailed = failed.past || [];
        const semester = data.semester || '最新学期';
        let html = `
            <div class="grade-summary-meta">
                <span>最新学期：${gradesEscape(semester)}</span>
                <span>及格 ${passed.length} 门</span>
                <span>尚不及格 ${currentFailed.length} 门</span>
                <span>曾不及格 ${pastFailed.length} 门</span>
            </div>
        `;

        html += '<div class="failed-section">';
        html += '<div class="failed-section-title passed-latest">最新学期及格成绩</div>';
        html += passed.length ? gradesBuildSimpleTable(passed) : '<p class="grade-summary-empty">最新学期暂无及格成绩数据</p>';
        html += '</div>';

        html += '<div class="failed-section">';
        html += '<div class="failed-section-title failed-current">尚不及格</div>';
        html += currentFailed.length ? gradesBuildFailedTable(currentFailed) : '<p class="grade-summary-empty">暂无尚不及格成绩</p>';
        html += '</div>';

        html += '<div class="failed-section">';
        html += '<div class="failed-section-title failed-past">曾不及格</div>';
        html += pastFailed.length ? gradesBuildFailedTable(pastFailed) : '<p class="grade-summary-empty">暂无曾不及格成绩</p>';
        html += '</div>';

        document.getElementById('grades-content').innerHTML = html;
    } catch (e) {
        document.getElementById('grades-content').innerHTML = '<p style="text-align:center;color:var(--error);">加载失败</p>';
    }
}
async function gradesShowCurrentSemester() {
    await checkLoginStatus();
    gradesShowResult('本学期成绩');
    try {
        const resp = await fetch('/api/grades/current', { headers: { 'X-Device-ID': getDeviceId() } });
        const data = await resp.json();
        if (data.success && data.grades && data.grades.length > 0) {
            displayGrades(data.grades);
        } else if (!data.success) {
            document.getElementById('grades-content').innerHTML = `<p style="text-align:center;color:var(--error);">${data.message || '查询失败'}</p>`;
        } else {
            document.getElementById('grades-content').innerHTML = '<p style="text-align:center;color:var(--text-tertiary);">暂无成绩数据</p>';
        }
    } catch (e) {
        document.getElementById('grades-content').innerHTML = '<p style="text-align:center;color:var(--error);">加载失败</p>';
    }
}

async function gradesShowSemesterPicker() {
    await checkLoginStatus();
    const modal = document.getElementById('semester-picker-modal');
    const list = document.getElementById('semester-picker-list');
    list.innerHTML = '<div class="loading">加载中...</div>';
    openUiModal(modal);
    try {
        const resp = await fetch('/api/grades/semesters', { headers: { 'X-Device-ID': getDeviceId() } });
        const data = await resp.json();
        if (!data.success) {
            list.innerHTML = `<p style="color:var(--error);text-align:center;">${gradesEscape(data.message || '查询失败')}</p>`;
            return;
        }
        if (!Array.isArray(data.semesters) || data.semesters.length === 0) {
            list.innerHTML = '<p style="color:var(--text-tertiary);text-align:center;">暂无学期数据</p>';
            return;
        }
        list.innerHTML = data.semesters.map(s => `
            <button class="semester-option-btn" onclick="gradesPickSemester('${s.replace(/'/g, "\\'")}')">${s}</button>
        `).join('');
    } catch (e) {
        list.innerHTML = '<p style="color:var(--error);text-align:center;">加载失败</p>';
    }
}

function closeSemesterPicker() {
    closeUiModal(document.getElementById('semester-picker-modal'));
}

async function gradesPickSemester(semester) {
    closeSemesterPicker();
    gradesShowResult(`及格成绩（${semester}）`);
    try {
        const resp = await fetch(`/api/grades/by_semester?semester=${encodeURIComponent(semester)}`, { headers: { 'X-Device-ID': getDeviceId() } });
        const data = await resp.json();
        if (!data.success) {
            document.getElementById('grades-content').innerHTML = `<p style="text-align:center;color:var(--error);">${gradesEscape(data.message || '查询失败')}</p>`;
        } else if (Array.isArray(data.grades) && data.grades.length > 0) {
            displayGrades(data.grades);
        } else {
            document.getElementById('grades-content').innerHTML = '<p style="text-align:center;color:var(--text-tertiary);">该学期暂无成绩数据</p>';
        }
    } catch (e) {
        document.getElementById('grades-content').innerHTML = '<p style="text-align:center;color:var(--error);">加载失败</p>';
    }
}

async function gradesLoadFailed() {
    await checkLoginStatus();
    gradesShowResult('不及格成绩');
    try {
        const resp = await fetch('/api/grades/failed', { headers: { 'X-Device-ID': getDeviceId() } });
        const data = await resp.json();
        if (!data.success) {
            document.getElementById('grades-content').innerHTML = `<p style="text-align:center;color:var(--error);">${data.message || '查询失败'}</p>`;
            return;
        }
        const current = data.current || [];
        const past = data.past || [];
        if (current.length === 0 && past.length === 0) {
            document.getElementById('grades-content').innerHTML = '<p style="text-align:center;color:var(--text-tertiary);">没有不及格成绩，继续加油！</p>';
            return;
        }
        let html = '';
        const fmtDate = s => (s && s.length === 8) ? `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` : (s || '-');
        const buildTable = (list) => {
            let t = '<table class="grades-table"><thead><tr><th>课程名称</th><th>学分</th><th>成绩</th><th>考试时间</th></tr></thead><tbody>';
            list.forEach(g => {
                t += `<tr><td>${g.course}</td><td>${g.credit}</td><td class="score-low">${g.score}</td><td>${fmtDate(g.exam_time)}</td></tr>`;
            });
            return t + '</tbody></table>';
        };
        if (current.length > 0) {
            html += `<div class="failed-section"><div class="failed-section-title failed-current">尚不及格</div>${buildTable(current)}</div>`;
        }
        if (past.length > 0) {
            html += `<div class="failed-section"><div class="failed-section-title failed-past">曾不及格</div>${buildTable(past)}</div>`;
        }
        document.getElementById('grades-content').innerHTML = html;
    } catch (e) {
        document.getElementById('grades-content').innerHTML = '<p style="text-align:center;color:var(--error);">加载失败</p>';
    }
}

function escapeGradeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[ch]));
}

function buildGpaDetailTable(details) {
    if (!Array.isArray(details) || details.length === 0) {
        return '';
    }

    const rows = details.filter(row => row && typeof row === 'object' && Object.keys(row).length > 0);
    if (rows.length === 0) {
        return '';
    }

    const preferredColumns = ['学年学期', '学分绩点', '学位绩点', '加权学分学位绩点', '学年', '学期', '平均学分绩点', '平均学位绩点', '总学分', '获得学分', '学分'];
    const allColumns = Array.from(new Set(rows.flatMap(row => Object.keys(row))));
    const columns = [
        ...preferredColumns.filter(column => allColumns.includes(column)),
        ...allColumns.filter(column => !preferredColumns.includes(column))
    ];

    let html = '<div class="gpa-detail-card">';
    html += '<h3 class="gpa-title">学期绩点明细</h3>';
    html += '<div class="grades-table-wrap"><table class="grades-table gpa-detail-table"><thead><tr>';
    columns.forEach(column => {
        html += `<th>${escapeGradeHtml(column)}</th>`;
    });
    html += '</tr></thead><tbody>';
    rows.forEach(row => {
        html += '<tr>';
        columns.forEach(column => {
            html += `<td>${escapeGradeHtml(row[column])}</td>`;
        });
        html += '</tr>';
    });
    html += '</tbody></table></div></div>';
    return html;
}

async function gradesLoadGpa() {
    await checkLoginStatus();
    gradesShowResult('学分绩点');
    try {
        const resp = await fetch('/api/grades/gpa', { headers: { 'X-Device-ID': getDeviceId() } });
        const data = await resp.json();
        if (!data.success) {
            document.getElementById('grades-content').innerHTML = `<p style="text-align:center;color:var(--error);">${gradesEscape(data.message || '查询失败')}</p>`;
            return;
        }
        const gpa = data.gpa || {};
        const creditGpa = gpa['学分绩点'];
        const degreeGpa = gpa['学位绩点'];
        const weightedGpa = gpa['加权学分学位绩点'];
        const semesterDetails = gpa['学期绩点明细'] || gpa.semester_details || [];
        let html = '<div class="gpa-info-card"><h3 class="gpa-title">绩点信息</h3><div class="gpa-items">';
        if (creditGpa !== null && creditGpa !== undefined) {
            html += `<div class="gpa-item"><span class="gpa-label">学分绩点</span><span class="gpa-value">${escapeGradeHtml(creditGpa)}</span></div>`;
        }
        if (degreeGpa !== null && degreeGpa !== undefined) {
            html += `<div class="gpa-item"><span class="gpa-label">学位绩点</span><span class="gpa-value">${escapeGradeHtml(degreeGpa)}</span></div>`;
        }
        if (weightedGpa !== null && weightedGpa !== undefined) {
            html += `<div class="gpa-item"><span class="gpa-label">加权学分学位绩点</span><span class="gpa-value">${escapeGradeHtml(weightedGpa)}</span></div>`;
        }
        if ((creditGpa === null || creditGpa === undefined) && (degreeGpa === null || degreeGpa === undefined) && (weightedGpa === null || weightedGpa === undefined)) {
            html += '<p class="gpa-empty">暂未查询到总体绩点</p>';
        }
        html += '</div></div>';
        html += buildGpaDetailTable(semesterDetails);
        document.getElementById('grades-content').innerHTML = html;
    } catch (e) {
        document.getElementById('grades-content').innerHTML = '<p style="text-align:center;color:var(--error);">加载失败</p>';
    }
}

// ==================== 考试成绩选择器 ====================

let _examSessions = null; // 缓存会话数据

async function gradesShowExamPicker() {
    await checkLoginStatus();
    const modal = document.getElementById('exam-picker-modal');
    document.getElementById('exam-picker-title').textContent = '选择学期';
    const body = document.getElementById('exam-picker-body');
    body.innerHTML = '<div class="loading">加载中...</div>';
    openUiModal(modal);

    if (!_examSessions) {
        try {
            const resp = await fetch('/api/grades/exam_sessions', { headers: { 'X-Device-ID': getDeviceId() } });
            const data = await resp.json();
            if (!data.success) {
                body.innerHTML = `<p style="color:var(--error);text-align:center;">${data.message || '加载失败'}</p>`;
                return;
            }
            _examSessions = data;
        } catch (e) {
            body.innerHTML = '<p style="color:var(--error);text-align:center;">加载失败</p>';
            return;
        }
    }

    // 倒序取最新 8 个学期
    const semesters = [..._examSessions.semesters].reverse().slice(0, 8);
    body.innerHTML = semesters.map(s =>
        `<button class="semester-option-btn" onclick="examPickSemester('${s.value}', '${s.text.replace(/'/g, "\\'")}')">${s.text}</button>`
    ).join('');
}

function examPickSemester(jxzxjh, semesterText) {
    document.getElementById('exam-picker-title').textContent = semesterText;
    const exams = (_examSessions.exams || []).filter(e => e.jxzxjh === jxzxjh);
    const body = document.getElementById('exam-picker-body');
    if (exams.length === 0) {
        body.innerHTML = '<p style="color:var(--text-tertiary);text-align:center;">该学期暂无考试记录</p>';
        return;
    }
    body.innerHTML = exams.map(e =>
        `<button class="semester-option-btn" onclick="examPickExam('${e.jxzxjh}','${e.ksbh}','${e.name.replace(/'/g, "\\'")}')">${e.name}</button>`
    ).join('');
}

async function examPickExam(jxzxjh, ksbh, examName) {
    closeExamPicker();
    gradesShowResult(examName);
    try {
        const resp = await fetch(`/api/grades/exam_scores?jxzxjh=${encodeURIComponent(jxzxjh)}&ksbh=${encodeURIComponent(ksbh)}`, {
            headers: { 'X-Device-ID': getDeviceId() }
        });
        const data = await resp.json();
        if (!data.success) {
            document.getElementById('grades-content').innerHTML = `<p style="text-align:center;color:var(--error);">${data.message || '查询失败'}</p>`;
            return;
        }
        if (!data.grades || data.grades.length === 0) {
            document.getElementById('grades-content').innerHTML = '<p style="text-align:center;color:var(--text-tertiary);">暂无成绩数据</p>';
            return;
        }
        let html = '<table class="grades-table"><thead><tr><th>课程名称</th><th>学分</th><th>成绩</th></tr></thead><tbody>';
        data.grades.forEach(g => {
            const scoreClass = (parseFloat(g.score) < 60) ? 'score-low' : '';
            html += `<tr><td>${g.course}</td><td>${g.credit}</td><td class="${scoreClass}">${g.score || '-'}</td></tr>`;
        });
        html += '</tbody></table>';
        document.getElementById('grades-content').innerHTML = html;
    } catch (e) {
        document.getElementById('grades-content').innerHTML = '<p style="text-align:center;color:var(--error);">加载失败</p>';
    }
}

function closeExamPicker() {
    closeUiModal(document.getElementById('exam-picker-modal'));
}

// 切换到成绩页时不自动加载，等用户点击功能按钮
function loadGrades() {
    gradesBackToMenu({ restoreFocus: false });
}

function displayGrades(grades) {
    const contentDiv = document.getElementById('grades-content');

    // 分离出学分绩点和学位绩点
    let creditGpa = null;
    let degreeGpa = null;
    const courseGrades = [];

    grades.forEach(grade => {
        const courseName = grade.course.trim();
        if (courseName === '学分绩点') {
            creditGpa = grade.score;
        } else if (courseName === '学位绩点') {
            degreeGpa = grade.score;
        } else {
            courseGrades.push(grade);
        }
    });

    // 构建课程成绩表格
    let html = '<table class="grades-table"><thead><tr>';
    html += '<th>课程名称</th><th>成绩</th>';
    html += '</tr></thead><tbody>';

    courseGrades.forEach(grade => {
        // 根据成绩设置颜色
        let scoreClass = 'score-medium';
        const score = parseFloat(grade.score);
        if (!isNaN(score)) {
            if (score >= 90) scoreClass = 'score-high';
            else if (score < 60) scoreClass = 'score-low';
        }

        html += `
            <tr>
                <td>${grade.course}</td>
                <td class="${scoreClass}">${grade.score}</td>
            </tr>
        `;
    });

    html += '</tbody></table>';

    // 添加绩点信息卡片
    if (creditGpa !== null || degreeGpa !== null) {
        html += '<div class="gpa-info-card">';
        html += '<h3 class="gpa-title">绩点信息</h3>';
        html += '<div class="gpa-items">';

        if (creditGpa !== null) {
            html += `
                <div class="gpa-item">
                    <span class="gpa-label">学分绩点</span>
                    <span class="gpa-value">${creditGpa}</span>
                </div>
            `;
        }

        if (degreeGpa !== null) {
            html += `
                <div class="gpa-item">
                    <span class="gpa-label">学位绩点</span>
                    <span class="gpa-value">${degreeGpa}</span>
                </div>
            `;
        }

        html += '</div></div>';
    }

    contentDiv.innerHTML = html;
}

// ==================== 教务评价相关 ====================

let unevaluatedCoursesData = [];

async function doFullEvaluation() {
    await checkLoginStatus();
    const resultDiv = document.getElementById('evaluation-result');
    const btn = document.getElementById('do-eval-btn');
    btn.disabled = true; btn.textContent = '评估中...';
    resultDiv.innerHTML = '<div class="loading">正在查询未评估课程...</div>';

    try {
        const response = await fetch('/api/unevaluated_courses', { headers: { 'X-Device-ID': getDeviceId() } });
        const data = await response.json();

        if (!data.success) {
            resultDiv.className = 'evaluation-result result-error';
            resultDiv.textContent = data.message || '查询失败';
            btn.disabled = false; btn.textContent = '完成教学评估'; return;
        }

        if (!data.has_courses) {
            resultDiv.className = 'evaluation-result result-success';
            resultDiv.innerHTML = `<div style="text-align:center;padding:20px;"><div style="font-size:40px;margin-bottom:10px;color:var(--success);">✓</div><div style="font-size:17px;color:var(--success);font-weight:600;">${data.message || '没有未评估的课程'}</div></div>`;
            btn.disabled = false; btn.textContent = '完成教学评估'; return;
        }

        // 显示找到的课程
        let coursesHtml = '<div style="margin-bottom:15px;">';
        data.courses.forEach(course => {
            coursesHtml += `<div style="background:var(--bg-secondary);padding:10px 14px;margin-bottom:6px;border-radius:10px;"><span style="font-weight:600;">${course['未评课程']}</span><span style="color:var(--text-secondary);margin-left:10px;">教师: ${course['教师']}</span></div>`;
        });
        coursesHtml += '</div>';
        resultDiv.innerHTML = coursesHtml + '<div class="loading">正在提交评教...</div>';

        const evalResponse = await fetch('/api/evaluation', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-ID': getDeviceId() }, body: JSON.stringify({ courses: data.courses }) });
        const evalData = await evalResponse.json();

        if (evalData.success) {
            unevaluatedCoursesData = [];
            resultDiv.className = 'evaluation-result result-success';
            resultDiv.innerHTML = `<div style="text-align:center;padding:20px;"><div style="font-size:40px;margin-bottom:10px;color:var(--success);">✓</div><div style="font-size:17px;color:var(--success);font-weight:600;">${evalData.message || '评估成功'}</div></div>`;
        } else {
            resultDiv.className = 'evaluation-result result-error';
            resultDiv.textContent = evalData.message || '评价失败';
        }
    } catch (error) {
        resultDiv.className = 'evaluation-result result-error';
        resultDiv.textContent = '网络错误，请重试';
    }
    btn.disabled = false; btn.textContent = '完成教学评估';
}

async function checkUnevaluatedCourses() {
    await checkLoginStatus();
    const resultDiv = document.getElementById('evaluation-result');
    resultDiv.innerHTML = '<div class="loading">正在查询未评估课程...</div>';
    try {
        const response = await fetch('/api/unevaluated_courses', { headers: { 'X-Device-ID': getDeviceId() } });
        const data = await response.json();
        if (data.success) {
            if (data.has_courses) {
                unevaluatedCoursesData = data.courses;
                displayUnevaluatedCourses(data.courses);
            } else {
                unevaluatedCoursesData = [];
                resultDiv.className = 'evaluation-result result-success';
                resultDiv.innerHTML = `<div style="text-align:center;padding:20px;"><div style="font-size:40px;margin-bottom:10px;color:var(--success);">✓</div><div style="font-size:17px;color:var(--success);font-weight:600;">${data.message}</div></div>`;
            }
        } else {
            resultDiv.className = 'evaluation-result result-error';
            resultDiv.textContent = data.message || '查询失败';
        }
    } catch (error) {
        resultDiv.className = 'evaluation-result result-error';
        resultDiv.textContent = '网络错误，请重试';
    }
}

function displayUnevaluatedCourses(courses) {
    const resultDiv = document.getElementById('evaluation-result');
    let html = '<div class="unevaluated-courses"><h3 style="margin-bottom:15px;font-weight:600;">未评估课程列表</h3>';
    courses.forEach(course => {
        html += `<div style="background:var(--bg-secondary);padding:14px 16px;margin-bottom:8px;border-radius:12px;"><div style="font-size:15px;font-weight:600;margin-bottom:4px;">${course['未评课程']}</div><div style="font-size:14px;color:var(--text-secondary);">教师: ${course['教师']}</div></div>`;
    });
    html += '<div style="text-align:center;margin-top:20px;"><button class="btn-primary" onclick="doEvaluation()">完成评估</button></div></div>';
    resultDiv.innerHTML = html;
}

async function doEvaluation() {
    await checkLoginStatus();
    const resultDiv = document.getElementById('evaluation-result');
    if (!unevaluatedCoursesData || unevaluatedCoursesData.length === 0) {
        showUiToast('没有未评估的课程', 'info');
        return;
    }
    resultDiv.innerHTML = '<div class="loading">正在提交评教...</div>';
    try {
        const response = await fetch('/api/evaluation', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-ID': getDeviceId() }, body: JSON.stringify({ courses: unevaluatedCoursesData }) });
        const data = await response.json();
        if (data.success) {
            unevaluatedCoursesData = [];
            resultDiv.className = 'evaluation-result result-success';
            resultDiv.innerHTML = `<div style="text-align:center;padding:20px;"><div style="font-size:40px;margin-bottom:10px;color:var(--success);">✓</div><div style="font-size:17px;color:var(--success);font-weight:600;">${data.message || '评价完成'}</div></div>`;
        } else {
            resultDiv.className = 'evaluation-result result-error';
            resultDiv.textContent = data.message || '评价失败';
        }
    } catch (error) {
        resultDiv.className = 'evaluation-result result-error';
        resultDiv.textContent = '网络错误，请重试';
    }
}

async function oneClickEvaluation() {
    await checkLoginStatus();
    const resultDiv = document.getElementById('evaluation-result');
    const btn = document.getElementById('one-click-eval-btn');
    btn.disabled = true; btn.textContent = '评教中...';
    resultDiv.innerHTML = '<div class="loading">正在查询未评估课程...</div>';
    try {
        const response = await fetch('/api/unevaluated_courses', { headers: { 'X-Device-ID': getDeviceId() } });
        const data = await response.json();
        if (!data.success) {
            resultDiv.className = 'evaluation-result result-error';
            resultDiv.textContent = data.message || '查询失败';
            btn.disabled = false; btn.textContent = '一键评教'; return;
        }
        if (!data.has_courses) {
            resultDiv.className = 'evaluation-result result-success';
            resultDiv.innerHTML = `<div style="text-align:center;padding:20px;"><div style="font-size:40px;margin-bottom:10px;color:var(--success);">✓</div><div style="font-size:17px;color:var(--success);font-weight:600;">没有未评估的课程</div></div>`;
            btn.disabled = false; btn.textContent = '一键评教'; return;
        }
        resultDiv.innerHTML = '<div class="loading">正在提交评教...</div>';
        const evalResponse = await fetch('/api/evaluation', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-ID': getDeviceId() }, body: JSON.stringify({ courses: data.courses }) });
        const evalData = await evalResponse.json();
        if (evalData.success) {
            unevaluatedCoursesData = [];
            resultDiv.className = 'evaluation-result result-success';
            resultDiv.innerHTML = `<div style="text-align:center;padding:20px;"><div style="font-size:40px;margin-bottom:10px;color:var(--success);">✓</div><div style="font-size:17px;color:var(--success);font-weight:600;">${evalData.message}</div></div>`;
        } else {
            resultDiv.className = 'evaluation-result result-error';
            resultDiv.textContent = evalData.message || '评价失败';
        }
    } catch (error) {
        resultDiv.className = 'evaluation-result result-error';
        resultDiv.textContent = '网络错误，请重试';
    }
    btn.disabled = false; btn.textContent = '一键评教';
}


// ==================== 公告功能 ====================
let currentPopupAnnouncementId = null;

// 加载并显示未读公告弹窗
async function loadAndShowAnnouncements() {
    try {
        const response = await fetch('/api/announcements', {
            headers: {
                'X-Device-ID': getDeviceId()
            }
        });
        const data = await response.json();

        if (data.success && data.announcements && data.announcements.length > 0) {
            // 找到第一个未标记为"不再显示"的公告
            const unreadAnnouncement = data.announcements.find(ann => !ann.never_show);

            if (unreadAnnouncement) {
                showAnnouncementPopup(unreadAnnouncement);
            }
        }
    } catch (error) {
        console.error('加载公告失败:', error);
    }
}

// 显示公告弹窗
function showAnnouncementPopup(announcement) {
    currentPopupAnnouncementId = announcement.id;

    document.getElementById('announcement-popup-title').textContent = announcement.title;
    document.getElementById('announcement-popup-content').innerHTML = announcement.content.replace(/\n/g, '<br>');
    document.getElementById('never-show-checkbox').checked = false;

    const modal = document.getElementById('announcement-popup');
    openUiModal(modal);
}

// 关闭公告弹窗
async function closeAnnouncementPopup() {
    const neverShow = document.getElementById('never-show-checkbox')?.checked === true;

    // 标记为已读
    if (currentPopupAnnouncementId) {
        try {
            await fetch(`/api/announcements/${currentPopupAnnouncementId}/read`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Device-ID': getDeviceId()
                },
                body: JSON.stringify({
                    never_show: neverShow
                })
            });
        } catch (error) {
            console.error('标记公告已读失败:', error);
        }
    }

    const modal = document.getElementById('announcement-popup');
    closeUiModal(modal);

    currentPopupAnnouncementId = null;
}

// 加载公告列表页面
async function loadAnnouncementsList() {
    const contentDiv = document.getElementById('announcements-list-content');
    contentDiv.innerHTML = '<div class="loading">加载中...</div>';

    try {
        const response = await fetch('/api/announcements', {
            headers: {
                'X-Device-ID': getDeviceId()
            }
        });
        const data = await response.json();

        if (data.success) {
            if (data.announcements && data.announcements.length > 0) {
                displayAnnouncementsList(data.announcements);
            } else {
                contentDiv.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-state-icon">&#128276;</div>
                        <div class="empty-state-text">暂无公告</div>
                    </div>
                `;
            }
        } else {
            renderRetryState(contentDiv, data.message || '公告加载失败', loadAnnouncementsList);
        }
    } catch (error) {
        console.error('加载公告列表失败:', error);
        renderRetryState(contentDiv, '公告加载失败，请重试', loadAnnouncementsList);
    }
}

// 显示公告列表
function displayAnnouncementsList(announcements) {
    const contentDiv = document.getElementById('announcements-list-content');

    let html = '';
    announcements.forEach(ann => {
        const createTime = new Date(ann.create_time).toLocaleString('zh-CN');
        const readBadge = ann.is_read ? '<span class="read-badge">已读</span>' : '<span class="unread-badge">未读</span>';

        html += `
            <div class="announcement-item ${ann.is_read ? 'read' : 'unread'}">
                <div class="announcement-item-header">
                    <h3>${ann.title}</h3>
                    ${readBadge}
                </div>
                <div class="announcement-item-content">
                    ${ann.content.replace(/\n/g, '<br>')}
                </div>
                <div class="announcement-item-footer">
                    <span class="announcement-item-time">${createTime}</span>
                </div>
            </div>
        `;
    });

    contentDiv.innerHTML = html;
}

// ==================== 反馈建议 ====================

function escapeFeedbackHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatFeedbackContent(value) {
    return escapeFeedbackHtml(value).replace(/\n/g, '<br>');
}

function formatFeedbackTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return '';
    }
    return date.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function renderRetryState(container, message, retry) {
    if (!container) return;
    container.innerHTML = `
        <div class="ui-retry-state" role="alert">
            <p>${escapeFeedbackHtml(message || '加载失败')}</p>
            <button class="btn-secondary" type="button">重新加载</button>
        </div>`;
    const retryButton = container.querySelector('.ui-retry-state button');
    if (retryButton && typeof retry === 'function') {
        retryButton.addEventListener('click', () => { void retry(); });
    }
}

// 加载反馈页面
async function loadFeedbackPage() {
    const contentDiv = document.getElementById('feedback-list-content');
    contentDiv.innerHTML = '<div class="loading">加载中...</div>';

    try {
        const response = await fetch('/api/feedback', {
            headers: {
                'X-Device-ID': getDeviceId()
            }
        });
        const data = await response.json();

        if (data.success) {
            displayFeedbackList(data.my_feedbacks || [], data.public_feedbacks || []);
        } else {
            renderRetryState(contentDiv, data.message || '反馈加载失败', loadFeedbackPage);
        }
    } catch (error) {
        console.error('加载反馈列表失败:', error);
        renderRetryState(contentDiv, '反馈加载失败，请重试', loadFeedbackPage);
    }
}

// 提交新反馈
async function submitNewFeedback() {
    const contentInput = document.getElementById('new-feedback-content');
    if (!contentInput) return;
    const content = contentInput.value.trim();
    const visibility = document.querySelector('input[name="feedback-visibility"]:checked')?.value || 'public';
    const submitButton = document.querySelector('.feedback-submit-btn');
    const status = document.getElementById('feedback-form-status');

    if (!content) {
        if (status) status.textContent = '先写一点反馈内容吧';
        showUiToast('先写一点反馈内容吧', 'error');
        contentInput.focus();
        return;
    }

    if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = '提交中...';
    }
    if (status) status.textContent = '正在提交反馈...';

    try {
        const response = await fetch('/api/feedback', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Device-ID': getDeviceId()
            },
            body: JSON.stringify({ content, visibility })
        });
        const data = await response.json();

        if (data.success) {
            contentInput.value = '';
            if (status) status.textContent = '反馈已提交，感谢你的建议。';
            showUiToast('反馈已提交', 'success');
            await loadFeedbackPage();
        } else {
            if (status) status.textContent = data.message || '提交失败，请稍后重试';
            showUiToast(data.message || '提交失败', 'error');
        }
    } catch (error) {
        console.error('提交反馈失败:', error);
        if (status) status.textContent = '网络错误，请重试';
        showUiToast('网络错误，请重试', 'error');
    } finally {
        if (submitButton) {
            submitButton.disabled = false;
            submitButton.textContent = '提交反馈';
        }
    }
}

// 提交回复
async function submitFeedbackReply(feedbackId) {
    const textarea = document.getElementById(`reply-input-${feedbackId}`);
    if (!textarea) return;
    const content = textarea.value.trim();

    if (!content) {
        showUiToast('请输入回复内容', 'error');
        textarea.focus();
        return;
    }

    try {
        const response = await fetch(`/api/feedback/${feedbackId}/reply`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Device-ID': getDeviceId()
            },
            body: JSON.stringify({ content })
        });
        const data = await response.json();

        if (data.success) {
            showUiToast('回复已发送', 'success');
            await loadFeedbackPage();
        } else {
            showUiToast(data.message || '回复失败', 'error');
        }
    } catch (error) {
        console.error('回复失败:', error);
        showUiToast('网络错误，请重试', 'error');
    }
}

// 切换回复框显示
function toggleReplyBox(feedbackId) {
    const box = document.getElementById(`reply-box-${feedbackId}`);
    box.style.display = box.style.display === 'none' ? 'flex' : 'none';
}

// 显示反馈列表
function displayFeedbackList(myFeedbacks, publicFeedbacks) {
    const contentDiv = document.getElementById('feedback-list-content');
    let html = '';

    if (myFeedbacks.length === 0 && publicFeedbacks.length === 0) {
        contentDiv.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">&#128172;</div>
                <div class="empty-state-text">还没有反馈</div>
                <div class="feedback-empty-hint">写下第一个问题或建议，管理员看到后就能跟进。</div>
            </div>
        `;
        return;
    }

    if (myFeedbacks.length > 0) {
        html += `<div class="feedback-section-title">我的反馈 <span class="feedback-soft-badge">${myFeedbacks.length} 条</span></div>`;
        myFeedbacks.forEach(fb => {
            html += buildFeedbackCard(fb);
        });
    }

    if (publicFeedbacks.length > 0) {
        html += `<div class="feedback-section-title">公开讨论 <span class="feedback-soft-badge">${publicFeedbacks.length} 条</span></div>`;
        publicFeedbacks.forEach(fb => {
            html += buildFeedbackCard(fb);
        });
    }

    contentDiv.innerHTML = html;
}

// 构建单条反馈卡片 HTML
function buildFeedbackCard(fb) {
    const createTime = formatFeedbackTime(fb.create_time);
    const visLabel = fb.visibility === 'public' ? '公开' : '仅自己可见';
    const visClass = fb.visibility === 'public' ? 'feedback-visibility-badge is-public' : 'feedback-visibility-badge';
    const authorName = fb.is_own ? '我' : escapeFeedbackHtml(fb.username || '同学');

    let html = `
        <div class="feedback-card">
            <div class="feedback-floor">
                <div class="feedback-floor-header">
                    <span class="feedback-floor-num">1楼</span>
                    <span class="feedback-username">${authorName}</span>
                    <span class="${visClass}">${visLabel}</span>
                </div>
                <div class="feedback-floor-content">${formatFeedbackContent(fb.content)}</div>
                <div class="feedback-floor-time">${createTime}</div>
            </div>
    `;

    if (fb.replies && fb.replies.length > 0) {
        fb.replies.forEach((reply, index) => {
            const replyTime = formatFeedbackTime(reply.create_time);
            const isAdmin = reply.username === '管理员';
            const replyName = isAdmin ? '管理员' : escapeFeedbackHtml(reply.username || '同学');
            html += `
                <div class="feedback-floor ${isAdmin ? 'feedback-floor-admin' : ''}">
                    <div class="feedback-floor-header">
                        <span class="feedback-floor-num">${index + 2}楼</span>
                        <span class="feedback-username${isAdmin ? ' admin-tag' : ''}">${replyName}</span>
                    </div>
                    <div class="feedback-floor-content">${formatFeedbackContent(reply.content)}</div>
                    <div class="feedback-floor-time">${replyTime}</div>
                </div>
            `;
        });
    }

    html += `
            <div class="feedback-reply-bar">
                <button class="feedback-reply-btn" onclick="toggleReplyBox(${fb.id})">回复这条反馈</button>
            </div>
            <div id="reply-box-${fb.id}" class="feedback-reply-box" style="display:none;">
                <textarea id="reply-input-${fb.id}" class="feedback-reply-textarea" rows="2" placeholder="补充说明或参与讨论..."></textarea>
                <button class="btn-primary btn-sm" onclick="submitFeedbackReply(${fb.id})">发送</button>
            </div>
        </div>
    `;
    return html;
}
// ==================== 会员功能 ====================

let _currentPayMemberType = null;

async function loadShortcutApiPage() {
    shortcutApiPlainKey = '';
    shortcutApiHasKey = false;
    const keyContainer = document.getElementById('shortcut-api-key');
    if (keyContainer) {
        keyContainer.hidden = true;
        keyContainer.innerHTML = '';
    }

    await loadMemberStatus('shortcut-api-member-status');
    await loadShortcutApiKey();
}

async function loadMemberPage() {
    await loadMemberStatus();
    await Promise.all([
        loadMemberOrders(),
        loadInvitationEarnings(),
    ]);
}

async function loadMemberStatus(targetId = 'member-status-card') {
    const card = document.getElementById(targetId);
    currentMemberStatus = null;
    if (!card) return;
    try {
        const resp = await fetch('/api/member/status', {
            headers: { 'X-Device-ID': getDeviceId() }
        });
        const data = await resp.json();
        if (!data.success) {
            renderRetryState(card, data.message || '会员状态加载失败', () => loadMemberStatus(targetId));
            return;
        }
        const d = data.data;
        currentMemberStatus = d || null;
        if (!d.is_member) {
            if (d.expire_time && d.is_expired) {
                const typeMap = { basic: '初级会员', advanced: '高级会员' };
                card.innerHTML = `<div class="member-status-expired"><span>您的${typeMap[d.member_type] || '会员'}已于 ${d.expire_time.slice(0, 10)} 到期</span><span>，请续费继续享受会员服务。</span></div>`;
            } else {
                card.innerHTML = `<div class="member-status-none">您当前没有会员，开通会员解锁更多功能。</div>`;
            }
        } else {
            const typeMap = { basic: '初级会员', advanced: '高级会员' };
            const badgeClass = d.member_type === 'advanced' ? 'member-badge-advanced' : 'member-badge-basic';
            card.innerHTML = `
                <div class="member-status-active">
                    <span class="member-badge ${badgeClass}">${typeMap[d.member_type] || '会员'}</span>
                    <span class="member-expire">有效期至：${d.expire_time ? d.expire_time.slice(0, 10) : '未知'}</span>
                </div>`;
        }
    } catch (e) {
        currentMemberStatus = null;
        renderRetryState(card, '会员状态加载失败，请重试', () => loadMemberStatus(targetId));
    }
}

function renderShortcutApiKeyStatus(data) {
    const status = document.getElementById('shortcut-api-status');
    if (!status) return;

    if (!currentMemberStatus) {
        shortcutApiHasKey = false;
        status.innerHTML = '<p class="shortcut-api-muted">会员状态加载失败，请刷新页面</p>';
        return;
    }

    if (currentMemberStatus.is_member !== true) {
        shortcutApiHasKey = false;
        status.innerHTML = '<p class="shortcut-api-muted">此功能需要初级会员以上</p>';
        return;
    }

    shortcutApiHasKey = Boolean(data && data.has_key === true);
    if (!shortcutApiHasKey) {
        status.innerHTML = `
            <div class="shortcut-api-empty">
                <p>暂未生成快捷指令密钥</p>
                <button class="btn-primary" type="button" onclick="generateShortcutApiKey()">生成快捷指令密钥</button>
            </div>`;
        return;
    }

    const prefix = data.key_prefix || 'urp_';
    const createTime = data.create_time || '';
    status.innerHTML = `
        <div class="shortcut-api-active">
            <div>
                <span class="shortcut-api-label">当前密钥</span>
                <code>${escapeGradeHtml(prefix)}...</code>
                <small>${escapeGradeHtml(createTime)}</small>
            </div>
            <button class="btn-secondary" type="button" onclick="generateShortcutApiKey()">重新生成</button>
        </div>`;
}

async function loadShortcutApiKey() {
    const status = document.getElementById('shortcut-api-status');
    const endpoint = document.getElementById('shortcut-api-endpoint');
    if (endpoint) {
        endpoint.textContent = `${window.location.origin}/api/shortcut/query`;
    }
    if (!status) return;

    if (!currentMemberStatus) {
        renderShortcutApiKeyStatus(null);
        return;
    }
    if (currentMemberStatus.is_member !== true) {
        renderShortcutApiKeyStatus(null);
        return;
    }

    status.innerHTML = '<div class="loading">加载中...</div>';
    try {
        const resp = await fetch('/api/member/api-key', {
            headers: { 'X-Device-ID': getDeviceId() }
        });
        const data = await resp.json();
        if (!data.success) {
            throw new Error(data.message || '密钥状态加载失败');
        }
        renderShortcutApiKeyStatus(data.data || {});
    } catch (e) {
        renderRetryState(status, e.message || '密钥状态加载失败', loadShortcutApiKey);
    }
}

async function generateShortcutApiKey() {
    const status = document.getElementById('shortcut-api-status');
    if (!currentMemberStatus || currentMemberStatus.is_member !== true) {
        renderShortcutApiKeyStatus(null);
        return;
    }
    if (shortcutApiHasKey) {
        const confirmed = await requestUiConfirmation({
            title: '重新生成快捷指令密钥',
            message: '重新生成后，旧密钥会立即失效，确定继续吗？',
            confirmText: '重新生成',
            danger: true,
        });
        if (!confirmed) return;
    }

    if (status) status.innerHTML = '<div class="loading">正在生成...</div>';
    try {
        const resp = await fetch('/api/member/api-key', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Device-ID': getDeviceId(),
            },
            body: JSON.stringify({}),
        });
        const data = await resp.json();
        const issued = data && data.success ? data.data : null;
        if (!issued || typeof issued.key !== 'string' || !issued.key) {
            throw new Error((data && data.message) || '密钥生成失败');
        }

        shortcutApiPlainKey = issued.key;
        shortcutApiHasKey = true;
        const keyContainer = document.getElementById('shortcut-api-key');
        if (keyContainer) {
            keyContainer.hidden = false;
            keyContainer.innerHTML = `
                <div class="shortcut-api-secret-head">
                    <span>请立即复制并保存完整密钥</span>
                    <span>刷新页面后不会再次显示</span>
                </div>
                <div class="shortcut-api-secret-row">
                    <code>${escapeGradeHtml(shortcutApiPlainKey)}</code>
                    <button id="shortcut-api-copy" class="btn-primary" type="button" onclick="copyShortcutApiKey()">复制密钥</button>
                </div>`;
        }
        await loadShortcutApiKey();
    } catch (e) {
        if (status) {
            status.innerHTML = `<p class="shortcut-api-error">${escapeGradeHtml(e.message || '密钥生成失败，请稍后重试')}</p>`;
        }
    }
}

async function copyShortcutApiKey() {
    const button = document.getElementById('shortcut-api-copy');
    const originalText = '复制密钥';
    if (!shortcutApiPlainKey || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        if (button) button.textContent = '复制失败，请手动复制';
        return;
    }

    try {
        await navigator.clipboard.writeText(shortcutApiPlainKey);
        if (button) {
            button.textContent = '已复制';
            window.setTimeout(() => {
                if (button.isConnected) button.textContent = originalText;
            }, 1500);
        }
    } catch (e) {
        if (button) button.textContent = '复制失败，请手动复制';
    }
}

function renderInvitationLink(data, errorMessage = '') {
    const container = document.getElementById('invitation-link-content');
    if (!container) return;

    if (!data || data.has_link !== true || !data.invite_url) {
        const message = errorMessage
            ? `<span class="invitation-link-error">${escapeGradeHtml(errorMessage)}</span>`
            : '<span>生成固定邀请链接，分享给新用户即可自动绑定邀请关系。</span>';
        container.innerHTML = `
            <div class="invitation-link-empty">
                ${message}
                <button class="btn-secondary" type="button" onclick="generateInvitationLink()">生成邀请链接</button>
            </div>`;
        return;
    }

    const safeUrl = escapeGradeHtml(data.invite_url);
    container.innerHTML = `
        <div class="invitation-link-label">我的固定邀请链接</div>
        <div class="invitation-link-row">
            <input id="invitation-link-input" class="invitation-link-input" type="text" readonly value="${safeUrl}">
            <button id="invitation-link-copy" class="btn-secondary" type="button" onclick="copyInvitationLink()">复制链接</button>
        </div>`;
}

async function generateInvitationLink() {
    const container = document.getElementById('invitation-link-content');
    if (container) container.innerHTML = '<div class="loading">正在生成...</div>';

    try {
        const response = await fetch('/api/invitation/link', {
            method: 'POST',
            headers: { 'X-Device-ID': getDeviceId() },
        });
        const data = await response.json().catch(() => ({ success: false }));
        if (!response.ok || !data.success || !data.data) {
            throw new Error(data.message || '生成邀请链接失败');
        }
        renderInvitationLink(data.data);
    } catch (error) {
        renderInvitationLink(null, error.message || '生成失败，请重试');
    }
}

async function copyInvitationLink() {
    const input = document.getElementById('invitation-link-input');
    const button = document.getElementById('invitation-link-copy');
    if (!input || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        if (button) button.textContent = '复制失败，请手动复制';
        return;
    }

    try {
        await navigator.clipboard.writeText(input.value);
        if (button) {
            button.textContent = '已复制';
            window.setTimeout(() => {
                if (button.isConnected) button.textContent = '复制链接';
            }, 1500);
        }
    } catch (error) {
        if (button) button.textContent = '复制失败，请手动复制';
    }
}

async function loadInvitationEarnings() {
    const card = document.getElementById('invitation-card');
    const linkContent = document.getElementById('invitation-link-content');
    const content = document.getElementById('invitation-earnings-content');
    if (!card || !content) return;

    card.style.display = '';
    if (linkContent) linkContent.innerHTML = '<div class="loading">加载中...</div>';
    content.innerHTML = '<div class="loading">加载中...</div>';

    const fetchJson = async (url) => {
        try {
            const resp = await fetch(url, { headers: { 'X-Device-ID': getDeviceId() } });
            const data = await resp.json().catch(() => ({ success: false, message: '接口返回格式异常' }));
            if (!resp.ok) {
                return { success: false, message: data.message || `请求失败：${resp.status}` };
            }
            return data;
        } catch (e) {
            return { success: false, message: '网络请求失败' };
        }
    };

    const [inviterData, linkData, earningsData, withdrawalsData] = await Promise.all([
        fetchJson('/api/invitation/my_inviter'),
        fetchJson('/api/invitation/link'),
        fetchJson('/api/invitation/earnings'),
        fetchJson('/api/invitation/withdrawals')
    ]);

    if (linkData.success && linkData.data) {
        renderInvitationLink(linkData.data);
    } else {
        renderInvitationLink(null, linkData.message || '邀请链接加载失败，请重试');
    }

    if (!earningsData.success || !earningsData.data) {
        content.innerHTML = `<div class="error-message">收益加载失败：${earningsData.message || '未知错误'}</div>`;
        return;
    }

    const data = earningsData.data;
    const inviteeTotal = parseFloat(data.invitee_total) || 0;
    const effectiveInviteCount = Number(data.effective_invite_count || 0);
    const currentReward = data.current_reward || '0.80';
    const earned = parseFloat(data.earned) || 0;
    const withdrawn = parseFloat(data.withdrawn) || 0;
    const available = parseFloat(data.available) || 0;

    let html = `<div class="invitation-promo"><strong>每成功邀请1位新付费用户，获得最高1.2元奖励。</strong></div>`;

    if (inviterData.success && inviterData.data && inviterData.data.inviter) {
        html += `<div class="inviter-info"><span class="inviter-label">邀请人：</span><span>${escapeGradeHtml(inviterData.data.inviter)}</span></div>`;
    }

    let hasPending = false;
    if (withdrawalsData.success && withdrawalsData.data) {
        withdrawalsData.data.forEach(r => {
            if (r.status === 'pending') hasPending = true;
        });
    }

    let btnText, btnDisabled, btnOpacity;
    if (hasPending) {
        btnText = '审核中';
        btnDisabled = true;
        btnOpacity = '0.5';
    } else if (available <= 0) {
        btnText = '暂无可提现';
        btnDisabled = true;
        btnOpacity = '0.5';
    } else {
        btnText = '提现';
        btnDisabled = false;
        btnOpacity = '1';
    }

    html += `<div class="earnings-summary">
        <div class="earnings-row"><span>有效邀请</span><span>${effectiveInviteCount} 人</span></div>
        <div class="earnings-row"><span>当前每人奖励</span><span class="earnings-rate">¥${escapeGradeHtml(currentReward)}</span></div>
        <div class="earnings-row"><span>团队充值</span><span>¥${inviteeTotal.toFixed(2)}</span></div>
        <div class="earnings-row earnings-row-total"><span>累计收益</span><span class="earnings-amount">¥${earned.toFixed(2)}</span></div>
    </div>`;

    if (data.next_level_count !== null && data.next_level_count !== undefined) {
        const remaining = Math.max(Number(data.next_level_count) - effectiveInviteCount, 0);
        html += `<div class="invite-hint">再邀请 ${remaining} 位新付费用户，后续每人奖励提升至 ¥${escapeGradeHtml(data.next_reward || '0.00')}。</div>`;
    } else {
        html += '<div class="invite-hint">已达到当前最高奖励档位，继续邀请仍可获得当前奖励。</div>';
    }

    if (Array.isArray(data.levels) && data.levels.length > 0) {
        html += '<div class="referral-levels"><div class="referral-section-title">奖励阶梯</div>';
        data.levels.forEach((level, index) => {
            const nextLevel = data.levels[index + 1];
            const range = nextLevel
                ? `${Number(level.min_count)}～${Number(nextLevel.min_count) - 1}人`
                : `${Number(level.min_count)}人以上`;
            html += `<div class="referral-level-row"><span>${range}</span><span>¥${escapeGradeHtml(level.reward)} / 人</span></div>`;
        });
        html += '</div>';
    }

    if (Array.isArray(data.milestones) && data.milestones.length > 0) {
        html += '<div class="referral-milestones"><div class="referral-section-title">限时任务</div>';
        data.milestones.forEach(milestone => {
            const label = escapeGradeHtml(milestone.label || milestone.id || '邀请任务');
            let status;
            if (milestone.completed) {
                status = milestone.rewarded ? '已完成，奖励已发放' : '已完成，奖励待发放';
            } else if (milestone.is_active) {
                status = `已完成 ${Number(milestone.count || 0)}/${Number(milestone.target_count || 0)}，还差 ${Number(milestone.remaining || 0)} 人`;
            } else {
                status = `目标 ${Number(milestone.target_count || 0)} 人，奖励 ¥${escapeGradeHtml(milestone.bonus || '0.00')}`;
            }
            html += `<div class="referral-milestone-row"><div><strong>${label}</strong><span>${status}</span></div><span>额外 ¥${escapeGradeHtml(milestone.bonus || '0.00')}</span></div>`;
        });
        html += '</div>';
    }

    html += `<div class="earnings-total">
        <span class="earnings-label">可提现</span><span class="earnings-amount">¥${available.toFixed(2)}</span>
        <button class="btn-withdraw" onclick="showWithdrawDialog()" ${btnDisabled ? 'disabled' : ''} style="opacity:${btnOpacity}">${btnText}</button>
    </div>`;
    if (withdrawn > 0) {
        html += `<div class="earnings-withdrawn"><span>已占用：¥${withdrawn.toFixed(2)}</span></div>`;
    }
    if (!withdrawalsData.success) {
        html += `<div class="invite-hint">提现记录加载失败：${withdrawalsData.message || '未知错误'}</div>`;
    }

    if ((data.earnings && data.earnings.length > 0) || (data.milestone_earnings && data.milestone_earnings.length > 0)) {
        html += '<div class="earnings-list">';
        (data.earnings || []).forEach(e => {
            html += `<div class="earning-item"><span>${escapeGradeHtml(e.invitee_username)} 首次付费</span><span class="earning-amount">+¥${(parseFloat(e.amount) || 0).toFixed(2)}</span><span class="earning-time">${e.create_time ? e.create_time.slice(0, 10) : ''}</span></div>`;
        });
        if (data.milestone_earnings && data.milestone_earnings.length > 0) {
            data.milestone_earnings.forEach(e => {
                html += `<div class="earning-item"><span>限时任务奖励</span><span class="earning-amount">+¥${(parseFloat(e.amount) || 0).toFixed(2)}</span><span class="earning-time">${e.create_time ? e.create_time.slice(0, 10) : ''}</span></div>`;
            });
        }
        html += '</div>';
    }

    html += '<div class="invite-hint">规则说明：每位被邀请用户首次完成付费时计为一次有效邀请，同一用户仅计一次；达到新档位后，后续邀请按新奖励计算，历史奖励不补差价。</div>';

    content.innerHTML = html;
}

async function loadMemberOrders() {
    const container = document.getElementById('member-orders-content');
    const payLinksDiv = document.getElementById('active-pay-links');
    if (payLinksDiv) {
        payLinksDiv.style.display = 'none';
        payLinksDiv.innerHTML = '';
    }
    try {
        const resp = await fetch('/api/member/orders', {
            headers: { 'X-Device-ID': getDeviceId() }
        });
        const data = await resp.json();
        if (!data.success || !data.data.length) {
            container.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:12px 0;">暂无购买记录</p>';
            return;
        }

        // 检查是否有有效支付链接
        const activeOrders = data.data.filter(o => o.active_pay_url);
        if (activeOrders.length > 0 && payLinksDiv) {
            const typeMap = { basic: '初级会员', advanced: '高级会员' };
            let linksHtml = '<div style="font-weight:600;margin-bottom:8px;">有效期内的支付链接</div>';
            for (const order of activeOrders) {
                const expireMin = Math.ceil(order.expire_seconds / 60);
                linksHtml += `
                    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;flex-wrap:wrap;gap:8px;">
                        <span>${typeMap[order.member_type]} ¥${order.amount} — <span style="color:var(--error);">剩余${expireMin}分钟</span></span>
                        <a href="${order.active_pay_url}" class="btn-primary" style="font-size:13px;padding:6px 16px;text-decoration:none;">立即支付</a>
                    </div>`;
            }
            payLinksDiv.innerHTML = linksHtml;
            payLinksDiv.style.display = 'block';
        }

        const typeMap = { basic: '初级会员', advanced: '高级会员' };
        const statusMap = { pending: '待支付', paid: '已支付', failed: '失败' };
        let html = '<div class="orders-list">';
        for (const order of data.data) {
            let payLinkHtml = order.active_pay_url ? ` <a class="btn-primary" href="${order.active_pay_url}" style="font-size:12px;padding:2px 10px;text-decoration:none;">去支付</a>` : '';
            html += `
                <div class="order-item">
                    <div class="order-info">
                        <span class="order-type">${typeMap[order.member_type] || order.member_type}</span>
                        <span class="order-amount">¥${order.amount}</span>
                        <span class="order-status order-status-${order.status}">${statusMap[order.status] || order.status}${payLinkHtml}</span>
                    </div>
                    <div class="order-time">${order.create_time ? order.create_time.slice(0, 16) : ''}</div>
                </div>`;
        }
        html += '</div>';
        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = '<p style="color:var(--error);">加载失败</p>';
    }
}

function updatePayTypeUI() {
    document.querySelectorAll('.pay-type-option').forEach(option => {
        const input = option.querySelector('input[name="pay-type"]');
        option.classList.toggle('pay-type-option-active', !!input && input.checked);
    });
}

function showPayDialog(memberType) {
    _currentPayMemberType = memberType;
    const prices = { basic: '3', advanced: '5' };
    const typeNames = { basic: '\u521d\u7ea7\u4f1a\u5458', advanced: '\u9ad8\u7ea7\u4f1a\u5458' };
    const defaultPay = document.getElementById('pay-type-alipay');
    if (defaultPay) defaultPay.checked = true;
    updatePayTypeUI();
    document.getElementById('pay-modal-title').textContent = `\u5f00\u901a${typeNames[memberType]}`;
    document.getElementById('pay-modal-desc').textContent = `\u4ef7\u683c\uff1a\u00a5${prices[memberType]}/\u534a\u5e74\uff0c\u7eed\u8d39\u4f1a\u81ea\u52a8\u53e0\u52a0\u5230\u539f\u5230\u671f\u65e5\u540e`;
    document.getElementById('pay-error').textContent = '';
    document.getElementById('pay-confirm-btn').disabled = false;
    document.getElementById('pay-confirm-btn').textContent = '\u786e\u8ba4\u652f\u4ed8';
    const modal = document.getElementById('pay-modal');
    openUiModal(modal);
}

function closePayDialog() {
    closeUiModal(document.getElementById('pay-modal'));
    _currentPayMemberType = null;
}

async function confirmPay() {
    const memberType = _currentPayMemberType;
    if (!memberType) return;
    const payType = document.querySelector('input[name="pay-type"]:checked')?.value || 'alipay';
    const btn = document.getElementById('pay-confirm-btn');
    const errDiv = document.getElementById('pay-error');
    btn.disabled = true;
    btn.textContent = '\u6b63\u5728\u521b\u5efa\u652f\u4ed8...';
    errDiv.textContent = '';
    try {
        const resp = await fetch('/api/member/create_order', {
            method: 'POST',
            headers: { 'X-Device-ID': getDeviceId(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ member_type: memberType, pay_type: payType })
        });
        const data = await resp.json();
        if (!data.success) {
            errDiv.textContent = data.message || '\u521b\u5efa\u8ba2\u5355\u5931\u8d25';
            btn.disabled = false;
            btn.textContent = '\u786e\u8ba4\u652f\u4ed8';
            return;
        }
        const payUrl = data.data.pay_url;
        if (payUrl) {
            closePayDialog();
            window.location.href = payUrl;
        } else {
            errDiv.textContent = '\u83b7\u53d6\u652f\u4ed8\u94fe\u63a5\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5';
            btn.disabled = false;
            btn.textContent = '\u786e\u8ba4\u652f\u4ed8';
        }
    } catch (e) {
        errDiv.textContent = '\u7f51\u7edc\u9519\u8bef\uff0c\u8bf7\u91cd\u8bd5';
        btn.disabled = false;
        btn.textContent = '\u786e\u8ba4\u652f\u4ed8';
    }
}


// ==================== 提现功能 ====================
let _withdrawAvailable = 0;

async function showWithdrawDialog() {
    const modal = document.getElementById('withdraw-modal');
    const errDiv = document.getElementById('withdraw-error');
    errDiv.textContent = '';
    document.getElementById('withdraw-real-name').value = '';
    document.getElementById('withdraw-alipay').value = '';
    document.getElementById('withdraw-available').innerHTML = '<div class="loading">加载中</div>';
    document.getElementById('withdraw-history').innerHTML = '';

    try {
        const [earningsResp, historyResp] = await Promise.all([
            fetch('/api/invitation/earnings', { headers: { 'X-Device-ID': getDeviceId() } }),
            fetch('/api/invitation/withdrawals', { headers: { 'X-Device-ID': getDeviceId() } })
        ]);
        const earningsData = await earningsResp.json();
        const historyData = await historyResp.json();

        const inviteeTotal = (earningsData.success && earningsData.data) ? (parseFloat(earningsData.data.invitee_total) || 0) : 0;
        const effectiveInviteCount = (earningsData.success && earningsData.data) ? (Number(earningsData.data.effective_invite_count) || 0) : 0;
        const currentReward = (earningsData.success && earningsData.data) ? (earningsData.data.current_reward || '0.80') : '0.80';
        const earned = (earningsData.success && earningsData.data) ? (parseFloat(earningsData.data.earned) || 0) : 0;
        const available = (earningsData.success && earningsData.data) ? (parseFloat(earningsData.data.available) || 0) : 0;

        _withdrawAvailable = available;
        document.getElementById('withdraw-available').innerHTML = `
            <div class="withdraw-amount-row">
                <span>团队充值</span><span>¥${inviteeTotal.toFixed(2)}</span>
            </div>
            <div class="withdraw-amount-row">
                <span>有效邀请</span><span>${effectiveInviteCount} 人</span>
            </div>
            <div class="withdraw-amount-row">
                <span>当前每人奖励</span><span>¥${currentReward}</span>
            </div>
            <div class="withdraw-amount-row">
                <span>累计收益</span><span>¥${earned.toFixed(2)}</span>
            </div>
            <div class="withdraw-amount-row">
                <span>可提现金额</span><span class="withdraw-available-amount">¥${available.toFixed(2)}</span>
            </div>
        `;

        // 提现记录
        if (historyData.success && historyData.data && historyData.data.length > 0) {
            const statusMap = { pending: '审核中', approved: '已转账', rejected: '已拒绝' };
            let histHtml = '<div class="withdraw-history-title">提现记录</div>';
            historyData.data.forEach(r => {
                histHtml += `<div class="withdraw-history-item">
                    <span>¥${parseFloat(r.amount).toFixed(2)}</span>
                    <span class="withdraw-status withdraw-status-${r.status}">${statusMap[r.status] || r.status}</span>
                    <span class="withdraw-history-time">${r.create_time ? r.create_time.slice(0, 10) : ''}</span>
                </div>`;
            });
            document.getElementById('withdraw-history').innerHTML = histHtml;
        }

        openUiModal(modal);
    } catch (e) {
        errDiv.textContent = '加载失败，请重试';
    }
}

function closeWithdrawDialog() {
    closeUiModal(document.getElementById('withdraw-modal'));
}

async function handleWithdraw(event) {
    event.preventDefault();
    const realName = document.getElementById('withdraw-real-name').value.trim();
    const alipay = document.getElementById('withdraw-alipay').value.trim();
    const errDiv = document.getElementById('withdraw-error');
    errDiv.textContent = '';

    if (_withdrawAvailable <= 0) {
        errDiv.textContent = '暂无可提现金额';
        return;
    }

    try {
        const resp = await fetch('/api/invitation/withdraw', {
            method: 'POST',
            headers: { 'X-Device-ID': getDeviceId(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ real_name: realName, alipay_account: alipay })
        });
        const data = await resp.json();
        if (data.success) {
            showUiToast(data.message || '提现申请已提交', 'success');
            closeWithdrawDialog();
            loadInvitationEarnings();
        } else {
            errDiv.textContent = data.message || '提现申请失败';
        }
    } catch (e) {
        errDiv.textContent = '网络错误，请重试';
    }
}


let signClasses = [];
let signStreamController = null;

async function signCheckStatus() {
    try {
        const resp = await fetch('/api/sign/status', {
            headers: { 'X-Device-ID': getDeviceId() },
        });
        const data = await resp.json();
        if (data.success && data.classes && data.classes.length > 0) {
            signClasses = data.classes;
            signShowControlCard(signClasses);
            if (data.running) {
                document.getElementById('sign-start-btn').style.display = 'none';
                document.getElementById('sign-stop-btn').style.display = '';
                document.getElementById('sign-log-card').style.display = '';
                signStartStream();
            }
        }
    } catch (e) { /* 忽略 */ }
}

function signAppendLog(msg) {
    const el = document.getElementById('sign-log-content');
    if (!el) return;
    el.textContent += msg + '\n';
    el.scrollTop = el.scrollHeight;
}

async function signLogin() {
    const username = document.getElementById('sign-username').value.trim();
    const password = document.getElementById('sign-password').value.trim();
    const errDiv = document.getElementById('sign-login-error');
    errDiv.style.display = 'none';
    if (!username || !password) {
        errDiv.textContent = '请输入用户名和密码';
        errDiv.style.display = 'block';
        return;
    }
    try {
        const resp = await fetch('/api/sign/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Device-ID': getDeviceId() },
            body: JSON.stringify({ username, password }),
        });
        const data = await resp.json();
        if (data.success) {
            signClasses = data.classes || [];
            signShowControlCard(signClasses);
        } else {
            errDiv.textContent = data.msg || '登录失败';
            errDiv.style.display = 'block';
        }
    } catch (e) {
        errDiv.textContent = '网络错误，请重试';
        errDiv.style.display = 'block';
    }
}

async function signLoginLink() {
    const link = document.getElementById('sign-wechat-link').value.trim();
    const errDiv = document.getElementById('sign-login-error');
    errDiv.style.display = 'none';
    if (!link) {
        errDiv.textContent = '请粘贴微信跳转链接';
        errDiv.style.display = 'block';
        return;
    }
    try {
        const resp = await fetch('/api/sign/login_link', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Device-ID': getDeviceId() },
            body: JSON.stringify({ link }),
        });
        const data = await resp.json();
        if (data.success) {
            signClasses = data.classes || [];
            signShowControlCard(signClasses);
        } else {
            errDiv.textContent = data.msg || '登录失败';
            errDiv.style.display = 'block';
        }
    } catch (e) {
        errDiv.textContent = '网络错误，请重试';
        errDiv.style.display = 'block';
    }
}

function signShowControlCard(classes) {
    document.getElementById('sign-login-card').style.display = 'none';
    document.getElementById('sign-control-card').style.display = '';

    const select = document.getElementById('sign-course-select');
    select.innerHTML = '';
    classes.forEach(c => {
        const opt = document.createElement('option');
        opt.value = JSON.stringify({ course_id: c.CourseID, class_id: c.TClassID });
        opt.textContent = c.CourseName + (c.ClassName ? ' - ' + c.ClassName : '');
        select.appendChild(opt);
    });
}

function signLogout() {
    signClasses = [];
    signStopStream();
    document.getElementById('sign-control-card').style.display = 'none';
    document.getElementById('sign-log-card').style.display = 'none';
    document.getElementById('sign-login-card').style.display = '';
    document.getElementById('sign-login-error').style.display = 'none';
    document.getElementById('sign-username').value = '';
    document.getElementById('sign-password').value = '';
    document.getElementById('sign-wechat-link').value = '';
}

async function signStart() {
    const errDiv = document.getElementById('sign-control-error');
    errDiv.style.display = 'none';

    const selected = document.getElementById('sign-course-select').value;
    if (!selected) {
        errDiv.textContent = '请选择课程';
        errDiv.style.display = 'block';
        return;
    }
    const { course_id, class_id } = JSON.parse(selected);
    const seconds = parseInt(document.getElementById('sign-seconds').value) || 10;
    const duration = parseInt(document.getElementById('sign-duration').value) || 180;
    const notify_email = document.getElementById('sign-email').value.trim();

    try {
        const resp = await fetch('/api/sign/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Device-ID': getDeviceId() },
            body: JSON.stringify({ course_id, class_id, seconds, duration, notify_email }),
        });
        const data = await resp.json();
        if (data.success) {
            document.getElementById('sign-start-btn').style.display = 'none';
            document.getElementById('sign-stop-btn').style.display = '';
            document.getElementById('sign-log-card').style.display = '';
            document.getElementById('sign-log-content').textContent = '';
            signStartStream();
        } else {
            errDiv.textContent = data.msg || '启动失败';
            errDiv.style.display = 'block';
        }
    } catch (e) {
        errDiv.textContent = '网络错误，请重试';
        errDiv.style.display = 'block';
    }
}

async function signStop() {
    try {
        await fetch('/api/sign/stop', {
            method: 'POST',
            headers: { 'X-Device-ID': getDeviceId() },
        });
    } catch (e) { /* ignore */ }
    signStopStream();
    document.getElementById('sign-start-btn').style.display = '';
    document.getElementById('sign-stop-btn').style.display = 'none';
}

function signStopStream() {
    if (signStreamController) {
        signStreamController.abort();
        signStreamController = null;
    }
}

async function signStartStream() {
    signStopStream();
    const controller = new AbortController();
    signStreamController = controller;

    try {
        const resp = await fetch('/api/sign/stream', {
            headers: { 'X-Device-ID': getDeviceId() },
            signal: controller.signal,
        });
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const line of lines) {
                if (line.startsWith('data:')) {
                    const raw = line.slice(5).trim();
                    try {
                        const obj = JSON.parse(raw);
                        if (obj.msg !== undefined) signAppendLog(obj.msg);
                    } catch (_) {
                        if (raw) signAppendLog(raw);
                    }
                }
            }
        }
    } catch (e) {
        if (e.name !== 'AbortError') {
            signAppendLog('[连接断开]');
        }
    }
    document.getElementById('sign-start-btn').style.display = '';
    document.getElementById('sign-stop-btn').style.display = 'none';
}


