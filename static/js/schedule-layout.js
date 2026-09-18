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

function resolveScheduleDinoCue({
    deltaX,
    viewportWidth,
    currentWeek,
    minWeek = 1,
    maxWeek = 25,
}) {
    const offset = Number(deltaX) || 0;
    const distance = Math.abs(offset);
    if (distance < 8) {
        return {
            active: false,
            blocked: false,
            direction: 0,
            progress: 0,
            obstacleProgress: 0,
            crossedObstacle: false,
            targetWeek: currentWeek,
        };
    }

    const direction = offset < 0 ? 1 : -1;
    const requestedWeek = currentWeek + direction;
    const targetWeek = Math.min(maxWeek, Math.max(minWeek, requestedWeek));
    const blocked = targetWeek !== requestedWeek;
    const width = Math.max(Number(viewportWidth) || 0, 1);
    const jumpDistance = Math.min(96, Math.max(48, width * 0.18));
    const progress = Math.min(distance / jumpDistance, 1);
    const roundedProgress = Number(progress.toFixed(3));
    const obstacleProgress = blocked ? Math.min(roundedProgress / 0.55, 1) : roundedProgress / 0.55;

    return {
        active: true,
        blocked,
        direction,
        progress: roundedProgress,
        obstacleProgress: Number(obstacleProgress.toFixed(3)),
        crossedObstacle: !blocked && progress >= 0.55,
        targetWeek,
    };
}

function pickScheduleDinoObstacle(randomValue = Math.random()) {
    const obstacles = ['cactus-single', 'cactus-double', 'rock'];
    const normalized = Math.min(Math.max(Number(randomValue) || 0, 0), 0.999999);
    return obstacles[Math.floor(normalized * obstacles.length)];
}

function resolveScheduleDinoRelease({ hadObstacle, crossedObstacle, shouldChange }) {
    if (!hadObstacle) return 'idle';
    if (shouldChange) return 'complete';
    return crossedObstacle ? 'reverse-jump' : 'fireball';
}

function shouldCrashScheduleDino({ airborne, pointerDown, idleMs, holdThreshold = 600 }) {
    return Boolean(airborne && pointerDown && Number(idleMs) >= holdThreshold);
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

function escapeScheduleHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function buildScheduleCourseDetailHtml(course = {}) {
    const section = Number.parseInt(course.section, 10);
    const duration = Number.parseInt(course.duration, 10) || 1;
    const endSection = section + duration - 1;
    const row = (label, value) => {
        if (value === null || value === undefined || value === '') return '';
        return `<div class="course-detail-row"><span class="course-detail-label">${escapeScheduleHtml(label)}</span><span>${escapeScheduleHtml(value)}</span></div>`;
    };

    return [
        row('课程号', course.code),
        row('教师', course.teacher),
        row('学分', course.credit),
        row('课程属性', course.courseAttribute),
        row('考试类型', course.examType),
        row('修读方式', course.studyMode),
        row('选课状态', course.selectionStatus),
        `<div class="course-detail-row"><span class="course-detail-label">时间</span><span>${escapeScheduleHtml(course.day)} 第${section}-${endSection}节</span></div>`,
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

function escapeHistoricalScheduleHtml(value) {
    return escapeScheduleHtml(value);
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
        resolveScheduleSwipe,
        resolveScheduleButtonSwipe,
        resolveScheduleDinoCue,
        resolveScheduleDinoRelease,
        shouldCrashScheduleDino,
        pickScheduleDinoObstacle,
        buildScheduleCourseCardData,
        buildScheduleCourseDetailHtml,
        buildHistoricalScheduleGridModel,
        buildHistoricalScheduleGridHtml,
    };
}
