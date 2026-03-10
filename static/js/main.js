// ==================== 全局变量 ====================
let currentWeek = parseInt(localStorage.getItem('current_week')) || 1;  // 当前查看的周次，从 localStorage 读取
let currentUsername = null;  // 当前登录用户名
let isCheckingLoginStatus = false;  // 是否正在检查登录状态
let cachedSchedule = null;  // 缓存的课表全量数据，避免切换周次时重复请求
let semesterStart = null;   // 学期第1周星期一的日期

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

        // 显示换绑请求结果通知（不管绑定与否都要检查）
        if (data.rebind_notifications && data.rebind_notifications.length > 0) {
            showRebindNotifications(data.rebind_notifications);
        }

        if (data.success && data.bound) {
            // 已绑定，显示用户名
            currentUsername = data.username;
            document.getElementById('sidebar-username').textContent = currentUsername;

            // 恢复上次访问的页面，如果没有则默认首页
            const lastPage = localStorage.getItem('current_page') || 'home';
            switchPage(lastPage);

            // 加载并显示公告
            loadAndShowAnnouncements();
        } else {
            // 未绑定，显示登录弹窗
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

// 处理登录表单提交
async function handleLogin(event) {
    event.preventDefault();

    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const errorDiv = document.getElementById('login-error');

    errorDiv.textContent = '';

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Device-ID': getDeviceId()
            },
            body: JSON.stringify({ username, password })
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
function showRebindDialog() {
    const modal = document.getElementById('rebind-modal');
    modal.classList.add('active');
    document.getElementById('overlay').classList.add('active');
}

function closeRebindDialog() {
    const modal = document.getElementById('rebind-modal');
    modal.classList.remove('active');
    document.getElementById('overlay').classList.remove('active');
}

// 处理换绑表单提交
async function handleRebind(event) {
    event.preventDefault();

    const newUsername = document.getElementById('new-username').value;
    const reason = document.getElementById('reason').value;
    const errorDiv = document.getElementById('rebind-error');

    errorDiv.textContent = '';

    try {
        const response = await fetch('/api/request_rebind', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Device-ID': getDeviceId()
            },
            body: JSON.stringify({ new_username: newUsername, reason: reason })
        });

        const data = await response.json();

        if (data.success) {
            alert('换绑申请已提交，请等待管理员审批');
            closeRebindDialog();
            document.getElementById('rebind-form').reset();
        } else {
            errorDiv.textContent = data.message || '提交失败';
        }
    } catch (error) {
        console.error('提交换绑申请失败:', error);
        errorDiv.textContent = '网络错误，请重试';
    }
}

// 显示换绑请求结果通知
function showRebindNotifications(notifications) {
    const messages = notifications.map(n => {
        if (n.status === 'approved') {
            return `你的换绑申请（${n.old_username} → ${n.new_username}）已通过，请重新登录绑定新账号`;
        } else {
            return `你的换绑申请（${n.old_username} → ${n.new_username}）已被拒绝`;
        }
    });
    alert(messages.join('\n'));

    // 标记为已通知
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
        'grades': '学分绩点查询',
        'evaluation': '教务评价',
        'announcements': '系统公告',
        'surveys': '问卷调查',
        'feedback': '反馈建议',
        'member': '会员购买'
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
            // 自动查询未评估课程
            checkUnevaluatedCourses();
            break;
        case 'announcements':
            loadAnnouncementsList();
            break;
        case 'surveys':
            loadSurveysList();
            break;
        case 'feedback':
            loadFeedbackPage();
            break;
        case 'member':
            loadMemberPage();
            break;
    }
}

// ==================== 首页：加载紧急事件 ====================
async function loadUrgentEvent() {
    // 后台检查登录状态（不阻塞日程加载）
    checkLoginStatus();

    const contentDiv = document.getElementById('urgent-content');
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
    { start: '09:50', end: '10:35' }, { start: '10:45', end: '11:30' },
    { start: '13:30', end: '14:15' }, { start: '14:25', end: '15:10' },
    { start: '15:20', end: '16:05' }, { start: '16:15', end: '17:00' },
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

async function loadSchedule(week = null, autoFetched = false) {
    const scheduleDays = document.getElementById('schedule-days');
    const messageDiv = document.getElementById('schedule-message');

    // 如果没有指定周次，使用当前周次
    if (week === null) {
        week = currentWeek;
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
            scheduleDays.innerHTML = '';
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
            }

            if (hasData) {
                cachedSchedule = schedule;
                renderFromCache(schedule, week);
            } else if (!autoFetched) {
                // 没有缓存数据，自动从教务系统获取
                scheduleDays.innerHTML = '';
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
                scheduleDays.innerHTML = '';
                showMessage(data.data.message || '暂无课程数据');
            }
        } else {
            scheduleDays.innerHTML = '';
            showMessage(data.message || '暂无课程数据');
        }
    } catch (error) {
        console.error('加载课程表失败:', error);
        scheduleDays.innerHTML = '';
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
    scheduleGrid.classList.toggle('no-weekend', !hasWeekend);
    document.querySelector('.schedule-header').classList.toggle('no-weekend', !hasWeekend);
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
        loadSchedule(newWeek);
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
                opt.textContent = `第${w}周`;
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
    loadSchedule(week);
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
        if (data.success && data.grades && data.grades.length > 0) {
            displayGrades(data.grades);
        } else {
            document.getElementById('grades-content').innerHTML = '<p style="text-align:center;color:var(--text-tertiary);">没有不及格成绩，继续加油！</p>';
        }
    } catch (e) {
        document.getElementById('grades-content').innerHTML = '<p style="text-align:center;color:var(--error);">加载失败</p>';
    }
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
        const gpa = data.gpa;
        const creditGpa = gpa['学分绩点'];
        const degreeGpa = gpa['学位绩点'];
        let html = '<div class="gpa-info-card"><h3 class="gpa-title">绩点信息</h3><div class="gpa-items">';
        if (creditGpa !== null && creditGpa !== undefined) {
            html += `<div class="gpa-item"><span class="gpa-label">学分绩点</span><span class="gpa-value">${creditGpa}</span></div>`;
        }
        if (degreeGpa !== null && degreeGpa !== undefined) {
            html += `<div class="gpa-item"><span class="gpa-label">学位绩点</span><span class="gpa-value">${degreeGpa}</span></div>`;
        }
        html += '</div></div>';
        document.getElementById('grades-content').innerHTML = html;
    } catch (e) {
        document.getElementById('grades-content').innerHTML = '<p style="text-align:center;color:var(--error);">加载失败</p>';
    }
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
// 全局变量：保存未评估课程的完整数据
let unevaluatedCoursesData = [];

async function checkUnevaluatedCourses() {
    // 先检查登录状态
    await checkLoginStatus();

    const resultDiv = document.getElementById('evaluation-result');
    resultDiv.innerHTML = '<div class="loading">正在查询未评估课程...</div>';

    try {
        const response = await fetch('/api/unevaluated_courses', {
            headers: {
                'X-Device-ID': getDeviceId()
            }
        });

        const data = await response.json();

        if (data.success) {
            if (data.has_courses) {
                // 保存完整的课程数据（包含 wjbm, bpr, pgnr 等参数）
                unevaluatedCoursesData = data.courses;
                // 显示课程列表和完成评估按钮
                displayUnevaluatedCourses(data.courses);
            } else {
                // 没有未评估课程
                unevaluatedCoursesData = [];
                resultDiv.className = 'evaluation-result result-success';
                resultDiv.innerHTML = `
                    <div style="text-align:center;padding:20px;">
                        <div style="font-size:40px;margin-bottom:10px;color:var(--success);">&#10003;</div>
                        <div style="font-size:17px;color:var(--success);font-weight:600;">${data.message}</div>
                    </div>
                `;
            }
        } else {
            resultDiv.className = 'evaluation-result result-error';
            resultDiv.textContent = data.message || '查询失败';
        }
    } catch (error) {
        console.error('查询未评估课程失败:', error);
        resultDiv.className = 'evaluation-result result-error';
        resultDiv.textContent = '网络错误，请重试';
    }
}

function displayUnevaluatedCourses(courses) {
    const resultDiv = document.getElementById('evaluation-result');

    let html = '<div class="unevaluated-courses">';
    html += '<h3 style="margin-bottom:15px;font-weight:600;">未评估课程列表</h3>';

    courses.forEach(course => {
        html += `
            <div style="background:var(--bg-secondary);padding:14px 16px;margin-bottom:8px;border-radius:12px;">
                <div style="font-size:15px;font-weight:600;margin-bottom:4px;">${course['未评课程']}</div>
                <div style="font-size:14px;color:var(--text-secondary);">教师: ${course['教师']}</div>
            </div>
        `;
    });

    html += '<div style="text-align:center;margin-top:20px;"><button class="btn-primary" onclick="doEvaluation()">完成评估</button></div>';
    html += '</div>';

    resultDiv.innerHTML = html;
}

async function doEvaluation() {
    // 先检查登录状态
    await checkLoginStatus();

    const resultDiv = document.getElementById('evaluation-result');
    const btn = document.querySelector('.eval-btn');

    // 检查是否有课程数据
    if (!unevaluatedCoursesData || unevaluatedCoursesData.length === 0) {
        alert('没有未评估的课程');
        return;
    }

    btn.disabled = true;
    btn.textContent = '评价中...';

    try {
        // 发送课程数据（包含 wjbm, bpr, pgnr 等参数）
        const response = await fetch('/api/evaluation', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Device-ID': getDeviceId()
            },
            body: JSON.stringify({
                courses: unevaluatedCoursesData
            })
        });

        const data = await response.json();

        if (data.success) {
            // 清空课程数据
            unevaluatedCoursesData = [];

            resultDiv.className = 'evaluation-result result-success';
            resultDiv.innerHTML = `
                <div style="text-align:center;padding:20px;">
                    <div style="font-size:40px;margin-bottom:10px;color:var(--success);">&#10003;</div>
                    <div style="font-size:17px;color:var(--success);font-weight:600;">${data.message || '评价完成'}</div>
                </div>
            `;
        } else {
            resultDiv.className = 'evaluation-result result-error';
            resultDiv.textContent = data.message || '评价失败';
            btn.disabled = false;
            btn.textContent = '完成评估';
        }
    } catch (error) {
        console.error('执行评价失败:', error);
        resultDiv.className = 'evaluation-result result-error';
        resultDiv.textContent = '网络错误，请重试';
        btn.disabled = false;
        btn.textContent = '完成评估';
    }
}

async function oneClickEvaluation() {
    await checkLoginStatus();

    const resultDiv = document.getElementById('evaluation-result');
    const btn = document.getElementById('one-click-eval-btn');

    btn.disabled = true;
    btn.textContent = '评教中...';
    resultDiv.innerHTML = '<div class="loading">正在查询未评估课程...</div>';

    try {
        const response = await fetch('/api/unevaluated_courses', {
            headers: { 'X-Device-ID': getDeviceId() }
        });
        const data = await response.json();

        if (!data.success) {
            resultDiv.className = 'evaluation-result result-error';
            resultDiv.textContent = data.message || '查询失败';
            btn.disabled = false;
            btn.textContent = '一键评教';
            return;
        }

        if (!data.has_courses) {
            resultDiv.className = 'evaluation-result result-success';
            resultDiv.innerHTML = `
                <div style="text-align:center;padding:20px;">
                    <div style="font-size:40px;margin-bottom:10px;color:var(--success);">&#10003;</div>
                    <div style="font-size:17px;color:var(--success);font-weight:600;">没有未评估的课程</div>
                </div>
            `;
            btn.disabled = false;
            btn.textContent = '一键评教';
            return;
        }

        resultDiv.innerHTML = '<div class="loading">正在提交评教...</div>';

        const evalResponse = await fetch('/api/evaluation', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Device-ID': getDeviceId()
            },
            body: JSON.stringify({ courses: data.courses })
        });
        const evalData = await evalResponse.json();

        if (evalData.success) {
            unevaluatedCoursesData = [];
            resultDiv.className = 'evaluation-result result-success';
            resultDiv.innerHTML = `
                <div style="text-align:center;padding:20px;">
                    <div style="font-size:40px;margin-bottom:10px;color:var(--success);">&#10003;</div>
                    <div style="font-size:17px;color:var(--success);font-weight:600;">${evalData.message}</div>
                </div>
            `;
        } else {
            resultDiv.className = 'evaluation-result result-error';
            resultDiv.textContent = evalData.message || '评价失败';
        }
    } catch (error) {
        console.error('一键评教失败:', error);
        resultDiv.className = 'evaluation-result result-error';
        resultDiv.textContent = '网络错误，请重试';
    }

    btn.disabled = false;
    btn.textContent = '一键评教';
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

// ==================== 问卷调查 ====================

// 加载问卷列表页面
async function loadSurveysList() {
    const contentDiv = document.getElementById('surveys-list-content');
    contentDiv.innerHTML = '<div class="loading">加载中...</div>';

    try {
        const response = await fetch('/api/surveys');
        const data = await response.json();

        if (data.success) {
            if (data.surveys && data.surveys.length > 0) {
                displaySurveysList(data.surveys);
            } else {
                contentDiv.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-state-icon">&#128203;</div>
                        <div class="empty-state-text">暂无问卷调查</div>
                    </div>
                `;
            }
        } else {
            contentDiv.innerHTML = '<p style="text-align:center;color:var(--error);">加载失败</p>';
        }
    } catch (error) {
        console.error('加载问卷列表失败:', error);
        contentDiv.innerHTML = '<p style="text-align:center;color:var(--error);">加载失败</p>';
    }
}

// 显示问卷列表
function displaySurveysList(surveys) {
    const contentDiv = document.getElementById('surveys-list-content');

    let html = '';
    surveys.forEach(survey => {
        const createTime = new Date(survey.create_time).toLocaleString('zh-CN');

        html += `
            <div class="announcement-item" style="cursor:pointer;" onclick="window.open('${survey.url}', '_blank')">
                <div class="announcement-item-header">
                    <h3>${survey.title}</h3>
                    <span class="unread-badge">点击填写</span>
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
            displayFeedbackList(data.my_feedbacks, data.public_feedbacks);
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
    const content = document.getElementById('new-feedback-content').value.trim();
    const visibility = document.querySelector('input[name="feedback-visibility"]:checked').value;

    if (!content) {
        alert('请输入反馈内容');
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
            document.getElementById('new-feedback-content').value = '';
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
    box.style.display = box.style.display === 'none' ? 'block' : 'none';
}

// 显示反馈列表
function displayFeedbackList(myFeedbacks, publicFeedbacks) {
    const contentDiv = document.getElementById('feedback-list-content');
    let html = '';

    if (myFeedbacks.length === 0 && publicFeedbacks.length === 0) {
        html = `
            <div class="empty-state">
                <div class="empty-state-icon">&#128172;</div>
                <div class="empty-state-text">暂无反馈</div>
            </div>
        `;
        contentDiv.innerHTML = html;
        return;
    }

    // 我的反馈
    if (myFeedbacks.length > 0) {
        html += '<div class="feedback-section-title">我的反馈</div>';
        myFeedbacks.forEach(fb => {
            html += buildFeedbackCard(fb);
        });
    }

    // 公开反馈
    if (publicFeedbacks.length > 0) {
        html += '<div class="feedback-section-title">公开反馈</div>';
        publicFeedbacks.forEach(fb => {
            html += buildFeedbackCard(fb);
        });
    }

    contentDiv.innerHTML = html;
}

// 构建单条反馈卡片 HTML（论坛楼层模式）
function buildFeedbackCard(fb) {
    const createTime = new Date(fb.create_time).toLocaleString('zh-CN');
    const visLabel = fb.visibility === 'public' ? '所有人可见' : '仅自己可见';
    const visClass = fb.visibility === 'public' ? 'unread-badge' : 'read-badge';

    let html = `
        <div class="feedback-card">
            <div class="feedback-floor">
                <div class="feedback-floor-header">
                    <span class="feedback-floor-num">1楼</span>
                    <span class="feedback-username">${fb.is_own ? '我' : fb.username}</span>
                    <span class="${visClass}" style="margin-left:auto;">${visLabel}</span>
                </div>
                <div class="feedback-floor-content">${fb.content.replace(/\n/g, '<br>')}</div>
                <div class="feedback-floor-time">${createTime}</div>
            </div>
    `;

    // 回复楼层
    if (fb.replies && fb.replies.length > 0) {
        fb.replies.forEach((reply, index) => {
            const replyTime = new Date(reply.create_time).toLocaleString('zh-CN');
            const isAdmin = reply.username === '管理员';
            html += `
                <div class="feedback-floor ${isAdmin ? 'feedback-floor-admin' : ''}">
                    <div class="feedback-floor-header">
                        <span class="feedback-floor-num">${index + 2}楼</span>
                        <span class="feedback-username${isAdmin ? ' admin-tag' : ''}">${reply.username}</span>
                    </div>
                    <div class="feedback-floor-content">${reply.content.replace(/\n/g, '<br>')}</div>
                    <div class="feedback-floor-time">${replyTime}</div>
                </div>
            `;
        });
    }

    // 回复按钮和输入框
    html += `
            <div class="feedback-reply-bar">
                <button class="feedback-reply-btn" onclick="toggleReplyBox(${fb.id})">回复</button>
            </div>
            <div id="reply-box-${fb.id}" class="feedback-reply-box" style="display:none;">
                <textarea id="reply-input-${fb.id}" class="feedback-reply-textarea" rows="2" placeholder="输入回复内容..."></textarea>
                <button class="btn-primary btn-sm" onclick="submitFeedbackReply(${fb.id})">发送</button>
            </div>
        </div>
    `;
    return html;
}

// ==================== 会员功能 ====================

let _currentPayMemberType = null;

async function loadMemberPage() {
    await Promise.all([loadMemberStatus(), loadMemberOrders()]);
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

async function loadMemberOrders() {
    const container = document.getElementById('member-orders-content');
    try {
        const resp = await fetch('/api/member/orders', {
            headers: { 'X-Device-ID': getDeviceId() }
        });
        const data = await resp.json();
        if (!data.success || !data.data.length) {
            container.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:12px 0;">暂无购买记录</p>';
            return;
        }
        const typeMap = { basic: '初级会员', advanced: '高级会员' };
        const statusMap = { pending: '待支付', paid: '已支付', failed: '失败' };
        let html = '<div class="orders-list">';
        for (const order of data.data) {
            html += `
                <div class="order-item">
                    <div class="order-info">
                        <span class="order-type">${typeMap[order.member_type] || order.member_type}</span>
                        <span class="order-amount">¥${order.amount}</span>
                        <span class="order-status order-status-${order.status}">${statusMap[order.status] || order.status}</span>
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

function showPayDialog(memberType) {
    _currentPayMemberType = memberType;
    const prices = { basic: '3', advanced: '5' };
    const typeNames = { basic: '初级会员', advanced: '高级会员' };
    document.getElementById('pay-modal-title').textContent = `开通${typeNames[memberType]}`;
    document.getElementById('pay-modal-desc').textContent = `价格：¥${prices[memberType]}/半年，到期后可续费`;
    document.getElementById('pay-error').textContent = '';
    document.getElementById('pay-confirm-btn').disabled = false;
    document.getElementById('pay-confirm-btn').textContent = '确认支付';
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
    btn.textContent = '请求中...';
    errDiv.textContent = '';
    try {
        const resp = await fetch('/api/member/create_order', {
            method: 'POST',
            headers: { 'X-Device-ID': getDeviceId(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ member_type: memberType, pay_type: payType })
        });
        const data = await resp.json();
        if (!data.success) {
            errDiv.textContent = data.message || '创建订单失败';
            btn.disabled = false;
            btn.textContent = '确认支付';
            return;
        }
        const payUrl = data.data.pay_url;
        if (payUrl) {
            closePayDialog();
            window.location.href = payUrl;
        } else {
            errDiv.textContent = '获取支付链接失败，请重试';
            btn.disabled = false;
            btn.textContent = '确认支付';
        }
    } catch (e) {
        errDiv.textContent = '网络错误，请重试';
        btn.disabled = false;
        btn.textContent = '确认支付';
    }
}
