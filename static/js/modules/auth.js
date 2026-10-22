import { resetScheduleEditor } from './schedule-editor.js';
import { pageResources } from './lifecycle.js';
import { state } from './store.js';
import { closeCalendarExport } from './calendar.js';
import { boundUsernameStorageKey } from './ad.js';
import { switchPage } from './router.js';
import { loadAnnouncementIndicator } from './announcements.js';
import { closeUiModal, openUiModal, requestUiConfirmation, showUiToast } from './ui.js';
const resources = pageResources('auth');

export const pendingInvitationTokenKey = 'pending_invitation_token';

export const ownInvitationTokenKey = 'own_invitation_token';

export function capturePendingInvitationToken() {
    try {
        const token = (new URLSearchParams(window.location.search).get('invite') || '').trim();
        const ownToken = (sessionStorage.getItem(ownInvitationTokenKey) || '').trim();
        if (token && token.length <= 128 && token !== ownToken) {
            sessionStorage.setItem(pendingInvitationTokenKey, token);
        }
    } catch (error) {
        if (error?.name === 'AbortError') return;
        // 隐私模式或禁用存储时不影响普通登录。
    }
}

export function getPendingInvitationToken() {
    try {
        const token = (sessionStorage.getItem(pendingInvitationTokenKey) || '').trim();
        return token.length > 0 && token.length <= 128 ? token : '';
    } catch (error) {
        if (error?.name === 'AbortError') return;
        return '';
    }
}

export function clearPendingInvitationToken() {
    try {
        sessionStorage.removeItem(pendingInvitationTokenKey);
    } catch (error) {
        if (error?.name === 'AbortError') return;
        // 存储不可用时无需阻断登录结果。
    }
}

export function sanitizeIndexUrl() {
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
        if (error?.name === 'AbortError') return;
        // 地址栏清理失败时不影响正常使用。
    }
}

export function setOwnInvitationTokenInUrl(token) {
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
        if (error?.name === 'AbortError') return;
        // 地址栏同步失败时不影响正常使用。
    }
    return false;
}

export async function ensureOwnInvitationTokenInUrl() {
    const operation = resources.capture();
    try {
        const response = await operation.wait(resources.fetch('/api/invitation/link', {
            method: 'POST',
            headers: { 'X-Device-ID': getDeviceId() },
        }));
        const data = await operation.wait(response.json().catch(() => ({ success: false })));
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
        if (error?.name === 'AbortError') return;
            // 存储不可用时不影响地址栏同步。
        }
        return true;
    } catch (error) {
        if (error?.name === 'AbortError') return;
        return false;
    }
}

export function setTemporarySession(expiresAt) {
    if (state.temporarySessionTimer) clearTimeout(state.temporarySessionTimer);
    state.temporarySessionTimer = null;
    state.temporarySessionExpiresAt = expiresAt ? Number(expiresAt) * 1000 : null;
    if (!state.temporarySessionExpiresAt) return;
    const remaining = state.temporarySessionExpiresAt - Date.now();
    if (remaining <= 0) {
        window.location.reload();
        return;
    }
    state.temporarySessionTimer = setTimeout(() => window.location.reload(), remaining + 50);
}

export function rememberBoundUsername(username) {
    const normalized = String(username || '').trim();
    if (state.academicCacheUsername !== normalized) {
        state.academicCacheGeneration++;
        if (typeof apiClient !== 'undefined') {
            apiClient.resetAuthState();
            apiClient.cancelRequest('grades');
            apiClient.cancelRequest('login-status');
            state.loginStatusPromise = null;
        }
        state.temporaryReloginPromptShown = false;
        state._examSessions = null;
        if (state.calendarExportKind) closeCalendarExport();
        state.cachedSchedule = null;
        state.scheduleRevision = 0;
        state.scheduleSemesterKey = null;
        state.scheduleOwnerToken = null;
        state.personalScheduleNotices = [];
        resetScheduleEditor();
        state.currentScheduleMap.clear();
        state.cachedExams = null;
        state.cachedScheduleExams = [];
        state.scheduleExamsStale = false;
        state.semesterStart = null;
        state.otherMajorScheduleData = null;
        state.calendarExportData = null;
        state.calendarExportAccount = '';
        state.academicCacheUsername = normalized;
        if (typeof document.querySelectorAll === 'function') {
            document.querySelectorAll('.schedule-week-panel .schedule-days').forEach(el => { el.innerHTML = ''; });
            document.querySelectorAll('.schedule-unplaced-exams').forEach(el => { el.innerHTML = ''; el.hidden = true; });
            document.querySelectorAll('[data-schedule-date]').forEach(el => { el.textContent = ''; });
            document.querySelectorAll('.schedule-day-today').forEach(el => el.classList.remove('schedule-day-today'));
            const examsContent = document.getElementById('exams-content');
            if (examsContent) examsContent.innerHTML = '<div class="loading">加载中...</div>';
        }
    }
    try {
        if (normalized && !state.temporarySessionExpiresAt) {
            localStorage.setItem(boundUsernameStorageKey, normalized);
        } else {
            localStorage.removeItem(boundUsernameStorageKey);
        }
    } catch (error) {
        if (error?.name === 'AbortError') return;
        // 本地存储不可用时不影响登录和广告浏览。
    }
}

export function getDeviceId() {
    return apiClient.getDeviceId();
}

export function checkLoginStatus() {
    // 并发调用者等待同一次检查，避免提前返回让后续查询抢跑。
    if (state.loginStatusPromise) return state.loginStatusPromise;
    const cached = state.loginStatusResult;
    if (cached && cached.generation === state.academicCacheGeneration
        && Date.now() - cached.at >= 0 && Date.now() - cached.at < 30000
        && (!state.temporarySessionExpiresAt || Date.now() < state.temporarySessionExpiresAt)) {
        return Promise.resolve(cached.data);
    }
    const pending = performLoginStatusCheck().finally(() => {
        if (state.loginStatusPromise === pending) state.loginStatusPromise = null;
    });
    state.loginStatusPromise = pending;
    return pending;
}

export async function performLoginStatusCheck() {
    const operation = resources.capture();
    const request = apiClient.beginRequest('login-status');
    const generation = state.academicCacheGeneration;
    const statusDot = document.querySelector('.status-dot');
    const statusText = document.querySelector('.status-text');
    statusDot.className = 'status-dot status-checking';
    statusText.textContent = '检查中';
    try {
        const response = await operation.wait(apiClient.request('/api/check_login_status', { signal: request.signal, timeout: 60000 }));
        const data = await operation.wait(response.json());
        if (!request.isCurrent() || generation !== state.academicCacheGeneration) return;
        state.loginStatusResult = data.success && data.logged_in
            ? { generation, at: Date.now(), data } : null;
        if (data.success && data.logged_in) {
            statusDot.className = 'status-dot status-online';
            statusText.textContent = '已登录';
        } else {
            statusDot.className = 'status-dot status-offline';
            statusText.textContent = '未连接';
        }
        return data;
    } catch (error) {
        if (error?.name === 'AbortError') return;
        if (!request.isCurrent() || generation !== state.academicCacheGeneration || error.name === 'AbortError') return;
        console.error('检查登录状态失败:', error);
        statusDot.className = 'status-dot status-offline';
        statusText.textContent = '连接失败';
    }
}

export async function checkBindStatus() {
    const operation = resources.capture();
    const generation = state.academicCacheGeneration;
    try {
        const response = await operation.wait(resources.fetch('/api/check_bind', {
            headers: {
                'X-Device-ID': getDeviceId()
            }
        }));
        const data = await operation.wait(response.json());

        if (generation !== state.academicCacheGeneration) return;
        if (data.success && data.bound) {
            setTemporarySession(data.temporary ? data.expires_at : null);
            state.currentUsername = data.username;
            rememberBoundUsername(state.currentUsername);
            state.isGuestMode = false;
            document.getElementById('sidebar-username').textContent = data.temporary
                ? `${state.currentUsername} · 临时` : state.currentUsername;
            if (!data.temporary) ensureOwnInvitationTokenInUrl();

            switchPage('home');
            loadAnnouncementIndicator();
        } else {
            const wasTemporary = Boolean(state.temporarySessionExpiresAt);
            setTemporarySession(null);
            state.currentUsername = null;
            rememberBoundUsername(null);
            state.isGuestMode = true;
            document.getElementById('sidebar-username').textContent = '未登录';
            if (wasTemporary) {
                window.location.reload();
                return;
            }
            switchPage('home');
            showLoginModal();
        }
    } catch (error) {
        if (error?.name === 'AbortError') return;
        console.error('检查绑定状态失败:', error);
        showLoginModal();
    }
}

export function showLoginModal() {
    const modal = document.getElementById('login-modal');
    openUiModal(modal, { initialFocusSelector: '#username' });
}

export function hideLoginModal() {
    const modal = document.getElementById('login-modal');
    closeUiModal(modal);
}

export function showPasswordDisclaimer() {
    const modal = document.getElementById('password-disclaimer-modal');
    if (!modal) return;

    const loginModal = document.getElementById('login-modal');
    state.passwordDisclaimerReturnToLogin = Boolean(
        loginModal && loginModal.classList && loginModal.classList.contains('active'),
    );
    if (state.passwordDisclaimerReturnToLogin) {
        closeUiModal(loginModal, { restoreFocus: false });
    }
    openUiModal(modal, { initialFocusSelector: '#password-disclaimer-close' });
}

export function closePasswordDisclaimer() {
    const modal = document.getElementById('password-disclaimer-modal');
    closeUiModal(modal, { restoreFocus: false });

    const shouldReturnToLogin = state.passwordDisclaimerReturnToLogin;
    state.passwordDisclaimerReturnToLogin = false;
    if (shouldReturnToLogin) {
        openUiModal(document.getElementById('login-modal'), {
            initialFocusSelector: '#bind-account',
        });
    }
}

export function skipBind() {
    state.isGuestMode = true;
    state.currentUsername = null;
    rememberBoundUsername(null);
    hideLoginModal();
    document.getElementById('sidebar-username').textContent = '访客';
    switchPage('home');
    loadAnnouncementIndicator();
}

function loginResponseError(response) {
    const status = response.status;
    const message = status === 504
        ? '登录服务响应超时（HTTP 504），请稍后重试。'
        : !response.ok
            ? `登录服务暂不可用（HTTP ${status}），请稍后重试或联系管理员。`
            : '登录服务返回了异常响应，请刷新页面后重试。';
    const error = new Error(message);
    error.name = 'LoginResponseError';
    return error;
}

export async function handleLogin(event) {
    const operation = resources.capture();
    event.preventDefault();

    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const bindControl = document.getElementById('bind-account');
    // 没有控件时按旧版客户端处理，避免旧页面升级期间意外失去绑定能力。
    const bindAccount = bindControl ? Boolean(bindControl.checked) : true;
    const invitationToken = bindAccount ? getPendingInvitationToken() : null;
    const errorDiv = document.getElementById('login-error');

    errorDiv.textContent = '';
    let response;
    let loginConfirmed = false;

    try {
        response = await operation.wait(resources.fetch('/api/login', {
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
        }));

        let data;
        try {
            data = await operation.wait(response.json());
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
            throw loginResponseError(response);
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)
                || typeof data.success !== 'boolean' || (!response.ok && data.success)) {
            throw loginResponseError(response);
        }

        if (data.success) {
            loginConfirmed = true;
            document.getElementById('password').value = '';
            state.temporaryReloginPromptShown = false;
            apiClient.resetAuthState();
            apiClient.cancelRequest('login-status');
            state.loginStatusPromise = null;
            const isBound = data.bound !== false;
            hideLoginModal();

            if (isBound || data.temporary) {
                setTemporarySession(data.temporary ? data.expires_at : null);
                state.currentUsername = data.username;
                rememberBoundUsername(state.currentUsername);
                state.isGuestMode = false;
                if (isBound) {
                    clearPendingInvitationToken();
                    ensureOwnInvitationTokenInUrl();
                }
                document.getElementById('sidebar-username').textContent = data.temporary
                    ? `${state.currentUsername} · 临时` : state.currentUsername;
                switchPage('home');
                loadAnnouncementIndicator();
                if (data.temporary) showUiToast(data.message || '已登录，本次输入的密码不会保存。登录失效后请重新输入。', 'info');
            } else {
                state.currentUsername = null;
                rememberBoundUsername(null);
                state.isGuestMode = true;
                document.getElementById('sidebar-username').textContent = '访客';
                switchPage('home');
                loadAnnouncementIndicator();
                showUiToast(data.message || '登录成功，本次未绑定账号；下次使用需重新登录', 'info');
            }
        } else {
            errorDiv.textContent = data.message || '登录失败';
        }
    } catch (error) {
        if (error?.name === 'AbortError') return;
        console.error('登录失败:', error);
        errorDiv.textContent = loginConfirmed
            ? '账号已登录，但页面加载异常，请刷新页面。'
            : error?.name === 'LoginResponseError' || error?.name === 'ApiError'
                ? error.message
                : !response && error?.name === 'TypeError'
                    ? '网络连接失败，请检查网络后重试。'
                    : '登录过程中发生异常，请刷新页面后重试。';
    }
}

export async function showRebindDialog() {
    const operation = resources.capture();
    const confirmed = await operation.wait(requestUiConfirmation({
        title: '重新绑定账号',
        message: '解绑后需要重新输入新账号密码，确定继续吗？',
        confirmText: '继续解绑',
        danger: true,
    }));
    if (!confirmed) {
        return;
    }
    await operation.wait(unbindForRebind());
}

export function closeRebindDialog() {
    const modal = document.getElementById('rebind-modal');
    closeUiModal(modal);
}

export async function handleRebind(event) {
    const operation = resources.capture();
    event.preventDefault();
    await operation.wait(unbindForRebind());
}

export async function unbindForRebind() {
    const operation = resources.capture();
    const errorDiv = document.getElementById('rebind-error');
    if (errorDiv) errorDiv.textContent = '';

    try {
        const response = await operation.wait(resources.fetch('/api/request_rebind', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Device-ID': getDeviceId()
            },
            body: JSON.stringify({})
        }));
        const data = await operation.wait(response.json());

        if (!data.success) {
            if (errorDiv) errorDiv.textContent = data.message || '解绑失败';
            else showUiToast(data.message || '解绑失败', 'error');
            return;
        }

        state.currentUsername = null;
        rememberBoundUsername(null);
        state.isGuestMode = false;
        document.getElementById('sidebar-username').textContent = '未绑定';
        closeRebindDialog();
        showLoginModal();
        showUiToast(data.message || '当前设备已解绑，请重新绑定新账号', 'success');
    } catch (error) {
        if (error?.name === 'AbortError') return;
        console.error('解绑失败:', error);
        if (errorDiv) errorDiv.textContent = '网络错误，请重试';
        else showUiToast('网络错误，请重试', 'error');
    }
}

export function initializeAuth() {
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible'
        && state.temporarySessionExpiresAt
        && Date.now() >= state.temporarySessionExpiresAt) {
        window.location.reload();
    }
});
document.addEventListener('api:auth-expired', event => {
    state.loginStatusResult = null;
    const statusDot = document.querySelector('.status-dot');
    const statusText = document.querySelector('.status-text');
    if (statusDot) statusDot.className = 'status-dot status-offline';
    if (statusText) statusText.textContent = '未连接';
    if (state.temporaryReloginPromptShown) return;
    state.temporaryReloginPromptShown = true;
    document.getElementById('login-error').textContent = event.detail.message;
    showLoginModal();
});
}
