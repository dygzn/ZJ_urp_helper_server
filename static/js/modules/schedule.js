import { mountScheduleMenu } from './schedule-menu.js';
import { pageResources } from './lifecycle.js';
import { currentSemesterStartValue } from './calendar.js';
import { closeUiModal, openUiModal, showUiToast } from './ui.js';
import { SCHEDULE_MAX_WEEK, SCHEDULE_MIN_WEEK, animateScheduleHeight, animateScheduleSwipeTo, ensureScheduleSwipePanels, getScheduleDataSource, getSchedulePanelElements, getScheduleSwipeElements, getScheduleSwipeWidth, getScheduleWeekPayload, hideScheduleActions, initScheduleActions, initScheduleSwipe, resetQueuedScheduleSwipe, resetScheduleSwipeGesture, scheduleSwipeGesture, setScheduleSwipeTransform } from './schedule-gestures.js';
import { state } from './store.js';
import { getDeviceId, rememberBoundUsername } from './auth.js';
const resources = pageResources('schedule');

export function returnToCurrentScheduleWeek() {
    const start = currentSemesterStartValue();
    if (!start) {
        showUiToast('学期日期待确认，暂时无法定位本周', 'info');
        return;
    }
    const elapsed = Date.parse(`${getCalendarChinaToday()}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
    const week = Math.floor(elapsed / (7 * 86400000)) + 1;
    if (week < SCHEDULE_MIN_WEEK || week > SCHEDULE_MAX_WEEK) {
        showUiToast('当前日期不在本学期课表范围内', 'info');
        return;
    }
    jumpToWeek(week);
}

export const PERIOD_TIMES_DEFAULT = [
    { start: '08:20', end: '09:05' }, { start: '09:15', end: '10:00' },
    { start: '10:15', end: '11:00' }, { start: '11:10', end: '11:55' },
    { start: '14:10', end: '14:55' }, { start: '15:05', end: '15:50' },
    { start: '16:05', end: '16:50' }, { start: '17:00', end: '17:45' },
    { start: '19:00', end: '19:45' }, { start: '19:55', end: '20:40' },
];

export const PERIOD_TIMES_FRESHMAN = [
    { start: '08:00', end: '08:45' }, { start: '08:55', end: '09:40' },
    { start: '09:55', end: '10:40' }, { start: '10:50', end: '11:35' },
    { start: '13:30', end: '14:15' }, { start: '14:25', end: '15:10' },
    { start: '15:25', end: '16:10' }, { start: '16:20', end: '17:05' },
    { start: '18:30', end: '19:15' }, { start: '19:25', end: '20:10' },
];

export function updateScheduleTimeline(isFreshman, root = document) {
    state.userIsFreshman = !!isFreshman;
    const times = isFreshman ? PERIOD_TIMES_FRESHMAN : PERIOD_TIMES_DEFAULT;
    root.querySelectorAll('.timeline-item').forEach((item, i) => {
        if (!times[i]) return;
        item.querySelector('.timeline-time-start').textContent = times[i].start;
        item.querySelector('.timeline-time-end').textContent = times[i].end;
    });
}

export async function showOtherMajorModal() {
    const operation = resources.capture();
    const modal = document.getElementById('other-major-modal');
    const body = document.getElementById('other-major-modal-body');

    openUiModal(modal);

    if (Object.keys(state.gradeData).length > 0) {
        _renderOtherMajorModal();
        return;
    }

    body.innerHTML = '<div class="loading">加载中...</div>';
    try {
        const resp = await operation.wait(resources.fetch('/api/schedule/other_majors', {
            headers: { 'X-Device-ID': getDeviceId() }
        }));
        const data = await operation.wait(resp.json());
        if (!data.success || !Object.keys(data.data).length) {
            body.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:20px 0;">暂无其他班级的课表数据</p>';
            return;
        }
        state.gradeData = data.data;
        // 默认选第一个年级和专业
        state.omSelected.grade = Object.keys(state.gradeData)[0];
        state.omSelected.major = Object.keys(state.gradeData[state.omSelected.grade])[0];
        state.omSelected.class_num = state.gradeData[state.omSelected.grade][state.omSelected.major][0];
        _renderOtherMajorModal();
    } catch (e) {
        if (e?.name === 'AbortError') return;
        body.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:20px 0;">加载失败，请重试</p>';
    }
}

export function _renderOtherMajorModal() {
    const grades = Object.keys(state.gradeData);
    const majors = state.omSelected.grade ? Object.keys(state.gradeData[state.omSelected.grade] || {}) : [];
    const classes = (state.omSelected.grade && state.omSelected.major)
        ? (state.gradeData[state.omSelected.grade][state.omSelected.major] || []) : [];

    document.getElementById('other-major-modal-body').innerHTML = `
        <p class="other-major-section-label">年级</p>
        <div class="other-major-chips">
            ${grades.map(g => `
                <button class="other-major-chip ${g === state.omSelected.grade ? 'selected' : ''}"
                        onclick="omSelectGrade('${g}')">${g}级</button>
            `).join('')}
        </div>
        <p class="other-major-section-label">专业</p>
        <div class="other-major-chips">
            ${majors.map(m => `
                <button class="other-major-chip ${m === state.omSelected.major ? 'selected' : ''}"
                        onclick="omSelectMajor('${m}')">${m}</button>
            `).join('')}
        </div>
        <p class="other-major-section-label">班级</p>
        <div class="other-major-chips">
            ${classes.map(c => `
                <button class="other-major-chip ${c === state.omSelected.class_num ? 'selected' : ''}"
                        onclick="omSelectClass('${c}')">${c}班</button>
            `).join('')}
        </div>
        <div class="other-major-confirm">
            <button class="btn-primary btn-full" onclick="loadOtherMajorSchedule()">查看该班课表</button>
        </div>
    `;
}

export function omSelectGrade(grade) {
    state.omSelected.grade = grade;
    state.omSelected.major = Object.keys(state.gradeData[grade] || {})[0] || null;
    state.omSelected.class_num = state.omSelected.major ? (state.gradeData[grade][state.omSelected.major][0] || null) : null;
    _renderOtherMajorModal();
}

export function omSelectMajor(major) {
    state.omSelected.major = major;
    state.omSelected.class_num = (state.gradeData[state.omSelected.grade][major] || [])[0] || null;
    _renderOtherMajorModal();
}

export function omSelectClass(cls) {
    state.omSelected.class_num = cls;
    _renderOtherMajorModal();
}

export function closeOtherMajorModal() {
    closeUiModal(document.getElementById('other-major-modal'));
}

export async function loadOtherMajorSchedule() {
    const operation = resources.capture();
    const { grade, major, class_num } = state.omSelected;
    if (!grade || !major || !class_num) return;

    closeOtherMajorModal();

    const scheduleMsg = document.getElementById('schedule-message');
    scheduleMsg.style.display = 'block';
    scheduleMsg.textContent = '加载中...';
    scheduleMsg.classList.remove('schedule-message-detail');

    try {
        const resp = await operation.wait(resources.fetch(`/api/schedule/other_major?grade=${encodeURIComponent(grade)}&major=${encodeURIComponent(major)}&class_num=${encodeURIComponent(class_num)}`, {
            headers: { 'X-Device-ID': getDeviceId() }
        }));
        const data = await operation.wait(resp.json());
        if (!data.success) {
            scheduleMsg.textContent = data.message || '加载失败';
            return;
        }
        state.otherMajorScheduleData = data.data.schedule;
        if (data.data.semester_start && !state.semesterStart) {
            state.semesterStart = new Date(data.data.semester_start);
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
        displaySchedule({ [state.currentWeek]: state.otherMajorScheduleData[String(state.currentWeek)] || [] });
    } catch (e) {
        if (e?.name === 'AbortError') return;
        scheduleMsg.textContent = '加载失败，请重试';
    }
}

export async function showHistoricalSchedule() {
    const operation = resources.capture();
    const modal = document.getElementById('historical-schedule-modal');
    if (!modal) return;

    openUiModal(modal);
    await operation.wait(loadHistoricalSchedule());
}

export function closeHistoricalSchedule() {
    const modal = document.getElementById('historical-schedule-modal');
    closeUiModal(modal);
}

export async function loadHistoricalSchedule(semester = '') {
    const operation = resources.capture();
    const body = document.getElementById('historical-schedule-body');
    const select = document.getElementById('historical-semester-select');
    if (!body || !select) return;

    const requestId = ++state.historicalScheduleRequestId;
    body.innerHTML = '<div class="loading">加载中...</div>';
    select.disabled = true;

    const url = semester
        ? `/api/historical_schedule?semester=${encodeURIComponent(semester)}`
        : '/api/historical_schedule';

    try {
        const response = await operation.wait(resources.fetch(url, {
            headers: { 'X-Device-ID': getDeviceId() }
        }));
        const data = await operation.wait(response.json());
        if (requestId !== state.historicalScheduleRequestId) return;

        if (!data.success || !data.data) {
            body.innerHTML = `<p class="historical-schedule-empty">${escapeHtml(data.message || '历年课表加载失败')}</p>`;
            return;
        }

        const semesters = Array.isArray(data.data.semesters) ? data.data.semesters : [];
        select.innerHTML = semesters.length
            ? semesters.map(option => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label || option.value)}</option>`).join('')
            : '<option value="">暂无可选学期</option>';
        select.disabled = semesters.length === 0;
        if (data.data.semester && semesters.some(option => option.value === data.data.semester)) {
            select.value = data.data.semester;
        }

        renderHistoricalSchedule(data.data.courses || []);
    } catch (error) {
        if (error?.name === 'AbortError') return;
        if (requestId !== state.historicalScheduleRequestId) return;
        console.error('加载历年课表失败:', error);
        body.innerHTML = '<p class="historical-schedule-empty">加载失败，请检查网络连接</p>';
    }
}

export function renderHistoricalSchedule(courses) {
    const body = document.getElementById('historical-schedule-body');
    if (!body) return;

    if (!Array.isArray(courses) || courses.length === 0) {
        body.innerHTML = '<p class="historical-schedule-empty">该学期暂无课程</p>';
        return;
    }

    body.innerHTML = buildHistoricalScheduleGridHtml(courses);
}

export function backToMySchedule() {
    state.otherMajorScheduleData = null;
    const scheduleMsg = document.getElementById('schedule-message');
    scheduleMsg.style.display = 'none';
    scheduleMsg.classList.remove('schedule-message-detail');
    refreshScheduleDisplay();
}

export async function updateScheduleData(event) {
    const operation = resources.capture();
    const generation = state.academicCacheGeneration;
    const btn = event?.currentTarget || event?.target || document.getElementById('update-schedule-btn');
    if (!btn) return;
    const originalText = btn.textContent;

    btn.disabled = true;
    btn.textContent = '更新中...';

    try {
        const response = await operation.wait(resources.api.request('/api/update_schedule', { method: 'POST', timeout: 60000 }));
        const data = await operation.wait(response.json());
        if (generation !== state.academicCacheGeneration) return;

        if (data.success) {
            showUiToast('课程表更新成功', 'success');
            state.cachedSchedule = null;  // 清除缓存，重新拉取
            // 重新加载课程表
            loadSchedule();
        } else {
            showUiToast(data.message || '更新失败', 'error');
        }
    } catch (error) {
        if (error?.name === 'AbortError') return;
        if (generation !== state.academicCacheGeneration) return;
        console.error('更新课程表失败:', error);
        showUiToast('更新课程表失败，学校可能暂未开放查询', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

export function resetScheduleDisplay() {
    state.currentScheduleMap.clear();
    state.scheduleHeightAnimation?.cancel();
    state.scheduleHeightAnimation = null;
    resetScheduleSwipeGesture();
    const swipe = ensureScheduleSwipePanels();
    const panels = swipe?.panels || [document.querySelector('.schedule-week-panel')].filter(Boolean);

    panels.forEach(panel => {
        const { scheduleDays, scheduleGrid, scheduleHeader } = getSchedulePanelElements(panel);
        if (!scheduleDays || !scheduleGrid || !scheduleHeader) return;
        scheduleDays.innerHTML = '';
        const unplaced = panel.querySelector('.schedule-unplaced-exams');
        if (unplaced) { unplaced.innerHTML = ''; unplaced.hidden = true; }
        panel.querySelectorAll('[data-schedule-date]').forEach(el => { el.textContent = ''; });
        panel.querySelectorAll('.schedule-day-today').forEach(el => el.classList.remove('schedule-day-today'));
        scheduleGrid.classList.remove('has-evening');
        setScheduleWeekendVisibility(false, scheduleGrid, scheduleHeader);
    });
    if (swipe) {
        swipe.track.classList.remove('is-dragging', 'is-animating', 'is-changing');
        swipe.viewport.classList.remove('is-swiping', 'is-settling');
        swipe.panels.forEach(panel => panel.classList.remove('is-swipe-target'));
        setScheduleSwipeTransform(0);
    }
}

export function refreshScheduleDisplay(week = null) {
    state.cachedSchedule = null;
    return loadSchedule(week);
}

export async function loadSchedule(week = null, autoFetched = false) {
    const operation = resources.capture();
    const request = resources.api.beginRequest('schedule');
    let generation = state.academicCacheGeneration;
    const useActualWeek = week === null;
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
        week = calcActualWeek() ?? state.currentWeek;
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
        state.currentWeek = w;
        localStorage.setItem('current_week', w);
        updateScheduleDates(w);

        const weekStr = String(w);
        const weekData = allSchedule[weekStr] ? { [weekStr]: allSchedule[weekStr] } : {};
        const hasExams = state.cachedScheduleExams.some(exam => Number(exam.week) === Number(w));
        if (Object.keys(weekData).length > 0 || hasExams) {
            hideMessage();
            displaySchedule(weekData);
            if (!currentSemesterStartValue()) {
                showMessage('学期起始日期待核对，请管理员在后台设置后刷新显示。');
            } else if (state.scheduleExamsStale) {
                showMessage('考试缓存属于旧学期，请到“考试安排”更新后查看。');
            }
        } else {
            displaySchedule({});
            showMessage(`第${w}周没有课程或考试${state.scheduleExamsStale ? '；考试缓存属于旧学期，请到“考试安排”更新。' : ''}`);
        }
    }

    // 如果有缓存，直接从缓存渲染
    if (state.cachedSchedule) {
        renderFromCache(state.cachedSchedule, week);
        return;
    }

    // 没有缓存，请求全量数据（不传 week 参数）
    try {
        const response = await operation.wait(resources.api.request('/api/schedule', { signal: request.signal }));
        const data = await operation.wait(response.json());
        if (!request.isCurrent() || generation !== state.academicCacheGeneration) return;

        if (data.success && data.account && data.account !== state.currentUsername) {
            state.currentUsername = data.account;
            rememberBoundUsername(state.currentUsername);
            generation = state.academicCacheGeneration;
            document.getElementById('sidebar-username').textContent = state.currentUsername;
        }
        if (data.success && data.data?.cache_stale) {
            resetScheduleDisplay();
            showMessage('后台已切换学期，请点击“更新课程表”获取本学期课程后再查看或导出。', true);
            return;
        }

        if (data.success && data.data) {
            const schedule = data.data.schedule || {};
            const hasData = Object.keys(schedule).length > 0;
            state.scheduleExamsStale = !!data.data.exams_cache_stale;
            state.cachedScheduleExams = !state.scheduleExamsStale && Array.isArray(data.data.exams) ? data.data.exams : [];

            if (typeof data.data.is_freshman === 'boolean') {
                state.userIsFreshman = data.data.is_freshman;
            }

            if (data.data.semester_start) {
                state.semesterStart = new Date(data.data.semester_start + 'T00:00:00');
                // API 返回后重新算一次，覆盖之前的降级值
                if (useActualWeek) {
                    week = calcActualWeek() ?? week;
                }
            }

            if (hasData || state.cachedScheduleExams.length > 0) {
                state.cachedSchedule = schedule;
                renderFromCache(schedule, week);
            } else if (!autoFetched) {
                // 没有缓存数据，自动从教务系统获取
                resetScheduleDisplay();
                showMessage('正在从教务系统获取课表...');
                try {
                    const updateResp = await operation.wait(resources.api.request('/api/update_schedule', {
                        method: 'POST', signal: request.signal, timeout: 60000,
                    }));
                    const updateData = await operation.wait(updateResp.json());
                    if (!request.isCurrent() || generation !== state.academicCacheGeneration) return;
                    if (updateData.success) {
                        loadSchedule(week, true);
                        return;
                    } else {
                        showMessage(updateData.message || '获取课表失败', true);
                    }
                } catch (e) {
        if (e?.name === 'AbortError') return;
                    if (!request.isCurrent() || generation !== state.academicCacheGeneration) return;
                    if (e.name === 'AbortError') return;
                    showMessage(e.message || '获取课表失败，学校可能暂未开放查询', true);
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
        if (error?.name === 'AbortError') return;
        if (!request.isCurrent() || generation !== state.academicCacheGeneration) return;
        if (error.name === 'AbortError') return;
        console.error('加载课程表失败:', error);
        resetScheduleDisplay();
        showMessage(error.message || '加载失败，请检查网络连接', true);
    }
}

export function renderScheduleWeek(schedule, panel, courseColorMap = buildScheduleCourseColorMap(schedule)) {
    const { scheduleDays, scheduleGrid, scheduleHeader } = getSchedulePanelElements(panel);
    if (!scheduleDays || !scheduleGrid || !scheduleHeader) return;
    const daysCourses = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] };
    let hasEvening = false;
    Object.values(schedule).forEach(weekCourses => {
        if (!Array.isArray(weekCourses)) return;
        weekCourses.forEach(course => {
            const day = Number(course['星期']);
            const section = Number.parseInt(course['节次'], 10);
            const duration = Number.parseInt(course['节数'], 10) || 1;
            if (!daysCourses[day] || section < 1 || !Number.isInteger(section)) return;
            if (section + duration - 1 >= 9) hasEvening = true;
            daysCourses[day].push(buildScheduleCourseCardData(course, day));
        });
    });

    const week = Number(panel.dataset.week) || state.currentWeek;
    // 每次注册使用新标识，避免重复课程、相邻周以及过期元素指向同一对象。
    const registerCourse = (course, day) => {
        const key = `${week}_${course.kind || 'course'}_${day}_${course.section ?? 'unplaced'}_${++state.scheduleCourseId}`;
        state.currentScheduleMap.set(key, course);
        return key;
    };
    const times = state.userIsFreshman ? PERIOD_TIMES_FRESHMAN : PERIOD_TIMES_DEFAULT;
    const weekExams = state.otherMajorScheduleData ? [] : state.cachedScheduleExams
        .filter(exam => Number(exam.week) === week)
        .map(exam => buildScheduleExamCardData(exam, times));
    const unplacedExams = [];
    weekExams.forEach(exam => {
        if (!exam.section || !daysCourses[exam.dayNumber]) {
            unplacedExams.push(exam);
            return;
        }
        if (exam.section + exam.duration - 1 >= 9) hasEvening = true;
        daysCourses[exam.dayNumber].push(exam);
    });
    const hasWeekend = daysCourses[6].length > 0 || daysCourses[7].length > 0
        || weekExams.some(exam => exam.dayNumber >= 6 && exam.dayNumber <= 7);

    let html = '';
    for (let day = 1; day <= 7; day++) {
        html += `<div class="schedule-day-column${day >= 6 ? ' schedule-day-weekend' : ''}" data-schedule-column-day="${day}">`;
        buildScheduleDayCardLayout(daysCourses[day]).forEach(course => {
            if (course.kind === 'exam' && course.lanes > 1) {
                unplacedExams.push({ ...course, note: '同一时段还有其他安排，请核对实际时间' });
            }
            const position = scheduleCourseGridPlacement(course.section, course.duration)
                + ` --schedule-event-lanes: ${course.lanes}; --schedule-event-lane: ${course.lane};`;
            const isExam = course.kind === 'exam';
            const startTime = times[course.section - 1]?.start;
            const endTime = times[course.section + course.duration - 2]?.end;
            const courseTime = startTime && endTime ? `${startTime}-${endTime}` : '';
            const color = courseColorMap.get(getScheduleCourseColorKey(course)) || '#2563eb';
            const courseId = registerCourse(course, day);
            html += `<button type="button" class="course-card${isExam ? ' schedule-exam-card' : ''}${course.duration === 1 ? ' is-single-period' : ''}"
                style="${position} --course-color: ${isExam ? 'var(--ui-exam-ink)' : color};"
                title="${escapeHtml(`${course.name}${isExam ? ` · 考试 · ${course.time}` : courseTime ? ` · ${courseTime}` : ''}${course.location ? ` · ${course.location}` : ''}`)}"
                data-course-id="${escapeHtml(courseId)}" data-day="${day}" tabindex="${panel.getAttribute?.('aria-hidden') === 'true' ? -1 : 0}" onclick="showCourseDetail(this)">
                <span class="course-card-name">${escapeHtml(course.name)}</span>
                ${isExam ? `<span class="schedule-exam-time" aria-label="${escapeHtml(course.time)}"><span>${escapeHtml(course.time.split('-')[0])}</span><span aria-hidden="true">-</span><span>${escapeHtml(course.time.split('-')[1])}</span></span>` : ''}
                ${course.location ? `<span class="course-card-location">${escapeHtml(course.location)}</span>` : ''}
                ${!isExam && courseTime ? `<span class="course-card-period desktop-only">${courseTime} · 第${course.section}${course.duration > 1 ? `-${course.section + course.duration - 1}` : ''}节</span>` : ''}
                ${isExam ? '<span class="schedule-exam-label">考试</span>' : ''}
            </button>`;
        });
        html += '</div>';
    }
    scheduleDays.innerHTML = html;
    const unplaced = panel.querySelector('.schedule-unplaced-exams');
    if (unplaced) {
        unplaced.hidden = weekExams.length === 0;
        unplaced.innerHTML = weekExams.length ? '<p class="schedule-unplaced-note">本周考试</p>'
            + weekExams.map(exam => {
                const extra = unplacedExams.find(item => item.name === exam.name && item.dayNumber === exam.dayNumber
                    && item.time === exam.time && item.location === exam.location);
                const note = extra ? extra.note || '时间待定或不在上课时段内' : '';
                const date = getCalendarDate(currentSemesterStartValue(), week, exam.dayNumber);
                return `<button type="button" class="schedule-unplaced-exam" data-course-id="${escapeHtml(registerCourse(exam, exam.dayNumber))}" data-day="${exam.dayNumber}" tabindex="${panel.getAttribute?.('aria-hidden') === 'true' ? -1 : 0}" onclick="showCourseDetail(this)"><strong>${escapeHtml(exam.name)}</strong><span class="schedule-exam-summary-time">${date ? `${escapeHtml(date)} ` : ''}${escapeHtml(exam.day)} ${escapeHtml(exam.time)}</span><span class="schedule-exam-summary-location">${escapeHtml(exam.location || '考试位置待定')}</span>${note ? `<small>${escapeHtml(note)}</small>` : ''}</button>`;
            }).join('') : '';
    }
    scheduleGrid.classList.toggle('has-evening', hasEvening);
    setScheduleWeekendVisibility(hasWeekend, scheduleGrid, scheduleHeader);
    updateScheduleTimeline(state.userIsFreshman, panel);
}

export function displaySchedule(schedule) {
    state.currentScheduleMap.clear();
    resetScheduleSwipeGesture();
    const source = getScheduleDataSource(schedule);
    const courseColorMap = buildScheduleCourseColorMap(source);
    const swipe = ensureScheduleSwipePanels();
    if (!swipe) {
        renderScheduleWeek(schedule, document.querySelector('.schedule-week-panel'), courseColorMap);
        return;
    }

    const hadWeek = !!swipe.current.dataset.week;
    const previousHeight = swipe.track.getBoundingClientRect?.().height;
    state.scheduleHeightAnimation?.cancel();
    state.scheduleHeightAnimation = null;

    [
        [swipe.previous, state.currentWeek - 1],
        [swipe.current, state.currentWeek],
        [swipe.next, state.currentWeek + 1],
    ].forEach(([panel, week], index) => {
        panel.dataset.week = String(week);
        panel.classList.toggle('is-current', index === 1);
        panel.classList.toggle('is-swipe-adjacent', index !== 1);
        panel.classList.remove('is-swipe-target');
        panel.setAttribute('aria-hidden', index === 1 ? 'false' : 'true');
        renderScheduleWeek(getScheduleWeekPayload(source, week), panel, courseColorMap);
    });

    updateScheduleDates(state.currentWeek);
    if (hadWeek) {
        animateScheduleHeight(swipe.track, previousHeight, swipe.track.getBoundingClientRect?.().height);
    }
    swipe.track.classList.remove('is-dragging', 'is-animating', 'is-changing');
    swipe.viewport.classList.remove('is-swiping', 'is-settling');
    setScheduleSwipeTransform(0);
}

export function getScheduleCourseColorKey(course = {}) {
    const source = course || {};
    const courseCode = String(source['课程号'] ?? source.code ?? '').trim();
    const courseName = String(source['课程名'] ?? source.name ?? '').trim();
    const teacher = String(source['教师'] ?? source.teacher ?? '').trim();
    return JSON.stringify(courseCode ? [courseCode, courseName] : [courseName, teacher]);
}

export function buildScheduleCourseColorMap(schedule = {}) {
    const courseKeys = new Set();
    Object.values(schedule || {}).forEach(weekCourses => {
        if (!Array.isArray(weekCourses)) return;
        weekCourses.forEach(course => courseKeys.add(getScheduleCourseColorKey(course)));
    });

    const sortedCourseKeys = Array.from(courseKeys).sort();
    // 按 Oklab 感知距离预先排序：每个新颜色优先远离已使用的颜色。
    // 少量课程只取前几个反差最大的颜色，更多课程才使用后续补充色。
    const palette = [
        '#2563eb', '#cf5900', '#16834a', '#9333d5',
        '#80441b', '#393a94', '#a05a85', '#007d98',
        '#4b5563', '#b91c1c', '#d52b78', '#a77800',
    ];
    const colorMap = new Map();
    sortedCourseKeys.forEach((courseKey, index) => {
        const hue = (208 + (index - palette.length) * 137.508) % 360;
        const color = palette[index] || `hsl(${hue.toFixed(3)}, 72%, 27%)`;
        colorMap.set(courseKey, color);
    });
    return colorMap;
}

export function showCourseDetail(el) {
    const course = state.currentScheduleMap.get(el?.dataset.courseId);
    if (!course) return;
    const modal = document.getElementById('course-detail-modal');
    const week = Number.parseInt(el.closest('.schedule-week-panel')?.dataset.week, 10) || state.currentWeek;
    const date = getCalendarDate(currentSemesterStartValue(), week, el.dataset.day);
    if (course.kind === 'exam') {
        document.getElementById('course-detail-name').textContent = `${course.name}（考试）`;
        document.getElementById('course-detail-body').innerHTML = buildScheduleExamDetailHtml({
            ...course, week, date: date || '学期起始日期或考试日期待核对',
        });
        openUiModal(modal);
        if (window.courseDetailTransition) window.courseDetailTransition.open(modal, el);
        return;
    }
    const times = state.userIsFreshman ? PERIOD_TIMES_FRESHMAN : PERIOD_TIMES_DEFAULT;
    const clock = getCalendarPeriodTime(course.section, course.duration, times);

    document.getElementById('course-detail-name').textContent = course.name;
    document.getElementById('course-detail-body').innerHTML = buildScheduleCourseDetailHtml({
        ...course,
        week,
        date: date || '学期起始日期待核对',
        clockTime: clock ? `${clock.start}–${clock.end}` : '',
    });

    openUiModal(modal);
    if (window.courseDetailTransition) window.courseDetailTransition.open(modal, el);
}

export function closeCourseDetail() {
    closeUiModal(document.getElementById('course-detail-modal'));
}

export function changeWeek(delta, animate = false) {
    const buttonSwipe = resolveScheduleButtonSwipe({
        delta,
        currentWeek: state.currentWeek,
        minWeek: SCHEDULE_MIN_WEEK,
        maxWeek: SCHEDULE_MAX_WEEK,
    });
    const newWeek = state.currentWeek + delta;

    if (animate) {
        const swipe = ensureScheduleSwipePanels();
        if (!buttonSwipe.shouldChange || !swipe || state.scheduleSwipeTransition || scheduleSwipeGesture.pointerId !== null) return;

        resetScheduleSwipeGesture();
        animateScheduleSwipeTo(buttonSwipe, getScheduleSwipeWidth(swipe.viewport));
        return;
    }

    if (newWeek >= SCHEDULE_MIN_WEEK && newWeek <= SCHEDULE_MAX_WEEK) {
        if (state.otherMajorScheduleData) {
            state.currentWeek = newWeek;
            document.getElementById('week-select').value = newWeek;
            updateScheduleDates(newWeek);
            displaySchedule({ [newWeek]: state.otherMajorScheduleData[String(newWeek)] || [] });
        } else {
            loadSchedule(newWeek);
        }
    }
}

export function updateScheduleDates(week) {
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
    const range = document.getElementById('schedule-desktop-range');
    if (range) {
        range.textContent = activeStart
            ? `${getCalendarDate(activeStart, week, 1)} 至 ${getCalendarDate(activeStart, week, 7)}`
            : '学期日期待确认';
    }
    const mobileRange = document.getElementById('schedule-mobile-range');
    if (mobileRange) {
        const start = activeStart && getCalendarDate(activeStart, week, 1);
        const end = activeStart && getCalendarDate(activeStart, week, 7);
        mobileRange.textContent = start
            ? `${start.replace(/-0?/g, '/')} – ${end.slice(0, 4) === start.slice(0, 4)
                ? end.split('-').slice(1).map(Number).join('/') : end.replace(/-0?/g, '/')}`
            : '学期日期待确认';
    }

    const swipe = ensureScheduleSwipePanels();
    const panels = swipe?.panels || [document.querySelector('.schedule-week-panel')].filter(Boolean);
    panels.forEach(panel => {
        const panelWeek = Number.parseInt(panel.dataset.week, 10);
        if (!Number.isInteger(panelWeek) || panelWeek < SCHEDULE_MIN_WEEK || panelWeek > SCHEDULE_MAX_WEEK) return;

        for (let day = 1; day <= 7; day++) {
            const dateEl = panel.querySelector(`[data-schedule-date="${day}"]`);
            const dayEl = panel.querySelector(`[data-schedule-day="${day}"]`);
            const column = panel.querySelector(`[data-schedule-column-day="${day}"]`);
            if (!dateEl) continue;

            if (!activeStart) {
                dateEl.textContent = '';
                if (dayEl) dayEl.classList.remove('schedule-day-today');
                if (column) column.classList.remove('schedule-column-today');
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
            if (column) column.classList.toggle('schedule-column-today', date === today);
        }
    });
}

export function jumpToWeek(week) {
    if (state.otherMajorScheduleData) {
        state.currentWeek = week;
        updateScheduleDates(week);
        displaySchedule({ [week]: state.otherMajorScheduleData[String(week)] || [] });
    } else {
        loadSchedule(week);
    }
}

export function mountSchedule(container, { scheduleWeek = null } = {}) {
    initScheduleSwipe();
    initScheduleActions();
    mountScheduleMenu();
    return refreshScheduleDisplay(scheduleWeek);
}

export function unmountSchedule() {
    resources.dispose();
    state.scheduleHeightAnimation?.cancel();
    state.scheduleHeightAnimation = null;
    const swipe = getScheduleSwipeElements();
    if (scheduleSwipeGesture.pointerId != null) {
        try { swipe?.viewport.releasePointerCapture?.(scheduleSwipeGesture.pointerId); } catch {}
    }
    if (state.scheduleSwipeTransition) {
        swipe?.track.removeEventListener('transitionend', state.scheduleSwipeTransition.onTransitionEnd);
    }
    state.scheduleSwipeTransition = null;
    state.scheduleSwipeTransitionTimer = null;
    resetQueuedScheduleSwipe();
    resetScheduleSwipeGesture();
    hideScheduleActions(false);
    if (swipe) {
        delete swipe.viewport.dataset.scheduleSwipeReady;
        swipe.track.classList.remove('is-animating', 'is-changing');
        swipe.track.style.transform = '';
        swipe.viewport.classList.remove('is-settling');
    }
    const page = document.getElementById('page-schedule');
    if (page) delete page.dataset.scheduleActionsReady;
}
