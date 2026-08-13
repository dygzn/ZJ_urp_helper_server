// ==================== 全局变量 ====================
let currentWeek = parseInt(localStorage.getItem('current_week')) || 1;
let currentUsername = null;
let isCheckingLoginStatus = false;
let cachedSchedule = null;
let semesterStart = null;   // 学期第1周星期一的日期
let isGuestMode = false;    // 访客模式（未绑定账号）

// ==================== 防止双击放大 ====================
let lastTouchEnd = 0;
document.addEventListener('touchend', function(event) {
    const now = Date.now();
    if (now - lastTouchEnd <= 300) {
        event.preventDefault();
    }
    lastTouchEnd = now;
}, false);

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
    try {
        const response = await fetch('/api/check_bind', {
            headers: {
                'X-Device-ID': getDeviceId()
            }
        });
        const data = await response.json();

        if (data.rebind_notifications && data.rebind_notifications.length > 0) {
            showRebindNotifications(data.rebind_notifications);
        }

        if (data.success && data.bound) {
            currentUsername = data.username;
            document.getElementById('sidebar-username').textContent = currentUsername;

            const urlPage = new URLSearchParams(window.location.search).get('page');
            let lastPage = urlPage || localStorage.getItem('current_page') || 'home';
            if (lastPage === 'tools') lastPage = 'home';
            switchPage(lastPage);
            loadAndShowAnnouncements();
        } else {
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
    modal.classList.add('active');
}

function hideLoginModal() {
    const modal = document.getElementById('login-modal');
    modal.classList.remove('active');
}

function skipBind() {
    isGuestMode = true;
    hideLoginModal();
    document.getElementById('sidebar-username').textContent = '访客';
    switchPage('home');
    loadAndShowAnnouncements();
}

async function handleLogin(event) {
    event.preventDefault();

    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const inviterInput = document.getElementById('inviter');
    const inviter = inviterInput ? inviterInput.value.trim() : '';
    const errorDiv = document.getElementById('login-error');

    errorDiv.textContent = '';

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Device-ID': getDeviceId()
            },
            body: JSON.stringify({ username, password, inviter })
        });

        const data = await response.json();

        if (data.success) {
            currentUsername = data.username;
            document.getElementById('sidebar-username').textContent = currentUsername;
            hideLoginModal();
            loadUrgentEvent();
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
    if (!confirm('确定要解绑当前账号并重新绑定吗？解绑后需要重新输入新账号密码。')) {
        return;
    }
    await unbindForRebind();
}

function closeRebindDialog() {
    const modal = document.getElementById('rebind-modal');
    modal.classList.remove('active');
    document.getElementById('overlay').classList.remove('active');
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
            else alert(data.message || '解绑失败');
            return;
        }

        currentUsername = null;
        isGuestMode = false;
        document.getElementById('sidebar-username').textContent = '未绑定';
        closeRebindDialog();
        showLoginModal();
        alert(data.message || '当前设备已解绑，请重新绑定新账号');
    } catch (error) {
        console.error('解绑失败:', error);
        if (errorDiv) errorDiv.textContent = '网络错误，请重试';
        else alert('网络错误，请重试');
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
    alert(messages.join('\n'));

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
    document.getElementById('sidebar').classList.add('active');
    document.getElementById('overlay').classList.add('active');
}

function closeSidebar() {
    document.getElementById('sidebar').classList.remove('active');
    document.getElementById('overlay').classList.remove('active');
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

function switchPage(pageName) {
    // 隐藏所有页面
    const pages = document.querySelectorAll('.page');
    pages.forEach(page => page.classList.remove('active'));

    // 显示目标页面
    const targetPage = document.getElementById(`page-${pageName}`);
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
        'member': '会员购买',
    };
    document.getElementById('page-title').textContent = titles[pageName] || '首页';

    // 更新导航项激活状态
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(nav => {
        if (nav.getAttribute('data-page') === pageName) {
            nav.classList.add('active');
        } else {
            nav.classList.remove('active');
        }
    });

    // 保存当前页面到 localStorage
    localStorage.setItem('current_page', pageName);

    // 加载对应页面的数据
    loadPageData(pageName);
}

function loadPageData(pageName) {
    const needsBind = ['schedule', 'exams', 'grades', 'evaluation'];
    if (isGuestMode && needsBind.includes(pageName)) {
        const pages = {
            'schedule': '课程表', 'exams': '考试安排', 'grades': '成绩查询',
            'evaluation': '教务评价'
        };
        const targetPage = document.getElementById(`page-${pageName}`);
        if (targetPage) {
            targetPage.innerHTML = `
                <div class="card" style="text-align:center;padding:40px 20px;">
                    <p style="color:var(--text-secondary);margin-bottom:16px;">${pages[pageName]}需要绑定教务账号</p>
                    <button class="btn-primary" onclick="showLoginModal()">立即绑定</button>
                </div>`;
        }
        return;
    }
    switch(pageName) {
        case 'home':
            loadUrgentEvent();
            break;
        case 'schedule':
            // 课程表页面自动加载
            loadSchedule();
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

document.addEventListener('keydown', function(event) {
    if (event.key !== 'Escape') return;

    const trigger = document.getElementById('service-contact-trigger');
    const popover = document.getElementById('service-contact-popover');
    if (!trigger || !popover || popover.hidden) return;

    setServiceContactPopoverOpen(
        ServiceStatusUI.nextContactPopoverState(true, 'escape'),
    );
    trigger.focus();
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
    // 后台检查登录状态（不阻塞日程加载）
    checkLoginStatus();

    const contentDiv = document.getElementById('urgent-content');

    if (isGuestMode) {
        contentDiv.innerHTML = '<p style="text-align:center;color:var(--text-secondary);">绑定教务账号后可查看今日课程和考试安排</p>';
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

        if (data.success && data.event) {
            updateScheduleTimeline(data.event.is_freshman);
            displayUrgentEvent(data.event);
        } else if (data.success) {
            updateScheduleTimeline(data.is_freshman);
            contentDiv.innerHTML = '<p style="text-align:center;color:var(--text-tertiary);">今天没有课程和考试，好好休息吧~</p>';
        } else {
            contentDiv.innerHTML = '<p style="text-align:center;color:var(--text-tertiary);">今天没有课程和考试，好好休息吧~</p>';
        }
    } catch (error) {
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

function updateScheduleTimeline(isFreshman) {
    userIsFreshman = !!isFreshman;
    const times = isFreshman ? PERIOD_TIMES_FRESHMAN : PERIOD_TIMES_DEFAULT;
    document.querySelectorAll('.timeline-item').forEach((item, i) => {
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
    const todayStr = now.toISOString().split('T')[0];

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
        const eventDate = new Date(datePart + 'T00:00:00');
        const todayDate = new Date(todayStr + 'T00:00:00');
        const diffDays = Math.round((eventDate - todayDate) / 86400000);
        const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        const dayName = dayNames[eventDate.getDay()];

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
        const dow = now.getDay();
        const nextDiffDays = nextDateStr
            ? Math.round((new Date(nextDateStr + 'T00:00:00') - new Date(todayStr + 'T00:00:00')) / 86400000)
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

async function showOtherMajorModal() {
    const modal = document.getElementById('other-major-modal');
    const overlay = document.getElementById('overlay');
    const body = document.getElementById('other-major-modal-body');

    modal.classList.add('active');
    overlay.classList.add('active');

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
    document.getElementById('other-major-modal').classList.remove('active');
    document.getElementById('overlay').classList.remove('active');
}

async function loadOtherMajorSchedule() {
    const { grade, major, class_num } = omSelected;
    if (!grade || !major || !class_num) return;

    closeOtherMajorModal();

    const scheduleMsg = document.getElementById('schedule-message');
    scheduleMsg.style.display = 'block';
    scheduleMsg.textContent = '加载中...';

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
        scheduleMsg.innerHTML = `${grade}级 专业${major} ${class_num}班（仅课程名与时间）&emsp;<button class="btn-secondary btn-sm" onclick="backToMySchedule()">返回我的课表</button>`;
        displaySchedule({ [currentWeek]: otherMajorScheduleData[String(currentWeek)] || [] });
    } catch (e) {
        scheduleMsg.textContent = '加载失败，请重试';
    }
}

function backToMySchedule() {
    otherMajorScheduleData = null;
    document.getElementById('schedule-message').style.display = 'none';
    if (cachedSchedule) {
        displaySchedule({ [currentWeek]: cachedSchedule[String(currentWeek)] || [] });
    } else {
        loadSchedule(currentWeek);
    }
}

// 更新课程表数据（从服务器获取最新数据）
async function updateScheduleData() {
    const btn = event.target;
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

        if (data.success) {
            alert('课程表更新成功');
            cachedSchedule = null;  // 清除缓存，重新拉取
            // 重新加载课程表
            loadSchedule();
        } else {
            alert(data.message || '更新失败');
        }
    } catch (error) {
        console.error('更新课程表失败:', error);
        alert('更新课程表失败，学校可能暂未开放课表查询');
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

function resetScheduleDisplay() {
    const scheduleDays = document.getElementById('schedule-days');
    const scheduleGrid = document.querySelector('.schedule-grid');
    const scheduleHeader = document.querySelector('.schedule-header');

    scheduleDays.innerHTML = '';
    scheduleGrid.classList.remove('has-evening');
    setScheduleWeekendVisibility(false, scheduleGrid, scheduleHeader);
}

async function loadSchedule(week = null, autoFetched = false) {
    const messageDiv = document.getElementById('schedule-message');

    // 根据学期开始日期算出实际当前周
    function calcActualWeek() {
        if (!semesterStart) return null;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const diffDays = Math.floor((today - semesterStart) / (1000 * 60 * 60 * 24));
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

        if (data.success && data.data) {
            const schedule = data.data.schedule || {};
            const hasData = Object.keys(schedule).length > 0;

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
                    if (updateData.success) {
                        loadSchedule(week, true);
                        return;
                    } else {
                        showMessage(updateData.message || '获取课表失败', true);
                    }
                } catch (e) {
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
        console.error('加载课程表失败:', error);
        resetScheduleDisplay();
        showMessage('加载失败，请检查网络连接', true);
    }
}

function displaySchedule(schedule) {
    const scheduleDays = document.getElementById('schedule-days');
    const scheduleGrid = document.querySelector('.schedule-grid');

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
                    if (section >= 9) hasEvening = true;
                    daysCourses[dayNum].push({
                        code: course['课程号'] || '',
                        name: course['课程名'],
                        credit: course['学分'] || '',
                        teacher: course['教师'] || '',
                        section: section,
                        duration: duration,
                        location: location,
                        campus: course['校区'] || '',
                        building: course['教学楼'] || '',
                        room: course['教室'] || ''
                    });
                }
            });
        }
    });

    // 检测是否是手机端
    const isMobile = window.innerWidth <= 768;
    const sectionHeight = isMobile ? 56 : 76;
    const gap = isMobile ? 3 : 6;

    // 检测周末是否有课
    const hasWeekend = daysCourses[6].length > 0 || daysCourses[7].length > 0;

    // 生成课程卡片HTML
    let html = '';
    for (let day = 1; day <= 7; day++) {
        const weekendClass = day >= 6 ? ' schedule-day-weekend' : '';
        html += `<div class="schedule-day-column${weekendClass}">`;

        const courses = daysCourses[day];
        courses.forEach((course, index) => {
            // 计算卡片位置和高度
            const top = (course.section - 1) * (sectionHeight + gap);
            const height = course.duration * sectionHeight + (course.duration - 1) * gap;

            // 为课程分配颜色（基于课程名称的哈希值）
            const colorIndex = getColorIndex(course.name);

            const dayNames = ['', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
            const courseData = encodeURIComponent(JSON.stringify({
                code: course.code,
                name: course.name,
                credit: course.credit,
                teacher: course.teacher,
                day: dayNames[day] || `星期${day}`,
                section: course.section,
                duration: course.duration,
                campus: course.campus,
                building: course.building,
                room: course.room,
                location: course.location
            }));

            html += `
                <div class="course-card course-card-color-${colorIndex}"
                     style="position: absolute; top: ${top}px; height: ${height}px; left: 0; right: 0;"
                     data-course="${courseData}"
                     onclick="showCourseDetail(this)">
                    <div class="course-card-name">${course.name}</div>
                    ${course.location ? `<div class="course-card-location">${course.location}</div>` : ''}
                </div>
            `;
        });

        html += '</div>';
    }

    scheduleDays.innerHTML = html;
    scheduleGrid.classList.toggle('has-evening', hasEvening);
    setScheduleWeekendVisibility(
        hasWeekend,
        scheduleGrid,
        document.querySelector('.schedule-header'),
    );
    updateScheduleTimeline(userIsFreshman);
}

// 根据课程名称生成颜色索引
function getColorIndex(courseName) {
    let hash = 5381;
    for (let i = 0; i < courseName.length; i++) {
        hash = ((hash << 5) + hash) ^ courseName.charCodeAt(i);
    }
    return Math.abs(hash) % 15; // 15种颜色
}

function showCourseDetail(el) {
    const course = JSON.parse(decodeURIComponent(el.dataset.course));
    const modal = document.getElementById('course-detail-modal');
    const endSection = course.section + course.duration - 1;

    document.getElementById('course-detail-name').textContent = course.name;
    document.getElementById('course-detail-body').innerHTML = `
        ${course.code ? `<div class="course-detail-row"><span class="course-detail-label">课程号</span><span>${course.code}</span></div>` : ''}
        ${course.teacher ? `<div class="course-detail-row"><span class="course-detail-label">教师</span><span>${course.teacher}</span></div>` : ''}
        ${course.credit ? `<div class="course-detail-row"><span class="course-detail-label">学分</span><span>${course.credit}</span></div>` : ''}
        <div class="course-detail-row"><span class="course-detail-label">时间</span><span>${course.day} 第${course.section}-${endSection}节</span></div>
        ${course.location ? `<div class="course-detail-row"><span class="course-detail-label">地点</span><span>${course.location}</span></div>` : ''}
        ${course.campus ? `<div class="course-detail-row"><span class="course-detail-label">校区</span><span>${course.campus}</span></div>` : ''}
        ${course.building ? `<div class="course-detail-row"><span class="course-detail-label">教学楼</span><span>${course.building}</span></div>` : ''}
        ${course.room ? `<div class="course-detail-row"><span class="course-detail-label">教室</span><span>${course.room}</span></div>` : ''}
    `;

    modal.classList.add('active');
}

function closeCourseDetail() {
    document.getElementById('course-detail-modal').classList.remove('active');
}

function changeWeek(delta) {
    const newWeek = currentWeek + delta;
    if (newWeek >= 1 && newWeek <= 25) {
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

    if (!semesterStart) return;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let day = 1; day <= 7; day++) {
        const dateEl = document.getElementById(`schedule-date-${day}`);
        const dayEl = document.getElementById(`schedule-day-${day}`);
        if (!dateEl) continue;

        const date = new Date(semesterStart);
        date.setDate(date.getDate() + (week - 1) * 7 + (day - 1));

        const m = date.getMonth() + 1;
        const d = date.getDate();
        dateEl.textContent = `${m}月${d}日`;

        // 高亮今天
        if (dayEl) {
            dayEl.classList.toggle('schedule-day-today', date.getTime() === today.getTime());
        }
    }
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
async function updateExamsData() {
    const btn = event.target;
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

        if (data.success) {
            alert('考试安排更新成功');
            // 重新加载考试安排
            loadExams();
        } else {
            alert(data.message || '更新失败');
        }
    } catch (error) {
        console.error('更新考试安排失败:', error);
        alert('更新考试安排失败，学校可能暂未开放考试查询');
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

async function loadExams(autoFetched = false) {
    const contentDiv = document.getElementById('exams-content');
    contentDiv.innerHTML = '<div class="loading">加载中</div>';

    try {
        const response = await fetch('/api/exams', {
            headers: {
                'X-Device-ID': getDeviceId()
            }
        });
        const data = await response.json();

        if (data.success && data.exams && data.exams.length > 0) {
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
                if (updateData.success) {
                    loadExams(true);
                    return;
                } else {
                    contentDiv.innerHTML = `<p style="text-align:center;color:var(--error);">${updateData.message || '获取考试安排失败'}</p>`;
                }
            } catch (e) {
                contentDiv.innerHTML = '<p style="text-align:center;color:var(--error);">获取考试安排失败，学校可能暂未开放查询</p>';
            }
        } else {
            contentDiv.innerHTML = '<p style="text-align:center;color:var(--text-tertiary);">暂无考试安排</p>';
        }
    } catch (error) {
        console.error('加载考试安排失败:', error);
        contentDiv.innerHTML = '<p style="text-align:center;color:var(--error);">加载失败</p>';
    }
}

function displayExams(exams) {
    const contentDiv = document.getElementById('exams-content');

    // 按考试名分组
    const examGroups = {};
    exams.forEach(exam => {
        const examName = exam.exam_name || '其他考试';
        if (!examGroups[examName]) {
            examGroups[examName] = [];
        }
        examGroups[examName].push(exam);
    });

    let html = '';

    // 遍历每个考试分组
    Object.keys(examGroups).forEach(examName => {
        const examList = examGroups[examName];

        html += `
            <div class="exam-group">
                <div class="exam-group-title">${examName}</div>
                <div class="exam-group-content">
        `;

        // 显示该考试下的所有课程
        examList.forEach(exam => {
            // 构建完整的考试时间信息
            let timeInfo = '';
            if (exam.week && exam.day) {
                const dayNames = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
                const dayName = dayNames[parseInt(exam.day)] || `星期${exam.day}`;
                timeInfo = `第${exam.week}周 ${dayName} ${exam.time}`;
            } else {
                timeInfo = exam.time;
            }

            // 计算倒计时和紧急程度
            let urgencyClass = 'exam-normal';
            let countdownHtml = '';
            if (exam.date) {
                const examDate = new Date(exam.date);
                const now = new Date();
                const diffDays = Math.ceil((examDate - now) / (1000 * 60 * 60 * 24));
                if (diffDays <= 3 && diffDays >= 0) {
                    urgencyClass = 'exam-urgent';
                    countdownHtml = `<div class="exam-countdown" style="color:var(--error);">${diffDays}天后考试</div>`;
                } else if (diffDays <= 7 && diffDays > 3) {
                    urgencyClass = 'exam-soon';
                    countdownHtml = `<div class="exam-countdown" style="color:var(--warning);">${diffDays}天后考试</div>`;
                } else if (diffDays > 7) {
                    countdownHtml = `<div class="exam-countdown" style="color:var(--accent);">${diffDays}天后考试</div>`;
                }
            }

            html += `
                <div class="exam-card ${urgencyClass}">
                    <div class="exam-course">${exam.course}</div>
                    <div class="exam-info">
                        <div class="exam-info-item">
                            <strong>考试时间:</strong> ${timeInfo}
                        </div>
                        <div class="exam-info-item">
                            <strong>考场:</strong> ${exam.location}
                        </div>
                        <div class="exam-info-item">
                            <strong>座位号:</strong> ${exam.seat}
                        </div>
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

// ==================== 成绩查询相关 ====================

function gradesBackToMenu() {
    document.getElementById('grades-menu').style.display = '';
    document.getElementById('grades-result').style.display = 'none';
}

function gradesShowResult(title) {
    document.getElementById('grades-menu').style.display = 'none';
    document.getElementById('grades-result').style.display = '';
    document.getElementById('grades-result-title').textContent = title;
    document.getElementById('grades-content').innerHTML = '<div class="loading">加载中</div>';
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
    const overlay = document.getElementById('overlay');
    const list = document.getElementById('semester-picker-list');
    list.innerHTML = '<div class="loading">加载中...</div>';
    modal.classList.add('active');
    overlay.classList.add('active');
    try {
        const resp = await fetch('/api/grades/semesters', { headers: { 'X-Device-ID': getDeviceId() } });
        const data = await resp.json();
        if (!data.success || !data.semesters.length) {
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
    document.getElementById('semester-picker-modal').classList.remove('active');
    document.getElementById('overlay').classList.remove('active');
}

async function gradesPickSemester(semester) {
    closeSemesterPicker();
    gradesShowResult(`及格成绩（${semester}）`);
    try {
        const resp = await fetch(`/api/grades/by_semester?semester=${encodeURIComponent(semester)}`, { headers: { 'X-Device-ID': getDeviceId() } });
        const data = await resp.json();
        if (data.success && data.grades && data.grades.length > 0) {
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
            document.getElementById('grades-content').innerHTML = '<p style="text-align:center;color:var(--error);">加载失败</p>';
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
    const overlay = document.getElementById('overlay');
    modal.classList.add('active');
    overlay.classList.add('active');
    document.getElementById('exam-picker-title').textContent = '选择学期';
    const body = document.getElementById('exam-picker-body');
    body.innerHTML = '<div class="loading">加载中...</div>';

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
    document.getElementById('exam-picker-modal').classList.remove('active');
    document.getElementById('overlay').classList.remove('active');
}

// 切换到成绩页时不自动加载，等用户点击功能按钮
function loadGrades() {
    gradesBackToMenu();
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
    if (!unevaluatedCoursesData || unevaluatedCoursesData.length === 0) { alert('没有未评估的课程'); return; }
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
    const overlay = document.getElementById('overlay');

    modal.style.display = 'flex';
    overlay.classList.add('active');
}

// 关闭公告弹窗
async function closeAnnouncementPopup() {
    const neverShow = document.getElementById('never-show-checkbox').checked;

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
    const overlay = document.getElementById('overlay');

    modal.style.display = 'none';
    overlay.classList.remove('active');

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
            contentDiv.innerHTML = '<p style="text-align:center;color:var(--error);">加载失败</p>';
        }
    } catch (error) {
        console.error('加载公告列表失败:', error);
        contentDiv.innerHTML = '<p style="text-align:center;color:var(--error);">加载失败</p>';
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
            contentDiv.innerHTML = '<p style="text-align:center;color:var(--error);">加载失败</p>';
        }
    } catch (error) {
        console.error('加载反馈列表失败:', error);
        contentDiv.innerHTML = '<p style="text-align:center;color:var(--error);">加载失败</p>';
    }
}

// 提交新反馈
async function submitNewFeedback() {
    const contentInput = document.getElementById('new-feedback-content');
    const content = contentInput.value.trim();
    const visibility = document.querySelector('input[name="feedback-visibility"]:checked').value;

    if (!content) {
        alert('先写一点反馈内容吧');
        contentInput.focus();
        return;
    }

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
            loadFeedbackPage();
        } else {
            alert(data.message || '提交失败');
        }
    } catch (error) {
        console.error('提交反馈失败:', error);
        alert('网络错误，请重试');
    }
}

// 提交回复
async function submitFeedbackReply(feedbackId) {
    const textarea = document.getElementById(`reply-input-${feedbackId}`);
    const content = textarea.value.trim();

    if (!content) {
        alert('请输入回复内容');
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
            loadFeedbackPage();
        } else {
            alert(data.message || '回复失败');
        }
    } catch (error) {
        console.error('回复失败:', error);
        alert('网络错误，请重试');
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

async function loadMemberPage() {
    await Promise.all([loadMemberStatus(), loadMemberOrders(), loadInvitationEarnings()]);
}

async function loadMemberStatus() {
    const card = document.getElementById('member-status-card');
    try {
        const resp = await fetch('/api/member/status', {
            headers: { 'X-Device-ID': getDeviceId() }
        });
        const data = await resp.json();
        if (!data.success) {
            card.innerHTML = `<p style="color:var(--error);">${data.message || '加载失败'}</p>`;
            return;
        }
        const d = data.data;
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
        card.innerHTML = `<p style="color:var(--error);">加载失败，请稍后重试</p>`;
    }
}

async function loadInvitationEarnings() {
    const card = document.getElementById('invitation-card');
    const content = document.getElementById('invitation-earnings-content');
    if (!card || !content) return;

    card.style.display = '';
    content.innerHTML = '<div class="loading">\u52a0\u8f7d\u4e2d...</div>';

    const fetchJson = async (url) => {
        try {
            const resp = await fetch(url, { headers: { 'X-Device-ID': getDeviceId() } });
            const data = await resp.json().catch(() => ({ success: false, message: '\u63a5\u53e3\u8fd4\u56de\u683c\u5f0f\u5f02\u5e38' }));
            if (!resp.ok) {
                return { success: false, message: data.message || `\u8bf7\u6c42\u5931\u8d25\uff1a${resp.status}` };
            }
            return data;
        } catch (e) {
            return { success: false, message: '\u7f51\u7edc\u8bf7\u6c42\u5931\u8d25' };
        }
    };

    const [inviterData, earningsData, withdrawalsData, memberData] = await Promise.all([
        fetchJson('/api/invitation/my_inviter'),
        fetchJson('/api/invitation/earnings'),
        fetchJson('/api/invitation/withdrawals'),
        fetchJson('/api/member/status')
    ]);

    if (!earningsData.success || !earningsData.data) {
        content.innerHTML = `<div class="error-message">\u6536\u76ca\u52a0\u8f7d\u5931\u8d25\uff1a${earningsData.message || '\u672a\u77e5\u9519\u8bef'}</div>`;
        return;
    }

    const isMember = memberData.success && memberData.data && memberData.data.is_member;
    const memberType = isMember ? memberData.data.member_type : null;
    const rateText = memberType === 'advanced' ? '20%' : (isMember ? '10%' : '0%');

    let html = '';

    if (inviterData.success && inviterData.data && inviterData.data.inviter) {
        html += `<div class="inviter-info"><span class="inviter-label">\u9080\u8bf7\u4eba\uff1a</span><span>${inviterData.data.inviter}</span></div>`;
    } else {
        html += `<div class="inviter-set-form">
            <input type="text" id="inviter-set-input" class="inviter-set-input" placeholder="\u586b\u5199\u9080\u8bf7\u4f60\u7684\u540c\u5b66\u5b66\u53f7">
            <button class="inviter-set-btn" onclick="handleSetInviter()">\u7ed1\u5b9a</button>
            <span id="inviter-set-error" class="inviter-set-error">${inviterData.success ? '' : (inviterData.message || '')}</span>
        </div>`;
    }

    const inviteeTotal = parseFloat(earningsData.data.invitee_total) || 0;
    const rate = earningsData.data.rate || '10%';
    const earned = parseFloat(earningsData.data.earned) || 0;
    const withdrawn = parseFloat(earningsData.data.withdrawn) || 0;
    const available = parseFloat(earningsData.data.available) || 0;

    let hasPending = false;
    if (withdrawalsData.success && withdrawalsData.data) {
        withdrawalsData.data.forEach(r => {
            if (r.status === 'pending') hasPending = true;
        });
    }

    let btnText, btnDisabled, btnOpacity;
    if (!isMember) {
        btnText = '\u5f00\u901a\u4f1a\u5458\u540e\u53ef\u63d0\u73b0';
        btnDisabled = true;
        btnOpacity = '0.5';
    } else if (hasPending) {
        btnText = '\u5ba1\u6838\u4e2d';
        btnDisabled = true;
        btnOpacity = '0.5';
    } else if (available <= 0) {
        btnText = '\u6682\u65e0\u53ef\u63d0\u73b0';
        btnDisabled = true;
        btnOpacity = '0.5';
    } else {
        btnText = '\u63d0\u73b0';
        btnDisabled = false;
        btnOpacity = '1';
    }

    html += `<div class="earnings-summary">
        <div class="earnings-row"><span>\u56e2\u961f\u5145\u503c</span><span>\u00a5${inviteeTotal.toFixed(2)}</span></div>
        <div class="earnings-row"><span>\u5206\u4f63\u6bd4\u4f8b</span><span class="earnings-rate">${rate}</span></div>
        <div class="earnings-row earnings-row-total"><span>\u7d2f\u8ba1\u6536\u76ca</span><span class="earnings-amount">\u00a5${earned.toFixed(2)}</span></div>
    </div>`;
    html += `<div class="earnings-total">
        <span class="earnings-label">\u53ef\u63d0\u73b0</span><span class="earnings-amount">\u00a5${available.toFixed(2)}</span>
        <button class="btn-withdraw" onclick="showWithdrawDialog()" ${btnDisabled ? 'disabled' : ''} style="opacity:${btnOpacity}">${btnText}</button>
    </div>`;
    if (withdrawn > 0) {
        html += `<div class="earnings-withdrawn"><span>\u5df2\u5360\u7528\uff1a\u00a5${withdrawn.toFixed(2)}</span></div>`;
    }
    if (!withdrawalsData.success) {
        html += `<div class="invite-hint">\u63d0\u73b0\u8bb0\u5f55\u52a0\u8f7d\u5931\u8d25\uff1a${withdrawalsData.message || '\u672a\u77e5\u9519\u8bef'}</div>`;
    }

    if (earningsData.data.earnings && earningsData.data.earnings.length > 0) {
        html += '<div class="earnings-list">';
        earningsData.data.earnings.forEach(e => {
            html += `<div class="earning-item"><span>${e.invitee_username} \u5f00\u901a\u4f1a\u5458</span><span class="earning-amount">+\u00a5${(parseFloat(e.amount) || 0).toFixed(2)}</span><span class="earning-time">${e.create_time ? e.create_time.slice(0, 10) : ''}</span></div>`;
        });
        html += '</div>';
    }

    if (!isMember) {
        html += `<div class="invite-hint">\u5f00\u901a\u4f1a\u5458\u540e\u53ef\u7533\u8bf7\u63d0\u73b0\uff1b\u6536\u76ca\u4f1a\u7ee7\u7eed\u7d2f\u8ba1\u663e\u793a\u3002</div>`;
    } else {
        html += `<div class="invite-hint">\u9080\u8bf7\u65b0\u7528\u6237\u7ed1\u5b9a\u8d26\u53f7\uff0c\u5bf9\u65b9\u5f00\u901a\u4f1a\u5458\u540e\u4f60\u53ef\u83b7\u5f97 <strong>${rateText}</strong> \u6536\u76ca\u3002</div>`;
    }

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
    const overlay = document.getElementById('overlay');
    modal.classList.add('active');
    overlay.classList.add('active');
}

function closePayDialog() {
    document.getElementById('pay-modal').classList.remove('active');
    document.getElementById('overlay').classList.remove('active');
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


// ==================== 设置邀请人 ====================
async function handleSetInviter() {
    const input = document.getElementById('inviter-set-input');
    const errEl = document.getElementById('inviter-set-error');
    const inviter = (input.value || '').trim();
    if (!inviter) {
        errEl.textContent = '请填写学号';
        return;
    }
    errEl.textContent = '';
    try {
        const resp = await fetch('/api/invitation/set', {
            method: 'POST',
            headers: { 'X-Device-ID': getDeviceId(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ inviter })
        });
        const data = await resp.json();
        if (data.success) {
            loadInvitationEarnings();
        } else {
            errEl.textContent = data.message || '设置失败';
        }
    } catch (e) {
        errEl.textContent = '网络错误，请重试';
    }
}

// ==================== 提现功能 ====================
let _withdrawAvailable = 0;

async function showWithdrawDialog() {
    const modal = document.getElementById('withdraw-modal');
    const overlay = document.getElementById('overlay');
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
        const rate = (earningsData.success && earningsData.data) ? earningsData.data.rate : '10%';
        const earned = (earningsData.success && earningsData.data) ? (parseFloat(earningsData.data.earned) || 0) : 0;
        const available = (earningsData.success && earningsData.data) ? (parseFloat(earningsData.data.available) || 0) : 0;

        _withdrawAvailable = available;
        document.getElementById('withdraw-available').innerHTML = `
            <div class="withdraw-amount-row">
                <span>团队充值</span><span>¥${inviteeTotal.toFixed(2)}</span>
            </div>
            <div class="withdraw-amount-row">
                <span>分佣比例</span><span>${rate}</span>
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

        modal.classList.add('active');
        overlay.classList.add('active');
    } catch (e) {
        errDiv.textContent = '加载失败，请重试';
    }
}

function closeWithdrawDialog() {
    document.getElementById('withdraw-modal').classList.remove('active');
    document.getElementById('overlay').classList.remove('active');
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
            alert(data.message);
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


