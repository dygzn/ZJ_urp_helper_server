const { readAppSource } = require('./helpers/app-source');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { installApi } = require('./helpers/browser-api');

function createPage(DateImpl = Date) {
    const nodes = new Map();
    const document = {
        readyState: 'loading',
        addEventListener() {},
        getElementById(id) {
            if (!nodes.has(id)) nodes.set(id, { textContent: '', value: '', hidden: false, style: {} });
            return nodes.get(id);
        },
    };
    const storage = new Map();
    const localStorage = {
        getItem(key) { return storage.get(key) ?? null; },
        setItem(key, value) { storage.set(key, String(value)); },
        removeItem(key) { storage.delete(key); },
    };
    const context = vm.createContext({ document, localStorage, window: {}, console, TextEncoder, Date: DateImpl });
    installApi(context);
    for (const filename of ['schedule-layout.js', 'calendar-export.js', 'main.js']) {
        vm.runInContext((filename === 'main.js' ? readAppSource() : fs.readFileSync(path.join(__dirname, '../static/js', filename), 'utf8')), context, { filename });
    }
    vm.runInContext('openUiModal = () => {}; showUiToast = () => {}; getDeviceId = () => "device";', context);
    return { context, nodes };
}

test('changing the bound account clears private schedule and exam caches', () => {
    const { context } = createPage();
    vm.runInContext(`
        rememberBoundUsername('student-a');
        cachedSchedule = { 1: [{ '课程名': '账号A的课程' }] };
        cachedExams = [{ course: '账号A的考试', seat: '12' }];
        semesterStart = new Date('2026-09-07T00:00:00');
        rememberBoundUsername('student-b');
    `, context);

    assert.equal(vm.runInContext('cachedSchedule', context), null);
    assert.equal(vm.runInContext('cachedExams', context), null);
    assert.equal(vm.runInContext('semesterStart', context), null);
});

test('calendar export fetches the currently bound account even when a cache exists', async () => {
    const { context, nodes } = createPage();
    let requests = 0;
    context.fetch = async url => {
        requests++;
        assert.equal(url, '/api/schedule');
        return {
            ok: true,
            json: async () => ({
                success: true,
                account: 'student-b',
                data: {
                    semester_start: '2026-09-07', is_freshman: false,
                    schedule: { 1: [{ '课程名': '账号B的课程', '星期': '1', '节次': '1', '节数': '2' }] },
                },
            }),
        };
    };
    vm.runInContext(`
        currentUsername = 'student-a';
        rememberBoundUsername('student-a');
        cachedSchedule = { 1: [{ '课程名': '账号A的课程' }] };
    `, context);

    await vm.runInContext("openCalendarExport('schedule')", context);

    assert.equal(requests, 1);
    assert.equal(vm.runInContext("calendarExportData['1'][0]['课程名']", context), '账号B的课程');
    assert.equal(nodes.get('calendar-export-start').value, '2026-09-07');
});

test('a response from the previous account cannot reopen the export dialog', async () => {
    const { context } = createPage();
    let respond;
    context.fetch = () => new Promise(resolve => { respond = resolve; });
    vm.runInContext("currentUsername = 'student-a'; rememberBoundUsername('student-a');", context);
    const pending = vm.runInContext("openCalendarExport('schedule')", context);
    vm.runInContext("currentUsername = 'student-b'; rememberBoundUsername('student-b');", context);
    respond({
        ok: true,
        json: async () => ({
            success: true, account: 'student-a',
            data: {
                semester_start: '2026-09-07', is_freshman: false,
                schedule: { 1: [{ '课程名': '旧账号课程', '星期': '1', '节次': '1', '节数': '2' }] },
            },
        }),
    });
    await pending;

    assert.equal(vm.runInContext('calendarExportData', context), null);
    assert.equal(vm.runInContext('cachedSchedule', context), null);
    assert.equal(vm.runInContext('currentUsername', context), 'student-b');
});

test('a stale schedule response cannot refill the old account cache', async () => {
    const { context } = createPage();
    let respond;
    context.fetch = () => new Promise(resolve => { respond = resolve; });
    vm.runInContext(`
        currentUsername = 'student-a'; rememberBoundUsername('student-a');
        updateScheduleDates = () => {}; displaySchedule = () => {}; resetScheduleDisplay = () => {};
    `, context);
    const pending = vm.runInContext('loadSchedule(null, true)', context);
    vm.runInContext("currentUsername = 'student-b'; rememberBoundUsername('student-b');", context);
    respond({
        json: async () => ({
            success: true, data: {
                semester_start: '2026-09-07', is_freshman: false,
                schedule: { 1: [{ '课程名': '旧账号课程', '星期': '1', '节次': '1', '节数': '2' }] },
            },
        }),
    });
    await pending;

    assert.equal(vm.runInContext('cachedSchedule', context), null);
});

test('a stale exam response cannot refill the old account cache', async () => {
    const { context } = createPage();
    let respond;
    context.fetch = () => new Promise(resolve => { respond = resolve; });
    vm.runInContext("currentUsername = 'student-a'; rememberBoundUsername('student-a');", context);
    const pending = vm.runInContext('loadExams(true)', context);
    vm.runInContext("currentUsername = 'student-b'; rememberBoundUsername('student-b');", context);
    respond({
        json: async () => ({
            success: true, semester_start: '2026-09-07',
            exams: [{ exam_name: '期末考试', course: '旧账号考试', week: '2', day: '5', time: '08:30-10:30' }],
        }),
    });
    await pending;

    assert.equal(vm.runInContext('cachedExams', context), null);
});

test('exam details do not show an exact date from an expired semester setting', () => {
    class FixedDate extends Date {
        constructor(...args) {
            super(...(args.length ? args : ['2026-09-25T04:00:00Z']));
        }
    }
    const { context, nodes } = createPage(FixedDate);
    vm.runInContext(`
        semesterStart = new Date('2026-03-02T00:00:00');
        displayExams([{ exam_name: '期末考试', course: '高等数学', week: '2', day: '5', time: '08:30-10:30' }]);
    `, context);

    assert.match(nodes.get('exams-content').innerHTML, /学期起始日期待核对/);
    assert.ok(!nodes.get('exams-content').innerHTML.includes('2026-03-13'));
});

test('an expired backend semester date prompts an admin correction on the schedule page', async () => {
    class FixedDate extends Date {
        constructor(...args) {
            super(...(args.length ? args : ['2026-09-25T04:00:00Z']));
        }
    }
    const { context, nodes } = createPage(FixedDate);
    vm.runInContext(`
        currentUsername = 'student-a'; rememberBoundUsername('student-a');
        semesterStart = new Date('2026-03-02T00:00:00');
        cachedSchedule = { 1: [{ '课程名': '高等数学' }] };
        updateScheduleDates = () => {}; displaySchedule = () => {};
    `, context);
    await vm.runInContext('loadSchedule(1)', context);
    assert.match(nodes.get('schedule-message').textContent, /请管理员在后台设置/);
});

test('refreshing the schedule reloads a semester date changed in admin settings', async () => {
    class FixedDate extends Date {
        constructor(...args) {
            super(...(args.length ? args : ['2026-09-25T04:00:00Z']));
        }
    }
    const { context } = createPage(FixedDate);
    vm.runInContext(`
        currentUsername = 'student-a'; rememberBoundUsername('student-a');
        semesterStart = new Date('2026-03-02T00:00:00');
        cachedSchedule = { 1: [{ '课程名': '旧课表' }] };
        updateScheduleDates = () => {}; displaySchedule = () => {};
    `, context);
    let requests = 0;
    context.fetch = async () => {
        requests++;
        return {
            json: async () => ({
                success: true, account: 'student-a',
                data: {
                    semester_start: '2026-09-07', is_freshman: false,
                    schedule: { 3: [{ '课程名': '新课表' }] },
                },
            }),
        };
    };
    await vm.runInContext('refreshScheduleDisplay()', context);
    assert.equal(requests, 1);
    assert.equal(vm.runInContext('currentSemesterStartValue()', context), '2026-09-07');
});

test('a schedule cache from before the admin semester change is not shown', async () => {
    const { context, nodes } = createPage();
    vm.runInContext("currentUsername = 'student-a'; rememberBoundUsername('student-a'); resetScheduleDisplay = () => {};", context);
    context.fetch = async () => ({
        json: async () => ({
            success: true, account: 'student-a',
            data: {
                semester_start: '2026-09-07', cache_stale: true,
                schedule: { 1: [{ '课程名': '上学期课程' }] },
            },
        }),
    });
    await vm.runInContext('loadSchedule()', context);
    assert.equal(vm.runInContext('cachedSchedule', context), null);
    assert.match(nodes.get('schedule-message').textContent, /更新课程表/);
});

test('an old exam cache cannot be shown or exported after a semester change', async () => {
    const { context, nodes } = createPage();
    vm.runInContext("currentUsername = 'student-a'; rememberBoundUsername('student-a');", context);
    context.fetch = async () => ({
        ok: true,
        json: async () => ({
            success: true, account: 'student-a', cache_stale: true,
            semester_start: '2026-09-07',
            exams: [{ exam_name: '期末考试', course: '上学期课程', week: '2', day: '5', time: '08:30-10:30' }],
        }),
    });
    await vm.runInContext('loadExams()', context);
    assert.equal(vm.runInContext('cachedExams', context), null);
    assert.match(nodes.get('exams-content').innerHTML, /更新考试安排/);
    await vm.runInContext("openCalendarExport('exams')", context);
    assert.equal(vm.runInContext('calendarExportData', context), null);
});

test('the home page warns when its course and exam caches belong to the previous semester', async () => {
    const { context, nodes } = createPage();
    const notices = [];
    const content = context.document.getElementById('urgent-content');
    content.prepend = node => notices.push(node.textContent);
    context.document.createElement = () => ({ textContent: '', className: '' });
    context.fetch = async () => ({
        json: async () => ({
            success: true,
            event: {
                current: null, next: null, upcoming: [], is_freshman: false,
                schedule_cache_stale: true, exams_cache_stale: true,
            },
        }),
    });
    vm.runInContext('checkLoginStatus = () => {}; updateScheduleTimeline = () => {}; displayUrgentEvent = () => {};', context);
    await vm.runInContext('loadUrgentEvent()', context);
    assert.match(notices.join(' '), /更新课程表/);
    assert.match(notices.join(' '), /更新考试安排/);
});

test('the home page asks for admin correction when the semester date is invalid', async () => {
    const { context, nodes } = createPage();
    const notices = [];
    const content = context.document.getElementById('urgent-content');
    content.prepend = node => notices.push(node.textContent);
    context.document.createElement = () => ({ textContent: '', className: '' });
    context.fetch = async () => ({
        json: async () => ({
            success: true,
            event: {
                current: null, next: null, upcoming: [], is_freshman: false,
                semester_start_invalid: true,
            },
        }),
    });
    vm.runInContext('checkLoginStatus = () => {}; updateScheduleTimeline = () => {}; displayUrgentEvent = () => {};', context);
    await vm.runInContext('loadUrgentEvent()', context);
    assert.match(notices.join(' '), /学期起始日期无效/);
    assert.equal(nodes.get('urgent-content').textContent, '');
});

test('the download action creates a detailed ICS file from the backend schedule', async () => {
    class FixedDate extends Date {
        constructor(...args) {
            super(...(args.length ? args : ['2026-09-25T04:00:00Z']));
        }
    }
    const { context, nodes } = createPage(FixedDate);
    let downloaded = null;
    let filename = '';
    context.Blob = class {
        constructor(parts) { this.parts = parts; }
    };
    context.URL = {
        createObjectURL(blob) { downloaded = blob.parts.join(''); return 'blob:calendar'; },
        revokeObjectURL() {},
    };
    context.document.body = { appendChild() {} };
    context.document.createElement = () => ({
        set download(value) { filename = value; },
        click() {}, remove() {},
    });
    context.window.setTimeout = callback => callback();
    context.fetch = async () => ({
        ok: true,
        json: async () => ({
            success: true, account: 'student-a',
            data: {
                semester_start: '2026-09-07', is_freshman: false,
                schedule: { 2: [{
                    '课程号': 'MATH101', '课程名': '高等数学', '教师': '张老师',
                    '星期': '2', '节次': '3', '节数': '2', '位置': '一教201',
                }] },
            },
        }),
    });
    vm.runInContext("closeUiModal = () => {}; currentUsername = 'student-a'; rememberBoundUsername('student-a');", context);
    await vm.runInContext("openCalendarExport('schedule')", context);
    vm.runInContext('downloadCalendarExport({ preventDefault() {} })', context);

    assert.equal(nodes.get('calendar-export-start').value, '2026-09-07');
    assert.equal(filename, '课程表-2026-09-07.ics');
    assert.match(downloaded, /BEGIN:VCALENDAR\r\n/);
    assert.match(downloaded.replace(/\r\n /g, ''), /教师：张老师/);
    assert.match(downloaded.replace(/\r\n /g, ''), /DTSTART:20260915T021500Z/);
});

test('one download contains both course meetings and exams from the same semester', async () => {
    class FixedDate extends Date {
        constructor(...args) {
            super(...(args.length ? args : ['2026-09-25T04:00:00Z']));
        }
    }
    const { context, nodes } = createPage(FixedDate);
    const requests = [];
    let downloaded = '';
    let filename = '';
    context.fetch = async url => {
        requests.push(url);
        const payload = url === '/api/schedule'
            ? {
                success: true, account: 'student-a',
                data: {
                    semester_start: '2026-09-07', is_freshman: false, cache_stale: false,
                    schedule: { 2: [{
                        '课程号': 'MATH101', '课程名': '高等数学', '教师': '张老师',
                        '星期': '2', '节次': '3', '节数': '2', '位置': '一教201',
                    }] },
                },
            }
            : {
                success: true, account: 'student-a', cache_stale: false,
                semester_start: '2026-09-07',
                exams: [{
                    exam_name: '期末考试', course: '高等数学', week: '2', day: '5',
                    time: '08:30-10:30', location: '一教201', seat: '12',
                }],
            };
        return { ok: true, json: async () => payload };
    };
    context.Blob = class { constructor(parts) { this.parts = parts; } };
    context.URL = {
        createObjectURL(blob) { downloaded = blob.parts.join(''); return 'blob:calendar'; },
        revokeObjectURL() {},
    };
    context.document.body = { appendChild() {} };
    context.document.createElement = () => ({
        set download(value) { filename = value; },
        click() {}, remove() {},
    });
    context.window.setTimeout = callback => callback();
    vm.runInContext("closeUiModal = () => {}; currentUsername = 'student-a'; rememberBoundUsername('student-a');", context);

    await vm.runInContext("openCalendarExport('all')", context);
    assert.equal(vm.runInContext('calendarExportKind', context), 'all');
    vm.runInContext('downloadCalendarExport({ preventDefault() {} })', context);

    assert.deepEqual(requests.sort(), ['/api/exams', '/api/schedule']);
    assert.equal(nodes.get('calendar-export-start').value, '2026-09-07');
    assert.equal(filename, '课表与考试-2026-09-07.ics');
    const ics = downloaded.replace(/\r\n /g, '');
    assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2);
    assert.match(ics, /教师：张老师/);
    assert.match(ics, /座位号：12/);
    assert.match(ics, /DTSTART:20260915T021500Z/);
    assert.match(ics, /DTSTART:20260918T003000Z/);
});

for (const scenario of [
    { name: 'only courses', hasCourses: true, hasExams: false, expected: 'SUMMARY:高等数学' },
    { name: 'only exams', hasCourses: false, hasExams: true, expected: '座位号：12' },
    { name: 'fresh exams with an outdated course cache', hasCourses: true, hasExams: true, staleCourses: true, expected: '座位号：12' },
]) {
    test(`the unified export works with ${scenario.name}`, async () => {
        class FixedDate extends Date {
            constructor(...args) {
                super(...(args.length ? args : ['2026-09-25T04:00:00Z']));
            }
        }
        const { context } = createPage(FixedDate);
        let downloaded = '';
        context.fetch = async url => ({
            ok: true,
            json: async () => url === '/api/schedule'
                ? {
                    success: true, account: 'student-a',
                    data: {
                        semester_start: '2026-09-07', is_freshman: false,
                        cache_stale: !!scenario.staleCourses,
                        schedule: scenario.hasCourses ? { 2: [{
                            '课程号': 'MATH101', '课程名': '高等数学', '教师': '张老师',
                            '星期': '2', '节次': '3', '节数': '2', '位置': '一教201',
                        }] } : {},
                    },
                }
                : {
                    success: true, account: 'student-a', cache_stale: false,
                    semester_start: '2026-09-07',
                    exams: scenario.hasExams ? [{
                        exam_name: '期末考试', course: '大学物理', week: '2', day: '5',
                        time: '08:30-10:30', location: '一教201', seat: '12',
                    }] : [],
                },
        });
        context.Blob = class { constructor(parts) { this.parts = parts; } };
        context.URL = {
            createObjectURL(blob) { downloaded = blob.parts.join(''); return 'blob:calendar'; },
            revokeObjectURL() {},
        };
        context.document.body = { appendChild() {} };
        context.document.createElement = () => ({ click() {}, remove() {} });
        context.window.setTimeout = callback => callback();
        vm.runInContext("closeUiModal = () => {}; currentUsername = 'student-a'; rememberBoundUsername('student-a');", context);

        await vm.runInContext("openCalendarExport('all')", context);
        assert.equal(vm.runInContext('calendarExportKind', context), 'all');
        vm.runInContext('downloadCalendarExport({ preventDefault() {} })', context);

        const ics = downloaded.replace(/\r\n /g, '');
        assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
        assert.ok(ics.includes(scenario.expected));
        if (scenario.staleCourses) assert.ok(!ics.includes('SUMMARY:高等数学'));
    });
}

test('a semester change between the two API responses stops unified export', async () => {
    const { context } = createPage();
    context.fetch = async url => ({
        ok: true,
        json: async () => url === '/api/schedule'
            ? { success: true, account: 'student-a', data: { semester_start: '2026-09-14', cache_stale: false, schedule: {} } }
            : { success: true, account: 'student-a', semester_start: '2026-09-07', cache_stale: false,
                exams: [{ exam_name: '期末考试', course: '大学物理', week: '2', day: '5', time: '08:30-10:30' }] },
    });
    vm.runInContext("currentUsername = 'student-a'; rememberBoundUsername('student-a'); showUiToast = message => { window.lastToast = message; };", context);

    await vm.runInContext("openCalendarExport('all')", context);

    assert.equal(vm.runInContext('calendarExportKind', context), null);
    assert.match(context.window.lastToast, /学期日期不一致/);
});
