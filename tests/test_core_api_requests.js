const { readAppSource } = require('./helpers/app-source');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { installApi } = require('./helpers/browser-api');

function page() {
    const nodes = new Map();
    const saved = new Map([['device_id', 'existing-device']]);
    const document = {
        readyState: 'loading',
        addEventListener() {},
        getElementById(id) {
            if (!nodes.has(id)) nodes.set(id, { style: {}, textContent: '', innerHTML: '', focus() {} });
            return nodes.get(id);
        },
        querySelector(selector) { return this.getElementById(selector); },
    };
    const context = vm.createContext({ document, window: {}, TextEncoder, console,
        localStorage: { getItem: key => saved.get(key) || null,
            setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) } });
    installApi(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/js/schedule-layout.js'), 'utf8'), context);
    vm.runInContext(readAppSource(), context);
    vm.runInContext(`currentUsername = 'student'; rememberBoundUsername('student');
        currentSemesterStartValue = () => ''; getCalendarChinaToday = () => '2026-10-02';
        updateScheduleDates = () => {}; resetScheduleDisplay = () => {};`, context);
    return { context, nodes };
}
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};
const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

test('overlapping login checks wait for the same request', async () => {
    const { context } = page();
    const pending = deferred();
    let calls = 0;
    context.fetch = () => { calls++; return pending.promise; };
    let secondFinished = false;
    const first = context.checkLoginStatus();
    const second = context.checkLoginStatus().then(() => { secondFinished = true; });
    await Promise.resolve();
    assert.equal(secondFinished, false);
    assert.equal(calls, 1);
    pending.resolve(response({ success: true, logged_in: true }));
    await Promise.all([first, second]);
});

test('late schedule responses cannot override the newer selected week', async () => {
    const { context } = page();
    const pending = [];
    context.fetch = (url, options) => {
        const item = deferred();
        pending.push({ ...item, url, options });
        return item.promise;
    };
    const rendered = [];
    context.displaySchedule = data => rendered.push(Object.keys(data)[0]);
    const first = context.loadSchedule(1, true);
    const second = context.loadSchedule(2, true);
    pending[1].resolve(response({ success: true, data: { schedule: { 2: [{ '课程名': '新课' }] } } }));
    await second;
    pending[0].resolve(response({ success: true, data: { schedule: { 1: [{ '课程名': '旧课' }] } } }));
    await first;
    assert.deepEqual(rendered, ['2']);
    assert.equal(pending[0].options.signal?.aborted, true);
    assert.equal(vm.runInContext('currentWeek', context), 2);
});

test('late grades cannot overwrite a later query or its title', async () => {
    const { context, nodes } = page();
    context.checkLoginStatus = async () => {};
    const pending = [];
    context.fetch = (url, options) => { const item = deferred(); pending.push({ ...item, url, options }); return item.promise; };
    const first = context.gradesShowCurrentSemester();
    await new Promise(resolve => setImmediate(resolve));
    const second = context.gradesLoadFailed();
    await new Promise(resolve => setImmediate(resolve));
    pending[1].resolve(response({ success: true, current: [{ course: '新结果', credit: '2', score: '45' }], past: [] }));
    await second;
    pending[0].resolve(response({ success: true, grades: [{ course: '旧结果', score: '90' }] }));
    await first;
    assert.match(nodes.get('grades-content').innerHTML, /新结果/);
    assert.doesNotMatch(nodes.get('grades-content').innerHTML, /旧结果/);
    assert.equal(nodes.get('grades-result-title').textContent, '不及格成绩');
    assert.equal(pending[0].options.signal.aborted, true);
});

test('account changes invalidate grades responses', async () => {
    const { context, nodes } = page();
    context.checkLoginStatus = async () => {};
    const data = deferred();
    context.fetch = () => data.promise;
    const pending = context.gradesLoadLatestSummary();
    await new Promise(resolve => setImmediate(resolve));
    vm.runInContext("currentUsername = 'other'; rememberBoundUsername('other');", context);
    data.resolve(response({ success: true, passed: [{ course: '上一账号', score: '90' }] }));
    await pending;
    assert.doesNotMatch(nodes.get('grades-content').innerHTML, /上一账号/);
});

test('global expiry event uses the existing relogin UI once', async () => {
    const { context, nodes } = page();
    context.fetch = async () => response({ success: false, code: 'EXPIRED', message: '登录已失效，请重新绑定' });
    let prompts = 0;
    context.showLoginModal = () => { prompts++; };
    await Promise.all([context.apiClient.request('/one'), context.apiClient.request('/two')]);
    assert.equal(prompts, 1);
    assert.equal(nodes.get('login-error').textContent, '登录已失效，请重新绑定');
});

test('an old account expiry response cannot prompt the newly selected account to log in', async () => {
    const { context } = page();
    const oldResponse = deferred();
    let prompts = 0;
    context.showLoginModal = () => { prompts++; };
    context.fetch = () => oldResponse.promise;
    const pending = context.apiClient.request('/api/schedule');
    vm.runInContext("currentUsername = 'other'; rememberBoundUsername('other');", context);
    oldResponse.resolve(response({ success: false, code: 'EXPIRED' }));
    await pending;
    assert.equal(prompts, 0);
    context.fetch = async () => response({ success: false, code: 'EXPIRED' });
    await context.apiClient.request('/api/grades/current');
    assert.equal(prompts, 1);
});

test('migrated summary and GPA queries retain the original API field mapping', async () => {
    const { context, nodes } = page();
    context.checkLoginStatus = async () => {};
    context.fetch = async url => response(url.endsWith('/latest_summary') ? {
        success: true, semester: '2026-2027-1', passed: [{ course: '已及格', score: '86' }],
        failed: { current: [{ course: '尚不及格', credit: '3', score: '50', exam_time: '20261001' }],
            past: [{ course: '曾不及格课程', score: '45' }] },
    } : { success: true, gpa: { '学分绩点': 3.25, '学位绩点': 3.5, '加权学分学位绩点': 3.4 } });
    await context.gradesLoadLatestSummary();
    assert.match(nodes.get('grades-content').innerHTML, /2026-2027-1/);
    assert.match(nodes.get('grades-content').innerHTML, /已及格/);
    assert.match(nodes.get('grades-content').innerHTML, /曾不及格课程/);
    assert.match(nodes.get('grades-content').innerHTML, /2026-10-01/);
    await context.gradesLoadGpa();
    assert.match(nodes.get('grades-content').innerHTML, /3\.25/);
    assert.match(nodes.get('grades-content').innerHTML, /3\.5/);
    assert.match(nodes.get('grades-content').innerHTML, /3\.4/);
});

test('grades dashboard loads current results and renders the three requested KPIs', async () => {
    const { context, nodes } = page();
    context.checkLoginStatus = async () => {};
    context.fetch = async url => {
        if (url.endsWith('/api/grades/latest_summary')) return response({
            success: true,
            semester: '2026-2027-1',
            passed: [
                { course: '高等数学', score: '91', credit: '3.5' },
                { course: '大学英语', score: '78', credit: '2' },
            ],
            failed: { current: [{ course: '物理', credit: '2', score: '52' }], past: [] },
        });
        if (url.endsWith('/api/grades/current')) return response({ success: true, grades: [
            { course: '高等数学', score: '91', credit: '3.5' },
            { course: '大学英语', score: '78', credit: '2' },
        ] });
        if (url.endsWith('/api/grades/gpa')) return response({ success: true, gpa: {
            '学分绩点': '3.20',
            '学期绩点明细': [
                { '学年学期': '2026-2027-1', '学分绩点': '3.67' },
                { '学年学期': '2025-2026-2', '学分绩点': '3.21' },
            ],
        } });
        if (url.endsWith('/api/grades/latest_makeup')) return response({
            success: true,
            latest_session: { period: '2026-2027-1', label: '2026-2027学年秋学期', sessions: ['2026秋学期补考'], status: 'no_results' },
            latest_published: { period: '2025-2026-1', label: '2025-2026学年秋学期', results: [
                { course: '中国近现代史纲要', credit: '3.0', score: '85.0', sessions: ['2025秋学期补考'] },
            ] },
        });
        throw new Error(`unexpected request: ${url}`);
    };

    await context.gradesLoadDashboard();

    assert.equal(nodes.get('grades-kpi-gpa').textContent, '3.67');
    assert.equal(nodes.get('grades-kpi-credits').textContent, '5.5');
    assert.equal(nodes.get('grades-kpi-failed').textContent, '1');
    assert.match(nodes.get('grades-content').innerHTML, /高等数学/);
    assert.match(nodes.get('grades-content').innerHTML, /大学英语/);
    assert.match(nodes.get('grades-content').innerHTML, /中国近现代史纲要/);
    assert.match(nodes.get('grades-content').innerHTML, /2026-2027学年秋学期补考暂无成绩/);
    assert.equal(nodes.get('grades-result-title').textContent, '一键查本学期成绩');
});

test('grades dashboard keeps the current table when an optional KPI request fails', async () => {
    const { context, nodes } = page();
    context.checkLoginStatus = async () => {};
    context.fetch = async url => {
        if (url.endsWith('/api/grades/latest_summary')) return response({ success: true,
            semester: '2026-2027-1', passed: [{ course: '程序设计', score: '88', credit: '4' }],
            failed: { current: [], past: [] } });
        if (url.endsWith('/api/grades/current')) return response({ success: true,
            grades: [{ course: '程序设计', score: '88', credit: '4' }] });
        if (url.endsWith('/api/grades/gpa')) throw new Error('绩点服务暂时不可用');
        if (url.endsWith('/api/grades/latest_makeup')) throw new Error('补考服务暂时不可用');
        throw new Error(`unexpected request: ${url}`);
    };

    await context.gradesLoadDashboard();

    assert.match(nodes.get('grades-content').innerHTML, /程序设计/);
    assert.equal(nodes.get('grades-kpi-gpa').textContent, '-');
    assert.equal(nodes.get('grades-kpi-credits').textContent, '4');
});

test('one-click grades render before slow makeup and never use the backup query', async () => {
    const { context, nodes } = page();
    context.checkLoginStatus = async () => {};
    const makeup = deferred();
    const urls = [];
    context.fetch = async url => {
        urls.push(url);
        if (url.endsWith('/latest_makeup')) return makeup.promise;
        if (url.endsWith('/latest_summary')) return response({ success: true,
            semester: '2026-2027-1', passed: [{ course: '先显示的课程', credit: '3', score: '80' }],
            failed: { current: [], past: [] } });
        if (url.endsWith('/gpa')) return response({ success: true, gpa: {} });
        throw new Error('备用查询不应自动请求');
    };
    const pending = context.gradesLoadDashboard();
    await new Promise(resolve => setImmediate(resolve));
    assert.match(nodes.get('grades-content').innerHTML, /先显示的课程/);
    assert.match(nodes.get('grades-content').innerHTML, /正在查询补考/);
    assert.equal(urls.includes('/api/grades/current'), false);
    makeup.resolve(response({ success: true, latest_session: null, latest_published: null }));
    await pending;
});

test('missing semester GPA and course credits are shown as unavailable rather than overall GPA or zero', () => {
    const { context, nodes } = page();
    context.renderGradesDashboard({ success: true, semester: '2026-2027-1',
        passed: [{ course: '未提供学分', score: '90' }], failed: { current: [], past: [] } },
        { success: true, gpa: { '学分绩点': '3.9', '学期绩点明细': [
            { '学年学期': '2025-2026-2', '学分绩点': '3.5' },
        ] } }, { success: true, latest_session: null });
    assert.equal(nodes.get('grades-kpi-gpa').textContent, '-');
    assert.equal(nodes.get('grades-kpi-credits').textContent, '-');
});

test('one-click evaluation stops before requests when the warning is cancelled', async () => {
    const { context, nodes } = page();
    context.checkLoginStatus = async () => {};
    const button = context.document.getElementById('one-click-eval-btn');
    button.disabled = false;
    context.requestUiConfirmation = async options => {
        assert.equal(options.message, '即将对本学期所有待评教师提交默认好评，该操作不可撤销，是否继续？');
        return false;
    };
    let calls = 0;
    context.fetch = async () => { calls++; return response({ success: true }); };

    await context.oneClickEvaluation();

    assert.equal(calls, 0);
    assert.equal(nodes.get('one-click-eval-btn').disabled, false);
});

test('one-click evaluation submits only after the warning is confirmed', async () => {
    const { context } = page();
    context.checkLoginStatus = async () => {};
    let confirmations = 0;
    context.requestUiConfirmation = async () => { confirmations++; return true; };
    const calls = [];
    context.fetch = async (url, options = {}) => {
        calls.push({ url, method: options.method || 'GET' });
        return response(url.endsWith('/api/unevaluated_courses')
            ? { success: true, has_courses: true, courses: [{ '未评课程': '高数', '教师': '王老师' }] }
            : { success: true, message: '评价完成' });
    };

    await context.oneClickEvaluation();

    assert.equal(confirmations, 1);
    assert.deepEqual(calls, [
        { url: '/api/unevaluated_courses', method: 'GET' },
        { url: '/api/evaluation', method: 'POST' },
    ]);
});


test('completing the displayed evaluation list preserves it without submitting when cancelled', async () => {
    const { context, nodes } = page();
    context.checkLoginStatus = async () => {};
    vm.runInContext("unevaluatedCoursesData = [{ '未评课程': '高数', '教师': '王老师' }];", context);
    const result = context.document.getElementById('evaluation-result');
    result.innerHTML = '现有待评课程列表';
    let calls = 0;
    context.fetch = async () => { calls++; return response({ success: true }); };
    context.requestUiConfirmation = async options => {
        assert.match(options.message, /1.*默认好评.*不可撤销/);
        return false;
    };
    await context.doEvaluation();
    assert.equal(calls, 0);
    assert.equal(nodes.get('evaluation-result').innerHTML, '现有待评课程列表');
    assert.equal(vm.runInContext('unevaluatedCoursesData.length', context), 1);
});

test('completing an evaluation list waits for confirmation before posting its displayed courses', async () => {
    const { context } = page();
    context.checkLoginStatus = async () => {};
    const courses = [{ '未评课程': '高数', '教师': '王老师' }];
    context.unevaluatedCoursesData = courses;
    const confirmation = deferred();
    context.requestUiConfirmation = () => confirmation.promise;
    const calls = [];
    context.fetch = async (url, options) => {
        calls.push({ url, method: options.method, body: JSON.parse(options.body) });
        return response({ success: true, message: '评价完成' });
    };
    const work = context.doEvaluation();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, []);
    confirmation.resolve(true);
    await work;
    assert.deepEqual(calls, [{ url: '/api/evaluation', method: 'POST', body: { courses } }]);
    assert.equal(vm.runInContext('unevaluatedCoursesData.length', context), 0);
});

test('leaving evaluation while confirmation is pending prevents the submission', async () => {
    const { context } = page();
    context.checkLoginStatus = async () => {};
    vm.runInContext("unevaluatedCoursesData = [{ '未评课程': '高数', '教师': '王老师' }];", context);
    const confirmation = deferred();
    context.requestUiConfirmation = () => confirmation.promise;
    let calls = 0;
    context.fetch = async () => { calls++; return response({ success: true }); };
    const work = context.doEvaluation();
    const rejected = assert.rejects(work, { name: 'AbortError' });
    await new Promise(resolve => setImmediate(resolve));
    context.unmountEvaluation();
    confirmation.resolve(true);
    await rejected;
    assert.equal(calls, 0);
});


for (const [action, id, label] of [['oneClickEvaluation', 'one-click-eval-btn', '一键评教'],
    ['doFullEvaluation', 'do-eval-btn', '完成教学评估']]) {
    test(`${action} restores its busy button when leaving and returning during a request`, async () => {
        const { context, nodes } = page();
        context.checkLoginStatus = async () => {};
        const button = context.document.getElementById(id);
        button.disabled = false;
        button.textContent = label;
        context.requestUiConfirmation = async () => true;
        const backend = deferred();
        context.fetch = () => backend.promise;
        const pending = context[action]();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(button.disabled, true);
        context.unmountEvaluation();
        vm.runInContext("pageResources('evaluation').activate(); mountEvaluation();", context);
        await pending;
        assert.equal(button.disabled, false);
        assert.equal(button.textContent, label);
        backend.resolve(response({ success: true, has_courses: false }));
        assert.equal(nodes.get('evaluation-result').innerHTML, '');
    });
}

test('successful login checks reuse short cache and account change invalidates it', async () => {
    const { context } = page();
    let calls = 0;
    context.fetch = async () => { calls++; return response({ success: true, logged_in: true }); };
    await context.checkLoginStatus();
    await context.checkLoginStatus();
    assert.equal(calls, 1);
    context.rememberBoundUsername('different-student');
    await context.checkLoginStatus();
    assert.equal(calls, 2);
});


test('live login checks work without a visible connection status widget', async () => {
    const { context } = page();
    context.document.querySelector = () => null;
    context.fetch = async () => response({success:true,logged_in:true});
    const result = await context.checkLoginStatus();
    assert.equal(result.logged_in,true);
});

test('grade queries show loading while authentication runs internally', async () => {
    const {context,nodes}=page();
    const login=deferred();
    context.checkLoginStatus=()=>login.promise;
    context.fetch=async()=>response({success:true,grades:[]});
    context.document.getElementById('grades-content');
    const pending=context.gradesShowCurrentSemester();
    assert.match(nodes.get('grades-content').innerHTML,/加载中/);
    login.resolve();
    await pending;
});
