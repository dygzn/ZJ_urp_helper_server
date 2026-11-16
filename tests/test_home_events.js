const { readAppSource } = require('./helpers/app-source');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function homeContext(response) {
    const content = { innerHTML: '' };
    const agenda = { innerHTML: '' }, heading = { textContent: '' }, today = { textContent: '', dateTime: '' };
    const document = { addEventListener() {}, getElementById: id => ({
        'urgent-content': content, 'home-agenda-content': agenda, 'home-agenda-title': heading,
        'home-today-date': today,
    }[id] || null) };
    const context = vm.createContext({ document, window: {}, console, TextEncoder,
        localStorage: { getItem() { return null; } },
        setInterval: () => 1, clearInterval() {},
        fetch: async () => ({ json: async () => response }),
    });
    for (const file of ['schedule-layout.js', 'calendar-export.js', 'main.js']) {
        vm.runInContext((file === 'main.js' ? readAppSource() : fs.readFileSync(path.join(__dirname, '../static/js', file), 'utf8')), context);
    }
    vm.runInContext(`checkLoginStatus = () => {}; getDeviceId = () => 'device';
        updateScheduleTimeline = () => {}; getCalendarChinaToday = () => '2026-09-30';`, context);
    return { context, content, agenda, heading, today };
}

test('home date shows the actual teaching week from the reminder response', async () => {
    const { context, today } = homeContext({ success: true, event: { current_week: 4, current: null, next: null } });
    vm.runInContext('currentWeek = 23', context);
    await context.loadUrgentEvent();
    assert.equal(today.dateTime, '2026-09-30');
    assert.match(today.textContent, /9月30日.*星期三.*第 4 周/);
    assert.doesNotMatch(today.textContent, /23/);
});

test('home does not invent a week when the semester has not started or is invalid', async () => {
    for (const [current_week, suffix] of [[0, '未开学'], [null, '周次未设置']]) {
        const { context, today } = homeContext({ success: true, event: { current_week, current: null, next: null } });
        await context.loadUrgentEvent();
        assert.ok(today.textContent.endsWith(suffix));
        assert.doesNotMatch(today.textContent, /第 1 周/);
    }
});

test('failed home queries report failure instead of claiming there are no classes', async () => {
    const { context, content } = homeContext({ success: false, message: '查询失败，请重试' });
    await context.loadUrgentEvent();
    assert.match(content.innerHTML, /查询失败/);
    assert.doesNotMatch(content.innerHTML, /今天没有课程|好好休息/);
});

test('home agenda shows the supplied teaching day and all remaining classes', () => {
    const { context, agenda, heading } = homeContext();
    context.displayUrgentEvent({ current: null, next: null, upcoming_label: '明日安排',
        upcoming: [
            { title: '高等数学', time: '08:20-10:00', location: 'A201', status: 'upcoming' },
            { title: '程序设计', time: '14:10-15:50', location: '实验楼302', status: 'upcoming' },
        ] });
    assert.equal(heading.textContent, '明日安排');
    assert.match(agenda.innerHTML, /08:20-10:00/);
    assert.match(agenda.innerHTML, /程序设计/);
    assert.match(agenda.innerHTML, /实验楼302/);
});

test('home exam reminders retain the end time and label the countdown as an exam', () => {
    const { context, content } = homeContext();
    context.displayUrgentEvent({ current: null, next: { type: 'exam', title: '软件工程',
        location: '教B-106', time: '2026-09-30 14:00-16:00', seat: '50', countdown: 90 } });
    assert.match(content.innerHTML, /14:00-16:00/);
    assert.match(content.innerHTML, /后考试/);
    assert.doesNotMatch(content.innerHTML, /后上课/);
    assert.match(content.innerHTML, /50/);
});

test('home reminders render course names and locations as text', () => {
    const { context, content } = homeContext();
    context.displayUrgentEvent({ current: { title: '设计 <基础>', location: 'A&B',
        time: '2026-09-30 08:20-10:00', remaining: 20 }, next: null });
    assert.match(content.innerHTML, /设计 &lt;基础&gt;/);
    assert.match(content.innerHTML, /A&amp;B/);
    assert.doesNotMatch(content.innerHTML, /<基础>/);
});

test('home with no upcoming events provides one clear empty state and a schedule action', () => {
    const { context, content } = homeContext();
    context.displayUrgentEvent({ current: null, next: null, upcoming: [] });
    assert.match(content.innerHTML, /暂无后续安排/);
    assert.match(content.innerHTML, /openHomeShortcut\('schedule'\)/);
    assert.doesNotMatch(content.innerHTML, /今天没课|好好休息|rest-message/);
});

test('guests can log in directly from the home reminder', async () => {
    const { context, content } = homeContext();
    vm.runInContext('isGuestMode = true', context);
    await context.loadUrgentEvent();
    assert.match(content.innerHTML, /showLoginModal\(\)/);
    assert.match(content.innerHTML, /登录教务账号/);
});

test('failed home queries have an actionable retry and escape the server message', async () => {
    const { context, content } = homeContext({ success: false, message: '学校 <暂不可用>' });
    await context.loadUrgentEvent();
    assert.match(content.innerHTML, /refreshUrgentEvent\(\)/);
    assert.match(content.innerHTML, /学校 &lt;暂不可用&gt;/);
    assert.doesNotMatch(content.innerHTML, /<暂不可用>/);
});

test('a pending course response cannot replace the guest login prompt', async () => {
    const { context, content } = homeContext();
    let respond;
    context.fetch = () => new Promise(resolve => { respond = resolve; });
    const pending = context.loadUrgentEvent();
    vm.runInContext('isGuestMode = true', context);
    await context.loadUrgentEvent();
    respond({ json: async () => ({ success: true, event: { current: null,
        next: { type: 'class', title: '旧查询课程', location: 'A201', time: '2026-09-30 10:15', countdown: 35 } } }) });
    await pending;
    assert.match(content.innerHTML, /登录教务账号/);
    assert.doesNotMatch(content.innerHTML, /旧查询课程/);
});
test('cross-day personal reminders show the real start and end dates',()=>{
 const {context,agenda,content}=homeContext();
 const course={title:'夜间学习',time:'23:13-00:27',start_at:'2026-10-04T23:13:00+08:00',end_at:'2026-10-05T00:27:00+08:00',remaining:20,status:'current'};
 context.renderHomeAgenda({upcoming:[course]});context.displayUrgentEvent({current:course,next:null,upcoming:[course]});
 assert.match(agenda.innerHTML,/10月4日 23:13/);assert.match(agenda.innerHTML,/10月5日 00:27/);
 assert.match(content.innerHTML,/10月5日 00:27/);
});

test('loading cached home agenda never checks academic login', async () => {
    const { context } = homeContext({ success: true, event: {current:null,next:null,upcoming:[]} });
    let checks = 0;
    context.checkLoginStatus = () => { checks++; };
    await context.loadUrgentEvent();
    assert.equal(checks, 0);
});


test('all two-week exams remain visible alongside an earlier class without duplicate exams', () => {
    const { context, content } = homeContext();
    const exam = { type: 'exam', title: '高等数学期末', time: '2026-10-07 08:30-10:30', location: '教A201', seat: '12' };
    context.displayUrgentEvent({ next: { type: 'class', title: '程序设计', time: '2026-09-30 08:00-10:00' },
        upcoming_exams: [exam, { ...exam, title: '大学英语期末' }] });
    assert.match(content.innerHTML, /程序设计/);
    assert.match(content.innerHTML, /高等数学期末/);
    assert.match(content.innerHTML, /大学英语期末/);
    assert.match(content.innerHTML, /08:30-10:30/);
    assert.match(content.innerHTML, /12/);
    context.displayUrgentEvent({ next: exam, upcoming_exams: [exam] });
    assert.equal(content.innerHTML.split('高等数学期末').length - 1, 1);
});
