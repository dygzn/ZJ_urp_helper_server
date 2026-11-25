import { chinaDateTime } from './schedule-editor-model.js';
import { pageResources } from './lifecycle.js';
import { state } from './store.js';
import { getDeviceId } from './auth.js';
import { updateScheduleTimeline } from './schedule.js';
const resources = pageResources('home');

export function mountHome() { return loadUrgentEvent(); }

export function unmountHome() {
    resources.dispose();
    state.countdownTimer = state.nextCountdownTimer = null;
}

export function homeIcon(name) {
    return `<svg class="home-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><use href="#home-icon-${name}"/></svg>`;
}

function renderHomeDate(eventData = {}) {
    const today = document.getElementById('home-today-date');
    if (!today) return;
    const date = getCalendarChinaToday();
    today.dateTime = date;
    const label = new Date(`${date}T00:00:00Z`).toLocaleDateString('zh-CN', {
        timeZone: 'UTC', month: 'long', day: 'numeric', weekday: 'long',
    });
    const week = eventData.current_week;
    const weekLabel = Number.isInteger(week) && week > 0 ? `第 ${week} 周`
        : week === 0 ? '未开学' : week === null ? '周次未设置' : '';
    today.textContent = weekLabel ? `${label} · ${weekLabel}` : label;
}

export function renderHomeState(kind, message) {
    const states = {
        empty: { title: '暂无后续安排', message: '暂未查询到后续课程或考试。课表有变动时，可前往日程表更新。', icon: 'calendar', action: "openHomeShortcut('schedule')", button: '查看课表' },
        guest: { title: '登录后查看你的安排', message: '课程、考试和上课地点会显示在这里。', icon: 'calendar', action: 'showLoginModal()', button: '登录教务账号' },
        error: { title: '安排暂时未能读取', message: '请检查网络后重试。', icon: 'warning', action: 'refreshUrgentEvent()', button: '重试' },
    };
    const state = states[kind];
    return `<div class="home-state home-state-${kind}"${kind === 'error' ? ' role="alert"' : ''}>
        <span class="home-state-icon">${homeIcon(state.icon)}</span>
        <div><strong>${state.title}</strong><p>${escapeHtml(message || state.message)}</p>
        <button class="${kind === 'guest' ? 'btn-primary' : 'btn-secondary'}" type="button" onclick="${state.action}">${state.button}</button></div>
    </div>`;
}

export function formatHomeCourseClock(course,includeStartDate=true) {
    const start=chinaDateTime(course.start_at),end=chinaDateTime(course.end_at);
    if(!start || !end || start.slice(0,10)===end.slice(0,10))return course.time_range || course.time || '';
    const date=value=>`${start.slice(0,4)!==end.slice(0,4)?value.slice(0,4)+'年':''}${Number(value.slice(5,7))}月${Number(value.slice(8,10))}日`;
    return `${includeStartDate?date(start)+' ':''}${start.slice(11)} 至 ${date(end)} ${end.slice(11)}`;
}

export function renderHomeAgenda(eventData) {
    const content = document.getElementById('home-agenda-content');
    const title = document.getElementById('home-agenda-title');
    if (!content) return;
    if (title) title.textContent = eventData.upcoming_label || '今日安排';
    const courses = Array.isArray(eventData.upcoming) ? eventData.upcoming : [];
    content.innerHTML = courses.length
        ? '<ol class="home-agenda-list">' + courses.map(course => `<li class="home-agenda-item${course.status === 'current' ? ' is-current' : ''}">
            <time>${escapeHtml(formatHomeCourseClock(course) || '时间待定')}</time>
            <div><strong>${escapeHtml(course.title || '课程')}</strong><span>${escapeHtml(course.location || '上课地点待确认')}</span></div>
            <span class="home-agenda-status">${course.status === 'current' ? '进行中' : '待上课'}</span>
        </li>`).join('') + '</ol>'
        : '<div class="home-agenda-empty"><p>暂无后续课程。考试时间和考场可从「查考试」查看。</p></div>';
}

export async function loadUrgentEvent() {
    const operation = resources.capture();
    const generation = state.academicCacheGeneration;

    const contentDiv = document.getElementById('urgent-content');
    const agenda = document.getElementById('home-agenda-content');
    renderHomeDate();
    if (state.countdownTimer) resources.clearInterval(state.countdownTimer);
    if (state.nextCountdownTimer) resources.clearInterval(state.nextCountdownTimer);
    state.countdownTimer = state.nextCountdownTimer = null;

    if (state.isGuestMode) {
        contentDiv.innerHTML = renderHomeState('guest');
        if (agenda) agenda.innerHTML = '<div class="home-agenda-empty"><p>登录后，这里会展示当天剩余课程或下一个有课日的课程。</p></div>';
        return;
    }

    contentDiv.innerHTML = '<div class="home-events-loading" role="status" aria-label="正在读取课程和考试安排"><span></span><span></span><p>正在读取安排…</p></div>';
    if (agenda) agenda.innerHTML = '<div class="loading">正在读取课程安排…</div>';

    try {
        const response = await operation.wait(resources.fetch('/api/urgent_event', {
            headers: {
                'X-Device-ID': getDeviceId()
            }
        }));
        const data = await operation.wait(response.json());
        if (generation !== state.academicCacheGeneration || state.isGuestMode) return;

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
            contentDiv.innerHTML = renderHomeState('empty');
            renderHomeAgenda({});
        } else {
            contentDiv.innerHTML = renderHomeState('error', data.message || '查询失败，请重试。');
            if (agenda) agenda.innerHTML = '<div class="home-agenda-empty"><p class="home-query-error">课程安排未能读取。</p><button class="btn-secondary" type="button" onclick="refreshUrgentEvent()" style="margin-top:10px;">重试</button></div>';
        }
    } catch (error) {
        if (error?.name === 'AbortError') return;
        if (generation !== state.academicCacheGeneration || state.isGuestMode) return;
        console.error('加载紧急事件失败:', error);
        contentDiv.innerHTML = renderHomeState('error', '加载失败，请检查网络后重试。');
        if (agenda) agenda.innerHTML = '<div class="home-agenda-empty"><p class="home-query-error">课程安排未能读取，请检查网络后重试。</p><button class="btn-secondary" type="button" onclick="refreshUrgentEvent()" style="margin-top:10px;">重试</button></div>';
    }
}

export function formatMinutes(minutes) {
    if (minutes >= 60) {
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        return m > 0 ? `${h}小时${m}分钟` : `${h}小时`;
    }
    return `${minutes}分钟`;
}

export function displayUrgentEvent(eventData) {
    const contentDiv = document.getElementById('urgent-content');
    renderHomeDate(eventData);
    renderHomeAgenda(eventData);

    if (state.countdownTimer) {
        resources.clearInterval(state.countdownTimer);
        state.countdownTimer = null;
    }
    if (state.nextCountdownTimer) {
        resources.clearInterval(state.nextCountdownTimer);
        state.nextCountdownTimer = null;
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
        return next?.start_at && next.end_at ? formatHomeCourseClock(next,false) : next?.time_range || t;
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

    if (noMoreToday && next) {
        html += '<p class="rest-message">今天暂无后续安排，下面是下一项提醒。</p>';
    }

    // 正在进行的课程（保留倒计时）
    if (current) {
        html += `
            <div class="event-card event-card-current">
                <div class="event-type"><span class="home-event-icon">${homeIcon('calendar')}</span><span>正在上课</span></div>
                <div class="event-title">${escapeHtml(current.title)}</div>
                <div class="event-location">${escapeHtml(current.location)}</div>
                <div class="event-time">${escapeHtml(formatHomeCourseClock(current))}</div>
                <div class="countdown" id="current-remaining">${current.remaining}分钟</div>
                <div class="countdown-label">后下课</div>
            </div>
        `;
    }

    // 下一个事件
    if (next) {
        let typeText;
        if (next.type === 'exam') {
            typeText = '下一场考试';
        } else if (nextIsToday && current) {
            typeText = '下一节课';
        } else if (nextIsToday) {
            typeText = '下一节课';
        } else {
            typeText = '下一节课';
        }
        const seatHtml = next.seat ? `<div class="event-seat">座位号： ${escapeHtml(next.seat)}</div>` : '';
        const timeLabel = getTimeLabel(next.time);
        const nextCountdownHtml = (nextIsToday && next.countdown != null)
            ? `<div class="countdown${next.countdown <= 10 ? ' countdown-urgent' : ''}" id="next-remaining">${formatMinutes(next.countdown)}</div><div class="countdown-label">${next.type === 'exam' ? '后考试' : '后上课'}</div>`
            : '';

        html += `
            <div class="event-card${current ? ' event-card-next' : ' event-card-upcoming'}${next.type === 'exam' ? ' event-card-exam' : ''}">
                <div class="event-type"><span class="home-event-icon">${homeIcon(next.type === 'exam' ? 'exam' : 'calendar')}</span><span>${typeText}</span></div>
                <div class="event-title">${escapeHtml(next.title)}</div>
                <div class="event-location">${escapeHtml(next.location)}</div>
                <div class="event-time-label">${escapeHtml(timeLabel)}</div>
                ${seatHtml}
                ${nextCountdownHtml}
            </div>
        `;
    } else if (!current) {
        html = renderHomeState('empty');
    }

    // 两周内每场考试独立显示，不被更早的课程挡住；next 中的考试只显示一次。
    const upcomingExams = Array.isArray(eventData.upcoming_exams) ? eventData.upcoming_exams : [];
    const additionalExams = upcomingExams.filter(exam => !(next?.type === 'exam'
        && exam.time === next.time && exam.title === next.title && exam.location === next.location));
    if (additionalExams.length) {
        if (!current && !next) html = '';
        html += additionalExams.map(exam => `
            <div class="event-card event-card-upcoming event-card-exam">
                <div class="event-type"><span class="home-event-icon">${homeIcon('exam')}</span><span>两周内考试</span></div>
                <div class="event-title">${escapeHtml(exam.title)}</div>
                <div class="event-location">${escapeHtml(exam.location || '')}</div>
                <div class="event-time-label">${escapeHtml(exam.time)}</div>
                ${exam.seat ? `<div class="event-seat">座位号： ${escapeHtml(exam.seat)}</div>` : ''}
            </div>
        `).join('');
    }
    contentDiv.innerHTML = html;

    // 正在进行中的课程倒计时（按真实截止时间校准，避免后台休眠漂移）
    if (current) {
        const currentEndAt = Date.now() + Number(current.remaining) * 60000;
        const syncCurrentRemaining = () => {
            const left = Math.ceil((currentEndAt - Date.now()) / 60000);
            const el = document.getElementById('current-remaining');
            if (!el || left <= 0) {
                resources.clearInterval(state.countdownTimer);
                state.countdownTimer = null;
                loadUrgentEvent();
                return;
            }
            el.textContent = `${left}分钟`;
        };
        state.countdownTimer = resources.setInterval(syncCurrentRemaining, 30000);
        if (typeof document.addEventListener === 'function') {
            resources.listen(document, 'visibilitychange', () => {
                if (document.visibilityState === 'visible') syncCurrentRemaining();
            });
        }
    }

    // 下一节课倒计时（按真实开始时间校准）
    if (next && nextIsToday && next.countdown != null) {
        const nextStartAt = Date.now() + Number(next.countdown) * 60000;
        const syncNextRemaining = () => {
            const left = Math.ceil((nextStartAt - Date.now()) / 60000);
            const el = document.getElementById('next-remaining');
            if (!el || left <= 0) {
                resources.clearInterval(state.nextCountdownTimer);
                state.nextCountdownTimer = null;
                loadUrgentEvent();
                return;
            }
            el.textContent = formatMinutes(left);
            if (left <= 10) {
                el.classList.add('countdown-urgent');
            }
        };
        state.nextCountdownTimer = resources.setInterval(syncNextRemaining, 30000);
        if (typeof document.addEventListener === 'function') {
            resources.listen(document, 'visibilitychange', () => {
                if (document.visibilityState === 'visible') syncNextRemaining();
            });
        }
    }
}

export function refreshUrgentEvent() {
    loadUrgentEvent();
}
