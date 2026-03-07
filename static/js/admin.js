// ==================== 全局变量 ====================
let adminKey = null;  // 管理员密钥
let currentRequestId = null;  // 当前审批的请求ID

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
    // 更新标签按钮状态
    const tabBtns = document.querySelectorAll('.tab-btn');
    tabBtns.forEach(btn => btn.classList.remove('active'));
    event.target.classList.add('active');

    // 切换内容
    const tabContents = document.querySelectorAll('.tab-content');
    tabContents.forEach(content => content.classList.remove('active'));
    document.getElementById(`tab-${tabName}`).classList.add('active');

    // 加载对应数据
    if (tabName === 'pending') {
        loadPendingRequests();
    } else if (tabName === 'users') {
        loadUsers();
    } else if (tabName === 'complex') {
        loadComplexRequests();
    } else if (tabName === 'announcements') {
        loadAnnouncements();
    } else if (tabName === 'surveys') {
        loadSurveys();
    } else if (tabName === 'feedback') {
        loadAdminFeedbacks();
    } else if (tabName === 'monitor') {
        loadMonitorData();
        startMonitorRefresh();
    } else if (tabName === 'config') {
        loadConfig();
    } else if (tabName === 'members') {
        loadAdminMembers();
    }

    // 离开监控 Tab 时停止自动刷新
    if (tabName !== 'monitor') {
        stopMonitorRefresh();
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
    const overlay = document.getElementById('overlay');
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

    modal.classList.add('active');
    overlay.classList.add('active');
}

function closeApproveModal() {
    const modal = document.getElementById('approve-modal');
    const overlay = document.getElementById('overlay');

    modal.classList.remove('active');
    overlay.classList.remove('active');

    currentRequestId = null;
}

// 处理批准
async function handleApprove() {
    if (!currentRequestId) {
        alert('请求ID丢失');
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
            alert(data.message || '换绑请求已批准');
            closeApproveModal();
            loadPendingRequests();
        } else {
            alert(data.message || '操作失败');
        }
    } catch (error) {
        console.error('批准失败:', error);
        alert('网络错误，请重试');
    }
}

// 处理拒绝
async function handleReject() {
    if (!currentRequestId) {
        alert('请求ID丢失');
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
            alert('换绑请求已拒绝');
            closeApproveModal();
            loadPendingRequests();
        } else {
            alert(data.message || '操作失败');
        }
    } catch (error) {
        console.error('拒绝失败:', error);
        alert('网络错误，请重试');
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
            alert('换绑请求已拒绝');
            loadPendingRequests();
        } else {
            alert(data.message || '操作失败');
        }
    } catch (error) {
        console.error('拒绝失败:', error);
        alert('网络错误，请重试');
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
        const data = await response.json();
        if (data.success) {
            userStatsData = data;
            renderUserDashboard();
        } else {
            container.innerHTML = '<p style="text-align:center;color:var(--error);">加载失败</p>';
        }
    } catch (e) {
        container.innerHTML = '<p style="text-align:center;color:var(--error);">加载失败</p>';
    }
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

    // 填充论文 API 配置
    const paperKeyInput = document.getElementById('paper-api-key');
    const paperUrlInput = document.getElementById('paper-api-base-url');
    if (paperKeyInput) paperKeyInput.value = config.paper_api_key || '';
    if (paperUrlInput) paperUrlInput.value = config.paper_api_base_url || 'https://api.mcxhm.cn';
}

async function handleUpdatePaperApi(event) {
    event.preventDefault();
    const api_key = document.getElementById('paper-api-key').value.trim();
    const base_url = document.getElementById('paper-api-base-url').value.trim();
    if (!base_url) { alert('Base URL 不能为空'); return; }
    try {
        const resp = await fetch('/api/admin/config/paper_api', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Admin-Key': adminKey },
            body: JSON.stringify({ api_key, base_url })
        });
        const data = await resp.json();
        alert(data.message || (data.success ? '保存成功' : '保存失败'));
    } catch (e) {
        alert('网络错误，请重试');
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
            alert(data.message || 'URL切换成功');
            loadConfig();
        } else {
            alert(data.message || '切换失败');
        }
    } catch (error) {
        console.error('切换URL失败:', error);
        alert('网络错误，请重试');
    }
}

async function handleUpdateUrls(event) {
    event.preventDefault();

    const url1 = document.getElementById('url-1').value.trim();
    const url2 = document.getElementById('url-2').value.trim();

    if (!url1 || !url2) {
        alert('请填写两个URL');
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
            alert(data.message || 'URL配置已更新');
            loadConfig();
        } else {
            alert(data.message || '更新失败');
        }
    } catch (error) {
        console.error('更新URL配置失败:', error);
        alert('网络错误，请重试');
    }
}

async function handleUpdateSemester(event) {
    event.preventDefault();

    const dateStr = document.getElementById('semester-start').value;
    if (!dateStr) {
        alert('请选择日期');
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
            alert(data.message || '学期配置已更新');
        } else {
            alert(data.message || '更新失败');
        }
    } catch (error) {
        console.error('更新学期配置失败:', error);
        alert('网络错误，请重试');
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
    const overlay = document.getElementById('overlay');
    modal.classList.add('active');
    overlay.classList.add('active');
}

function showEditAnnouncementModal(id, announcement) {
    currentAnnouncementId = id;
    document.getElementById('announcement-modal-title').textContent = '编辑公告';
    document.getElementById('announcement-title').value = announcement.title;
    document.getElementById('announcement-content').value = announcement.content;
    document.getElementById('announcement-active').checked = announcement.is_active;

    const modal = document.getElementById('announcement-modal');
    const overlay = document.getElementById('overlay');
    modal.classList.add('active');
    overlay.classList.add('active');
}

function closeAnnouncementModal() {
    const modal = document.getElementById('announcement-modal');
    const overlay = document.getElementById('overlay');
    modal.classList.remove('active');
    overlay.classList.remove('active');
    currentAnnouncementId = null;
}

async function handleAnnouncementSubmit(event) {
    event.preventDefault();

    const title = document.getElementById('announcement-title').value.trim();
    const content = document.getElementById('announcement-content').value.trim();
    const isActive = document.getElementById('announcement-active').checked;

    if (!title || !content) {
        alert('标题和内容不能为空');
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
            alert(data.message || (isEdit ? '公告更新成功' : '公告发布成功'));
            closeAnnouncementModal();
            loadAnnouncements();
        } else {
            alert(data.message || '操作失败');
        }
    } catch (error) {
        console.error('保存公告失败:', error);
        alert('网络错误，请重试');
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
            alert('公告删除成功');
            loadAnnouncements();
        } else {
            alert(data.message || '删除失败');
        }
    } catch (error) {
        console.error('删除公告失败:', error);
        alert('网络错误，请重试');
    }
}

// ==================== 问卷管理 ====================
let currentSurveyId = null;

async function loadSurveys() {
    const listDiv = document.getElementById('surveys-list');
    listDiv.innerHTML = '<div class="loading">加载中...</div>';

    try {
        const response = await fetch('/api/admin/surveys', {
            headers: {
                'Admin-Key': adminKey
            }
        });

        const data = await response.json();

        if (data.success) {
            if (data.surveys && data.surveys.length > 0) {
                displaySurveys(data.surveys);
            } else {
                listDiv.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-state-icon">
                            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
                        </div>
                        <div class="empty-state-text">暂无问卷</div>
                    </div>
                `;
            }
        } else {
            listDiv.innerHTML = '<p style="text-align:center;color:var(--error);">加载失败</p>';
        }
    } catch (error) {
        console.error('加载问卷失败:', error);
        listDiv.innerHTML = '<p style="text-align:center;color:var(--error);">加载失败</p>';
    }
}

function displaySurveys(surveys) {
    const listDiv = document.getElementById('surveys-list');

    let html = '';
    surveys.forEach(survey => {
        const createTime = new Date(survey.create_time).toLocaleString('zh-CN');
        const statusClass = survey.is_active ? 'active' : 'inactive';
        const statusText = survey.is_active ? '启用' : '禁用';

        html += `
            <div class="announcement-card">
                <div class="announcement-header">
                    <h3>${survey.title}</h3>
                    <span class="announcement-status ${statusClass}">${statusText}</span>
                </div>
                <div class="announcement-content">
                    <a href="${survey.url}" target="_blank" style="color:var(--primary);word-break:break-all;">${survey.url}</a>
                </div>
                <div class="announcement-footer">
                    <span class="announcement-time">发布时间: ${createTime}</span>
                    <div class="announcement-actions">
                        <button class="edit-btn" onclick="showEditSurveyModal(${survey.id}, ${JSON.stringify(survey).replace(/"/g, '&quot;')})">编辑</button>
                        <button class="delete-btn" onclick="deleteSurvey(${survey.id})">删除</button>
                    </div>
                </div>
            </div>
        `;
    });

    listDiv.innerHTML = html;
}

function showCreateSurveyModal() {
    currentSurveyId = null;
    document.getElementById('survey-modal-title').textContent = '发布新问卷';
    document.getElementById('survey-title').value = '';
    document.getElementById('survey-url').value = '';
    document.getElementById('survey-active').checked = true;

    const modal = document.getElementById('survey-modal');
    const overlay = document.getElementById('overlay');
    modal.classList.add('active');
    overlay.classList.add('active');
}

function showEditSurveyModal(id, survey) {
    currentSurveyId = id;
    document.getElementById('survey-modal-title').textContent = '编辑问卷';
    document.getElementById('survey-title').value = survey.title;
    document.getElementById('survey-url').value = survey.url;
    document.getElementById('survey-active').checked = survey.is_active;

    const modal = document.getElementById('survey-modal');
    const overlay = document.getElementById('overlay');
    modal.classList.add('active');
    overlay.classList.add('active');
}

function closeSurveyModal() {
    const modal = document.getElementById('survey-modal');
    const overlay = document.getElementById('overlay');
    modal.classList.remove('active');
    overlay.classList.remove('active');
    currentSurveyId = null;
}

async function handleSurveySubmit(event) {
    event.preventDefault();

    const title = document.getElementById('survey-title').value.trim();
    const url = document.getElementById('survey-url').value.trim();
    const isActive = document.getElementById('survey-active').checked;

    if (!title || !url) {
        alert('标题和链接不能为空');
        return;
    }

    const isEdit = currentSurveyId !== null;
    const apiUrl = isEdit ? `/api/admin/surveys/${currentSurveyId}` : '/api/admin/surveys';
    const method = isEdit ? 'PUT' : 'POST';

    try {
        const response = await fetch(apiUrl, {
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Admin-Key': adminKey
            },
            body: JSON.stringify({
                title: title,
                url: url,
                is_active: isActive
            })
        });

        const data = await response.json();

        if (data.success) {
            alert(data.message || (isEdit ? '问卷更新成功' : '问卷发布成功'));
            closeSurveyModal();
            loadSurveys();
        } else {
            alert(data.message || '操作失败');
        }
    } catch (error) {
        console.error('保存问卷失败:', error);
        alert('网络错误，请重试');
    }
}

async function deleteSurvey(id) {
    if (!confirm('确定要删除这条问卷吗？')) {
        return;
    }

    try {
        const response = await fetch(`/api/admin/surveys/${id}`, {
            method: 'DELETE',
            headers: {
                'Admin-Key': adminKey
            }
        });

        const data = await response.json();

        if (data.success) {
            alert('问卷删除成功');
            loadSurveys();
        } else {
            alert(data.message || '删除失败');
        }
    } catch (error) {
        console.error('删除问卷失败:', error);
        alert('网络错误，请重试');
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
    const overlay = document.getElementById('overlay');
    modal.classList.add('active');
    overlay.classList.add('active');
}

function closeFeedbackReplyModal() {
    const modal = document.getElementById('feedback-reply-modal');
    const overlay = document.getElementById('overlay');
    modal.classList.remove('active');
    overlay.classList.remove('active');
    currentReplyFeedbackId = null;
}

async function handleFeedbackReplySubmit(event) {
    event.preventDefault();

    const content = document.getElementById('feedback-reply-content').value.trim();

    if (!content) {
        alert('回复内容不能为空');
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
            alert('回复成功');
            closeFeedbackReplyModal();
            loadAdminFeedbacks();
        } else {
            alert(data.message || '回复失败');
        }
    } catch (error) {
        console.error('回复反馈失败:', error);
        alert('网络错误，请重试');
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
            alert('反馈删除成功');
            loadAdminFeedbacks();
        } else {
            alert(data.message || '删除失败');
        }
    } catch (error) {
        console.error('删除反馈失败:', error);
        alert('网络错误，请重试');
    }
}

// ==================== 复杂论文需求管理 ====================
let pendingCompleteAction = null;
let selectedFinishFile = null;

async function loadComplexRequests() {
    const listDiv = document.getElementById('complex-list');
    listDiv.innerHTML = '<div class="loading">加载中...</div>';

    try {
        const response = await fetch('/api/admin/complex_requests', {
            headers: {
                'X-Admin-Key': adminKey
            }
        });

        const data = await response.json();

        if (data.success) {
            const requests = data.requests;

            // 更新统计
            const total = requests.length;
            const completed = requests.filter(r => r.finish_file).length;
            const pending = total - completed;

            document.getElementById('complex-total').textContent = total;
            document.getElementById('complex-pending').textContent = pending;
            document.getElementById('complex-completed').textContent = completed;

            if (requests.length === 0) {
                listDiv.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-state-icon">
                            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
                        </div>
                        <div class="empty-state-text">暂无论文需求</div>
                    </div>
                `;
            } else {
                displayComplexRequests(requests);
            }
        } else {
            listDiv.innerHTML = '<p style="text-align:center;color:var(--error);">加载失败</p>';
        }
    } catch (error) {
        console.error('加载复杂需求失败:', error);
        listDiv.innerHTML = '<p style="text-align:center;color:var(--error);">加载失败</p>';
    }
}

function displayComplexRequests(requests) {
    const listDiv = document.getElementById('complex-list');

    let html = '';
    requests.forEach(req => {
        const date = new Date(req.created_at);
        const dateStr = date.toLocaleDateString('zh-CN') + ' ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        const isCompleted = !!req.finish_file;
        const hasFeedback = req.feedback_history && req.feedback_history.length > 0;
        const statusClass = isCompleted ? 'active' : 'inactive';
        let statusText = isCompleted ? '已完成' : '待处理';
        if (!isCompleted && hasFeedback) {
            statusText = '待修改';
        }

        const downloadAttachBtn = req.file
            ? `<button class="edit-btn" onclick="downloadComplexAttachment('${req.username}', '${req.id}')">下载附件</button>`
            : '';

        const completeBtn = isCompleted
            ? `<button class="edit-btn" disabled style="opacity:0.5;">已完成</button>`
            : `<button class="approve-btn" onclick="showCompleteModal('${req.username}', '${req.id}', '${escapeHtmlAttr(req.title)}')">标记完成</button>`;

        const requirementsPreview = req.requirements
            ? `<div class="complex-requirements">${escapeHtml(req.requirements.substring(0, 200))}${req.requirements.length > 200 ? '...' : ''}</div>`
            : '';

        // 显示最新的反馈意见
        let feedbackSection = '';
        if (hasFeedback) {
            const latestFeedback = req.feedback_history[req.feedback_history.length - 1];
            const feedbackDate = new Date(latestFeedback.submitted_at);
            const feedbackDateStr = feedbackDate.toLocaleDateString('zh-CN') + ' ' + feedbackDate.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
            feedbackSection = `
                <div class="feedback-section">
                    <div class="feedback-header">用户反馈 (${feedbackDateStr}) - 共${req.feedback_history.length}次反馈</div>
                    <div class="feedback-content">${escapeHtml(latestFeedback.feedback)}</div>
                </div>
            `;
        }

        html += `
            <div class="announcement-card">
                <div class="announcement-header">
                    <h3>${escapeHtml(req.title)}</h3>
                    <span class="announcement-status ${statusClass}">${statusText}</span>
                </div>
                <div class="complex-meta">
                    <span>${req.username}</span>
                    <span>${dateStr}</span>
                    ${req.file ? '<span>附件</span>' : ''}
                    ${hasFeedback ? '<span style="color:var(--warning);">有反馈</span>' : ''}
                </div>
                ${requirementsPreview}
                ${feedbackSection}
                <div class="announcement-footer">
                    <span class="announcement-time">请求ID: ${req.id}</span>
                    <div class="announcement-actions">
                        ${downloadAttachBtn}
                        ${completeBtn}
                    </div>
                </div>
            </div>
        `;
    });

    listDiv.innerHTML = html;
}

function downloadComplexAttachment(username, requestId) {
    window.open(`/api/admin/download_attachment?username=${username}&request_id=${requestId}&key=${adminKey}`, '_blank');
}

function showCompleteModal(username, requestId, title) {
    pendingCompleteAction = { username, requestId };
    selectedFinishFile = null;

    const modal = document.getElementById('complete-modal');
    const overlay = document.getElementById('overlay');
    const detailsDiv = document.getElementById('complete-details');

    detailsDiv.innerHTML = `
        <div class="detail-row">
            <span class="detail-label">论文标题:</span>
            <span class="detail-value">${title}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">用户:</span>
            <span class="detail-value">${username}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">请求ID:</span>
            <span class="detail-value" style="font-family:monospace;font-size:12px;">${requestId}</span>
        </div>
    `;

    // 重置文件输入
    document.getElementById('finish-file-input').value = '';
    document.getElementById('finish-file-info').style.display = 'none';

    modal.classList.add('active');
    overlay.classList.add('active');
}

function handleFinishFileSelect(event) {
    const file = event.target.files[0];
    if (file) {
        selectedFinishFile = file;
        const fileInfo = document.getElementById('finish-file-info');
        fileInfo.style.display = 'flex';
        fileInfo.innerHTML = `
            <span class="uploaded-file-name" style="color:var(--success);">${file.name}</span>
            <button class="uploaded-file-remove" onclick="removeFinishFile()">移除</button>
        `;
    }
}

function removeFinishFile() {
    selectedFinishFile = null;
    document.getElementById('finish-file-input').value = '';
    document.getElementById('finish-file-info').style.display = 'none';
}

function closeCompleteModal() {
    const modal = document.getElementById('complete-modal');
    const overlay = document.getElementById('overlay');
    modal.classList.remove('active');
    overlay.classList.remove('active');
    pendingCompleteAction = null;
    selectedFinishFile = null;
    document.getElementById('finish-file-input').value = '';
    document.getElementById('finish-file-info').style.display = 'none';
}

async function confirmUploadAndComplete() {
    if (!pendingCompleteAction) return;

    if (!selectedFinishFile) {
        alert('请选择要上传的论文文件');
        return;
    }

    const btn = document.getElementById('confirm-complete-btn');
    btn.disabled = true;
    btn.textContent = '上传中...';

    try {
        const formData = new FormData();
        formData.append('file', selectedFinishFile);
        formData.append('username', pendingCompleteAction.username);
        formData.append('request_id', pendingCompleteAction.requestId);

        const response = await fetch('/api/admin/upload_finish_file', {
            method: 'POST',
            headers: {
                'X-Admin-Key': adminKey
            },
            body: formData
        });

        const data = await response.json();

        if (data.success) {
            alert('上传成功，已标记为完成');
            closeCompleteModal();
            loadComplexRequests();
        } else {
            alert(data.message || '上传失败');
        }
    } catch (error) {
        console.error('上传失败:', error);
        alert('网络错误，请重试');
    } finally {
        btn.disabled = false;
        btn.textContent = '上传并标记完成';
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
async function loadAdminMembers() {
    const listDiv = document.getElementById('members-list');
    listDiv.innerHTML = '<div class="loading">加载中</div>';
    try {
        const resp = await fetch('/api/admin/members', { headers: { 'Admin-Key': adminKey } });
        const data = await resp.json();
        if (!data.success) { listDiv.innerHTML = '<p style="color:var(--error);">加载失败</p>'; return; }
        const members = data.data;
        if (!members.length) { listDiv.innerHTML = '<p style="text-align:center;color:#888;">暂无会员</p>'; return; }
        const typeMap = { basic: '初级会员', advanced: '高级会员' };
        let html = '<div class="member-table-wrap"><table class="member-table"><thead><tr><th>学号</th><th>类型</th><th>到期时间</th><th>开通时间</th><th>状态</th><th>操作</th></tr></thead><tbody>';
        const now = new Date();
        for (const m of members) {
            const expire = new Date(m.expire_time);
            const valid = expire > now;
            const statusHtml = valid
                ? `<span class="member-status-valid">有效</span>`
                : `<span class="member-status-expired">已过期</span>`;
            html += `<tr>
                <td><span class="member-username-link" onclick="fillGrantForm('${m.username}','${m.member_type}')">${m.username}</span></td>
                <td>${typeMap[m.member_type] || m.member_type}</td>
                <td>${m.expire_time ? m.expire_time.slice(0,10) : '-'}</td>
                <td>${m.create_time ? m.create_time.slice(0,10) : '-'}</td>
                <td>${statusHtml}</td>
                <td>
                    <button class="btn-sm btn-danger" onclick="revokeMember('${m.username}')">撤销</button>
                </td>
            </tr>`;
        }
        html += '</tbody></table></div>';
        listDiv.innerHTML = html;
    } catch (e) {
        listDiv.innerHTML = '<p style="color:var(--error);">加载失败</p>';
    }
}

function fillGrantForm(username, memberType) {
    document.getElementById('grant-username').value = username;
    document.getElementById('grant-type').value = memberType;
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
    msgDiv.textContent = '处理中...';
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
            loadAdminMembers();
        } else {
            msgDiv.className = 'member-form-msg member-form-msg-error';
            msgDiv.textContent = data.message || '操作失败';
        }
    } catch (e) {
        msgDiv.className = 'member-form-msg member-form-msg-error';
        msgDiv.textContent = '网络错误，请重试';
    }
}

async function handleRevokeMember() {
    const username = document.getElementById('grant-username').value.trim();
    const msgDiv = document.getElementById('grant-member-msg');
    if (!username) {
        msgDiv.className = 'member-form-msg member-form-msg-error';
        msgDiv.textContent = '请先输入学号';
        return;
    }
    await revokeMember(username);
}

async function revokeMember(username) {
    if (!confirm(`确定要撤销 ${username} 的会员资格吗？`)) return;
    const listDiv = document.getElementById('members-list');
    try {
        const resp = await fetch('/api/admin/members/revoke', {
            method: 'POST',
            headers: { 'Admin-Key': adminKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ username })
        });
        const data = await resp.json();
        if (data.success) {
            loadAdminMembers();
        } else {
            alert(data.message || '撤销失败');
        }
    } catch (e) {
        alert('网络错误，请重试');
    }
}
