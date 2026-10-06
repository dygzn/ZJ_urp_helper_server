const { readAppSource } = require('./helpers/app-source');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { installApi } = require('./helpers/browser-api');

function makePage() {
    const classes = () => {
        const names = new Set();
        return { contains: name => names.has(name), remove: name => names.delete(name),
            toggle(name, on) { if (on) names.add(name); else names.delete(name); } };
    };
    const days = { innerHTML: '' };
    const grid = { classList: classes() };
    const header = { classList: classes() };
    const unplaced = { innerHTML: '', hidden: true };
    const panel = { dataset: { week: '1' }, querySelector(selector) {
        return { '.schedule-days': days, '.schedule-grid': grid,
            '.schedule-header': header, '.schedule-unplaced-exams': unplaced }[selector];
    }, querySelectorAll() { return []; } };
    const nodes = new Map([['schedule-message', { style: {}, textContent: '' }],
        ['course-detail-modal', {}], ['course-detail-name', {}], ['course-detail-body', {}]]);
    const document = { addEventListener() {}, querySelector: () => panel,
        getElementById: id => nodes.get(id) || null };
    const context = vm.createContext({ document, window: {}, console, TextEncoder,
        localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} } });
    installApi(context);
    for (const file of ['schedule-layout.js', 'calendar-export.js', 'main.js']) {
        vm.runInContext((file === 'main.js' ? readAppSource() : fs.readFileSync(path.join(__dirname, '../static/js', file), 'utf8')), context);
    }
    context.panel = panel;
    vm.runInContext('openUiModal = () => {};', context);
    return { context, panel, days, grid, header, unplaced, nodes };
}

const exam = { exam_name: '2026秋学期补考', course: '高等数学A（Ⅱ）-66',
    week: '1', day: '6', time: '08:00-10:00', location: '仙林校区教B-106',
    campus: '仙林校区', building: '教B', room: '-106', seat: '50' };

for (const [freshman, clock] of [[false, '08:20-10:00'], [true, '08:00-09:40']]) {
    test(`desktop course clock respects ${freshman ? 'freshman' : 'default'} teaching hours`, () => {
        const { context, days } = makePage();
        context.freshman = freshman;
        vm.runInContext(`userIsFreshman = freshman; renderScheduleWeek({ 1: [
            { '课程名': '高等数学', '星期': '1', '节次': '1', '节数': '2', '位置': 'A201' }
        ] }, panel);`, context);
        assert.match(days.innerHTML, new RegExp(clock));
    });
}

test('an exam-only week renders the real Saturday exam and reveals the weekend', () => {
    const { context, days, grid, header } = makePage();
    context.exams = [exam];
    vm.runInContext('cachedScheduleExams = exams; renderScheduleWeek({}, panel);', context);
    assert.match(days.innerHTML, /高等数学A（Ⅱ）-66/);
    assert.match(days.innerHTML, /08:00-10:00/);
    assert.match(days.innerHTML, /仙林校区教B-106/);
    assert.match(days.innerHTML, /schedule-exam-card/);
    assert.equal(grid.classList.contains('no-weekend'), false);
    assert.equal(header.classList.contains('no-weekend'), false);
    context.panel.dataset.week = '2';
    vm.runInContext('renderScheduleWeek({}, panel);', context);
    assert.doesNotMatch(days.innerHTML, /高等数学/);
    assert.equal(grid.classList.contains('no-weekend'), true);
});

test('exam detail retains the actual clock, seat and location without claiming class periods', () => {
    const { context, nodes } = makePage();
    context.exams = [exam];
    vm.runInContext('cachedScheduleExams = exams; renderScheduleWeek({}, panel);', context);
    const html = vm.runInContext('panel.querySelector(".schedule-days").innerHTML', context);
    const courseId = /data-course-id="([^"]+)"/.exec(html)?.[1];
    assert.ok(courseId, 'exam has a clickable detail reference');
    context.element = { dataset: { courseId, day: '6' }, closest: () => context.panel };
    vm.runInContext("semesterStart = new Date('2026-09-07T00:00:00'); showCourseDetail(element);", context);
    const detail = nodes.get('course-detail-body').innerHTML;
    assert.match(detail, /2026秋学期补考/);
    assert.match(detail, /08:00-10:00/);
    assert.match(detail, /座位号/);
    assert.match(detail, /50/);
    assert.match(detail, /2026-09-12/);
    assert.doesNotMatch(detail, /第\d+-\d+节/);
});

test('course details use compact references and retain large, escaped fields', () => {
    const { context, days, nodes } = makePage();
    context.courses = [{ '课程名': '<数学 & "讨论">', '星期': '1', '节次': '1', '节数': '2',
        '教师': '长名字'.repeat(2000), '学分': 0 }];
    vm.runInContext('renderScheduleWeek({ 1: courses }, panel);', context);
    assert.doesNotMatch(days.innerHTML, /data-course=|长名字/);
    assert.match(days.innerHTML, /&lt;数学 &amp; &quot;讨论&quot;&gt;/);
    const courseId = /data-course-id="([^"]+)"/.exec(days.innerHTML)?.[1];
    assert.ok(courseId && courseId.length < 100);
    context.element = { dataset: { courseId, day: '1' }, closest: () => context.panel };
    vm.runInContext('showCourseDetail(element)', context);
    assert.equal(nodes.get('course-detail-name').textContent, '<数学 & "讨论">');
    assert.match(nodes.get('course-detail-body').innerHTML, /长名字/);
    assert.match(nodes.get('course-detail-body').innerHTML, /学分<\/span><span>0<\/span>/);
});

test('duplicate courses and adjacent weeks retain independent detail references', () => {
    const { context, days, nodes } = makePage();
    const ids = [];
    for (const week of [1, 2, 3]) {
        context.panel.dataset.week = String(week);
        context.courses = ['甲', '乙'].map(teacher => ({ '课程名': '数学', '星期': '1',
            '节次': '1', '节数': '2', '教师': `${teacher}${week}` }));
        vm.runInContext('renderScheduleWeek({ 1: courses }, panel);', context);
        ids.push(...[...days.innerHTML.matchAll(/data-course-id="([^"]+)"/g)].map(match => match[1]));
    }
    assert.equal(new Set(ids).size, 6);
    ids.forEach((courseId, index) => {
        context.element = { dataset: { courseId, day: '1' }, closest: () => context.panel };
        vm.runInContext('showCourseDetail(element)', context);
        assert.match(nodes.get('course-detail-body').innerHTML, new RegExp(`${index % 2 ? '乙' : '甲'}${Math.floor(index / 2) + 1}`));
    });
});

test('resetting the schedule discards references and ignores stale detail clicks', () => {
    const { context, days, nodes } = makePage();
    vm.runInContext("renderScheduleWeek({ 1: [{ '课程名': '旧课程', '星期': '1', '节次': '1' }] }, panel)", context);
    const courseId = /data-course-id="([^"]+)"/.exec(days.innerHTML)?.[1];
    assert.ok(courseId);
    context.element = { dataset: { courseId, day: '1' }, closest: () => context.panel };
    vm.runInContext('resetScheduleDisplay()', context);
    assert.doesNotThrow(() => vm.runInContext('showCourseDetail(element)', context));
    assert.equal(nodes.get('course-detail-body').innerHTML, undefined);
    assert.equal(vm.runInContext('currentScheduleMap.size', context), 0);
});

test('redrawing a schedule bounds the map and never reuses stale card references', () => {
    const { context, days, nodes } = makePage();
    vm.runInContext("displaySchedule({ 1: [{ '课程名': '旧课程', '星期': '1', '节次': '1' }] })", context);
    const courseId = /data-course-id="([^"]+)"/.exec(days.innerHTML)?.[1];
    assert.ok(courseId);
    vm.runInContext("displaySchedule({ 1: [{ '课程名': '新课程', '星期': '1', '节次': '1' }] })", context);
    assert.equal(vm.runInContext('currentScheduleMap.size', context), 1);
    context.element = { dataset: { courseId }, closest: () => context.panel };
    vm.runInContext('showCourseDetail(element)', context);
    assert.equal(nodes.get('course-detail-body').innerHTML, undefined);
    vm.runInContext("rememberBoundUsername('another-student')", context);
    assert.equal(vm.runInContext('currentScheduleMap.size', context), 0);
});

test('unplaced exam summaries resolve details from memory', () => {
    const { context, unplaced, nodes } = makePage();
    context.exams = [{ ...exam, time: '待定' }];
    vm.runInContext('cachedScheduleExams = exams; renderScheduleWeek({}, panel)', context);
    assert.doesNotMatch(unplaced.innerHTML, /data-course=/);
    const courseId = /data-course-id="([^"]+)"/.exec(unplaced.innerHTML)?.[1];
    assert.ok(courseId);
    context.element = { dataset: { courseId, day: '6' }, closest: () => context.panel };
    vm.runInContext('showCourseDetail(element)', context);
    assert.match(nodes.get('course-detail-body').innerHTML, /待定/);
    assert.match(nodes.get('course-detail-body').innerHTML, /座位号/);
});

test('overlapping courses and exams remain visible in separate lanes', () => {
    const { context, days, unplaced } = makePage();
    context.exams = [{ ...exam, day: '1' }];
    vm.runInContext(`cachedScheduleExams = exams; renderScheduleWeek({ 1: [
        { '课程名': '软件工程导论', '星期': '1', '节次': '1', '节数': '2' }
    ] }, panel);`, context);
    assert.match(days.innerHTML, /软件工程导论/);
    assert.match(days.innerHTML, /高等数学/);
    assert.match(days.innerHTML, /--schedule-event-lanes: 2/);
    assert.match(days.innerHTML, /--schedule-event-lane: 1/);
    assert.equal(unplaced.hidden, false);
    assert.match(unplaced.innerHTML, /08:00-10:00/);
    assert.match(unplaced.innerHTML, /同一时段/);
});

test('switching accounts clears the personal exam overlay', () => {
    const { context, days } = makePage();
    context.exams = [exam];
    vm.runInContext("rememberBoundUsername('student-a'); cachedScheduleExams = exams; rememberBoundUsername('student-b'); renderScheduleWeek({}, panel);", context);
    assert.doesNotMatch(days.innerHTML, /高等数学/);
});

test('an evening exam reveals evening rows using the freshman timetable', () => {
    const { context, days, grid } = makePage();
    context.exams = [{ ...exam, time: '18:30-20:10' }];
    vm.runInContext('userIsFreshman = true; cachedScheduleExams = exams; renderScheduleWeek({}, panel);', context);
    assert.equal(grid.classList.contains('has-evening'), true);
    assert.match(days.innerHTML, /grid-row: 9 \/ span 2/);
    assert.match(days.innerHTML, /18:30-20:10/);
});

test('unknown or out-of-hours exam times are retained below the grid', () => {
    const { context, unplaced } = makePage();
    context.exams = [{ ...exam, time: '待定' }, { ...exam, course: '午间考试', time: '12:10-13:10' }];
    vm.runInContext('cachedScheduleExams = exams; renderScheduleWeek({}, panel);', context);
    assert.equal(unplaced.hidden, false);
    assert.match(unplaced.innerHTML, /待定/);
    assert.match(unplaced.innerHTML, /午间考试/);
    assert.match(unplaced.innerHTML, /12:10-13:10/);
});

test('another class schedule never includes the personal exams', () => {
    const { context, days } = makePage();
    context.exams = [exam];
    vm.runInContext('cachedScheduleExams = exams; otherMajorScheduleData = {}; renderScheduleWeek({}, panel);', context);
    assert.doesNotMatch(days.innerHTML, /高等数学/);
});

for (const stale of [false, true]) {
    test(`loading a course-free week ${stale ? 'ignores stale' : 'shows fresh'} exam data`, async () => {
        const { context, nodes } = makePage();
        context.fetch = async () => ({ json: async () => ({ success: true, account: 'student', data: {
            schedule: {}, exams: [exam], exams_cache_stale: stale, semester_start: '2026-09-07',
        } }) });
        vm.runInContext(`currentUsername = 'student'; getDeviceId = () => 'device';
            resetScheduleDisplay = () => {}; updateScheduleDates = () => {};
            displaySchedule = () => { window.didRender = true; };`, context);
        await vm.runInContext('loadSchedule(1, true)', context);
        assert.equal(context.window.didRender === true, !stale);
        if (!stale) assert.doesNotMatch(nodes.get('schedule-message').textContent, /没有课程|暂无课程/);
    });
}
