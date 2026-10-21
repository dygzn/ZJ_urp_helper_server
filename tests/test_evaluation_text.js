const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readDomainSource } = require('./helpers/app-source');

const payload = '<img src=x onerror="globalThis.injected=true"> & "教师"';
const escaped = '&lt;img src=x onerror=&quot;globalThis.injected=true&quot;&gt; &amp; &quot;教师&quot;';
const courses = [{ '未评课程': payload, '教师': payload, wjbm: 'offline-form', bpr: 'offline-teacher', pgnr: 'offline-course', oper: 'wjShow' }];

function evaluationPage(responses = []) {
    const nodes = new Map();
    const requests = [];
    const context = vm.createContext({
        window: {}, console, AbortController, DOMException,
        document: { getElementById(id) {
            if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', className: '', disabled: false });
            return nodes.get(id);
        } },
        checkLoginStatus: async () => {}, getDeviceId: () => 'offline-device',
        requestUiConfirmation: async () => true, showUiToast() {},
        fetch: async (url, options) => {
            requests.push({ url, options });
            assert.ok(responses.length, `unexpected request: ${url}`);
            const response = responses.shift();
            if (response instanceof Error) throw response;
            return { json: async () => response };
        },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/js/schedule-layout.js'), 'utf8'), context);
    vm.runInContext(readDomainSource('evaluation'), context);
    context.unevaluatedCoursesData = courses;
    return { context, nodes, requests };
}

function assertEscaped(html) {
    assert.doesNotMatch(html, /<img\b/);
    assert.ok(html.includes(escaped), 'dynamic value must be displayed as literal text');
}

test('待评列表将课程名和教师名作为文本显示', () => {
    const { context, nodes } = evaluationPage();
    context.displayUnevaluatedCourses(courses);
    const html = nodes.get('evaluation-result').innerHTML;
    assertEscaped(html);
    assert.equal(html.split(escaped).length - 1, 2);
    assert.match(html, /onclick="doEvaluation\(\)"/);
});

for (const action of ['checkUnevaluatedCourses', 'doFullEvaluation']) {
    test(`${action} 的空列表提示不会插入服务端标记`, async () => {
        const { context, nodes } = evaluationPage([{ success: true, has_courses: false, message: payload }]);
        await context[action]();
        assertEscaped(nodes.get('evaluation-result').innerHTML);
    });
}

for (const action of ['doEvaluation', 'oneClickEvaluation', 'doFullEvaluation']) {
    test(`${action} 安全显示成功消息且保留提交载荷`, async () => {
        const responses = [{ success: true, message: payload }];
        if (action !== 'doEvaluation') responses.unshift({ success: true, has_courses: true, courses });
        const { context, nodes, requests } = evaluationPage(responses);
        await context[action]();
        assertEscaped(nodes.get('evaluation-result').innerHTML);
        const submitted = requests.find(request => request.url === '/api/evaluation');
        assert.deepEqual(JSON.parse(submitted.options.body), { courses });
        assert.equal(context.unevaluatedCoursesData.length, 0);
    });
}

test('完整评教的提交前预览同样转义课程名和教师名', async () => {
    const { context, nodes } = evaluationPage([{ success: true, has_courses: true, courses }, new Error('offline submission failure')]);
    const previews = [];
    const result = context.document.getElementById('evaluation-result');
    let html = '';
    Object.defineProperty(result, 'innerHTML', { get: () => html, set: value => { html = value; previews.push(value); } });
    await context.doFullEvaluation();
    const preview = previews.find(value => value.includes('evaluation-course-preview'));
    assert.ok(preview);
    assertEscaped(preview);
    assert.equal(preview.split(escaped).length - 1, 2);
    assert.equal(nodes.get('do-eval-btn').disabled, false);
});
