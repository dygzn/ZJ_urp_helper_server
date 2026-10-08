import { pageResources } from './lifecycle.js';
import { state } from './store.js';
import { getDeviceId, rememberBoundUsername } from './auth.js';
import { closeUiModal, openUiModal, showUiToast } from './ui.js';
import { PERIOD_TIMES_DEFAULT, PERIOD_TIMES_FRESHMAN } from './schedule.js';
const resources = pageResources('calendar');

export function currentSemesterStartValue() {
    if (!(state.semesterStart instanceof Date) || Number.isNaN(state.semesterStart.getTime())) return '';
    const year = state.semesterStart.getFullYear();
    const month = String(state.semesterStart.getMonth() + 1).padStart(2, '0');
    const day = String(state.semesterStart.getDate()).padStart(2, '0');
    return getCurrentCalendarSemesterStart(`${year}-${month}-${day}`) || '';
}

export async function openCalendarExport(kind) {
    if (kind !== 'schedule' && kind !== 'exams' && kind !== 'all') return;
    const operation = resources.activate();
    const scope = operation;
    if (state.currentPage) pageResources(state.currentPage).addCleanup(() => scope.dispose());
    let generation = state.academicCacheGeneration;
    try {
        const endpoints = kind === 'all' ? ['/api/schedule', '/api/exams']
            : [kind === 'schedule' ? '/api/schedule' : '/api/exams'];
        const replies = await operation.wait(Promise.all(endpoints.map(async url => {
    const operation = resources.capture();
            const response = await operation.wait(resources.fetch(url, { headers: { 'X-Device-ID': getDeviceId() } }));
            return { url, response, payload: await operation.wait(response.json()) };
        })));
        if (generation !== state.academicCacheGeneration) return;
        for (const { response, payload } of replies) {
            if (!response.ok || !payload.success) throw new Error(payload.message || '读取日程数据失败');
        }
        const schedulePayload = replies.find(reply => reply.url === '/api/schedule')?.payload;
        const examPayload = replies.find(reply => reply.url === '/api/exams')?.payload;
        if (schedulePayload?.account && examPayload?.account && schedulePayload.account !== examPayload.account) {
            throw new Error('课表与考试不属于同一账号，请重新登录后重试。');
        }
        const account = String(schedulePayload?.account || examPayload?.account || state.currentUsername || '').trim();
        if (account && account !== state.currentUsername) {
            state.currentUsername = account;
            rememberBoundUsername(account);
            generation = state.academicCacheGeneration;
            document.getElementById('sidebar-username').textContent = account;
        }
        const scheduleStale = !!schedulePayload?.data?.cache_stale && !Object.values(schedulePayload?.data?.schedule || {}).some(courses => courses.some(course => course.source === 'custom'));
        const examStale = !!examPayload?.cache_stale;
        if (kind === 'schedule' && scheduleStale) {
            throw new Error('后台已切换学期，请先更新课程表再导出。');
        }
        if (kind === 'exams' && examStale) {
            throw new Error('后台已切换学期，请先更新考试安排再导出。');
        }
        const scheduleSource = schedulePayload?.data?.schedule;
        const examSource = examPayload?.exams;
        const scheduleStart = schedulePayload?.data?.semester_start;
        const examStart = examPayload?.semester_start;
        const hasSchedule = !!scheduleSource && Object.values(scheduleSource)
            .some(courses => Array.isArray(courses) && courses.length);
        const hasExams = Array.isArray(examSource) && examSource.length > 0;
        const useSchedule = kind !== 'exams' && hasSchedule && !scheduleStale;
        const useExams = kind !== 'schedule' && hasExams && !examStale;
        if (!useSchedule && !useExams) {
            if (scheduleStale || examStale) {
                throw new Error('后台已切换学期，请先更新课程表或考试安排后再导出。');
            }
            throw new Error('暂无可导出的课程或考试安排');
        }
        if (scheduleStart && examStart && scheduleStart !== examStart) {
            throw new Error('课表与考试的学期日期不一致，请重试。');
        }
        const source = kind === 'all' ? {
            schedule: useSchedule ? scheduleSource : {},
            exams: useExams ? examSource : [],
        }
            : kind === 'schedule' ? scheduleSource : examSource;
        const start = useSchedule ? scheduleStart : examStart;
        state.semesterStart = start ? new Date(`${start}T00:00:00`) : null;
        if (typeof schedulePayload?.data?.is_freshman === 'boolean') {
            state.userIsFreshman = schedulePayload.data.is_freshman;
        }
        if (schedulePayload) state.cachedSchedule = scheduleStale ? null : scheduleSource;
        if (examPayload) state.cachedExams = examStale ? null : examSource;

        state.calendarExportKind = kind;
        state.calendarExportData = source;
        state.calendarExportAccount = account;
        document.getElementById('calendar-export-title').textContent = useSchedule && useExams
            ? '导出课表与考试到日历'
            : useSchedule ? '导出课程表到日历' : '导出考试安排到日历';
        const description = kind === 'schedule'
            ? '将全部已缓存的上课时段分别写入日历，并附上教师、地点和课程详情。'
            : kind === 'exams'
                ? '将全部已缓存的考试写入日历，并附上考场、座位号等详情。'
                : useSchedule && useExams
                    ? '将课程和考试写入同一个日历文件，并附上教师、教室、考场和座位号等详情。'
                    : useSchedule
                        ? `当前仅有可导出的课表，将导出课程详情。${examStale ? '考试安排需更新后才能导出。' : ''}`
                        : `当前仅有可导出的考试安排，将导出考场、座位号等详情。${scheduleStale ? '课程表需更新后才能导出。' : ''}`;
        const currentStart = currentSemesterStartValue();
        document.getElementById('calendar-export-description').textContent = currentStart
            ? description
            : `${description} 后台学期日期已过期或未设置，请联系管理员校正；本次导出也可手动输入实际首周星期一。`;
        document.getElementById('calendar-export-start').value = currentStart;
        const error = document.getElementById('calendar-export-error');
        error.textContent = '';
        error.hidden = true;
        if (state.uiModalState.activeModal?.id === 'exams-modal') {
            closeUiModal(state.uiModalState.activeModal);
        }
        openUiModal(document.getElementById('calendar-export-modal'), { initialFocusSelector: '#calendar-export-start' });
    } catch (error) {
        if (error?.name === 'AbortError') return;
        if (generation !== state.academicCacheGeneration) return;
        showUiToast(error.message || '读取日程数据失败', 'error');
    }
}

export function closeCalendarExport() {
    closeUiModal(document.getElementById('calendar-export-modal'));
    state.calendarExportKind = null;
    state.calendarExportData = null;
    state.calendarExportAccount = '';
}

export function unmountCalendar() {
    resources.dispose();
    state.calendarExportKind = null;
    state.calendarExportData = null;
    state.calendarExportAccount = '';
}

export function downloadCalendarExport(event) {
    event.preventDefault();
    const start = document.getElementById('calendar-export-start').value;
    const error = document.getElementById('calendar-export-error');
    const showError = message => {
        error.textContent = message;
        error.hidden = false;
    };
    if (!getCalendarDate(start, 1, 1)) {
        showError('请选择有效的学期首周星期一。');
        return;
    }
    const combinedSchedule = state.calendarExportKind === 'all'
        && Object.values(state.calendarExportData.schedule || {}).some(courses => Array.isArray(courses) && courses.length);
    const combinedExams = state.calendarExportKind === 'all' && state.calendarExportData.exams?.length > 0;
    const name = state.calendarExportKind === 'schedule' || (combinedSchedule && !combinedExams) ? '课程表'
        : state.calendarExportKind === 'exams' || (combinedExams && !combinedSchedule) ? '考试安排' : '课表与考试';
    const periodTimes = state.userIsFreshman ? PERIOD_TIMES_FRESHMAN : PERIOD_TIMES_DEFAULT;
    let result;
    if (state.calendarExportKind === 'schedule') {
        result = buildScheduleCalendarEvents(state.calendarExportData, start, periodTimes);
    } else if (state.calendarExportKind === 'exams') {
        result = buildExamCalendarEvents(state.calendarExportData, start);
    } else {
        const courses = buildScheduleCalendarEvents(state.calendarExportData.schedule, start, periodTimes);
        const exams = buildExamCalendarEvents(state.calendarExportData.exams, start);
        result = {
            events: [...courses.events, ...exams.events]
                .sort((a, b) => `${a.date}${a.start}${a.summary}`.localeCompare(`${b.date}${b.start}${b.summary}`)),
            skipped: courses.skipped + exams.skipped,
        };
    }
    if (!result.events.length) {
        showError('没有可导出的日程，请检查记录中的日期、节次或时间。');
        return;
    }

    const ics = serializeCalendar(result.events, name, new Date(), state.calendarExportAccount);
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${name}-${start}.ics`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    closeCalendarExport();
    const skipped = result.skipped ? `，另有 ${result.skipped} 条时间不完整的记录未导出` : '';
    showUiToast(`已生成 ${result.events.length} 条日程${skipped}`, 'success');
}
