// 日期和时间均按学校所在的中国标准时间解释，导出的日程使用 UTC 时间戳。
function parseCalendarSemesterStart(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1
        || date.getUTCDate() !== day || date.getUTCDay() !== 1) return null;
    return date;
}

function calendarPositiveInteger(value, maximum) {
    const text = String(value ?? '').trim();
    if (!/^\d+$/.test(text)) return null;
    const number = Number(text);
    return Number.isInteger(number) && number >= 1 && number <= maximum ? number : null;
}

function getCalendarDate(semesterStart, week, day) {
    const firstMonday = parseCalendarSemesterStart(semesterStart);
    const weekNumber = calendarPositiveInteger(week, 53);
    const dayNumber = calendarPositiveInteger(day, 7);
    if (!firstMonday || !weekNumber || !dayNumber) return null;
    return new Date(firstMonday.getTime() + ((weekNumber - 1) * 7 + dayNumber - 1) * 86400000)
        .toISOString().slice(0, 10);
}

function getCalendarChinaToday(now = new Date()) {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return null;
    return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}

function getCurrentCalendarSemesterStart(value, now = new Date()) {
    const start = parseCalendarSemesterStart(value);
    const chinaToday = getCalendarChinaToday(now);
    if (!start || !chinaToday) return null;
    const daysFromStart = (Date.parse(`${chinaToday}T00:00:00Z`) - start.getTime()) / 86400000;
    return daysFromStart >= -14 && daysFromStart < 25 * 7 ? String(value) : null;
}

function parseCalendarClock(value) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    return hour <= 23 && minute <= 59 ? hour * 60 + minute : null;
}

function getCalendarPeriodTime(section, duration, periodTimes) {
    if (!Array.isArray(periodTimes)) return null;
    const startSection = calendarPositiveInteger(section, periodTimes.length);
    const count = calendarPositiveInteger(duration, periodTimes.length);
    if (!startSection || !count || startSection + count - 1 > periodTimes.length) return null;
    const start = periodTimes[startSection - 1]?.start;
    const end = periodTimes[startSection + count - 2]?.end;
    const startMinutes = parseCalendarClock(start);
    const endMinutes = parseCalendarClock(end);
    return startMinutes !== null && endMinutes !== null && endMinutes > startMinutes
        ? { start, end } : null;
}

function parseCalendarExamTime(value) {
    const match = /^\s*(\d{1,2}:\d{2})\s*[-—–~～至]\s*(\d{1,2}:\d{2})\s*$/.exec(String(value || ''));
    if (!match) return null;
    const startMinutes = parseCalendarClock(match[1]);
    const endMinutes = parseCalendarClock(match[2]);
    return startMinutes !== null && endMinutes !== null && endMinutes > startMinutes
        ? { start: match[1].padStart(5, '0'), end: match[2].padStart(5, '0') } : null;
}

function calendarDetailLines(pairs) {
    return pairs.filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '')
        .map(([label, value]) => `${label}：${value}`);
}

function buildScheduleCalendarEvents(schedule, semesterStart, periodTimes) {
    const events = [];
    let skipped = 0;
    const occurrences = new Map();
    for (const [week, courses] of Object.entries(schedule || {})) {
        if (!Array.isArray(courses)) continue;
        for (const course of courses) {
            const exactStart = course.start_at && new Date(course.start_at);
            const exactEnd = course.end_at && new Date(course.end_at);
            const chinaParts = date => new Date(date.getTime() + 8 * 3600000).toISOString();
            const exact = course.time_mode !== 'period' && exactStart && exactEnd && Number.isFinite(exactStart.getTime()) && exactEnd > exactStart;
            const date = exact ? chinaParts(exactStart).slice(0,10) : getCalendarDate(semesterStart, week, course['星期']);
            const endDate = exact ? chinaParts(exactEnd).slice(0,10) : date;
            const time = exact ? {start:chinaParts(exactStart).slice(11,16),end:chinaParts(exactEnd).slice(11,16)} : getCalendarPeriodTime(course['节次'], course['节数'], periodTimes);
            const name = String(course['课程名'] || '').trim();
            if (!date || !time || !name) {
                skipped++;
                continue;
            }
            const section = Number(course['节次']);
            const duration = Number(course['节数']);
            const location = course['位置'] || [course['校区'], course['教学楼'], course['教室']].filter(Boolean).join('');
            const identity = JSON.stringify([
                'course', semesterStart, week, course['课程号'] || name,
                course['星期'], course['节次'],
            ]);
            const occurrence = (occurrences.get(identity) || 0) + 1;
            occurrences.set(identity, occurrence);
            events.push({
                id: course.event_id ? JSON.stringify(['course', semesterStart, course.event_id]) : `${identity}:${occurrence}`,
                date, endDate, start: time.start, end: time.end, summary: name, location,
                description: calendarDetailLines([
                    ['课程号', course['课程号']], ['教师', course['教师']], ['学分', course['学分']],
                    ['课程属性', course['课程属性']], ['考试类型', course['考试类型']],
                    ['修读方式', course['修读方式']], ['选课状态', course['选课状态']],
                    ['周次', `第${week}周`], ['星期', `星期${course['星期']}`],
                    ['日期', date], ['节次', section > 0 && duration > 0 ? `第${section}-${section + duration - 1}节` : '自定时间'],
                    ['时间', `${time.start}–${time.end}`], ['地点', location],
                    ['校区', course['校区']], ['教学楼', course['教学楼']], ['教室', course['教室']],
                    ...(course.extra_fields || []).map(field => [field.name, field.value]),
                ]).join('\n'),
            });
        }
    }
    events.sort((a, b) => `${a.date}${a.start}${a.summary}`.localeCompare(`${b.date}${b.start}${b.summary}`));
    return { events, skipped };
}

function buildExamCalendarEvents(exams, semesterStart) {
    const events = [];
    let skipped = 0;
    const occurrences = new Map();
    for (const exam of Array.isArray(exams) ? exams : []) {
        const date = getCalendarDate(semesterStart, exam.week, exam.day);
        const time = parseCalendarExamTime(exam.time);
        const course = String(exam.course || '').trim();
        if (!date || !time || !course) {
            skipped++;
            continue;
        }
        const location = exam.location || [exam.campus, exam.building, exam.room].filter(Boolean).join('');
        const identity = JSON.stringify(['exam', semesterStart, course, exam.exam_name || '']);
        const occurrence = (occurrences.get(identity) || 0) + 1;
        occurrences.set(identity, occurrence);
        events.push({
            id: `${identity}:${occurrence}`,
            date, start: time.start, end: time.end,
            summary: exam.exam_name ? `${course}（${exam.exam_name}）` : `${course}考试`,
            location,
            description: calendarDetailLines([
                ['考试名', exam.exam_name], ['课程', course], ['周次', `第${exam.week}周`],
                ['星期', `星期${exam.day}`], ['日期', date],
                ['时间', `${time.start}～${time.end}`], ['考场', location],
                ['校区', exam.campus], ['教学楼', exam.building], ['教室', exam.room],
                ['座位号', exam.seat],
            ]).join('\n'),
        });
    }
    events.sort((a, b) => `${a.date}${a.start}${a.summary}`.localeCompare(`${b.date}${b.start}${b.summary}`));
    return { events, skipped };
}

function escapeCalendarText(value) {
    return String(value ?? '').replace(/\r\n?|\n/g, '\n').replace(/\\/g, '\\\\')
        .replace(/\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
}

function calendarUtcStamp(date, time) {
    const [year, month, day] = date.split('-').map(Number);
    const [hour, minute] = time.split(':').map(Number);
    return new Date(Date.UTC(year, month - 1, day, hour, minute) - 8 * 3600000)
        .toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function calendarEventId(event, namespace) {
    const bytes = new TextEncoder().encode(JSON.stringify([namespace, event.id || event]));
    let first = 2166136261;
    let second = 1618033989;
    for (const byte of bytes) {
        first = Math.imul(first ^ byte, 16777619) >>> 0;
        second = Math.imul(second ^ byte, 16777619) >>> 0;
    }
    return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}@urp-helper.local`;
}

function foldCalendarLine(line) {
    const encoder = new TextEncoder();
    const folded = [];
    let current = '';
    let bytes = 0;
    for (const character of line) {
        const length = encoder.encode(character).length;
        if (bytes + length > 75) {
            folded.push(current);
            current = ' ';
            bytes = 1;
        }
        current += character;
        bytes += length;
    }
    folded.push(current);
    return folded.join('\r\n');
}

function serializeCalendar(events, name, generatedAt = new Date(), namespace = '') {
    const stamp = generatedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const lines = [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//URP Helper//Calendar Export//ZH',
        'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-TIMEZONE:Asia/Shanghai',
        `X-WR-CALNAME:${escapeCalendarText(name)}`,
    ];
    for (const event of events) {
        lines.push(
            'BEGIN:VEVENT', `UID:${calendarEventId(event, namespace)}`, `DTSTAMP:${stamp}`,
            `DTSTART:${calendarUtcStamp(event.date, event.start)}`,
            `DTEND:${calendarUtcStamp(event.endDate || event.date, event.end)}`,
            `SUMMARY:${escapeCalendarText(event.summary)}`,
            `LOCATION:${escapeCalendarText(event.location)}`,
            `DESCRIPTION:${escapeCalendarText(event.description)}`,
            'END:VEVENT',
        );
    }
    lines.push('END:VCALENDAR');
    return `${lines.map(foldCalendarLine).join('\r\n')}\r\n`;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        getCalendarDate,
        getCalendarChinaToday,
        getCurrentCalendarSemesterStart,
        getCalendarPeriodTime,
        parseCalendarExamTime,
        buildScheduleCalendarEvents,
        buildExamCalendarEvents,
        serializeCalendar,
    };
}
