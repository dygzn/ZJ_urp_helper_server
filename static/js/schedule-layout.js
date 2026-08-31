function setScheduleWeekendVisibility(hasWeekend, scheduleGrid, scheduleHeader) {
    const hideWeekend = !hasWeekend;
    scheduleGrid.classList.toggle('no-weekend', hideWeekend);
    scheduleHeader.classList.toggle('no-weekend', hideWeekend);
}

function buildHistoricalScheduleGridModel(courses) {
    const days = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
    const normalizedCourses = (Array.isArray(courses) ? courses : [])
        .map(course => {
            const day = Number.parseInt(course['星期'], 10);
            const start = Number.parseInt(course['节次'], 10);
            const parsedDuration = Number.parseInt(course['节数'], 10);
            const duration = Number.isInteger(parsedDuration) && parsedDuration > 0 ? parsedDuration : 1;
            if (!Number.isInteger(day) || day < 1 || day > 7 || !Number.isInteger(start) || start < 1) {
                return null;
            }

            return {
                name: String(course['课程名'] || '未命名课程'),
                location: String(course['位置'] || ''),
                classNo: String(course['课序'] || ''),
                day,
                start,
                duration,
                column: day + 1,
                row: start + 1,
                sectionText: duration > 1
                    ? `第${start}-${start + duration - 1}节`
                    : `第${start}节`,
            };
        })
        .filter(Boolean)
        .sort((left, right) => (
            left.day - right.day
            || left.start - right.start
            || left.name.localeCompare(right.name, 'zh-CN')
        ));

    const lastPeriod = normalizedCourses.reduce(
        (maximum, course) => Math.max(maximum, course.start + course.duration - 1),
        10,
    );

    return {
        days,
        periods: Array.from({ length: lastPeriod }, (_, index) => index + 1),
        courses: normalizedCourses,
    };
}

function escapeHistoricalScheduleHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function buildHistoricalScheduleGridHtml(courses) {
    const model = buildHistoricalScheduleGridModel(courses);
    const dayHeaders = model.days.map((day, index) => (
        `<div class="historical-schedule-day-header" style="grid-column: ${index + 2}; grid-row: 1;">${day}</div>`
    )).join('');
    const periodLabels = model.periods.map(period => (
        `<div class="historical-schedule-period" style="grid-column: 1; grid-row: ${period + 1};">第${period}节</div>`
    )).join('');
    const slots = model.periods.map(period => (
        model.days.map((_, dayIndex) => (
            `<div class="historical-schedule-slot" style="grid-column: ${dayIndex + 2}; grid-row: ${period + 1};"></div>`
        )).join('')
    )).join('');
    const courseBlocks = model.courses.map(course => {
        const location = course.location || '地点未提供';
        const classNo = course.classNo ? `<small>课序 ${escapeHistoricalScheduleHtml(course.classNo)}</small>` : '';
        const title = escapeHistoricalScheduleHtml(`${course.name} · ${location} · ${course.sectionText}`);
        return `<article class="historical-schedule-course-block" title="${title}" style="grid-column: ${course.column}; grid-row: ${course.row} / span ${course.duration};"><strong>${escapeHistoricalScheduleHtml(course.name)}</strong><span>${escapeHistoricalScheduleHtml(location)}</span><small>${course.sectionText}</small>${classNo}</article>`;
    }).join('');

    return `<div class="historical-schedule-summary">共 ${model.courses.length} 个课程时段</div><div class="historical-schedule-grid-scroll"><div class="historical-schedule-grid" style="--historical-period-count: ${model.periods.length};"><div class="historical-schedule-grid-corner">节次</div>${dayHeaders}${periodLabels}${slots}${courseBlocks}</div></div>`;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        setScheduleWeekendVisibility,
        buildHistoricalScheduleGridModel,
        buildHistoricalScheduleGridHtml,
    };
}
