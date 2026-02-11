// ==================== 全局变量 ====================
let currentWeek = parseInt(localStorage.getItem('current_week')) || 1;  // 当前查看的周次，从 localStorage 读取
let currentUsername = null;  // 当前登录用户名
let isCheckingLoginStatus = false;  // 是否正在检查登录状态

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
        'experiments': '实验系统',
        'evaluation': '教务评价',
        'paper': '论文生成',
        'announcements': '系统公告'
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
        case 'experiments':
            loadExperiments();
            break;
        case 'evaluation':
            // 自动查询未评估课程
            checkUnevaluatedCourses();
            break;
        case 'announcements':
            loadAnnouncementsList();
            break;
    }
}

// ==================== 首页：加载紧急事件 ====================
async function loadUrgentEvent() {
    // 先检查登录状态
    await checkLoginStatus();

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
            displayUrgentEvent(data.event);
        } else {
            contentDiv.innerHTML = '<p style="text-align:center;color:#999;">暂无紧急事项</p>';
        }
    } catch (error) {
        console.error('加载紧急事件失败:', error);
        contentDiv.innerHTML = '<p style="text-align:center;color:#f44336;">加载失败</p>';
    }
}

function displayUrgentEvent(event) {
    const contentDiv = document.getElementById('urgent-content');

    const typeText = event.type === 'class' ? '📚 下一节课' : '📝 即将考试';
    const seatHtml = event.seat ? `<div class="event-seat">座位号: ${event.seat}</div>` : '';

    contentDiv.innerHTML = `
        <div class="event-card">
            <div class="event-type">${typeText}</div>
            <div class="event-title">${event.title}</div>
            <div class="event-location">📍 ${event.location}</div>
            <div class="event-time">🕐 ${event.time}</div>
            <div class="countdown">${event.countdown}</div>
            <div class="countdown-label">分钟后开始</div>
            ${seatHtml}
        </div>
    `;
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
            // 重新加载课程表
            loadSchedule();
        } else {
            alert(data.message || '更新失败');
        }
    } catch (error) {
        console.error('更新课程表失败:', error);
        alert('网络错误，请重试');
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

// 更新课程表按钮点击处理
async function updateSchedule() {
    // 直接加载当前周的课程表
    loadSchedule();
}

async function loadSchedule(week = null) {
    const contentDiv = document.getElementById('schedule-content');

    // 如果没有指定周次，使用当前周次
    if (week === null) {
        week = currentWeek;
    }

    const weekParam = `?week=${week}`;

    try {
        const response = await fetch(`/api/schedule${weekParam}`, {
            headers: {
                'X-Device-ID': getDeviceId()
            }
        });
        const data = await response.json();

        if (data.success && data.data) {
            // 更新当前周次
            if (data.data.week !== null) {
                currentWeek = data.data.week;
                document.getElementById('current-week').textContent = currentWeek;
                // 保存当前周次到 localStorage
                localStorage.setItem('current_week', currentWeek);
            }

            // 显示课程表（即使没有数据也显示空表格）
            displaySchedule(data.data.schedule || {});
        } else {
            contentDiv.innerHTML = `<p style="text-align:center;color:#999;padding:40px;">${data.message || '暂无课程数据'}</p>`;
        }
    } catch (error) {
        console.error('加载课程表失败:', error);
        contentDiv.innerHTML = '<p style="text-align:center;color:#f44336;padding:40px;">加载失败，请检查网络连接</p>';
    }
}

function displaySchedule(schedule) {
    const scheduleDays = document.getElementById('schedule-days');

    // 为每个星期创建课程列表
    const daysCourses = {
        1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: []
    };

    // 遍历所有周次的课程
    Object.values(schedule).forEach(weekCourses => {
        if (Array.isArray(weekCourses)) {
            weekCourses.forEach(course => {
                const dayNum = parseInt(course['星期']);
                const section = parseInt(course['节次']);
                const duration = parseInt(course['节数']) || 1;
                const location = course['位置'] || '';

                if (dayNum && section) {
                    daysCourses[dayNum].push({
                        name: course['课程名'],
                        section: section,
                        duration: duration,
                        location: location
                    });
                }
            });
        }
    });

    // 检测是否是手机端
    const isMobile = window.innerWidth <= 768;
    const sectionHeight = isMobile ? 60 : 80;
    const gap = isMobile ? 4 : 8;

    // 生成课程卡片HTML
    let html = '';
    for (let day = 1; day <= 7; day++) {
        html += '<div class="schedule-day-column">';

        const courses = daysCourses[day];
        courses.forEach((course, index) => {
            // 计算卡片位置和高度
            const top = (course.section - 1) * (sectionHeight + gap);
            const height = course.duration * sectionHeight + (course.duration - 1) * gap;

            // 为课程分配颜色（基于课程名称的哈希值）
            const colorIndex = getColorIndex(course.name);

            html += `
                <div class="course-card course-card-color-${colorIndex}"
                     style="position: absolute; top: ${top}px; height: ${height}px; left: 0; right: 0;">
                    <div class="course-card-name">${course.name}</div>
                    ${course.location ? `<div class="course-card-location">${course.location}</div>` : ''}
                </div>
            `;
        });

        html += '</div>';
    }

    scheduleDays.innerHTML = html;
}

// 根据课程名称生成颜色索引
function getColorIndex(courseName) {
    let hash = 0;
    for (let i = 0; i < courseName.length; i++) {
        hash = courseName.charCodeAt(i) + ((hash << 5) - hash);
    }
    return Math.abs(hash) % 10; // 10种颜色
}

function changeWeek(delta) {
    const newWeek = currentWeek + delta;
    if (newWeek >= 1 && newWeek <= 30) {  // 假设最多30周
        loadSchedule(newWeek);
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
        alert('网络错误，请重试');
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

async function loadExams() {
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
        } else {
            contentDiv.innerHTML = '<p style="text-align:center;color:#999;">暂无考试安排</p>';
        }
    } catch (error) {
        console.error('加载考试安排失败:', error);
        contentDiv.innerHTML = '<p style="text-align:center;color:#f44336;">加载失败</p>';
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

            html += `
                <div class="exam-card">
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
async function loadGrades() {
    // 先检查登录状态
    await checkLoginStatus();

    const contentDiv = document.getElementById('grades-content');
    contentDiv.innerHTML = '<div class="loading">加载中</div>';

    try {
        const response = await fetch('/api/grades', {
            headers: {
                'X-Device-ID': getDeviceId()
            }
        });
        const data = await response.json();

        if (data.success && data.grades && data.grades.length > 0) {
            displayGrades(data.grades);
        } else {
            contentDiv.innerHTML = '<p style="text-align:center;color:#999;">暂无成绩数据</p>';
        }
    } catch (error) {
        console.error('加载成绩失败:', error);
        contentDiv.innerHTML = '<p style="text-align:center;color:#f44336;">加载失败</p>';
    }
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

// ==================== 实验系统相关 ====================
async function loadExperiments() {
    // 先检查登录状态
    await checkLoginStatus();

    const contentDiv = document.getElementById('experiments-content');
    contentDiv.innerHTML = '<div class="loading">加载中</div>';

    try {
        const response = await fetch('/api/experiments', {
            headers: {
                'X-Device-ID': getDeviceId()
            }
        });
        const data = await response.json();

        if (data.success && data.experiments && data.experiments.length > 0) {
            displayExperiments(data.experiments);
        } else {
            contentDiv.innerHTML = '<p style="text-align:center;color:#999;">暂无实验数据</p>';
        }
    } catch (error) {
        console.error('加载实验数据失败:', error);
        contentDiv.innerHTML = '<p style="text-align:center;color:#f44336;">加载失败</p>';
    }
}

function displayExperiments(experiments) {
    const contentDiv = document.getElementById('experiments-content');

    let html = '';
    experiments.forEach(exp => {
        const statusClass = exp.status === '已完成' ? 'status-completed' : 'status-pending';

        html += `
            <div class="experiment-card">
                <div>
                    <div class="experiment-name">${exp.name}</div>
                    <div style="font-size:12px;color:#666;margin-top:5px;">成绩: ${exp.score || '未评分'}</div>
                </div>
                <div class="experiment-status ${statusClass}">${exp.status}</div>
            </div>
        `;
    });

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
                        <div style="font-size:48px;margin-bottom:10px;">✅</div>
                        <div style="font-size:18px;color:#4caf50;">${data.message}</div>
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
    html += '<h3 style="margin-bottom:15px;color:#333;">未评估课程列表</h3>';

    courses.forEach(course => {
        html += `
            <div class="course-item" style="background:#f5f5f5;padding:15px;margin-bottom:10px;border-radius:8px;">
                <div style="font-size:16px;font-weight:bold;margin-bottom:5px;">${course['未评课程']}</div>
                <div style="font-size:14px;color:#666;">教师: ${course['教师']}</div>
            </div>
        `;
    });

    html += '<button class="eval-btn" onclick="doEvaluation()" style="margin-top:20px;">完成评估</button>';
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
                    <div style="font-size:48px;margin-bottom:10px;">✅</div>
                    <div style="font-size:18px;color:#4caf50;">${data.message || '评价完成'}</div>
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
                    <div style="font-size:48px;margin-bottom:10px;">✅</div>
                    <div style="font-size:18px;color:#4caf50;">没有未评估的课程</div>
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
                    <div style="font-size:48px;margin-bottom:10px;">✅</div>
                    <div style="font-size:18px;color:#4caf50;">${evalData.message}</div>
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

// ==================== 论文生成模式管理 ====================

let currentPaperMode = 'simple';
let selectedFile = null;

// 切换论文生成模式
function switchPaperMode(mode) {
    currentPaperMode = mode;

    // 更新标签页样式
    document.querySelectorAll('.paper-mode-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.mode === mode);
    });

    // 切换表单显示
    document.getElementById('simple-mode-form').style.display = mode === 'simple' ? 'block' : 'none';
    document.getElementById('complex-mode-form').style.display = mode === 'complex' ? 'block' : 'none';

    // 切换到复杂模式时自动加载已保存的需求
    if (mode === 'complex') {
        loadComplexRequests();
    }
}

// 文件选择处理
function handleFileSelect(event) {
    const file = event.target.files[0];
    if (file) {
        selectedFile = file;
        const fileInfo = document.getElementById('uploaded-file-info');
        fileInfo.style.display = 'flex';
        fileInfo.innerHTML = `
            <span class="uploaded-file-name">📎 ${file.name}</span>
            <button class="uploaded-file-remove" onclick="removeSelectedFile()">移除</button>
        `;
    }
}

// 移除已选文件
function removeSelectedFile() {
    selectedFile = null;
    document.getElementById('complex-file').value = '';
    document.getElementById('uploaded-file-info').style.display = 'none';
}

// 保存复杂需求到服务器
async function saveComplexRequest() {
    const title = document.getElementById('complex-title').value.trim();
    const requirements = document.getElementById('complex-requirements').value.trim();
    const resultDiv = document.getElementById('complex-result');

    if (!title) {
        alert('请输入论文标题');
        return;
    }

    if (!requirements && !selectedFile) {
        alert('请输入具体要求或上传要求文件');
        return;
    }

    resultDiv.innerHTML = '<div class="loading">保存中...</div>';

    try {
        let response;

        if (selectedFile) {
            // 有文件上传，使用 FormData
            const formData = new FormData();
            formData.append('title', title);
            formData.append('requirements', requirements);
            formData.append('file', selectedFile);

            response = await fetch('/api/save_complex_request', {
                method: 'POST',
                headers: {
                    'X-Device-ID': getDeviceId()
                },
                body: formData
            });
        } else {
            // 纯文本需求
            response = await fetch('/api/save_complex_request', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Device-ID': getDeviceId()
                },
                body: JSON.stringify({ title, requirements })
            });
        }

        const data = await response.json();

        if (data.success) {
            resultDiv.innerHTML = '<div class="result-success" style="padding:15px;text-align:center;color:#4caf50;">✅ 需求保存成功</div>';
            // 清空表单
            document.getElementById('complex-title').value = '';
            document.getElementById('complex-requirements').value = '';
            removeSelectedFile();
            // 刷新列表
            loadComplexRequests();
        } else {
            resultDiv.innerHTML = `<div class="result-error" style="padding:15px;text-align:center;color:#f44336;">❌ ${data.message}</div>`;
        }
    } catch (error) {
        console.error('保存需求失败:', error);
        resultDiv.innerHTML = '<div class="result-error" style="padding:15px;text-align:center;color:#f44336;">❌ 网络错误，请重试</div>';
    }
}

// 加载已保存的复杂需求
async function loadComplexRequests() {
    const listDiv = document.getElementById('complex-requests-list');
    const container = document.getElementById('requests-container');

    listDiv.style.display = 'block';
    container.innerHTML = '<div class="loading">加载中...</div>';

    try {
        const response = await fetch('/api/get_complex_requests', {
            headers: {
                'X-Device-ID': getDeviceId()
            }
        });
        const data = await response.json();

        if (data.success) {
            if (data.requests.length === 0) {
                container.innerHTML = '<div class="no-drafts">暂无保存的需求</div>';
            } else {
                container.innerHTML = data.requests.map(req => {
                    const date = new Date(req.created_at);
                    const dateStr = date.toLocaleDateString('zh-CN') + ' ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
                    const fileTag = req.file
                        ? `<a href="/api/download_request_file/${req.id}" style="color:#2196f3;font-size:12px;margin-left:8px;text-decoration:none;">📎 下载附件</a>`
                        : '';
                    const finishTag = req.finish_file
                        ? `<span style="color:#4caf50;font-size:12px;margin-left:8px;">✅ 已完成</span>`
                        : '<span style="color:#ff9800;font-size:12px;margin-left:8px;">⏳ 待处理</span>';
                    const downloadBtn = req.finish_file
                        ? `<button class="draft-btn" style="background:#4caf50;color:white;" onclick="downloadFinishedPaper('${req.finish_file}', '${req.id}')">下载论文</button>`
                        : '';
                    const feedbackBtn = req.finish_file
                        ? `<button class="draft-btn draft-btn-feedback" onclick="showFeedbackModal('${req.id}', '${escapeHtmlAttr(req.title)}')">反馈修改</button>`
                        : '';
                    const confirmBtn = req.finish_file
                        ? `<button class="draft-btn draft-btn-confirm" onclick="showConfirmReceiptModal('${req.id}', '${escapeHtmlAttr(req.title)}')">满意签收</button>`
                        : '';

                    return `
                        <div class="draft-item">
                            <div class="draft-info">
                                <div class="draft-title">${escapeHtml(req.title)}${fileTag}${finishTag}</div>
                                <div class="draft-meta">${dateStr}</div>
                            </div>
                            <div class="draft-actions">
                                ${downloadBtn}
                                ${feedbackBtn}
                                ${confirmBtn}
                                <button class="draft-btn draft-btn-load" onclick="loadRequest('${req.id}')">加载</button>
                                <button class="draft-btn draft-btn-delete" onclick="deleteRequest('${req.id}')">删除</button>
                            </div>
                        </div>
                    `;
                }).join('');
            }
        } else {
            container.innerHTML = `<div class="no-drafts" style="color:#f44336;">${data.message}</div>`;
        }
    } catch (error) {
        console.error('加载需求失败:', error);
        container.innerHTML = '<div class="no-drafts" style="color:#f44336;">加载失败，请重试</div>';
    }
}

// 加载指定需求到表单
async function loadRequest(requestId) {
    try {
        const response = await fetch('/api/get_complex_requests', {
            headers: {
                'X-Device-ID': getDeviceId()
            }
        });
        const data = await response.json();

        if (data.success) {
            const req = data.requests.find(r => r.id === requestId);
            if (req) {
                document.getElementById('complex-title').value = req.title || '';
                document.getElementById('complex-requirements').value = req.requirements || '';

                if (req.file) {
                    alert('草稿已加载。注意：附件需要重新上传');
                } else {
                    alert('草稿已加载');
                }

                // 滚动到表单顶部
                document.getElementById('complex-mode-form').scrollIntoView({ behavior: 'smooth' });
            }
        }
    } catch (error) {
        console.error('加载需求失败:', error);
        alert('加载失败，请重试');
    }
}

// 删除需求
async function deleteRequest(requestId) {
    if (!confirm('确定要删除这个需求吗？')) {
        return;
    }

    try {
        const response = await fetch(`/api/delete_complex_request/${requestId}`, {
            method: 'DELETE',
            headers: {
                'X-Device-ID': getDeviceId()
            }
        });
        const data = await response.json();

        if (data.success) {
            loadComplexRequests();
        } else {
            alert(data.message);
        }
    } catch (error) {
        console.error('删除需求失败:', error);
        alert('删除失败，请重试');
    }
}

// HTML转义
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// 下载已完成的论文
function downloadFinishedPaper(filename, requestId) {
    window.location.href = `/api/download_finished_paper/${encodeURIComponent(requestId)}`;
}

// HTML属性转义
function escapeHtmlAttr(text) {
    return text.replace(/'/g, "\\'").replace(/"/g, '\\"');
}

// ==================== 反馈修改功能 ====================

let pendingFeedbackRequestId = null;

// 显示反馈弹窗
function showFeedbackModal(requestId, title) {
    pendingFeedbackRequestId = requestId;

    const modal = document.getElementById('feedback-modal');
    const overlay = document.getElementById('overlay');

    document.getElementById('feedback-title').textContent = title;
    document.getElementById('feedback-content').value = '';

    modal.classList.add('active');
    overlay.classList.add('active');
}

// 关闭反馈弹窗
function closeFeedbackModal() {
    const modal = document.getElementById('feedback-modal');
    const overlay = document.getElementById('overlay');

    modal.classList.remove('active');
    overlay.classList.remove('active');
    pendingFeedbackRequestId = null;
}

// 提交反馈
async function submitFeedback() {
    if (!pendingFeedbackRequestId) return;

    const feedback = document.getElementById('feedback-content').value.trim();
    if (!feedback) {
        alert('请输入修改意见');
        return;
    }

    const btn = document.getElementById('submit-feedback-btn');
    btn.disabled = true;
    btn.textContent = '提交中...';

    try {
        const response = await fetch(`/api/submit_feedback/${pendingFeedbackRequestId}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Device-ID': getDeviceId()
            },
            body: JSON.stringify({ feedback })
        });

        const data = await response.json();

        if (data.success) {
            alert('反馈提交成功，论文将重新处理');
            closeFeedbackModal();
            loadComplexRequests();
        } else {
            alert(data.message || '提交失败');
        }
    } catch (error) {
        console.error('提交反馈失败:', error);
        alert('网络错误，请重试');
    } finally {
        btn.disabled = false;
        btn.textContent = '提交反馈';
    }
}

// ==================== 满意签收功能 ====================

let pendingReceiptRequestId = null;

// 显示签收确认弹窗
function showConfirmReceiptModal(requestId, title) {
    pendingReceiptRequestId = requestId;

    const modal = document.getElementById('receipt-modal');
    const overlay = document.getElementById('overlay');

    document.getElementById('receipt-title').textContent = title;

    modal.classList.add('active');
    overlay.classList.add('active');
}

// 关闭签收弹窗
function closeReceiptModal() {
    const modal = document.getElementById('receipt-modal');
    const overlay = document.getElementById('overlay');

    modal.classList.remove('active');
    overlay.classList.remove('active');
    pendingReceiptRequestId = null;
}

// 确认签收
async function confirmReceipt() {
    if (!pendingReceiptRequestId) return;

    const btn = document.getElementById('confirm-receipt-btn');
    btn.disabled = true;
    btn.textContent = '签收中...';

    try {
        const response = await fetch(`/api/confirm_receipt/${pendingReceiptRequestId}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Device-ID': getDeviceId()
            }
        });

        const data = await response.json();

        if (data.success) {
            alert('签收成功，感谢您的使用！');
            closeReceiptModal();
            loadComplexRequests();
        } else {
            alert(data.message || '签收失败');
        }
    } catch (error) {
        console.error('签收失败:', error);
        alert('网络错误，请重试');
    } finally {
        btn.disabled = false;
        btn.textContent = '确认签收';
    }
}

// ==================== 论文生成 ====================

async function generatePaper() {
    const title = document.getElementById('paper-title').value.trim();
    const subject = document.getElementById('paper-subject').value.trim();
    const requirements = document.getElementById('paper-requirements').value.trim();
    const keywords = document.getElementById('paper-keywords').value.trim();
    const wordcount = document.getElementById('paper-wordcount').value;
    const template = document.getElementById('paper-template').value;
    const resultDiv = document.getElementById('paper-result');
    const btn = document.getElementById('generate-paper-btn');

    if (!title) {
        alert('请输入论文标题');
        return;
    }

    btn.disabled = true;
    btn.textContent = '生成中...';

    // 显示进度条
    resultDiv.innerHTML = `
        <div class="progress-container">
            <div class="progress-bar">
                <div class="progress-fill" id="progress-fill" style="width: 0%"></div>
            </div>
            <div class="progress-text" id="progress-text">准备生成...</div>
            <div class="progress-percent" id="progress-percent">0%</div>
        </div>
    `;

    try {
        const response = await fetch('/api/generate_paper', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Device-ID': getDeviceId()
            },
            body: JSON.stringify({
                title: title,
                subject: subject,
                requirements: requirements,
                keywords: keywords,
                wordcount: wordcount,
                template: template
            })
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(line.slice(6));

                        if (data.type === 'progress') {
                            // 更新进度条
                            const progressFill = document.getElementById('progress-fill');
                            const progressText = document.getElementById('progress-text');
                            const progressPercent = document.getElementById('progress-percent');

                            if (progressFill) progressFill.style.width = data.percent + '%';
                            if (progressText) progressText.textContent = '正在生成: ' + data.section;
                            if (progressPercent) progressPercent.textContent = data.percent + '%';
                        } else if (data.type === 'complete') {
                            // 生成完成
                            resultDiv.className = 'paper-result result-success';
                            resultDiv.innerHTML = `
                                <div style="text-align:center;padding:20px;">
                                    <div style="font-size:48px;margin-bottom:10px;">✅</div>
                                    <div style="font-size:18px;color:#4caf50;margin-bottom:20px;">论文生成成功</div>
                                    <a href="/api/download_paper/${data.filename}" class="update-schedule-btn" style="display:inline-block;text-decoration:none;background-color:#2196f3;">下载论文</a>
                                </div>
                            `;
                        } else if (data.type === 'error') {
                            // 生成出错
                            resultDiv.className = 'paper-result result-error';
                            resultDiv.textContent = data.message || '生成失败';
                        }
                    } catch (e) {
                        console.error('解析SSE数据失败:', e);
                    }
                }
            }
        }
    } catch (error) {
        console.error('论文生成失败:', error);
        resultDiv.className = 'paper-result result-error';
        resultDiv.textContent = '网络错误，请重试';
    }

    btn.disabled = false;
    btn.textContent = '生成论文';
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
                        <div class="empty-state-icon">📢</div>
                        <div class="empty-state-text">暂无公告</div>
                    </div>
                `;
            }
        } else {
            contentDiv.innerHTML = '<p style="text-align:center;color:#f44336;">加载失败</p>';
        }
    } catch (error) {
        console.error('加载公告列表失败:', error);
        contentDiv.innerHTML = '<p style="text-align:center;color:#f44336;">加载失败</p>';
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

