// ==================== 全局变量 ====================
let adminKey = null;  // 管理员密钥
const adminUi = typeof URPUI !== 'undefined' ? URPUI : null;
const adminModalState = {
    activeModal: null,
    returnFocus: null,
};

function showAdminToast(message, type = 'info') {
    const region = document.getElementById('admin-toast-region');
    if (!region) return;
    const toast = document.createElement('div');
    toast.className = `admin-toast admin-toast-${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.textContent = message || '';
    region.appendChild(toast);
    window.setTimeout(() => toast.remove(), 3600);
}

function adminGetFocusable(container) {
    if (adminUi && typeof adminUi.getFocusableElements === 'function') {
        return adminUi.getFocusableElements(container);
    }
    if (!container || typeof container.querySelectorAll !== 'function') return [];
    return Array.from(container.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )).filter(element => !element.disabled && !element.hidden);
}

function adminSyncOverlay() {
    const overlay = document.getElementById('overlay');
    const shouldShow = Boolean(
        adminModalState.activeModal
        && adminModalState.activeModal.classList.contains('active'),
    );
    overlay?.classList.toggle('active', shouldShow);
    document.body?.classList.toggle('admin-ui-locked', shouldShow);
}

function adminOpenModal(modal, initialFocusSelector = '') {
    if (!modal) return;
    if (adminModalState.activeModal && adminModalState.activeModal !== modal) {
        adminCloseModal(adminModalState.activeModal, false);
    }
    if (!adminModalState.activeModal) {
        adminModalState.returnFocus = document.activeElement || null;
    }
    adminModalState.activeModal = modal;
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    adminSyncOverlay();

    const initial = initialFocusSelector && modal.querySelector(initialFocusSelector);
    const focusable = adminGetFocusable(modal);
    (initial || focusable[0])?.focus?.({ preventScroll: true });
}

function adminCloseModal(modal, restoreFocus = true) {
    if (!modal) return;
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    if (adminModalState.activeModal === modal) {
        adminModalState.activeModal = null;
        const returnFocus = adminModalState.returnFocus;
        adminModalState.returnFocus = null;
        if (restoreFocus && returnFocus?.isConnected !== false) {
            returnFocus.focus?.({ preventScroll: true });
        }
    }
    adminSyncOverlay();
}

function adminHandleOverlayClick(event) {
    if (event?.target !== event?.currentTarget) return;
    adminCloseModal(adminModalState.activeModal);
}

function adminHandleKeydown(event) {
    const modal = adminModalState.activeModal;
    if (!modal) return;
    if (event.key === 'Escape') {
        adminCloseModal(modal);
        return;
    }
    if (event.key !== 'Tab') return;

    const focusable = adminGetFocusable(modal);
    if (!focusable.length) {
        event.preventDefault();
        return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus?.({ preventScroll: true });
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus?.({ preventScroll: true });
    }
}

document.addEventListener('keydown', adminHandleKeydown);

// ==================== 页面初始化 ====================
document.addEventListener('DOMContentLoaded', function() {
    document.querySelector('.tabs')?.addEventListener('keydown', event => {
        if (!event.target.classList.contains('tab-btn')) return;
        const buttons = Array.from(event.currentTarget.querySelectorAll('.tab-btn'));
        const index = buttons.indexOf(event.target);
        let nextIndex;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % buttons.length;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + buttons.length) % buttons.length;
        else if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = buttons.length - 1;
        else return;
        event.preventDefault();
        const next = buttons[nextIndex];
        switchTab(next.dataset.tab);
        next.focus({preventScroll: true});
    });
    // 检查是否已登录（从sessionStorage获取）
    const savedKey = sessionStorage.getItem('admin_key');
    if (savedKey) {
        adminKey = savedKey;
        showAdminPanel();
        loadUsers();
    }
});

// ==================== 管理员登录 ====================
async function handleAdminLogin(event) {
    event.preventDefault();

    const key = document.getElementById('admin-key').value;
    const errorDiv = document.getElementById('login-error');
    const submitBtn = document.querySelector?.('#admin-login-form button[type="submit"]') || null;
    if (submitBtn?.disabled) return;

    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = '登录中...';
    }
    errorDiv.textContent = '';

    // 只校验管理员密钥，统计状态不可用时仍允许登录后台。
    try {
        const response = await fetch('/api/admin/auth', {
            cache: 'no-store',
            headers: {
                'X-Admin-Key': key
            }
        });

        const data = await response.json();

        if (data.success) {
            adminKey = key;
            sessionStorage.setItem('admin_key', key);
            showAdminPanel();
            loadUsers();
        } else {
            errorDiv.textContent = data.message || '密钥错误';
        }
    } catch (error) {
        console.error('登录失败:', error);
        errorDiv.textContent = '网络错误，请重试';
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = '登录';
        }
    }
}

function showAdminPanel() {
    document.getElementById('admin-login').style.display = 'none';
    document.getElementById('admin-panel').style.display = 'block';
}

function adminLogout() {
    stopUserGrowthRefresh();
    adminKey = null;
    sessionStorage.removeItem('admin_key');
    document.getElementById('admin-login').style.display = 'flex';
    document.getElementById('admin-panel').style.display = 'none';
}

// ==================== 标签页切换 ====================
function switchTab(tabName) {
    if (tabName !== 'users') stopUserGrowthRefresh();
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');
    if (adminUi && typeof adminUi.syncTabAriaState === 'function') {
        adminUi.syncTabAriaState(tabBtns, tabContents, tabName);
    } else {
        tabBtns.forEach(btn => {
            const isSelected = btn.dataset.tab === tabName;
            btn.classList.toggle('active', isSelected);
            btn.setAttribute('aria-selected', String(isSelected));
        });
        tabContents.forEach(content => {
            const isSelected = content.id === `tab-${tabName}`;
            content.classList.toggle('active', isSelected);
        });
    }

    // 加载对应数据
    if (tabName === 'users') {
        loadUsers();
    } else if (tabName === 'wechat') {
        loadWechatBindings();
    } else if (tabName === 'ad-stats') {
        loadAdvertisement();
        loadAdStats();
    } else if (tabName === 'announcements') {
        loadAnnouncements();
    } else if (tabName === 'service-status') {
        loadAdminServiceStatus();
    } else if (tabName === 'feedback') {
        loadAdminFeedbacks();
    } else if (tabName === 'activity') {
        loadTodayActivity();
    } else if (tabName === 'config') {
        loadConfig();
    } else if (tabName === 'members') {
        loadAdminMembers();
        loadConfig();
    } else if (tabName === 'withdrawals') {
        loadAdminWithdrawals();
        loadCommissionStats();
    }
}

// ==================== 个人状态 ====================
function updateServiceStatusPresetSelection(statusText) {
    document.querySelectorAll('.admin-service-status-preset').forEach(button => {
        button.classList.toggle('active', button.dataset.serviceStatus === statusText);
    });
}

function selectServiceStatus(statusText) {
    const input = document.getElementById('admin-service-status-text');
    input.value = statusText;
    input.focus();
    updateServiceStatusPresetSelection(statusText);
}

function showAdminServiceStatusUpdatedAt(updatedAt) {
    const updated = document.getElementById('admin-service-status-updated');
    updated.textContent = ServiceStatusUI.formatUpdatedAt(updatedAt);
}

async function loadAdminServiceStatus() {
    const message = document.getElementById('admin-service-status-message');
    message.className = 'hint-message';
    message.textContent = '正在加载...';

    try {
        const response = await fetch('/api/admin/service-status', {
            headers: {'X-Admin-Key': adminKey}
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
            throw new Error(result.message || '状态加载失败');
        }

        const data = result.data || {};
        const input = document.getElementById('admin-service-status-text');
        input.value = data.status_text || '';
        document.getElementById('admin-accepting-orders').checked = data.accepting_orders === true;
        updateServiceStatusPresetSelection(input.value);
        showAdminServiceStatusUpdatedAt(data.updated_at);
        message.textContent = '';
    } catch (error) {
        console.error('加载个人状态失败:', error);
        message.className = 'hint-message config-inline-status-error';
        message.textContent = error.message || '状态加载失败';
    }
}

async function saveAdminServiceStatus(event) {
    event.preventDefault();
    const input = document.getElementById('admin-service-status-text');
    const message = document.getElementById('admin-service-status-message');
    const statusText = input.value.trim();
    const acceptingOrders = document.getElementById('admin-accepting-orders').checked;

    if (!statusText) {
        message.className = 'hint-message config-inline-status-error';
        message.textContent = '状态文字不能为空';
        input.focus();
        return;
    }

    message.className = 'hint-message';
    message.textContent = '正在保存...';

    try {
        const response = await fetch('/api/admin/service-status', {
            method: 'PUT',
            headers: {
                'X-Admin-Key': adminKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                status_text: statusText,
                accepting_orders: acceptingOrders
            })
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
            throw new Error(result.message || '状态保存失败');
        }

        input.value = result.data.status_text;
        updateServiceStatusPresetSelection(result.data.status_text);
        showAdminServiceStatusUpdatedAt(result.data.updated_at);
        message.className = 'hint-message config-inline-status-success';
        message.textContent = result.message || '状态已更新';
    } catch (error) {
        console.error('保存个人状态失败:', error);
        message.className = 'hint-message config-inline-status-error';
        message.textContent = error.message || '状态保存失败';
    }
}

// ==================== 用户统计仪表盘 ====================

let userStatsData = null;
let bindingArchivePreview = null;
let bindingArchiveBatch = null;

async function previewBindingArchive() {
    const status = document.getElementById('binding-archive-status');
    const previewButton = document.getElementById('archive-preview-button');
    const executeButton = document.getElementById('archive-execute-button');
    previewButton.disabled = true;
    executeButton.disabled = true;
    bindingArchivePreview = null;
    bindingArchiveBatch = null;
    document.getElementById('binding-archive-prepared').checked = false;
    status.textContent = '正在读取当前数据库…';
    try {
        const response = await fetch('/api/admin/bindings/archive', {cache: 'no-store', headers: {'X-Admin-Key': adminKey}});
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.message || '预览失败');
        const data = result.data;
        if (!data || data.protocol_version !== 2) {
            throw new Error('归档模块版本不一致：服务器仍返回旧版数据。请完整更新服务代码、重启所有进程并强制刷新页面，暂勿执行清理。');
        }
        if (!data.enabled) {
            status.textContent = '当前使用 SQLite，此功能仅用于服务器 MySQL，无法执行清理。';
            return;
        }
        bindingArchivePreview = data;
        // randomUUID 在普通 HTTP 的服务器后台不可用，使用 getRandomValues 生成 UUID。
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        const hex = Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
        bindingArchiveBatch = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
        const count = data.counts;
        status.textContent = `目标：${data.target.host}:${data.target.port}/${data.target.database}。处理后保留 ${data.unique_users} 个用户，每个学号一条。已有 user_account ${data.archived_records} 个；旧版复数表 ${data.legacy_compact_records || 0} 条。待清理：绑定 ${count.users} 条、换绑请求 ${count.pending_requests} 条、微信绑定 ${count.wechat_bindings} 条、会话 ${count.wechat_sessions} 条、旧版用户归档 ${count.user_account_archive || 0} 条、旧版关联明细 ${count.binding_record_archive || 0} 条。`;
        // 旧版复数账号表不计入设备清理 counts，但只要它还有记录，
        // 仍然需要执行一次合并，否则它会一直占用数据库并绕过新主表。
        const hasLegacyAccounts = Number(data.legacy_compact_records || 0) > 0;
        executeButton.disabled = !hasLegacyAccounts && !Object.values(count).some(n => n > 0);
    } catch (error) {
        status.textContent = error.message;
    } finally {
        previewButton.disabled = false;
    }
}

async function executeBindingArchive() {
    if (!bindingArchivePreview || !bindingArchiveBatch) return;
    if (!document.getElementById('binding-archive-prepared').checked) {
        showAdminToast('请先完成数据库备份并暂停其他实例及用户入口', 'error');
        return;
    }
    const target = bindingArchivePreview.target;
    if (!confirm(`确认将 ${target.host}:${target.port}/${target.database} 的用户资料按学号合并为 ${bindingArchivePreview.unique_users} 条？仅保留账号、最近绑定的密码和时间信息；旧设备、会话及旧归档明细将清除，用户需重新登录绑定。`)) return;
    const button = document.getElementById('archive-execute-button');
    const previewButton = document.getElementById('archive-preview-button');
    const status = document.getElementById('binding-archive-status');
    button.disabled = true;
    previewButton.disabled = true;
    status.textContent = '正在归档、核对并清理，请勿关闭页面…';
    try {
        const response = await fetch('/api/admin/bindings/archive', {
            method: 'POST', headers: {'X-Admin-Key': adminKey, 'Content-Type': 'application/json'},
            body: JSON.stringify({protocol_version: 2, fingerprint: bindingArchivePreview.fingerprint, batch_id: bindingArchiveBatch, prepared: true})
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
            if (response.status === 409) bindingArchivePreview = null;
            throw new Error(result.message || '归档失败');
        }
        if (!result.data || result.data.protocol_version !== 2 || !Number.isInteger(result.data.account_count)
            || result.data.account_count < 0 || !Number.isInteger(result.data.counts?.users)) {
            const batch = result.data?.batch_id || bindingArchiveBatch;
            bindingArchivePreview = null;
            throw new Error(`服务器返回旧版或不完整结果，未确认精简成功。批次 ${batch}。请核对旧归档表并完整更新、重启服务，暂勿再次清理。`);
        }
        status.textContent = `${result.message || '用户资料已合并保存'}。精简用户 ${result.data.account_count} 个，每个学号一条；清理绑定 ${result.data.counts.users} 条；批次 ${result.data.batch_id}。`;
        bindingArchivePreview = null;
        bindingArchiveBatch = null;
        await loadUsers();
    } catch (error) {
        status.textContent = bindingArchivePreview
            ? `${error.message} 如遇网络中断，可点击执行按钮使用同一批次重试。`
            : error.message;
        button.disabled = !bindingArchivePreview;
    } finally {
        previewButton.disabled = false;
    }
}

let userChartMode = 'new';

let usersPending = null;
let userGrowthTimer = null;
let userStatsClockOffset = null;

function isUserGrowthVisible() {
    return adminKey && document.visibilityState !== 'hidden'
        && document.getElementById('tab-users').classList.contains('active');
}

function stopUserGrowthRefresh() {
    if (userGrowthTimer !== null) clearTimeout(userGrowthTimer);
    userGrowthTimer = null;
}

function scheduleUserGrowthRefresh() {
    stopUserGrowthRefresh();
    if (userStatsClockOffset === null || !isUserGrowthVisible()) return;
    // 用服务端快照校准浏览器时钟，只在北京时间下一个零点读取一次。
    const beijingTime = Date.now() + userStatsClockOffset + 8 * 3600000;
    const untilMidnight = 86400000 - beijingTime % 86400000;
    userGrowthTimer = setTimeout(() => {
        userGrowthTimer = null;
        if (isUserGrowthVisible()) return loadUsers();
    }, untilMidnight);
}

document.addEventListener('visibilitychange', () => {
    if (!isUserGrowthVisible()) return stopUserGrowthRefresh();
    if (userStatsClockOffset === null || !userStatsData) return;
    const beijingTime = Date.now() + userStatsClockOffset + 8 * 3600000;
    const today = new Date(beijingTime).toISOString().slice(0, 10);
    if (today !== userStatsData.date) {
        loadUsers();
    } else {
        scheduleUserGrowthRefresh();
    }
});

function loadUsers() {
    if (usersPending) return usersPending;
    stopUserGrowthRefresh();
    const container = document.getElementById('users-list');
    const status = document.getElementById('users-stats-status');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    container.innerHTML = '<div class="loading">加载中</div>';
    status.textContent = '正在刷新用户统计...';
    usersPending = (async () => {
        try {
            const response = await fetch('/api/admin/users', {
                headers: { 'X-Admin-Key': adminKey }, cache: 'no-store', signal: controller.signal
            });
            const raw = await response.text();
            let data;
            try {
                data = JSON.parse(raw);
            } catch (_) {
                const snippet = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
                throw new Error(`接口返回的不是 JSON，HTTP ${response.status}：${snippet || raw.slice(0, 300)}`);
            }
            if (!response.ok || !data.success) throw new Error(data.message || '加载失败');
            userStatsData = data;
            renderUserDashboard();
            if (!data.generated_at) {
                status.textContent = '已刷新用户统计。';
                return;
            }
            userStatsClockOffset = Date.parse(data.generated_at) - Date.now();
            const time = new Intl.DateTimeFormat('zh-CN', {
                timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
            }).format(new Date(data.generated_at));
            status.textContent = `统计截至：${time}（北京时间）`;
            scheduleUserGrowthRefresh();
        } catch (error) {
            const message = error.name === 'AbortError' ? '请求超时，请刷新重试' : error.message || '加载失败';
            container.innerHTML = `<p style="text-align:center;color:var(--error);">${escapeHtml(message)}</p>`;
            status.textContent = '刷新失败，请点击刷新重试。';
        } finally {
            clearTimeout(timeout);
            usersPending = null;
        }
    })();
    return usersPending;
}

async function loadAdStats() {
    const container = document.getElementById('ad-stats');
    if (!container) return;
    container.innerHTML = '<div class="loading">加载中</div>';
    try {
        const response = await fetch('/api/admin/ad_stats', {
            headers: { 'X-Admin-Key': adminKey }
        });
        const data = await response.json();
        if (!data.success) {
            container.innerHTML = `<p style="color:var(--error);text-align:center;">${escapeHtml(data.message || '加载失败')}</p>`;
            return;
        }
        renderAdStats(data.data || {});
    } catch (error) {
        container.innerHTML = `<p style="color:var(--error);text-align:center;">${escapeHtml(error.message || '加载失败')}</p>`;
    }
}

function renderAdStats(stats) {
    const container = document.getElementById('ad-stats');
    if (!container) return;

    const impressions = Number(stats.total_impressions) || 0;
    const clicks = Number(stats.total_clicks) || 0;
    const copies = Number(stats.total_copies) || 0;
    const dismissals = Number(stats.total_dismissals) || 0;
    const clickRate = Number(stats.click_through_rate) || 0;
    const detailRate = Number(stats.detail_conversion_rate) || 0;
    const overallRate = Number(stats.overall_conversion_rate) || 0;
    const copyUsernames = Array.isArray(stats.copy_usernames) ? stats.copy_usernames : [];
    const daily = Array.isArray(stats.daily) ? stats.daily : [];
    const rows = daily.slice().reverse().map(item => {
        const date = escapeHtml(String(item.date || '-'));
        const dayImpressions = Number(item.impressions) || 0;
        const dayClicks = Number(item.clicks) || 0;
        const dayCopies = Number(item.copies) || 0;
        return `<div class="ad-stats-row"><span class="ad-stats-row-date">${date}</span><span class="ad-stats-row-metrics"><span>展示 ${dayImpressions}</span><span>点击 ${dayClicks}</span><strong>复制 ${dayCopies}</strong></span></div>`;
    }).join('');

    const copyUsers = copyUsernames.map(username => (
        `<span class="ad-copy-user">${escapeHtml(String(username))}</span>`
    )).join('');

    container.innerHTML = `<div class="ud-cards ad-stats-cards">
        <div class="ud-card"><div class="ud-card-value">${impressions}</div><div class="ud-card-label">广告展示</div></div>
        <div class="ud-card ud-card-blue"><div class="ud-card-value">${clicks}</div><div class="ud-card-label">详情点击 · 横幅点击率 ${clickRate}%</div></div>
        <div class="ud-card ud-card-green"><div class="ud-card-value">${copies}</div><div class="ud-card-label">微信复制 · 详情转化率 ${detailRate}%</div></div>
        <div class="ud-card"><div class="ud-card-value">${overallRate}%</div><div class="ud-card-label">完整转化率</div></div>
    </div>
    <div class="ud-section ad-stats-section">
        <div class="ud-section-header"><span class="ud-section-title">最近 14 天</span><span class="ad-stats-hint">关闭 ${dismissals} 次 · 漏斗次数按天汇总</span></div>
        <div class="ad-stats-daily">${rows || '<div class="empty-state"><div class="empty-state-text">暂无广告记录</div></div>'}</div>
    </div>
    <div class="ud-section ad-stats-section">
        <div class="ud-section-header"><span class="ud-section-title">曾复制的学号</span><span class="ad-stats-hint">共 ${copyUsernames.length} 人 · 每个学号只显示一次</span></div>
        <div class="ad-copy-users">${copyUsers || '<div class="empty-state"><div class="empty-state-text">暂时还没有学号记录</div></div>'}</div>
    </div>`;
}

function renderUserDashboard() {
    const { total, daily } = userStatsData;
    const container = document.getElementById('users-list');

    if (total === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-state-text">暂无用户，无法计算会员率</div></div>';
        return;
    }

    // 以本次服务端快照的北京时间日期为准，不使用浏览器时钟划分统计日。
    const today = userStatsData.date || new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
    const anchor = Date.parse(`${today}T00:00:00Z`);
    const dayBefore = days => new Date(anchor - days * 86400000).toISOString().slice(0, 10);
    const todayNew = (daily.find(d => d.date === today) || {}).count || 0;
    const cutWeek = dayBefore(6);
    const cutMonth = dayBefore(29);
    const weekNew = daily.filter(d => d.date >= cutWeek && d.date <= today).reduce((s, d) => s + d.count, 0);
    const monthNew = daily.filter(d => d.date >= cutMonth && d.date <= today).reduce((s, d) => s + d.count, 0);

    // ── 概况卡片 ──
    let html = `<div class="ud-cards">
        <div class="ud-card">
            <div class="ud-card-value">${total}</div>
            <div class="ud-card-label">总用户</div>
        </div>
        <div class="ud-card ud-card-green">
            <div class="ud-card-value">+${todayNew}</div>
            <div class="ud-card-label">今日新增</div>
        </div>
        <div class="ud-card ud-card-blue">
            <div class="ud-card-value">+${weekNew}</div>
            <div class="ud-card-label">近 7 日</div>
        </div>
        <div class="ud-card ud-card-orange">
            <div class="ud-card-value">+${monthNew}</div>
            <div class="ud-card-label">近 30 日</div>
        </div>
    </div>`;

    if (userStatsData.membership_growth) {
        const growth = userStatsData.membership_growth;
        const rate = growth.rate === null ? '—' : `${growth.rate > 0 ? '+' : ''}${growth.rate.toFixed(1)}%`;
        html += `<section class="ud-section member-growth" aria-labelledby="member-growth-title">
            <div class="ud-section-header"><span class="ud-section-title" id="member-growth-title">会员增长率</span></div>
            <div class="member-growth-values"><strong>${rate}</strong><span>近 7 日 <b>${growth.current} 人</b></span><span>前 7 日 <b>${growth.previous} 人</b></span></div>
            <p class="config-desc">${growth.rate === null ? '前 7 日为 0，无法计算增长率。' : '按近 7 日相对前 7 日的会员登记人数计算。'}仅统计现存会员记录，普通续费不重复计入；删除或重新授予会影响历史。</p>
        </section>`;
    }

    // ── 增长趋势 ──
    const N = 14;
    const chartData = [];
    const firstDay = dayBefore(N - 1);
    const counts = new Map(daily.map(d => [d.date, d.count]));
    let cumulative = daily.filter(d => d.date < firstDay).reduce((sum, d) => sum + d.count, 0);
    for (let i = N - 1; i >= 0; i--) {
        const date = dayBefore(i);
        const count = counts.get(date) || 0;
        cumulative += count;
        chartData.push({ date, count, total: cumulative });
    }

    const isNew   = userChartMode === 'new';
    const vals    = chartData.map(d => isNew ? d.count : d.total);
    const maxVal  = Math.max(...vals, 1);
    const minVal  = isNew ? 0 : Math.min(...vals);
    const range   = maxVal - minVal || 1;

    html += `<div class="ud-section">
        <div class="ud-section-header">
            <span class="ud-section-title">增长趋势</span>
            <div class="ud-toggle" role="group" aria-label="增长趋势视图">
                <button type="button" data-chart-mode="new" aria-pressed="${isNew}" class="${isNew ? 'active':''}" onclick="switchChartMode('new')">每日新增</button>
                <button type="button" data-chart-mode="total" aria-pressed="${!isNew}" class="${!isNew ? 'active':''}" onclick="switchChartMode('total')">累计总量</button>
            </div>
        </div>`;

    if (isNew) {
        html += `<div class="ud-bar-chart">`;
        chartData.forEach(d => {
            const h = (d.count / maxVal * 100).toFixed(1);
            const label = d.date.substring(5).replace('-', '/');
            html += `<div class="ud-col">
                <div class="ud-col-label">${d.count > 0 ? '+'+d.count : ''}</div>
                <div class="ud-col-track"><div class="ud-col-bar" style="height:${h}%"></div></div>
                <div class="ud-col-date">${label}</div>
            </div>`;
        });
        html += `</div>`;
    } else {
        // SVG 折线图 — 固定 viewBox 宽高，等比缩放
        const svgW = 560, svgH = 168;
        const pad  = { t: 32, b: 28, l: 16, r: 16 };
        const plotW = svgW - pad.l - pad.r;
        const plotH = svgH - pad.t - pad.b;

        const pts = chartData.map((d, i) => {
            const x = pad.l + (i / (N - 1)) * plotW;
            const y = pad.t + plotH - ((d.total - minVal) / range) * plotH;
            return { x: +x.toFixed(2), y: +y.toFixed(2), val: d.total, date: d.date.substring(5).replace('-', '/') };
        });
        const line = pts.map(p => `${p.x},${p.y}`).join(' ');
        const area = `${pts[0].x},${svgH - pad.b} ${line} ${pts[pts.length-1].x},${svgH - pad.b}`;

        html += `<svg class="ud-line-svg" viewBox="0 0 ${svgW} ${svgH}">
            <defs>
                <linearGradient id="lg" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="var(--ui-accent)" stop-opacity="0.18"/>
                    <stop offset="100%" stop-color="var(--ui-accent)" stop-opacity="0"/>
                </linearGradient>
            </defs>
            <polygon points="${area}" fill="url(#lg)"/>
            <polyline points="${line}" fill="none" stroke="var(--ui-accent)" stroke-width="2" stroke-linejoin="round"/>
            ${pts.map(p => `<circle cx="${p.x}" cy="${p.y}" r="3.5" fill="var(--ui-accent)"><title>${p.date}：${p.val}</title></circle>`).join('')}
            ${pts.map((p, i) => i % 2 === 0 ? `<text x="${p.x}" y="${svgH - 6}" text-anchor="middle" fill="var(--ui-subtle)" font-size="12">${p.date}</text>` : '').join('')}
            ${pts.map((p, i) => `<text x="${p.x}" y="${p.y - (i % 2 === 0 ? 8 : 20)}" text-anchor="middle" fill="var(--ui-muted)" font-size="12">${p.val}</text>`).join('')}
        </svg>`;
    }
    html += `</div>`;

    // 饼图只负责人数构成，右侧文字同时提供准确人数和会员率。
    const grades = userStatsData.membership_rates?.grades;
    if (Array.isArray(grades) && grades.length) {
        const colors = ['#2055a2', '#4b77b5', '#7698c5', '#9db5d3', '#c1cfe1', '#536982', '#8a9ba9', '#a4adbb'];
        const gradeTotal = grades.reduce((sum, grade) => sum + grade.users, 0);
        let offset = 0;
        const segments = grades.map((grade, index) => {
            const start = offset;
            offset += gradeTotal ? grade.users / gradeTotal * 100 : 0;
            return `${colors[index % colors.length]} ${start}% ${offset}%`;
        });
        const rows = grades.map((grade, index) => {
            const label = grade.grade ? `${grade.grade} 级` : '未识别';
            const rate = grade.users ? `${(grade.members / grade.users * 100).toFixed(1)}%` : '—';
            return `<div class="grade-stat-row">
                <span class="grade-stat-name"><span class="grade-stat-swatch" style="background:${colors[index % colors.length]}" aria-hidden="true"></span>${escapeHtml(label)}</span>
                <span>${grade.users} 人</span><span>会员 ${grade.members} / ${grade.users} 人</span><strong>${rate}</strong>
            </div>`;
        }).join('');
        html += `<section class="ud-section grade-stats" aria-labelledby="grade-stats-title">
            <div class="ud-section-header"><span class="ud-section-title" id="grade-stats-title">年级人数分布与会员率</span></div>
            <p class="config-desc">饼图显示各年级人数占比；会员率为有效会员数 ÷ 该年级用户数。年级依据学号推断。</p>
            <div class="grade-stats-content">
                <div class="grade-pie" role="img" aria-label="年级人数分布，具体人数见下方列表" style="background:conic-gradient(${segments.join(',')})"><div><strong>${gradeTotal}</strong><span>总用户</span></div></div>
                <div class="grade-stats-list">${rows}</div>
            </div>
        </section>`;
    } else {
        html += '<div class="ud-section grade-stats"><p class="config-desc">年级统计暂不可用，请刷新重试。</p></div>';
    }

    container.innerHTML = html;
}

function switchChartMode(mode) {
    userChartMode = mode;
    renderUserDashboard();
    document.querySelector?.(`.ud-toggle button[data-chart-mode="${mode}"]`)?.focus?.({ preventScroll: true });
}

// ==================== 系统配置管理 ====================
async function loadConfig() {
    const currentUrlDiv = document.getElementById('current-url');
    const urlOptionsDiv = document.getElementById('url-options');

    currentUrlDiv.innerHTML = '<div class="loading">加载中</div>';
    urlOptionsDiv.innerHTML = '<div class="loading">加载中</div>';

    try {
        const response = await fetch('/api/admin/config', {
            headers: {
                'X-Admin-Key': adminKey
            }
        });

        const data = await response.json();

        if (data.success) {
            displayConfig(data.config);
        } else {
            currentUrlDiv.innerHTML = '<p style="color:var(--error);">加载失败</p>';
            urlOptionsDiv.innerHTML = '<p style="color:var(--error);">加载失败</p>';
        }
    } catch (error) {
        console.error('加载配置失败:', error);
        currentUrlDiv.innerHTML = '<p style="color:var(--error);">加载失败</p>';
        urlOptionsDiv.innerHTML = '<p style="color:var(--error);">加载失败</p>';
    }
}

function displayConfig(config) {
    const currentIndex = config.current_url_index || 0;
    const urls = config.urp_urls || [];
    const currentUrl = urls[currentIndex] || '未配置';

    // 显示当前URL
    const currentUrlDiv = document.getElementById('current-url');
    currentUrlDiv.innerHTML = `
        <div class="current-url-text">${currentUrl}</div>
    `;

    // 显示URL选项
    const urlOptionsDiv = document.getElementById('url-options');
    let html = '';

    urls.forEach((url, index) => {
        const isActive = index === currentIndex;
        const activeClass = isActive ? 'active' : '';
        const statusHtml = isActive ? '<span class="url-status active">当前使用</span>' : '';

        html += `
            <div class="url-option ${activeClass}">
                <div class="url-info">
                    <div class="url-label">URL ${index + 1}</div>
                    <div class="url-text">${url}</div>
                </div>
                <div>
                    ${statusHtml}
                    <button class="switch-url-btn"
                            onclick="switchUrl(${index})"
                            ${isActive ? 'disabled' : ''}>
                        ${isActive ? '使用中' : '切换'}
                    </button>
                </div>
            </div>
        `;
    });

    urlOptionsDiv.innerHTML = html;

    // 填充URL编辑表单
    document.getElementById('url-1').value = urls[0] || '';
    document.getElementById('url-2').value = urls[1] || '';

    // 填充学期起始日期
    const semesterInput = document.getElementById('semester-start');
    if (semesterInput && config.semester_start) {
        semesterInput.value = config.semester_start;
    }
    const gradesMemberRequired = document.getElementById('grades-member-required');
    const gradesMemberStatus = document.getElementById('grades-member-status');
    if (gradesMemberRequired) {
        const required = config.grades_require_member !== false;
        gradesMemberRequired.checked = required;
        if (gradesMemberStatus) {
            gradesMemberStatus.textContent = required ? '当前：需要初级会员' : '当前：无需会员';
        }
    }
    const memberPageEnabled = document.getElementById('member-page-enabled');
    const memberPageStatus = document.getElementById('member-page-status');
    if (memberPageEnabled) {
        const enabled = config.member_page_enabled !== false;
        memberPageEnabled.checked = enabled;
        if (memberPageStatus) {
            memberPageStatus.textContent = enabled ? '当前：显示' : '当前：隐藏';
        }
    }
    fillDatabaseConfig(config.database || {});
}



function fillDatabaseConfig(database) {
    const type = database.type || 'sqlite';
    const mysql = database.mysql || {};
    const typeEl = document.getElementById('database-type');
    if (!typeEl) return;

    typeEl.value = type;
    document.getElementById('database-sqlite-path').value = database.sqlite_path || 'data/urp_helper.db';
    document.getElementById('database-mysql-host').value = mysql.host || '';
    document.getElementById('database-mysql-port').value = mysql.port || 3306;
    document.getElementById('database-mysql-name').value = mysql.database || 'urp_helper';
    document.getElementById('database-mysql-user').value = mysql.user || '';
    document.getElementById('database-mysql-password').value = mysql.password || '';
    toggleDatabaseFields();
}

function toggleDatabaseFields() {
    const type = document.getElementById('database-type')?.value || 'sqlite';
    const sqliteFields = document.getElementById('database-sqlite-fields');
    const mysqlFields = document.getElementById('database-mysql-fields');
    if (sqliteFields) sqliteFields.style.display = type === 'sqlite' ? '' : 'none';
    if (mysqlFields) mysqlFields.style.display = type === 'mysql' ? '' : 'none';
}

async function handleUpdateDatabase(event) {
    event.preventDefault();
    const status = document.getElementById('database-config-status');
    const type = document.getElementById('database-type').value;
    const payload = {
        type,
        sqlite_path: document.getElementById('database-sqlite-path').value.trim() || 'data/urp_helper.db',
        mysql: {
            host: document.getElementById('database-mysql-host').value.trim(),
            port: parseInt(document.getElementById('database-mysql-port').value, 10) || 3306,
            database: document.getElementById('database-mysql-name').value.trim(),
            user: document.getElementById('database-mysql-user').value.trim(),
            password: document.getElementById('database-mysql-password').value
        }
    };

    if (type === 'mysql' && (!payload.mysql.host || !payload.mysql.database || !payload.mysql.user)) {
        showAdminToast('请填写 MySQL 主机、数据库名和用户名', 'error');
        return;
    }

    if (status) {
        status.textContent = '正在测试连接并初始化表结构...';
        status.className = 'config-inline-status';
    }

    try {
        const response = await fetch('/api/admin/config/database', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Admin-Key': adminKey
            },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (data.success) {
            if (status) {
                status.textContent = data.message || '数据库配置已保存';
                status.className = 'config-inline-status config-inline-status-success';
            }
            if (data.config) {
                displayConfig(data.config);
            }
        } else {
            if (status) {
                status.textContent = data.message || '保存失败';
                status.className = 'config-inline-status config-inline-status-error';
            }
            showAdminToast(data.message || '保存失败', 'error');
        }
    } catch (error) {
        console.error('保存数据库配置失败:', error);
        if (status) {
            status.textContent = '网络错误，请重试';
            status.className = 'config-inline-status config-inline-status-error';
        }
    }
}

async function handleMigrateSqliteData() {
    const status = document.getElementById('database-config-status');
    const sqlitePath = document.getElementById('database-sqlite-path').value.trim() || 'data/urp_helper.db';
    if (!confirm('确定要把本机 SQLite 数据导入当前数据库吗？已有相同主键的数据会被覆盖。')) {
        return;
    }
    if (status) {
        status.textContent = '正在导入 SQLite 数据...';
        status.className = 'config-inline-status';
    }
    try {
        const response = await fetch('/api/admin/config/database/migrate_sqlite', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Admin-Key': adminKey
            },
            body: JSON.stringify({ sqlite_path: sqlitePath })
        });
        const data = await response.json();
        if (data.success) {
            const total = Object.values(data.data || {}).reduce((sum, value) => sum + (typeof value === 'number' ? value : 0), 0);
            if (status) {
                status.textContent = `${data.message || '导入完成'}，共导入 ${total} 条记录`;
                status.className = 'config-inline-status config-inline-status-success';
            }
        } else {
            if (status) {
                status.textContent = data.message || '导入失败';
                status.className = 'config-inline-status config-inline-status-error';
            }
            showAdminToast(data.message || '导入失败', 'error');
        }
    } catch (error) {
        console.error('导入 SQLite 数据失败:', error);
        if (status) {
            status.textContent = '网络错误，请重试';
            status.className = 'config-inline-status config-inline-status-error';
        }
    }
}
async function handleUpdateGradesMemberRequired() {
    const checkbox = document.getElementById('grades-member-required');
    const status = document.getElementById('grades-member-status');
    const required = !!checkbox.checked;
    if (status) {
        status.textContent = '保存中...';
    }

    try {
        const response = await fetch('/api/admin/config/grades_member', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Admin-Key': adminKey
            },
            body: JSON.stringify({ grades_require_member: required })
        });
        const data = await response.json();
        if (data.success) {
            if (status) {
                status.textContent = required ? '当前：需要初级会员' : '当前：无需会员';
            }
        } else {
            checkbox.checked = !required;
            if (status) {
                status.textContent = '保存失败';
            }
            showAdminToast(data.message || '保存失败', 'error');
        }
    } catch (error) {
        checkbox.checked = !required;
        if (status) {
            status.textContent = '保存失败';
        }
        console.error('保存查成绩权限失败:', error);
        showAdminToast('网络错误，请重试', 'error');
    }
}

async function handleUpdateMemberPageEnabled() {
    const checkbox = document.getElementById('member-page-enabled');
    const status = document.getElementById('member-page-status');
    if (!checkbox) return;

    const enabled = !!checkbox.checked;
    if (status) {
        status.textContent = '保存中...';
    }

    try {
        const response = await fetch('/api/admin/config/member_page', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Admin-Key': adminKey
            },
            body: JSON.stringify({ member_page_enabled: enabled })
        });
        const data = await response.json();
        if (response.ok && data.success) {
            if (status) {
                status.textContent = enabled ? '当前：显示（刷新前端后生效）' : '当前：隐藏（刷新前端后生效）';
            }
        } else {
            checkbox.checked = !enabled;
            if (status) {
                status.textContent = '保存失败';
            }
            showAdminToast(data.message || '保存失败', 'error');
        }
    } catch (error) {
        checkbox.checked = !enabled;
        if (status) {
            status.textContent = '保存失败';
        }
        console.error('保存前端充值页面显示设置失败:', error);
        showAdminToast('网络错误，请重试', 'error');
    }
}

async function switchUrl(urlIndex) {
    if (!confirm(`确定要切换到URL ${urlIndex + 1}吗？`)) {
        return;
    }

    try {
        const response = await fetch('/api/admin/config/url', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Admin-Key': adminKey
            },
            body: JSON.stringify({
                url_index: urlIndex
            })
        });

        const data = await response.json();

        if (data.success) {
            showAdminToast(data.message || 'URL切换成功', 'success');
            loadConfig();
        } else {
            showAdminToast(data.message || '切换失败', 'error');
        }
    } catch (error) {
        console.error('切换URL失败:', error);
        showAdminToast('网络错误，请重试', 'error');
    }
}

async function handleUpdateUrls(event) {
    event.preventDefault();

    const url1 = document.getElementById('url-1').value.trim();
    const url2 = document.getElementById('url-2').value.trim();

    if (!url1 || !url2) {
        showAdminToast('请填写两个URL', 'error');
        return;
    }

    if (!confirm('确定要更新URL配置吗？')) {
        return;
    }

    try {
        const response = await fetch('/api/admin/config/url', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Admin-Key': adminKey
            },
            body: JSON.stringify({
                urls: [url1, url2]
            })
        });

        const data = await response.json();

        if (data.success) {
            showAdminToast(data.message || 'URL配置已更新', 'success');
            loadConfig();
        } else {
            showAdminToast(data.message || '更新失败', 'error');
        }
    } catch (error) {
        console.error('更新URL配置失败:', error);
        showAdminToast('网络错误，请重试', 'error');
    }
}

async function handleUpdateSemester(event) {
    event.preventDefault();

    const dateStr = document.getElementById('semester-start').value;
    if (!dateStr) {
        showAdminToast('请选择日期', 'error');
        return;
    }

    try {
        const response = await fetch('/api/admin/semester', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Admin-Key': adminKey
            },
            body: JSON.stringify({ semester_start: dateStr })
        });

        const data = await response.json();
        if (data.success) {
            showAdminToast(data.message || '学期配置已更新', 'success');
        } else {
            showAdminToast(data.message || '更新失败', 'error');
        }
    } catch (error) {
        console.error('更新学期配置失败:', error);
        showAdminToast('网络错误，请重试', 'error');
    }
}

// ==================== 公告管理 ====================
let currentAnnouncementId = null;

async function loadAnnouncements() {
    const listDiv = document.getElementById('announcements-list');
    listDiv.innerHTML = '<div class="loading">加载中...</div>';

    try {
        const response = await fetch('/api/admin/announcements', {
            headers: {
                'X-Admin-Key': adminKey
            }
        });

        const data = await response.json();

        if (data.success) {
            if (data.announcements && data.announcements.length > 0) {
                displayAnnouncements(data.announcements);
            } else {
                listDiv.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-state-icon">
                            <svg class="ui-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><use href="/static/icons/lucide.svg#bell"/></svg>
                        </div>
                        <div class="empty-state-text">暂无公告</div>
                    </div>
                `;
            }
        } else {
            listDiv.innerHTML = '<p style="text-align:center;color:var(--error);">加载失败</p>';
        }
    } catch (error) {
        console.error('加载公告失败:', error);
        listDiv.innerHTML = '<p style="text-align:center;color:var(--error);">加载失败</p>';
    }
}

let cachedAdminAnnouncements = new Map();

function displayAnnouncements(announcements) {
    const listDiv = document.getElementById('announcements-list');
    cachedAdminAnnouncements = new Map();

    let html = '';
    announcements.forEach(ann => {
        const annId = Number(ann.id);
        cachedAdminAnnouncements.set(annId, ann);
        const createTime = new Date(ann.create_time).toLocaleString('zh-CN');
        const statusClass = ann.is_active ? 'active' : 'inactive';
        const statusText = ann.is_active ? '启用' : '禁用';

        html += `
            <div class="announcement-card">
                <div class="announcement-header">
                    <h3>${escapeHtml(ann.title)}</h3>
                    <span class="announcement-status ${statusClass}">${statusText}</span>
                </div>
                <div class="announcement-content">
                    ${escapeHtml(ann.content).replace(/\n/g, '<br>')}
                </div>
                <div class="announcement-footer">
                    <span class="announcement-time">发布时间: ${escapeHtml(createTime)}</span>
                    <div class="announcement-actions">
                        <button class="edit-btn" type="button" onclick="showEditAnnouncementModal(${annId})">编辑</button>
                        <button class="delete-btn" type="button" onclick="deleteAnnouncement(${annId})">删除</button>
                    </div>
                </div>
            </div>
        `;
    });

    listDiv.innerHTML = html;
}

function showCreateAnnouncementModal() {
    currentAnnouncementId = null;
    document.getElementById('announcement-modal-title').textContent = '发布新公告';
    document.getElementById('announcement-title').value = '';
    document.getElementById('announcement-content').value = '';
    document.getElementById('announcement-active').checked = true;

    const modal = document.getElementById('announcement-modal');
    adminOpenModal(modal);
}

function showEditAnnouncementModal(id, announcement) {
    const item = announcement || cachedAdminAnnouncements.get(Number(id));
    if (!item) return;
    currentAnnouncementId = id;
    document.getElementById('announcement-modal-title').textContent = '编辑公告';
    document.getElementById('announcement-title').value = item.title || '';
    document.getElementById('announcement-content').value = item.content || '';
    document.getElementById('announcement-active').checked = Boolean(item.is_active);

    const modal = document.getElementById('announcement-modal');
    adminOpenModal(modal);
}

function closeAnnouncementModal() {
    const modal = document.getElementById('announcement-modal');
    adminCloseModal(modal);
    currentAnnouncementId = null;
}

async function handleAnnouncementSubmit(event) {
    event.preventDefault();

    const title = document.getElementById('announcement-title').value.trim();
    const content = document.getElementById('announcement-content').value.trim();
    const isActive = document.getElementById('announcement-active').checked;
    const submitBtn = document.querySelector?.('#announcement-form button[type="submit"]') || null;
    if (submitBtn?.disabled) return;

    if (!title || !content) {
        showAdminToast('标题和内容不能为空', 'error');
        return;
    }

    const isEdit = currentAnnouncementId !== null;
    const url = isEdit ? `/api/admin/announcements/${currentAnnouncementId}` : '/api/admin/announcements';
    const method = isEdit ? 'PUT' : 'POST';

    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = '保存中...';
    }

    try {
        const response = await fetch(url, {
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'X-Admin-Key': adminKey
            },
            body: JSON.stringify({
                title: title,
                content: content,
                is_active: isActive
            })
        });

        const data = await response.json();

        if (data.success) {
            showAdminToast(data.message || (isEdit ? '公告更新成功' : '公告发布成功'), 'success');
            closeAnnouncementModal();
            loadAnnouncements();
        } else {
            showAdminToast(data.message || '操作失败', 'error');
        }
    } catch (error) {
        console.error('保存公告失败:', error);
        showAdminToast('网络错误，请重试', 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = '保存';
        }
    }
}

async function deleteAnnouncement(id) {
    if (!confirm('确定要删除这条公告吗？')) {
        return;
    }

    try {
        const response = await fetch(`/api/admin/announcements/${id}`, {
            method: 'DELETE',
            headers: {
                'X-Admin-Key': adminKey
            }
        });

        const data = await response.json();

        if (data.success) {
            showAdminToast('公告删除成功', 'success');
            loadAnnouncements();
        } else {
            showAdminToast(data.message || '删除失败', 'error');
        }
    } catch (error) {
        console.error('删除公告失败:', error);
        showAdminToast('网络错误，请重试', 'error');
    }
}

// ==================== 反馈管理 ====================
let currentReplyFeedbackId = null;

async function loadAdminFeedbacks() {
    const listDiv = document.getElementById('feedback-list');
    listDiv.innerHTML = '<div class="loading">加载中...</div>';

    try {
        const response = await fetch('/api/admin/feedback', {
            headers: {
                'X-Admin-Key': adminKey
            }
        });

        const data = await response.json();

        if (data.success) {
            if (data.feedbacks && data.feedbacks.length > 0) {
                displayAdminFeedbacks(data.feedbacks);
            } else {
                listDiv.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-state-icon">
                            <svg class="ui-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><use href="/static/icons/lucide.svg#message-square"/></svg>
                        </div>
                        <div class="empty-state-text">暂无反馈</div>
                    </div>
                `;
            }
        } else {
            listDiv.innerHTML = '<p style="text-align:center;color:var(--error);">加载失败</p>';
        }
    } catch (error) {
        console.error('加载反馈失败:', error);
        listDiv.innerHTML = '<p style="text-align:center;color:var(--error);">加载失败</p>';
    }
}

function displayAdminFeedbacks(feedbacks) {
    const listDiv = document.getElementById('feedback-list');
    const element = (tag, className = '', text = null, css = '') => {
        const node = document.createElement(tag);
        node.className = className;
        if (text !== null) node.textContent = text;
        if (css) node.style.cssText = css;
        return node;
    };
    const cards = feedbacks.map(fb => {
        const card = element('div', 'announcement-card');
        const header = element('div', 'announcement-header');
        header.append(element('h3', '', fb.username ?? ''), element('span',
            `announcement-status ${fb.visibility === 'public' ? 'active' : 'inactive'}`,
            fb.visibility === 'public' ? '公开' : '私密'));
        const content = element('div', 'announcement-content');
        content.append(element('strong', '', '1楼', 'color:var(--accent);font-size:12px;'),
            element('div', '', fb.content ?? '', 'margin-top:4px;white-space:pre-wrap;overflow-wrap:anywhere;'));
        card.append(header, content);
        (fb.replies || []).forEach((reply, index) => {
            const isAdmin = reply.username === '管理员';
            const row = element('div', '', null,
                'margin-top:8px;padding:10px;background:var(--bg-secondary);border-radius:8px;'
                + (isAdmin ? 'border-left:2px solid var(--success);' : ''));
            const heading = element('div', '', null,
                'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;gap:8px;');
            const author = element('span');
            author.append(element('strong', '', `${index + 2}楼 `, 'color:var(--accent);font-size:12px;'),
                element('span', '', reply.username ?? '',
                    `font-size:12px;font-weight:600;color:${isAdmin ? 'var(--success)' : 'var(--text-primary)'};overflow-wrap:anywhere;`));
            heading.append(author, element('span', '', new Date(reply.create_time).toLocaleString('zh-CN'),
                'font-size:11px;color:var(--text-tertiary);'));
            row.append(heading, element('div', '', reply.content ?? '',
                'font-size:13px;color:var(--text-secondary);line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;'));
            card.append(row);
        });
        const footer = element('div', 'announcement-footer');
        const actions = element('div', 'announcement-actions');
        const replyButton = element('button', 'edit-btn', '回复');
        const deleteButton = element('button', 'delete-btn', '删除');
        replyButton.type = deleteButton.type = 'button';
        replyButton.addEventListener('click', () => showFeedbackReplyModal(fb.id, fb.content ?? ''));
        deleteButton.addEventListener('click', () => deleteAdminFeedback(fb.id));
        actions.append(replyButton, deleteButton);
        footer.append(element('span', 'announcement-time', new Date(fb.create_time).toLocaleString('zh-CN')), actions);
        card.append(footer);
        return card;
    });
    listDiv.replaceChildren(...cards);
}

function showFeedbackReplyModal(feedbackId, content) {
    currentReplyFeedbackId = feedbackId;
    const original = document.createElement('p');
    original.style.cssText = 'color:var(--text-secondary);font-size:13px;padding:10px;background:var(--bg-secondary);border-radius:8px;margin-bottom:12px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;';
    original.textContent = content;
    document.getElementById('feedback-reply-original').replaceChildren(original);
    document.getElementById('feedback-reply-content').value = '';

    const modal = document.getElementById('feedback-reply-modal');
    adminOpenModal(modal);
}

function closeFeedbackReplyModal() {
    const modal = document.getElementById('feedback-reply-modal');
    adminCloseModal(modal);
    currentReplyFeedbackId = null;
}

async function handleFeedbackReplySubmit(event) {
    event.preventDefault();

    const content = document.getElementById('feedback-reply-content').value.trim();

    if (!content) {
        showAdminToast('回复内容不能为空', 'error');
        return;
    }

    try {
        const response = await fetch(`/api/admin/feedback/${currentReplyFeedbackId}/reply`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Admin-Key': adminKey
            },
            body: JSON.stringify({ content })
        });

        const data = await response.json();

        if (data.success) {
            showAdminToast('回复成功', 'success');
            closeFeedbackReplyModal();
            loadAdminFeedbacks();
        } else {
            showAdminToast(data.message || '回复失败', 'error');
        }
    } catch (error) {
        console.error('回复反馈失败:', error);
        showAdminToast('网络错误，请重试', 'error');
    }
}

async function deleteAdminFeedback(id) {
    if (!confirm('确定要删除这条反馈及其所有回复吗？')) {
        return;
    }

    try {
        const response = await fetch(`/api/admin/feedback/${id}`, {
            method: 'DELETE',
            headers: {
                'X-Admin-Key': adminKey
            }
        });

        const data = await response.json();

        if (data.success) {
            showAdminToast('反馈删除成功', 'success');
            loadAdminFeedbacks();
        } else {
            showAdminToast(data.message || '删除失败', 'error');
        }
    } catch (error) {
        console.error('删除反馈失败:', error);
        showAdminToast('网络错误，请重试', 'error');
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function escapeHtmlAttr(text) {
    return text.replace(/'/g, "\\'").replace(/"/g, '\\"');
}

// ==================== 今日活跃 ====================

let activityPending = null;

function loadTodayActivity() {
    if (activityPending) return activityPending;
    const count = document.getElementById('today-active-count');
    const sources = ['web', 'miniprogram', 'app', 'unknown'];
    const status = document.getElementById('today-activity-status');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    count.textContent = '-';
    sources.forEach(source => { document.getElementById(`today-active-${source}`).textContent = '-'; });
    status.textContent = '加载中...';
    activityPending = (async () => {
        try {
            const response = await fetch('/api/admin/activity/today', {
                headers: { 'X-Admin-Key': adminKey }, cache: 'no-store', signal: controller.signal
            });
            const result = await response.json();
            if (!response.ok || !result.success) throw new Error(result.message || '读取失败');
            count.textContent = result.data.active_users;
            sources.forEach(source => { document.getElementById(`today-active-${source}`).textContent = result.data.sources[source]; });
            status.textContent = `统计日期：${result.data.date}（北京时间）`;
        } catch (error) {
            status.textContent = '今日活跃统计加载失败，请点击刷新重试。';
        } finally {
            clearTimeout(timeout);
            activityPending = null;
        }
    })();
    return activityPending;
}

// ==================== 会员管理 ====================
async function loadAdminMembers(usernameArg = '') {
    const listDiv = document.getElementById('members-list');
    const input = document.getElementById('grant-username');
    const username = (usernameArg || (input ? input.value : '') || '').trim();

    if (!username) {
        listDiv.innerHTML = '<div class="empty-state">\u8f93\u5165\u5b66\u53f7\u540e\u67e5\u8be2\u6216\u8c03\u6574\u4f1a\u5458\u72b6\u6001</div>';
        return;
    }

    listDiv.innerHTML = '<div class="loading">\u67e5\u8be2\u4e2d...</div>';
    try {
        const resp = await fetch(`/api/admin/members?username=${encodeURIComponent(username)}`, { headers: { 'X-Admin-Key': adminKey } });
        const data = await resp.json();
        if (!data.success) {
            listDiv.innerHTML = `<p style="color:var(--error);">${data.message || '\u67e5\u8be2\u5931\u8d25'}</p>`;
            return;
        }
        renderAdminMemberDetail(data.data);
    } catch (e) {
        listDiv.innerHTML = '<p style="color:var(--error);">\u7f51\u7edc\u9519\u8bef\uff0c\u8bf7\u91cd\u8bd5</p>';
    }
}

function queryAdminMember() {
    loadAdminMembers();
}

function renderAdminMemberDetail(data) {
    const listDiv = document.getElementById('members-list');
    if (!data) {
        listDiv.innerHTML = '<div class="empty-state">\u8f93\u5165\u5b66\u53f7\u540e\u67e5\u8be2\u6216\u8c03\u6574\u4f1a\u5458\u72b6\u6001</div>';
        return;
    }

    const typeMap = { basic: '\u521d\u7ea7\u4f1a\u5458', advanced: '\u9ad8\u7ea7\u4f1a\u5458' };
    const member = data.membership;
    const now = new Date();
    let statusHtml = '<span class="member-status-expired">\u975e\u4f1a\u5458</span>';
    let memberRows = `
        <div class="withdraw-history-item"><span>\u5b66\u53f7</span><strong>${escapeHtml(data.username)}</strong></div>
        <div class="withdraw-history-item"><span>\u7528\u6237\u7ed1\u5b9a</span><strong>${data.user_exists ? '\u5df2\u7ed1\u5b9a' : '\u672a\u5728 users \u8868\u627e\u5230'}</strong></div>`;

    if (member) {
        const expire = new Date(member.expire_time);
        const valid = expire > now;
        statusHtml = valid
            ? '<span class="member-status-valid">\u6709\u6548</span>'
            : '<span class="member-status-expired">\u5df2\u8fc7\u671f</span>';
        memberRows += `
            <div class="withdraw-history-item"><span>\u4f1a\u5458\u7c7b\u578b</span><strong>${typeMap[member.member_type] || escapeHtml(member.member_type)}</strong></div>
            <div class="withdraw-history-item"><span>\u5230\u671f\u65f6\u95f4</span><strong>${member.expire_time ? member.expire_time.slice(0, 19).replace('T', ' ') : '-'}</strong></div>
            <div class="withdraw-history-item"><span>\u5f00\u901a\u65f6\u95f4</span><strong>${member.create_time ? member.create_time.slice(0, 19).replace('T', ' ') : '-'}</strong></div>`;
        fillGrantForm(member.username, member.member_type, { preserveMessage: true });
    } else {
        memberRows += '<div class="withdraw-history-item"><span>\u4f1a\u5458\u72b6\u6001</span><strong>\u6682\u65e0\u4f1a\u5458\u8bb0\u5f55</strong></div>';
    }

    let ordersHtml = '<div class="commission-muted">\u6682\u65e0\u8fd1\u671f\u8ba2\u5355</div>';
    if (data.recent_orders && data.recent_orders.length) {
        ordersHtml = data.recent_orders.map(o => `
            <div class="withdraw-history-item">
                <span>${typeMap[o.member_type] || escapeHtml(o.member_type || '-')} \u00a5${o.amount || '0'}</span>
                <strong>${escapeHtml(o.status || '-')}</strong>
                <span class="commission-muted">${o.create_time ? o.create_time.slice(0, 10) : ''}</span>
            </div>`).join('');
    }

    listDiv.innerHTML = `
        <div class="member-table-wrap">
            <div class="commission-mini-grid">
                <span>\u5f53\u524d\u72b6\u6001</span>
                <strong>${statusHtml}</strong>
            </div>
            <div class="withdraw-history">${memberRows}</div>
            <div class="withdraw-history-title">\u8fd1\u671f\u8ba2\u5355</div>
            <div class="withdraw-history">${ordersHtml}</div>
        </div>`;
}

function fillGrantForm(username, memberType, { preserveMessage = false } = {}) {
    document.getElementById('grant-username').value = username;
    document.getElementById('grant-type').value = memberType || 'basic';
    document.getElementById('grant-days').value = 180;
    if (!preserveMessage) {
        document.getElementById('grant-member-msg').textContent = '';
    }
}

async function handleGrantMember(event) {
    event.preventDefault();
    const username = document.getElementById('grant-username').value.trim();
    const memberType = document.getElementById('grant-type').value;
    const days = parseInt(document.getElementById('grant-days').value);
    const msgDiv = document.getElementById('grant-member-msg');
    const submitBtn = document.querySelector?.('.member-grant-form button[type="submit"]') || null;
    if (submitBtn?.disabled) return;
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = '处理中...';
    }
    msgDiv.className = 'member-form-msg';
    msgDiv.textContent = '\u5904\u7406\u4e2d...';
    try {
        const resp = await fetch('/api/admin/members/grant', {
            method: 'POST',
            headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, member_type: memberType, days })
        });
        const data = await resp.json();
        if (data.success) {
            msgDiv.className = 'member-form-msg member-form-msg-success';
            msgDiv.textContent = data.message;
            showAdminToast(data.message || '会员开通成功', 'success');
            loadAdminMembers(username);
        } else {
            msgDiv.className = 'member-form-msg member-form-msg-error';
            msgDiv.textContent = data.message || '\u64cd\u4f5c\u5931\u8d25';
        }
    } catch (e) {
        msgDiv.className = 'member-form-msg member-form-msg-error';
        msgDiv.textContent = '\u7f51\u7edc\u9519\u8bef\uff0c\u8bf7\u91cd\u8bd5';
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = '确认开通';
        }
    }
}

async function handleRevokeMember() {
    const username = document.getElementById('grant-username').value.trim();
    const msgDiv = document.getElementById('grant-member-msg');
    if (!username) {
        msgDiv.className = 'member-form-msg member-form-msg-error';
        msgDiv.textContent = '\u8bf7\u5148\u8f93\u5165\u5b66\u53f7';
        return;
    }
    await revokeMember(username);
}

async function revokeMember(username) {
    if (!confirm(`\u786e\u5b9a\u8981\u64a4\u9500 ${username} \u7684\u4f1a\u5458\u8d44\u683c\u5417\uff1f`)) return;
    try {
        const resp = await fetch('/api/admin/members/revoke', {
            method: 'POST',
            headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ username })
        });
        const data = await resp.json();
        if (data.success) {
            const msgDiv = document.getElementById('grant-member-msg');
            msgDiv.className = 'member-form-msg member-form-msg-success';
            msgDiv.textContent = data.message;
            loadAdminMembers(username);
        } else {
            showAdminToast(data.message || '\u64a4\u9500\u5931\u8d25', 'error');
        }
    } catch (e) {
        showAdminToast('\u7f51\u7edc\u9519\u8bef\uff0c\u8bf7\u91cd\u8bd5', 'error');
    }
}

// ==================== 提现审核 ====================
let cachedAdminWithdrawals = new Map();
const pendingWithdrawalReviews = new Set();

async function loadAdminWithdrawals() {
    const listDiv = document.getElementById('withdrawals-list');
    listDiv.innerHTML = '<div class="loading">加载中...</div>';
    try {
        const resp = await fetch('/api/admin/withdrawals', { headers: { 'X-Admin-Key': adminKey } });
        const data = await resp.json();
        if (!data.success) { listDiv.innerHTML = `<p style="color:var(--error);">${escapeHtml(data.message || '加载失败')}</p>`; return; }
        const items = data.data;
        cachedAdminWithdrawals = new Map();
        if (!items.length) { listDiv.innerHTML = '<div class="empty-state">暂无提现申请</div>'; return; }
        const statusMap = { pending: '待审核', approved: '已通过', rejected: '已拒绝' };
        const statusClass = { pending: 'status-pending', approved: 'status-approved', rejected: 'status-rejected' };
        let html = '<div class="member-table-wrap"><table class="member-table"><thead><tr><th>申请人</th><th>收款信息</th><th>提现金额</th><th>佣金情况</th><th>状态</th><th>时间</th><th>操作</th></tr></thead><tbody>';
        for (const w of items) {
            cachedAdminWithdrawals.set(Number(w.id), w);
            const amount = parseFloat(w.amount) || 0;
            const earned = parseFloat(w.earned) || 0;
            const withdrawn = parseFloat(w.withdrawn) || 0;
            const availableAfter = parseFloat(w.available_after) || 0;
            html += `<tr>
                <td data-label="申请人"><div class="commission-user">${escapeHtml(w.username)}</div></td>
                <td data-label="收款信息">
                    <div class="withdraw-payee">${escapeHtml(w.real_name)}</div>
                    <div class="commission-muted">${escapeHtml(w.alipay_account)}</div>
                </td>
                <td data-label="提现金额"><strong>¥${amount.toFixed(2)}</strong></td>
                <td data-label="佣金情况">
                    <div class="commission-mini-grid">
                        <span>累计 ¥${earned.toFixed(2)}</span>
                        <span>已占用 ¥${withdrawn.toFixed(2)}</span>
                        <span>通过后剩 ¥${availableAfter.toFixed(2)}</span>
                    </div>
                </td>
                <td data-label="状态"><span class="admin-status-pill ${statusClass[w.status] || ''}">${escapeHtml(statusMap[w.status] || w.status)}</span></td>
                <td data-label="时间">
                    <div>${escapeHtml(w.create_time ? w.create_time.slice(0, 16) : '')}</div>
                    ${w.review_time ? `<div class="commission-muted">审核 ${escapeHtml(w.review_time.slice(0, 16))}</div>` : ''}
                </td>
                <td data-label="操作">${w.status === 'pending' ? `
                    <button class="btn-sm btn-success" type="button" onclick="approveWithdrawal(${Number(w.id)})">通过</button>
                    <button class="btn-sm btn-danger" type="button" onclick="rejectWithdrawal(${Number(w.id)})">拒绝</button>
                ` : '-'}</td>
            </tr>`;
        }
        html += '</tbody></table></div>';
        listDiv.innerHTML = html;
    } catch (e) {
        listDiv.innerHTML = `<p style="color:var(--error);">${escapeHtml(e.message || '加载失败')}</p>`;
    }
}
function formatWithdrawalSummary(id) {
    const item = cachedAdminWithdrawals.get(Number(id));
    if (!item) return '';
    const amount = (parseFloat(item.amount) || 0).toFixed(2);
    return `\n学号：${item.username || '-'}\n姓名：${item.real_name || '-'}\n支付宝：${item.alipay_account || '-'}\n金额：¥${amount}`;
}
async function approveWithdrawal(id) {
    if (pendingWithdrawalReviews.has(id)) return;
    if (!confirm(`确认审核通过该提现申请？通过后需管理员手动转账。${formatWithdrawalSummary(id)}`)) return;
    pendingWithdrawalReviews.add(id);
    const triggerBtn = document.querySelector?.(`button[onclick="approveWithdrawal(${Number(id)})"]`) || null;
    if (triggerBtn) triggerBtn.disabled = true;
    try {
        const resp = await fetch(`/api/admin/withdrawals/${id}/approve`, {
            method: 'POST',
            headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' }
        });
        const data = await resp.json();
        if (data.success) {
            showAdminToast('提现审核已通过', 'success');
            loadAdminWithdrawals();
            loadCommissionStats();
        } else {
            showAdminToast(data.message || '操作失败', 'error');
        }
    } catch (e) {
        showAdminToast('网络错误，请重试', 'error');
    } finally {
        pendingWithdrawalReviews.delete(id);
        if (triggerBtn && triggerBtn.isConnected) triggerBtn.disabled = false;
    }
}

async function rejectWithdrawal(id) {
    if (pendingWithdrawalReviews.has(id)) return;
    if (!confirm(`确认拒绝该提现申请？${formatWithdrawalSummary(id)}`)) return;
    pendingWithdrawalReviews.add(id);
    const triggerBtn = document.querySelector?.(`button[onclick="rejectWithdrawal(${Number(id)})"]`) || null;
    if (triggerBtn) triggerBtn.disabled = true;
    try {
        const resp = await fetch(`/api/admin/withdrawals/${id}/reject`, {
            method: 'POST',
            headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' }
        });
        const data = await resp.json();
        if (data.success) {
            showAdminToast('提现申请已拒绝', 'success');
            loadAdminWithdrawals();
            loadCommissionStats();
        } else {
            showAdminToast(data.message || '操作失败', 'error');
        }
    } catch (e) {
        showAdminToast('网络错误，请重试', 'error');
    } finally {
        pendingWithdrawalReviews.delete(id);
        if (triggerBtn && triggerBtn.isConnected) triggerBtn.disabled = false;
    }
}

// ==================== 佣金统计 ====================
async function loadCommissionStats() {
    const container = document.getElementById('commission-stats');
    container.innerHTML = '<div class="loading">加载中...</div>';
    try {
        const resp = await fetch('/api/admin/commission_stats', { headers: { 'X-Admin-Key': adminKey } });
        const data = await resp.json();
        if (!data.success) { container.innerHTML = `<p style="color:var(--error);text-align:center;">${escapeHtml(data.message || '加载失败')}</p>`; return; }
        const { users, summary } = data.data;
        const s = summary || {};
        let html = `<div class="commission-summary-grid">
            <div class="commission-summary-card"><div class="commission-summary-value">¥${escapeHtml(s.total_invitee_paid || '0')}</div><div class="commission-summary-label">团队充值</div></div>
            <div class="commission-summary-card"><div class="commission-summary-value">¥${escapeHtml(s.total_earned || '0')}</div><div class="commission-summary-label">累计佣金</div></div>
            <div class="commission-summary-card"><div class="commission-summary-value">¥${escapeHtml(s.total_available || '0')}</div><div class="commission-summary-label">可提现</div></div>
            <div class="commission-summary-card"><div class="commission-summary-value">¥${escapeHtml(s.total_pending || '0')}</div><div class="commission-summary-label">审核中</div></div>
        </div>`;
        if (!users.length) {
            container.innerHTML = html + '<div class="empty-state">暂无返佣记录</div>';
            return;
        }
        html += '<div class="member-table-wrap"><table class="member-table"><thead><tr><th>邀请人</th><th>团队</th><th>充值额</th><th>累计佣金</th><th>已占用</th><th>可提现</th><th>最近收益</th></tr></thead><tbody>';
        for (const u of users) {
            const available = parseFloat(u.available) || 0;
            const pending = parseFloat(u.pending_withdraw) || 0;
            html += `<tr class="${available > 0 ? 'commission-row-active' : ''}">
                <td data-label="邀请人"><span class="commission-user">${escapeHtml(u.username)}</span></td>
                <td data-label="团队">${u.invitee_count || 0} 人 / ${u.commission_count || 0} 笔${u.milestone_count ? ` / ${u.milestone_count} 个任务奖励` : ''}</td>
                <td data-label="充值额">¥${escapeHtml(u.invitee_paid_amount)}</td>
                <td data-label="累计佣金">¥${escapeHtml(u.earned)}</td>
                <td data-label="已占用">
                    <div>¥${escapeHtml(u.withdrawn)}</div>
                    ${pending > 0 ? `<div class="commission-muted">含审核中 ¥${pending.toFixed(2)}</div>` : ''}
                </td>
                <td data-label="可提现"><strong class="commission-available">¥${escapeHtml(u.available)}</strong></td>
                <td data-label="最近收益">${escapeHtml(u.last_earning_time ? u.last_earning_time.slice(0, 16) : '-')}</td>
            </tr>`;
        }
        html += '</tbody></table></div>';
        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = `<p style="color:var(--error);text-align:center;">${escapeHtml(e.message || '加载失败')}</p>`;
    }
}
