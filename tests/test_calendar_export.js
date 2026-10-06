const test = require('node:test');
const assert = require('node:assert/strict');

const {
    getCalendarDate,
    getCalendarChinaToday,
    getCurrentCalendarSemesterStart,
    getCalendarPeriodTime,
    buildScheduleCalendarEvents,
    buildExamCalendarEvents,
    serializeCalendar,
} = require('../static/js/calendar-export.js');
const { buildScheduleCourseDetailHtml } = require('../static/js/schedule-layout.js');

const monday = '2026-09-07';
const periodTimes = [
    { start: '08:20', end: '09:05' },
    { start: '09:15', end: '10:00' },
    { start: '10:15', end: '11:00' },
    { start: '11:10', end: '11:55' },
];

function unfold(ics) {
    return ics.replace(/\r\n /g, '');
}

test('schedule calendar uses each week and class period with full course details', () => {
    const schedule = {
        2: [{
            '课程号': 'MATH101', '课程名': '高等数学', '学分': '4', '教师': '张老师',
            '课程属性': '必修', '考试类型': '闭卷', '修读方式': '正常', '选课状态': '已选',
            '星期': '2', '节次': '3', '节数': '2', '位置': '东校区一教201',
            '校区': '东校区', '教学楼': '一教', '教室': '201',
        }],
    };
    const { events, skipped } = buildScheduleCalendarEvents(schedule, monday, periodTimes);
    const ics = unfold(serializeCalendar(events, '课程表', new Date('2026-09-01T00:00:00Z')));

    assert.equal(skipped, 0);
    assert.equal(events.length, 1);
    assert.match(ics, /DTSTART:20260915T021500Z\r\nDTEND:20260915T035500Z/);
    assert.match(ics, /SUMMARY:高等数学/);
    assert.match(ics, /LOCATION:东校区一教201/);
    for (const detail of ['课程号：MATH101', '教师：张老师', '学分：4', '考试类型：闭卷',
        '修读方式：正常', '选课状态：已选', '周次：第2周', '节次：第3-4节',
        '校区：东校区', '教学楼：一教', '教室：201']) {
        assert.ok(ics.includes(detail), detail);
    }
});

test('exam calendar retains exam type, exact time, campus, room and seat', () => {
    const exams = [{
        exam_name: '期末考试', course: '高等数学', week: '2', day: '5',
        time: '08:30～10:30', location: '东校区一教201',
        campus: '东校区', building: '一教', room: '201', seat: '12',
    }];
    const { events, skipped } = buildExamCalendarEvents(exams, monday);
    const ics = unfold(serializeCalendar(events, '考试安排', new Date('2026-09-01T00:00:00Z')));

    assert.equal(skipped, 0);
    assert.equal(events.length, 1);
    assert.match(ics, /DTSTART:20260918T003000Z\r\nDTEND:20260918T023000Z/);
    assert.match(ics, /SUMMARY:高等数学（期末考试）/);
    for (const detail of ['考试名：期末考试', '课程：高等数学', '日期：2026-09-18',
        '时间：08:30～10:30', '考场：东校区一教201', '座位号：12',
        '校区：东校区', '教学楼：一教', '教室：201']) {
        assert.ok(ics.includes(detail), detail);
    }
});

test('invalid start dates and uncertain event times never create calendar events', () => {
    assert.equal(getCalendarDate('2026-09-08', 1, 1), null);
    assert.equal(getCalendarDate('2026-02-30', 1, 1), null);
    assert.equal(getCalendarPeriodTime(3, 3, periodTimes), null);

    const schedule = { 1: [
        { '课程名': '无效节次', '星期': '1', '节次': '12', '节数': '2' },
        { '课程名': '有效课程', '星期': '1', '节次': '1', '节数': '1' },
    ] };
    const built = buildScheduleCalendarEvents(schedule, monday, periodTimes);
    assert.equal(built.events.length, 1);
    assert.equal(built.skipped, 1);

    const exams = [
        { course: '时间不明', week: '2', day: '1', time: '待定' },
        { course: '结束早于开始', week: '2', day: '1', time: '11:00-10:00' },
    ];
    const result = buildExamCalendarEvents(exams, monday);
    assert.equal(result.events.length, 0);
    assert.equal(result.skipped, 2);
});

test('an expired semester setting is not treated as a current exact date', () => {
    const now = new Date('2026-09-25T12:00:00+08:00');
    assert.equal(getCurrentCalendarSemesterStart('2026-03-02', now), null);
    assert.equal(getCurrentCalendarSemesterStart('2026-09-07', now), '2026-09-07');
    assert.equal(getCurrentCalendarSemesterStart('2026-09-08', now), null);
});

test('calendar day boundaries use China time', () => {
    assert.equal(getCalendarChinaToday(new Date('2026-09-24T16:30:00Z')), '2026-09-25');
    assert.equal(getCalendarChinaToday(new Date('2026-09-25T15:59:00Z')), '2026-09-25');
});

test('ICS text is escaped, folded by UTF-8 bytes, and has stable event ids', () => {
    const event = {
        date: monday, start: '08:20', end: '09:05',
        summary: '课程,名称;测试\\换行\n第二行', location: '一教,201',
        description: `备注：${'中文'.repeat(60)}\n第二行`,
    };
    const first = serializeCalendar([event], '我的,课表', new Date('2026-09-01T00:00:00Z'));
    const second = serializeCalendar([event], '我的,课表', new Date('2026-09-02T00:00:00Z'));
    const lines = first.split('\r\n');
    assert.ok(lines.every(line => Buffer.byteLength(line, 'utf8') <= 75));
    assert.match(unfold(first), /SUMMARY:课程\\,名称\\;测试\\\\换行\\n第二行/);
    assert.match(unfold(first), /X-WR-CALNAME:我的\\,课表/);
    assert.equal(unfold(first).match(/^UID:.*$/m)[0], unfold(second).match(/^UID:.*$/m)[0]);
    assert.match(first, /\r\nEND:VCALENDAR\r\n$/);
});

test('reexporting a class after a room change keeps its calendar identity', () => {
    const course = {
        '课程号': 'MATH101', '课程名': '高等数学',
        '星期': '2', '节次': '1', '节数': '1', '位置': '一教201',
    };
    const before = buildScheduleCalendarEvents({ 2: [course] }, monday, periodTimes).events;
    const after = buildScheduleCalendarEvents({ 2: [{ ...course, '位置': '一教202' }] }, monday, periodTimes).events;
    const uid = events => unfold(serializeCalendar(events, '课程表')).match(/^UID:(.*)$/m)[1];

    assert.equal(uid(before), uid(after));
    assert.notEqual(before[0].location, after[0].location);
});

test('reordering two meetings of the same course keeps each calendar identity', () => {
    const mondayCourse = { '课程号': 'MATH101', '课程名': '高等数学', '星期': '1', '节次': '1', '节数': '2' };
    const thursdayCourse = { ...mondayCourse, '星期': '4', '节次': '3' };
    const before = buildScheduleCalendarEvents({ 2: [mondayCourse, thursdayCourse] }, monday, periodTimes).events;
    const after = buildScheduleCalendarEvents({ 2: [thursdayCourse, mondayCourse] }, monday, periodTimes).events;
    const idsByDate = events => new Map(events.map(event => [event.date, unfold(serializeCalendar([event], '课程表')).match(/^UID:(.*)$/m)[1]]));

    assert.deepEqual(idsByDate(before), idsByDate(after));
});

test('two accounts exporting the same lesson receive different event ids', () => {
    const event = {
        id: 'course:2026-autumn:MATH101:week2', date: monday,
        start: '08:20', end: '09:05', summary: '高等数学',
        location: '一教201', description: '教师：张老师',
    };
    const uid = namespace => unfold(serializeCalendar([event], '课程表', new Date('2026-09-01T00:00:00Z'), namespace))
        .match(/^UID:(.*)$/m)[1];
    assert.notEqual(uid('student-a'), uid('student-b'));
    assert.equal(uid('student-a'), uid('student-a'));
});

test('moving an exam to a new time updates the same calendar event', () => {
    const exam = {
        exam_name: '期末考试', course: '高等数学', week: '2', day: '5',
        time: '08:30-10:30', location: '一教201', seat: '12',
    };
    const before = buildExamCalendarEvents([exam], monday).events;
    const after = buildExamCalendarEvents([{ ...exam, time: '09:30-11:30' }], monday).events;
    const uid = events => unfold(serializeCalendar(events, '考试安排')).match(/^UID:(.*)$/m)[1];

    assert.equal(uid(before), uid(after));
    assert.notEqual(before[0].start, after[0].start);
});

test('course detail shows the exact date and clock time when available', () => {
    const html = buildScheduleCourseDetailHtml({
        name: '高等数学', day: '星期二', week: 2, section: 3, duration: 2,
        date: '2026-09-15', clockTime: '10:15–11:55', teacher: '张老师',
    });
    assert.match(html, /第2周/);
    assert.match(html, /2026-09-15/);
    assert.match(html, /10:15–11:55/);
});
