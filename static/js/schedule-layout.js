function setScheduleWeekendVisibility(hasWeekend, scheduleGrid, scheduleHeader) {
    const hideWeekend = !hasWeekend;
    scheduleGrid.classList.toggle('no-weekend', hideWeekend);
    scheduleHeader.classList.toggle('no-weekend', hideWeekend);
}

function resolveScheduleSwipe({
    deltaX,
    duration,
    viewportWidth,
    currentWeek,
    minWeek = 1,
    maxWeek = 25,
}) {
    const distance = Math.abs(Number(deltaX) || 0);
    const elapsed = Math.max(Number(duration) || 0, 1);
    const width = Math.max(Number(viewportWidth) || 0, 1);
    const distanceThreshold = Math.min(96, Math.max(48, width * 0.18));
    const velocityThreshold = 0.45;
    const isCommitted = distance >= distanceThreshold
        || (distance >= 24 && distance / elapsed >= velocityThreshold);

    if (!isCommitted) {
        return { shouldChange: false, direction: 0, week: currentWeek };
    }

    const direction = deltaX < 0 ? 1 : -1;
    const nextWeek = Math.min(maxWeek, Math.max(minWeek, currentWeek + direction));
    if (nextWeek === currentWeek) {
        return { shouldChange: false, direction: 0, week: currentWeek };
    }

    return { shouldChange: true, direction, week: nextWeek };
}

function resolveScheduleActionPull(distance, threshold = 170) {
    const pull = Math.max(0, Number(distance) || 0);
    const limit = Math.max(1, Number(threshold) || 170);
    const progress = Math.min(pull / limit, 1);
    return {
        offset: Math.round(68 * progress),
        progress,
        shouldOpen: pull >= limit,
    };
}

function scheduleCourseGridPlacement(section, duration) {
    const start = Math.max(1, Math.trunc(Number(section) || 1));
    const span = Math.max(1, Math.trunc(Number(duration) || 1));
    return `grid-row: ${start} / span ${span}; grid-column: 1;`;
}

function resolveScheduleButtonSwipe({
    delta,
    currentWeek,
    minWeek = 1,
    maxWeek = 25,
}) {
    const direction = Math.sign(Number(delta) || 0);
    if (Math.abs(Number(delta)) !== 1 || direction === 0) {
        return { shouldChange: false, direction: 0, week: currentWeek };
    }

    const nextWeek = Math.min(maxWeek, Math.max(minWeek, currentWeek + direction));
    if (nextWeek === currentWeek) {
        return { shouldChange: false, direction: 0, week: currentWeek };
    }

    return { shouldChange: true, direction, week: nextWeek };
}

function buildScheduleCourseCardData(course, day) {
    const source = course || {};
    const dayNumber = Number.parseInt(day, 10);
    const section = Number.parseInt(source['节次'], 10);
    const duration = Number.parseInt(source['节数'], 10) || 1;
    const dayNames = ['', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];

    return {
        code: String(source['课程号'] ?? ''),
        name: String(source['课程名'] ?? ''),
        credit: String(source['学分'] ?? ''),
        teacher: String(source['教师'] ?? ''),
        courseAttribute: String(source['课程属性'] ?? ''),
        examType: String(source['考试类型'] ?? ''),
        studyMode: String(source['修读方式'] ?? ''),
        selectionStatus: String(source['选课状态'] ?? ''),
        day: dayNames[dayNumber] || `星期${dayNumber}`,
        section,
        duration,
        location: String(source['位置'] ?? ''),
        campus: String(source['校区'] ?? ''),
        building: String(source['教学楼'] ?? ''),
        room: String(source['教室'] ?? ''),
    };
}

// 考试使用真实钟点，网格只借用与其相交的节次行，不将考试时间换成上课时间。
function buildScheduleExamCardData(exam, periodTimes) {
    const time = parseCalendarExamTime(exam.time);
    const sections = [];
    if (time) {
        const start = parseCalendarClock(time.start);
        const end = parseCalendarClock(time.end);
        periodTimes.forEach((period, index) => {
            if (start < parseCalendarClock(period.end) && end > parseCalendarClock(period.start)) {
                sections.push(index + 1);
            }
        });
    }
    const dayNumber = Number(exam.day);
    const days = ['', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
    return {
        kind: 'exam', name: String(exam.course || '未命名考试'),
        examName: String(exam.exam_name || '考试'), week: Number(exam.week),
        day: days[dayNumber] || '星期待定', dayNumber,
        time: time ? `${time.start}-${time.end}` : String(exam.time || '时间待定'),
        section: sections[0] || null,
        duration: sections.length ? sections.at(-1) - sections[0] + 1 : 0,
        location: String(exam.location || [exam.campus, exam.building, exam.room].filter(Boolean).join('')),
        campus: String(exam.campus ?? ''), building: String(exam.building ?? ''),
        room: String(exam.room ?? ''), seat: String(exam.seat ?? ''),
    };
}

function buildScheduleDayCardLayout(cards) {
    const sorted = cards.slice().sort((a, b) => a.section - b.section || b.duration - a.duration);
    let group = [];
    let groupEnd = 0;
    const result = [];
    const flush = () => {
        const laneEnds = [];
        const placed = group.map(card => {
            let lane = laneEnds.findIndex(end => end <= card.section);
            if (lane < 0) lane = laneEnds.length;
            laneEnds[lane] = card.section + card.duration;
            return { ...card, lane };
        });
        result.push(...placed.map(card => ({ ...card, lanes: laneEnds.length })));
        group = [];
    };
    for (const card of sorted) {
        if (group.length && card.section >= groupEnd) flush();
        if (!group.length) groupEnd = 0;
        group.push(card);
        groupEnd = Math.max(groupEnd, card.section + card.duration);
    }
    flush();
    return result;
}

function buildScheduleExamDetailHtml(exam = {}) {
    const rows = [
        ['日期', exam.date], ['时间', exam.time], ['考试位置', exam.location],
        ['周次', `第${exam.week}周 ${exam.day}`], ['考试名', exam.examName],
        ['校区', exam.campus], ['教学楼', exam.building], ['教室', exam.room], ['座位号', exam.seat],
    ];
    return rows.filter(([, value]) => value !== null && value !== undefined && value !== '')
        .map(([label, value]) => `<div class="course-detail-row"><span class="course-detail-label">${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`)
        .join('\n');
}

// 用户端共享的文本及双引号 HTML 属性转义；空值为空串，保留 0 和 false。
const htmlEntities = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => htmlEntities[character]);
}

function buildScheduleCourseDetailHtml(course = {}) {
    const section = Number.parseInt(course.section, 10);
    const duration = Number.parseInt(course.duration, 10) || 1;
    const endSection = section + duration - 1;
    const row = (label, value) => {
        if (value === null || value === undefined || value === '') return '';
        return `<div class="course-detail-row"><span class="course-detail-label">${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`;
    };

    return [
        row('课程号', course.code),
        row('教师', course.teacher),
        row('学分', course.credit),
        row('课程属性', course.courseAttribute),
        row('考试类型', course.examType),
        row('修读方式', course.studyMode),
        row('选课状态', course.selectionStatus),
        row('日期', course.date),
        `<div class="course-detail-row"><span class="course-detail-label">时间</span><span>${course.week ? `第${escapeHtml(course.week)}周 ` : ''}${escapeHtml(course.day)} 第${section}-${endSection}节${course.clockTime ? `（${escapeHtml(course.clockTime)}）` : ''}</span></div>`,
        row('地点', course.location),
        row('校区', course.campus),
        row('教学楼', course.building),
        row('教室', course.room),
    ].filter(Boolean).join('\n');
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
        const classNo = course.classNo ? `<small>课序 ${escapeHtml(course.classNo)}</small>` : '';
        const title = escapeHtml(`${course.name} · ${location} · ${course.sectionText}`);
        return `<article class="historical-schedule-course-block" title="${title}" style="grid-column: ${course.column}; grid-row: ${course.row} / span ${course.duration};"><strong>${escapeHtml(course.name)}</strong><span>${escapeHtml(location)}</span><small>${course.sectionText}</small>${classNo}</article>`;
    }).join('');

    return `<div class="historical-schedule-summary">共 ${model.courses.length} 个课程时段</div><div class="historical-schedule-grid-scroll"><div class="historical-schedule-grid" style="--historical-period-count: ${model.periods.length};"><div class="historical-schedule-grid-corner">节次</div>${dayHeaders}${periodLabels}${slots}${courseBlocks}</div></div>`;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        escapeHtml,
        setScheduleWeekendVisibility,
        resolveScheduleSwipe,
        resolveScheduleButtonSwipe,
        buildScheduleCourseCardData,
        buildScheduleCourseDetailHtml,
        buildHistoricalScheduleGridModel,
        buildHistoricalScheduleGridHtml,
    };
}
