import { pageResources } from './lifecycle.js';
import { state } from './store.js';
import { getDeviceId, rememberBoundUsername } from './auth.js';
import { showUiToast } from './ui.js';
import { currentSemesterStartValue } from './calendar.js';
const resources = pageResources('exams');

export function mountExams() {
    const scope = resources.activate();
    if (state.currentPage) pageResources(state.currentPage).addCleanup(() => scope.dispose());
    return loadExams();
}

export function unmountExams() { resources.dispose(); }

export async function updateExamsData(event) {
    const operation = resources.capture();
    const generation = state.academicCacheGeneration;
    const btn = event?.currentTarget || event?.target || document.getElementById('update-exams-btn');
    if (!btn) return;
    const originalText = btn.textContent;

    btn.disabled = true;
    btn.textContent = '更新中...';

    try {
        const response = await operation.wait(resources.fetch('/api/update_exams', {
            method: 'POST',
            headers: {
                'X-Device-ID': getDeviceId()
            }
        }));
        const data = await operation.wait(response.json());
        if (generation !== state.academicCacheGeneration) return;

        if (data.success) {
            showUiToast('考试安排更新成功', 'success');
            state.cachedSchedule = null;
            state.cachedExams = null;
            // 重新加载考试安排
            loadExams();
            if (state.currentPage === 'schedule' && typeof window !== 'undefined' && typeof window.loadSchedule === 'function') {
                window.loadSchedule();
            }
        } else {
            showUiToast(data.message || '更新失败', 'error');
        }
    } catch (error) {
        if (error?.name === 'AbortError') return;
        if (generation !== state.academicCacheGeneration) return;
        console.error('更新考试安排失败:', error);
        showUiToast('更新考试安排失败，学校可能暂未开放查询', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

export async function loadExams(autoFetched = false) {
    const operation = resources.capture();
    let generation = state.academicCacheGeneration;
    const contentDiv = document.getElementById('exams-content');
    state.cachedExams = null;
    contentDiv.innerHTML = '<div class="loading">加载中</div>';

    try {
        const response = await operation.wait(resources.fetch('/api/exams', {
            headers: {
                'X-Device-ID': getDeviceId()
            }
        }));
        const data = await operation.wait(response.json());
        if (generation !== state.academicCacheGeneration) return;

        if (data.success && data.account && data.account !== state.currentUsername) {
            state.currentUsername = data.account;
            rememberBoundUsername(state.currentUsername);
            generation = state.academicCacheGeneration;
            document.getElementById('sidebar-username').textContent = state.currentUsername;
        }
        if (data.success && data.cache_stale) {
            state.cachedScheduleExams = [];
            state.scheduleExamsStale = true;
            contentDiv.innerHTML = '<p style="text-align:center;color:var(--warning);">后台已切换学期，请点击“更新考试安排”获取本学期考试后再查看或导出。</p>';
            return;
        }

        if (data.success && data.semester_start) {
            state.semesterStart = new Date(`${data.semester_start}T00:00:00`);
        }
        if (data.success && data.exams && data.exams.length > 0) {
            state.cachedExams = data.exams;
            state.cachedScheduleExams = data.exams;
            state.scheduleExamsStale = false;
            displayExams(data.exams);
        } else if (!autoFetched) {
            // 没有缓存数据，自动从教务系统获取
            contentDiv.innerHTML = '<p style="text-align:center;color:var(--text-tertiary);">正在从教务系统获取考试安排...</p>';
            try {
                const updateResp = await operation.wait(resources.fetch('/api/update_exams', {
                    method: 'POST',
                    headers: { 'X-Device-ID': getDeviceId() }
                }));
                const updateData = await operation.wait(updateResp.json());
                if (generation !== state.academicCacheGeneration) return;
                if (updateData.success) {
                    loadExams(true);
                    return;
                } else {
                    contentDiv.innerHTML = `<p style="text-align:center;color:var(--error);">${escapeHtml(updateData.message || '获取考试安排失败')}</p>`;
                }
            } catch (e) {
        if (e?.name === 'AbortError') return;
                if (generation !== state.academicCacheGeneration) return;
                contentDiv.innerHTML = '<p style="text-align:center;color:var(--error);">获取考试安排失败，学校可能暂未开放查询</p>';
            }
        } else {
            state.cachedScheduleExams = [];
            state.scheduleExamsStale = false;
            contentDiv.innerHTML = '<p style="text-align:center;color:var(--text-tertiary);">暂无考试安排</p>';
        }
    } catch (error) {
        if (error?.name === 'AbortError') return;
        if (generation !== state.academicCacheGeneration) return;
        console.error('加载考试安排失败:', error);
        contentDiv.innerHTML = '<p style="text-align:center;color:var(--error);">加载失败</p>';
    }
}

export function displayExams(exams) {
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
                <div class="exam-group-title">${escapeHtml(examName)}</div>
                <div class="exam-group-content">
        `;
        examList.forEach(exam => {
            const date = getCalendarDate(currentSemesterStartValue(), exam.week, exam.day);
            const dayNames = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
            const dayName = dayNames[Number(exam.day)] || `星期${exam.day || '待定'}`;
            const weekText = exam.week ? `第${exam.week}周 ${dayName}` : dayName;
            const location = exam.location || [exam.campus, exam.building, exam.room].filter(Boolean).join('');
            const row = (label, value) => value
                ? `<div class="exam-info-item"><strong>${label}：</strong><span>${escapeHtml(value)}</span></div>`
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
                } else if (diffDays < 0) {
                    urgencyClass = 'exam-ended';
                    countdownHtml = '<div class="exam-countdown" style="color:var(--ui-subtle, var(--text-tertiary));">已结束</div>';
                }
            }

            html += `
                <div class="exam-card ${urgencyClass}">
                    <div class="exam-course">${escapeHtml(exam.course || '未命名课程')}</div>
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
