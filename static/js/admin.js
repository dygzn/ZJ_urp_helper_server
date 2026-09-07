// ==================== 全局变量 ====================
let adminKey = null;  // 管理员密钥
let currentRequestId = null;  // 当前审批的请求ID
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

    errorDiv.textContent = '';

    // 验证密钥（通过尝试获取待审批列表）
    try {
        const response = await fetch('/api/admin/pending_requests', {
            headers: {
                'Admin-Key': key
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
    }
}

function showAdminPanel() {
    document.getElementById('admin-login').style.display = 'none';
    document.getElementById('admin-panel').style.display = 'block';
}

function adminLogout() {
    adminKey = null;
    sessionStorage.removeItem('admin_key');
    document.getElementById('admin-login').style.display = 'flex';
    document.getElementById('admin-panel').style.display = 'none';
}

// ==================== 标签页切换 ====================
function switchTab(tabName) {
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
    if (tabName === 'pending') {
        loadPendingRequests();
    } else if (tabName === 'users') {
        loadUsers();
    } else if (tabName === 'ad-stats') {
        loadAdStats();
    } else if (tabName === 'announcements') {
        loadAnnouncements();
    } else if (tabName === 'service-status') {
        loadAdminServiceStatus();
    } else if (tabName === 'feedback') {
        loadAdminFeedbacks();
    } else if (tabName === 'monitor') {
        loadMonitorData();
        startMonitorRefresh();
    } else if (tabName === 'config') {
        loadConfig();
    } else if (tabName === 'members') {
        loadAdminMembers();
        loadConfig();
    } else if (tabName === 'withdrawals') {
        loadAdminWithdrawals();
        loadCommissionStats();
    }

    // 离开监控 Tab 时停止自动刷新
    if (tabName !== 'monitor') {
        stopMonitorRefresh();
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
            headers: {'Admin-Key': adminKey}
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
                'Admin-Key': adminKey,
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

// ==================== 加载待审批请求 ====================
async function loadPendingRequests() {
    const listDiv = document.getElementById('pending-list');
    listDiv.innerHTML = '<div class="loading">加载中</div>';

    try {
        const response = await fetch('/api/admin/pending_requests', {
            headers: {
                'Admin-Key': adminKey
            }
        });

        const data = await response.json();

        if (data.success) {
            if (data.requests && data.requests.length > 0) {
                displayPendingRequests(data.requests);
            } else {
                listDiv.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-state-icon">
                            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>
                        </div>
                        <div class="empty-state-text">暂无待审批请求</div>
                    </div>
                `;
            }
        } else {
            listDiv.innerHTML = '<p style="text-align:center;color:var(--error);">加载失败</p>';
        }
    } catch (error) {
        console.error('加载待审批请求失败:', error);
        listDiv.innerHTML = '<p style="text-align:center;color:var(--error);">加载失败</p>';
    }
}

function displayPendingRequests(requests) {
    const listDiv = document.getElementById('pending-list');

    let html = '';
    requests.forEach(req => {
        const time = new Date(req.time).toLocaleString('zh-CN');

        html += `
            <div class="request-card">
                <div class="request-header">
                    <span class="request-id">ID: ${req.id.substring(0, 8)}</span>
                    <span class="request-time">${time}</span>
                </div>
                <div class="request-info">
                    <div class="info-row">
                        <span class="info-label">设备ID:</span>
                        <span class="info-value device-id">${req.device_id.substring(0, 16)}...</span>
                    </div>
                    <div class="info-row">
                        <span class="info-label">原账号:</span>
                        <span class="info-value">${req.old_username}</span>
                    </div>
                    <div class="info-row">
                        <span class="info-label">新账号:</span>
                        <span class="info-value">${req.new_username}</span>
                    </div>
                </div>
                <div class="request-reason">
                    <strong>换绑原因:</strong> ${req.reason}
                </div>
                <div class="request-actions">
                    <button class="approve-btn" onclick="showApproveModal('${req.id}', ${JSON.stringify(req).replace(/"/g, '&quot;')})">批准</button>
                    <button class="reject-btn" onclick="rejectRequest('${req.id}')">拒绝</button>
                </div>
            </div>
        `;
    });

    listDiv.innerHTML = html;
}

// ==================== 审批弹窗 ====================
function showApproveModal(requestId, request) {
    currentRequestId = requestId;

    const modal = document.getElementById('approve-modal');
    const detailsDiv = document.getElementById('approve-details');

    // 显示请求详情
    detailsDiv.innerHTML = `
        <div class="detail-row">
            <span class="detail-label">原账号:</span>
            <span class="detail-value">${request.old_username}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">新账号:</span>
            <span class="detail-value">${request.new_username}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">换绑原因:</span>
            <span class="detail-value">${request.reason}</span>
        </div>
    `;

    adminOpenModal(modal);
}

function closeApproveModal() {
    const modal = document.getElementById('approve-modal');
    adminCloseModal(modal);

    currentRequestId = null;
}

// 处理批准
async function handleApprove() {
    if (!currentRequestId) {
        showAdminToast('请求ID丢失', 'error');
        return;
    }

    if (!confirm('确定要批准这个换绑请求吗？批准后该设备将解绑，用户需要重新登录。')) {
        return;
    }

    try {
        const response = await fetch('/api/admin/approve_rebind', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Admin-Key': adminKey
            },
            body: JSON.stringify({
                request_id: currentRequestId,
                approved: true
            })
        });

        const data = await response.json();

        if (data.success) {
            showAdminToast(data.message || '换绑请求已批准', 'success');
            closeApproveModal();
            loadPendingRequests();
        } else {
            showAdminToast(data.message || '操作失败', 'error');
        }
    } catch (error) {
        console.error('批准失败:', error);
        showAdminToast('网络错误，请重试', 'error');
    }
}

// 处理拒绝
async function handleReject() {
    if (!currentRequestId) {
        showAdminToast('请求ID丢失', 'error');
        return;
    }

    if (!confirm('确定要拒绝这个换绑请求吗？')) {
        return;
    }

    try {
        const response = await fetch('/api/admin/approve_rebind', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Admin-Key': adminKey
            },
            body: JSON.stringify({
                request_id: currentRequestId,
                approved: false
            })
        });

        const data = await response.json();

        if (data.success) {
            showAdminToast('换绑请求已拒绝', 'success');
            closeApproveModal();
            loadPendingRequests();
        } else {
            showAdminToast(data.message || '操作失败', 'error');
        }
    } catch (error) {
        console.error('拒绝失败:', error);
        showAdminToast('网络错误，请重试', 'error');
    }
}

// 直接拒绝（不打开弹窗）
async function rejectRequest(requestId) {
    if (!confirm('确定要拒绝这个换绑请求吗？')) {
        return;
    }

    try {
        const response = await fetch('/api/admin/approve_rebind', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Admin-Key': adminKey
            },
            body: JSON.stringify({
                request_id: requestId,
                approved: false
            })
        });

        const data = await response.json();

        if (data.success) {
            showAdminToast('换绑请求已拒绝', 'success');
            loadPendingRequests();
        } else {
            showAdminToast(data.message || '操作失败', 'error');
        }
    } catch (error) {
        console.error('拒绝失败:', error);
        showAdminToast('网络错误，请重试', 'error');
    }
}

// ==================== 用户统计仪表盘 ====================

let userStatsData = null;
let userChartMode = 'new';

async function loadUsers() {
    const container = document.getElementById('users-list');
    container.innerHTML = '<div class="loading">加载中</div>';
    try {
        const response = await fetch('/api/admin/users', { headers: { 'Admin-Key': adminKey } });
        const raw = await response.text();
        let data;
        try {
            data = JSON.parse(raw);
        } catch (_) {
            const snippet = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
            container.innerHTML = `<p style="text-align:center;color:var(--error);">接口返回的不是 JSON，HTTP ${response.status}：${snippet || raw.slice(0, 300)}</p>`;
            return;
        }
        if (data.success) {
            userStatsData = data;
            renderUserDashboard();
        } else {
            container.innerHTML = `<p style="text-align:center;color:var(--error);">${data.message || '加载失败'}</p>`;
        }
    } catch (e) {
        container.innerHTML = `<p style="text-align:center;color:var(--error);">${e.message || '加载失败'}</p>`;
    }
}

async function loadAdStats() {
    const container = document.getElementById('ad-stats');
    if (!container) return;
    container.innerHTML = '<div class="loading">加载中</div>';
    try {
        const response = await fetch('/api/admin/ad_stats', {
            headers: { 'Admin-Key': adminKey }
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
    const { total, classes, daily } = userStatsData;
    const container = document.getElementById('users-list');

    if (total === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-state-text">暂无用户</div></div>';
        return;
    }

    // 统计数字
    const today = new Date().toISOString().split('T')[0];
    const todayNew  = (daily.find(d => d.date === today) || {}).count || 0;
    const cutWeek   = new Date(Date.now() - 7  * 86400000).toISOString().split('T')[0];
    const cutMonth  = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const weekNew   = daily.filter(d => d.date > cutWeek ).reduce((s, d) => s + d.count, 0);
    const monthNew  = daily.filter(d => d.date > cutMonth).reduce((s, d) => s + d.count, 0);

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

    // ── 增长趋势 ──
    const N = 14;
    const chartData = [];
    for (let i = N - 1; i >= 0; i--) {
        const ds = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
        const hit = daily.find(x => x.date === ds);
        chartData.push({ date: ds, count: hit ? hit.count : 0, total: hit ? hit.total : 0 });
    }
    // 补齐累计（无数据天用前一天的累计）
    for (let i = 0; i < chartData.length; i++) {
        if (!chartData[i].total) {
            chartData[i].total = i > 0 ? chartData[i-1].total : (total - monthNew);
        }
    }

    const isNew   = userChartMode === 'new';
    const vals    = chartData.map(d => isNew ? d.count : d.total);
    const maxVal  = Math.max(...vals, 1);
    const minVal  = isNew ? 0 : Math.min(...vals);
    const range   = maxVal - minVal || 1;

    html += `<div class="ud-section">
        <div class="ud-section-header">
            <span class="ud-section-title">增长趋势</span>
            <div class="ud-toggle">
                <button class="${isNew ? 'active':''}" onclick="switchChartMode('new')">每日新增</button>
                <button class="${!isNew ? 'active':''}" onclick="switchChartMode('total')">累计总量</button>
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
        const svgW = 560, svgH = 160;
        const pad  = { t: 24, b: 28, l: 12, r: 12 };
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
                    <stop offset="0%" stop-color="#007AFF" stop-opacity="0.2"/>
                    <stop offset="100%" stop-color="#007AFF" stop-opacity="0"/>
                </linearGradient>
            </defs>
            <polygon points="${area}" fill="url(#lg)"/>
            <polyline points="${line}" fill="none" stroke="#007AFF" stroke-width="2" stroke-linejoin="round"/>
            ${pts.map(p => `<circle cx="${p.x}" cy="${p.y}" r="3.5" fill="#007AFF"/>`).join('')}
            ${pts.map((p, i) => i % 2 === 0 ? `<text x="${p.x}" y="${svgH - 6}" text-anchor="middle" fill="#AEAEB2" font-size="12">${p.date}</text>` : '').join('')}
            ${pts.map(p => `<text x="${p.x}" y="${p.y - 8}" text-anchor="middle" fill="#6E6E73" font-size="12">${p.val}</text>`).join('')}
        </svg>`;
    }
    html += `</div>`;

    // ── 用户构成 ──
    const pieColors = ['#007AFF','#34C759','#FF9500','#FF375F','#5E5CE6','#BF5AF2','#64D2FF','#FFD60A'];

    // 年级汇总
    const yearMap = {};
    classes.forEach(cls => {
        const key = cls.class_id === '其他' ? '其他' : cls.class_id.substring(0, 2);
        yearMap[key] = (yearMap[key] || 0) + cls.count;
    });
    const yearRows = Object.entries(yearMap).sort((a, b) => a[0].localeCompare(b[0]))
        .map(([k, v]) => ({ label: k === '其他' ? '其他' : '20'+k+' 级', count: v }));
    const maxYear = Math.max(...yearRows.map(r => r.count));

    // 专业明细：去掉专业代码的前两位 "15"
    const majorRows = classes.map((cls, i) => {
        if (cls.class_id === '其他') return { label: '其他', sublabel: null, count: cls.count, color: pieColors[i % pieColors.length] };
        const year = cls.class_id.substring(0, 2);
        const major = cls.class_id.substring(4, 7);   // 去掉 "15"，取后3位
        return { label: '20'+year+' 级', sublabel: major, count: cls.count, color: pieColors[i % pieColors.length] };
    });
    const maxMajor = Math.max(...majorRows.map(r => r.count));

    html += `<div class="ud-section">
        <div class="ud-section-header"><span class="ud-section-title">用户构成</span></div>
        <div class="ud-dist-block">
            <div class="ud-dist-group-label">按年级</div>`;
    yearRows.forEach((r, i) => {
        const pct = (r.count / total * 100).toFixed(1);
        const w   = (r.count / maxYear * 100).toFixed(1);
        html += `<div class="ud-dist-row">
            <div class="ud-dist-name">${r.label}</div>
            <div class="ud-dist-track"><div class="ud-dist-bar" style="width:${w}%;background:${pieColors[i % pieColors.length]}"></div></div>
            <div class="ud-dist-stat">${r.count} <span class="ud-dist-pct">${pct}%</span></div>
        </div>`;
    });

    html += `<div class="ud-dist-group-label" style="margin-top:14px;">按专业</div>`;
    majorRows.forEach(r => {
        const pct = (r.count / total * 100).toFixed(1);
        const w   = (r.count / maxMajor * 100).toFixed(1);
        const name = r.sublabel ? `${r.label} · <strong>${r.sublabel}</strong>` : r.label;
        html += `<div class="ud-dist-row">
            <div class="ud-dist-name ud-dist-name-major">${name}</div>
            <div class="ud-dist-track"><div class="ud-dist-bar" style="width:${w}%;background:${r.color}"></div></div>
            <div class="ud-dist-stat">${r.count} <span class="ud-dist-pct">${pct}%</span></div>
        </div>`;
    });

    html += `</div></div>`;

    container.innerHTML = html;
}

function switchChartMode(mode) {
    userChartMode = mode;
    renderUserDashboard();
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
                'Admin-Key': adminKey
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
                'Admin-Key': adminKey
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
                'Admin-Key': adminKey
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
                'Admin-Key': adminKey
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
async function switchUrl(urlIndex) {
    if (!confirm(`确定要切换到URL ${urlIndex + 1}吗？`)) {
        return;
    }

    try {
        const response = await fetch('/api/admin/config/url', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Admin-Key': adminKey
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
                'Admin-Key': adminKey
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
                'Admin-Key': adminKey
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
                'Admin-Key': adminKey
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
                            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
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

function displayAnnouncements(announcements) {
    const listDiv = document.getElementById('announcements-list');

    let html = '';
    announcements.forEach(ann => {
        const createTime = new Date(ann.create_time).toLocaleString('zh-CN');
        const statusClass = ann.is_active ? 'active' : 'inactive';
        const statusText = ann.is_active ? '启用' : '禁用';

        html += `
            <div class="announcement-card">
                <div class="announcement-header">
                    <h3>${ann.title}</h3>
                    <span class="announcement-status ${statusClass}">${statusText}</span>
                </div>
                <div class="announcement-content">
                    ${ann.content.replace(/\n/g, '<br>')}
                </div>
                <div class="announcement-footer">
                    <span class="announcement-time">发布时间: ${createTime}</span>
                    <div class="announcement-actions">
                        <button class="edit-btn" onclick="showEditAnnouncementModal(${ann.id}, ${JSON.stringify(ann).replace(/"/g, '&quot;')})">编辑</button>
                        <button class="delete-btn" onclick="deleteAnnouncement(${ann.id})">删除</button>
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
    currentAnnouncementId = id;
    document.getElementById('announcement-modal-title').textContent = '编辑公告';
    document.getElementById('announcement-title').value = announcement.title;
    document.getElementById('announcement-content').value = announcement.content;
    document.getElementById('announcement-active').checked = announcement.is_active;

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

    if (!title || !content) {
        showAdminToast('标题和内容不能为空', 'error');
        return;
    }

    const isEdit = currentAnnouncementId !== null;
    const url = isEdit ? `/api/admin/announcements/${currentAnnouncementId}` : '/api/admin/announcements';
    const method = isEdit ? 'PUT' : 'POST';

    try {
        const response = await fetch(url, {
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Admin-Key': adminKey
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
                'Admin-Key': adminKey
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
                'Admin-Key': adminKey
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
                            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
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

    let html = '';
    feedbacks.forEach(fb => {
        const createTime = new Date(fb.create_time).toLocaleString('zh-CN');
        const visClass = fb.visibility === 'public' ? 'active' : 'inactive';
        const visText = fb.visibility === 'public' ? '公开' : '私密';

        html += `
            <div class="announcement-card">
                <div class="announcement-header">
                    <h3>${fb.username}</h3>
                    <span class="announcement-status ${visClass}">${visText}</span>
                </div>
                <div class="announcement-content">
                    <strong style="color:var(--accent);font-size:12px;">1楼</strong>
                    <div style="margin-top:4px;">${fb.content.replace(/\n/g, '<br>')}</div>
                </div>
        `;

        // 回复楼层
        if (fb.replies && fb.replies.length > 0) {
            fb.replies.forEach((reply, index) => {
                const replyTime = new Date(reply.create_time).toLocaleString('zh-CN');
                const isAdmin = reply.username === '管理员';
                const nameColor = isAdmin ? 'var(--success)' : 'var(--text-primary)';
                html += `
                    <div style="margin-top:8px;padding:10px;background:var(--bg-secondary);border-radius:8px;${isAdmin ? 'border-left:2px solid var(--success);' : ''}">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                            <span><strong style="color:var(--accent);font-size:12px;">${index + 2}楼</strong> <span style="font-size:12px;font-weight:600;color:${nameColor};">${reply.username}</span></span>
                            <span style="font-size:11px;color:var(--text-tertiary);">${replyTime}</span>
                        </div>
                        <div style="font-size:13px;color:var(--text-secondary);line-height:1.6;">${reply.content.replace(/\n/g, '<br>')}</div>
                    </div>
                `;
            });
        }

        html += `
                <div class="announcement-footer">
                    <span class="announcement-time">${createTime}</span>
                    <div class="announcement-actions">
                        <button class="edit-btn" onclick="showFeedbackReplyModal(${fb.id}, ${JSON.stringify(fb.content).replace(/"/g, '&quot;')})">回复</button>
                        <button class="delete-btn" onclick="deleteAdminFeedback(${fb.id})">删除</button>
                    </div>
                </div>
            </div>
        `;
    });

    listDiv.innerHTML = html;
}

function showFeedbackReplyModal(feedbackId, content) {
    currentReplyFeedbackId = feedbackId;
    document.getElementById('feedback-reply-original').innerHTML =
        '<p style="color:var(--text-secondary);font-size:13px;padding:10px;background:var(--bg-secondary);border-radius:8px;margin-bottom:12px;line-height:1.6;">' +
        content.replace(/\n/g, '<br>') + '</p>';
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
                'Admin-Key': adminKey
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
                'Admin-Key': adminKey
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

// ==================== 监控功能 ====================

let monitorTimer = null;

function startMonitorRefresh() {
    stopMonitorRefresh();
    monitorTimer = setInterval(loadMonitorData, 30000);
}

function stopMonitorRefresh() {
    if (monitorTimer) {
        clearInterval(monitorTimer);
        monitorTimer = null;
    }
}

async function loadMonitorData() {
    try {
        const onlineRes = await fetch('/api/admin/monitor/online', { headers: { 'Admin-Key': adminKey } });
        const onlineData = await onlineRes.json();
        if (onlineData.success) {
            document.getElementById('online-count').textContent = onlineData.data.online_count;
            renderOnlineUsers(onlineData.data.users);
        }
    } catch (error) {
        console.error('加载监控数据失败:', error);
    }
}

function renderOnlineUsers(users) {
    const container = document.getElementById('online-users-list');
    if (!users.length) {
        container.innerHTML = '<div class="empty-state">当前无在线用户</div>';
        return;
    }

    let html = '<table class="monitor-table"><thead><tr><th>用户名</th><th>最后活跃</th><th>最后操作</th></tr></thead><tbody>';
    users.forEach(u => {
        html += `<tr>
            <td>${escapeHtml(u.username)}</td>
            <td>${u.last_active.split(' ')[1] || u.last_active}</td>
            <td>${escapeHtml(u.last_endpoint)}</td>
        </tr>`;
    });
    html += '</tbody></table>';
    container.innerHTML = html;
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
        const resp = await fetch(`/api/admin/members?username=${encodeURIComponent(username)}`, { headers: { 'Admin-Key': adminKey } });
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
        fillGrantForm(member.username, member.member_type);
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

function fillGrantForm(username, memberType) {
    document.getElementById('grant-username').value = username;
    document.getElementById('grant-type').value = memberType || 'basic';
    document.getElementById('grant-days').value = 180;
    document.getElementById('grant-member-msg').textContent = '';
}

async function handleGrantMember(event) {
    event.preventDefault();
    const username = document.getElementById('grant-username').value.trim();
    const memberType = document.getElementById('grant-type').value;
    const days = parseInt(document.getElementById('grant-days').value);
    const msgDiv = document.getElementById('grant-member-msg');
    msgDiv.className = 'member-form-msg';
    msgDiv.textContent = '\u5904\u7406\u4e2d...';
    try {
        const resp = await fetch('/api/admin/members/grant', {
            method: 'POST',
            headers: { 'Admin-Key': adminKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, member_type: memberType, days })
        });
        const data = await resp.json();
        if (data.success) {
            msgDiv.className = 'member-form-msg member-form-msg-success';
            msgDiv.textContent = data.message;
            loadAdminMembers(username);
        } else {
            msgDiv.className = 'member-form-msg member-form-msg-error';
            msgDiv.textContent = data.message || '\u64cd\u4f5c\u5931\u8d25';
        }
    } catch (e) {
        msgDiv.className = 'member-form-msg member-form-msg-error';
        msgDiv.textContent = '\u7f51\u7edc\u9519\u8bef\uff0c\u8bf7\u91cd\u8bd5';
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
            headers: { 'Admin-Key': adminKey, 'Content-Type': 'application/json' },
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
async function loadAdminWithdrawals() {
    const listDiv = document.getElementById('withdrawals-list');
    listDiv.innerHTML = '<div class="loading">加载中...</div>';
    try {
        const resp = await fetch('/api/admin/withdrawals', { headers: { 'Admin-Key': adminKey } });
        const data = await resp.json();
        if (!data.success) { listDiv.innerHTML = `<p style="color:var(--error);">${data.message || '加载失败'}</p>`; return; }
        const items = data.data;
        if (!items.length) { listDiv.innerHTML = '<p style="text-align:center;color:#888;">暂无提现申请</p>'; return; }
        const statusMap = { pending: '待审核', approved: '已通过', rejected: '已拒绝' };
        const statusClass = { pending: 'status-pending', approved: 'status-approved', rejected: 'status-rejected' };
        let html = '<div class="member-table-wrap"><table class="member-table"><thead><tr><th>申请人</th><th>收款信息</th><th>提现金额</th><th>佣金情况</th><th>状态</th><th>时间</th><th>操作</th></tr></thead><tbody>';
        for (const w of items) {
            const amount = parseFloat(w.amount) || 0;
            const earned = parseFloat(w.earned) || 0;
            const withdrawn = parseFloat(w.withdrawn) || 0;
            const availableAfter = parseFloat(w.available_after) || 0;
            html += `<tr>
                <td><div class="commission-user">${w.username}</div></td>
                <td>
                    <div class="withdraw-payee">${w.real_name}</div>
                    <div class="commission-muted">${w.alipay_account}</div>
                </td>
                <td><strong>¥${amount.toFixed(2)}</strong></td>
                <td>
                    <div class="commission-mini-grid">
                        <span>累计 ¥${earned.toFixed(2)}</span>
                        <span>已占用 ¥${withdrawn.toFixed(2)}</span>
                        <span>通过后剩 ¥${availableAfter.toFixed(2)}</span>
                    </div>
                </td>
                <td><span class="admin-status-pill ${statusClass[w.status] || ''}">${statusMap[w.status] || w.status}</span></td>
                <td>
                    <div>${w.create_time ? w.create_time.slice(0, 16) : ''}</div>
                    ${w.review_time ? `<div class="commission-muted">审核 ${w.review_time.slice(0, 16)}</div>` : ''}
                </td>
                <td>${w.status === 'pending' ? `
                    <button class="btn-sm btn-success" onclick="approveWithdrawal(${w.id})">通过</button>
                    <button class="btn-sm btn-danger" onclick="rejectWithdrawal(${w.id})">拒绝</button>
                ` : '-'}</td>
            </tr>`;
        }
        html += '</tbody></table></div>';
        listDiv.innerHTML = html;
    } catch (e) {
        listDiv.innerHTML = `<p style="color:var(--error);">${e.message || '加载失败'}</p>`;
    }
}
async function approveWithdrawal(id) {
    if (!confirm('确认审核通过？通过后需管理员手动转账。')) return;
    try {
        const resp = await fetch(`/api/admin/withdrawals/${id}/approve`, {
            method: 'POST',
            headers: { 'Admin-Key': adminKey, 'Content-Type': 'application/json' }
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
    }
}

async function rejectWithdrawal(id) {
    if (!confirm('确认拒绝该提现申请？')) return;
    try {
        const resp = await fetch(`/api/admin/withdrawals/${id}/reject`, {
            method: 'POST',
            headers: { 'Admin-Key': adminKey, 'Content-Type': 'application/json' }
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
    }
}

// ==================== 佣金统计 ====================
async function loadCommissionStats() {
    const container = document.getElementById('commission-stats');
    container.innerHTML = '<div class="loading">加载中...</div>';
    try {
        const resp = await fetch('/api/admin/commission_stats', { headers: { 'Admin-Key': adminKey } });
        const data = await resp.json();
        if (!data.success) { container.innerHTML = `<p style="color:var(--error);text-align:center;">${data.message || '加载失败'}</p>`; return; }
        const { users, summary } = data.data;
        const s = summary || {};
        let html = `<div class="commission-summary-grid">
            <div class="commission-summary-card"><div class="commission-summary-value">¥${s.total_invitee_paid || '0'}</div><div class="commission-summary-label">团队充值</div></div>
            <div class="commission-summary-card"><div class="commission-summary-value">¥${s.total_earned || '0'}</div><div class="commission-summary-label">累计佣金</div></div>
            <div class="commission-summary-card"><div class="commission-summary-value">¥${s.total_available || '0'}</div><div class="commission-summary-label">可提现</div></div>
            <div class="commission-summary-card"><div class="commission-summary-value">¥${s.total_pending || '0'}</div><div class="commission-summary-label">审核中</div></div>
        </div>`;
        if (!users.length) {
            container.innerHTML = html + '<p style="text-align:center;color:#888;">暂无返佣记录</p>';
            return;
        }
        html += '<div class="member-table-wrap"><table class="member-table"><thead><tr><th>邀请人</th><th>团队</th><th>充值额</th><th>累计佣金</th><th>已占用</th><th>可提现</th><th>最近收益</th></tr></thead><tbody>';
        for (const u of users) {
            const available = parseFloat(u.available) || 0;
            const pending = parseFloat(u.pending_withdraw) || 0;
            html += `<tr class="${available > 0 ? 'commission-row-active' : ''}">
                <td><span class="commission-user">${u.username}</span></td>
                <td>${u.invitee_count || 0} 人 / ${u.commission_count || 0} 笔${u.milestone_count ? ` / ${u.milestone_count} 个任务奖励` : ''}</td>
                <td>¥${u.invitee_paid_amount}</td>
                <td>¥${u.earned}</td>
                <td>
                    <div>¥${u.withdrawn}</div>
                    ${pending > 0 ? `<div class="commission-muted">含审核中 ¥${pending.toFixed(2)}</div>` : ''}
                </td>
                <td><strong class="commission-available">¥${u.available}</strong></td>
                <td>${u.last_earning_time ? u.last_earning_time.slice(0, 16) : '-'}</td>
            </tr>`;
        }
        html += '</tbody></table></div>';
        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = `<p style="color:var(--error);text-align:center;">${e.message || '加载失败'}</p>`;
    }
}
