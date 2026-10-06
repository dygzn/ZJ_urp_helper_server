const { readAppSource } = require('./helpers/app-source');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { installApi } = require('./helpers/browser-api');

function page() {
    const context = vm.createContext({ document: { addEventListener() {} }, window: {},
        localStorage: { getItem(key) { return key === 'device_id' ? 'existing-device' : null; } }, console });
    for (const file of ['schedule-layout.js', 'main.js']) {
        vm.runInContext((file === 'main.js' ? readAppSource() : fs.readFileSync(path.join(__dirname, '../static/js', file), 'utf8')), context);
    }
    return context;
}

function gradePage() {
    const context = page();
    installApi(context);
    const nodes = new Map();
    context.document.getElementById = id => {
        if (!nodes.has(id)) nodes.set(id, { style: {}, innerHTML: '', textContent: '' });
        return nodes.get(id);
    };
    vm.runInContext('checkLoginStatus = async () => {}; gradesShowResult = () => {}; closeExamPicker = () => {};', context);
    return { context, nodes };
}

test('full grade rendering escapes course names, scores and GPA values', () => {
    const { context, nodes } = gradePage();
    context.displayGrades([{ course: '<img>', score: '<script>' },
        { course: '学分绩点', score: '<svg>' }, { course: '零分课程', score: 0 }]);
    const html = nodes.get('grades-content').innerHTML;
    assert.doesNotMatch(html, /<img>|<script>|<svg>/);
    assert.match(html, /&lt;img&gt;/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&lt;svg&gt;/);
    assert.match(html, /class="score-low">0<\/td>/);
});

test('failed and exam grade queries escape all returned table fields and error messages', async () => {
    for (const query of ['gradesLoadFailed()', "examPickExam('semester', 'exam', '考试')"]) {
        const { context, nodes } = gradePage();
        context.fetch = async () => ({ json: async () => ({ success: true,
            grades: [{ course: '<img>', credit: '<svg>', score: '<script>' }],
            current: [{ course: '<img>', credit: '<svg>', score: '<script>', exam_time: '<iframe>' }], past: [] }) });
        await vm.runInContext(query, context);
        assert.doesNotMatch(nodes.get('grades-content').innerHTML, /<img>|<svg>|<script>|<iframe>/);
        assert.match(nodes.get('grades-content').innerHTML, /&lt;img&gt;/);
        context.fetch = async () => ({ json: async () => ({ success: false, message: '<img>' }) });
        await vm.runInContext(query, context);
        assert.match(nodes.get('grades-content').innerHTML, /&lt;img&gt;/);
    }
});

test('exam picker keeps names and identifiers out of inline JavaScript', () => {
    const { context, nodes } = gradePage();
    context.sessions = { exams: [{ jxzxjh: "秋');evil();//", ksbh: '\"><img>', name: '<script>' }] };
    vm.runInContext('_examSessions = sessions; examPickSemester("秋\');evil();//", "秋学期")', context);
    const html = nodes.get('exam-picker-body').innerHTML;
    assert.doesNotMatch(html, /<img>|<script>|onclick="[^"]*evil/);
    assert.match(html, /&lt;script&gt;/);
});

test('shared HTML escaping preserves zero and false while neutralizing markup and quotes', () => {
    const context = page();
    assert.equal(typeof context.escapeHtml, 'function');
    for (const [value, expected] of [[null, ''], [undefined, ''], [0, '0'], [false, 'false'],
        ['<img src="x" onerror=\'alert(1)\'>&', '&lt;img src=&quot;x&quot; onerror=&#39;alert(1)&#39;&gt;&amp;']]) {
        assert.equal(context.escapeHtml(value), expected);
    }
});

test('grade tables preserve numeric zero scores and credits', () => {
    const context = page();
    assert.match(context.gradesBuildSimpleTable([{ course: '<课程>', score: 0 }]),
        /&lt;课程&gt;<\/td><td class="score-low">0<\/td>/);
    assert.match(context.gradesBuildFailedTable([{ course: '课程', credit: 0, score: 0 }]),
        /<td>0<\/td><td class="score-low">0<\/td>/);
});

test('makeup results preserve zero, distinguish unpublished grades and escape session names', () => {
    const context = page();
    const html = context.gradesBuildMakeupTable([
        { course: '<高数>', credit: 0, score: 0, sessions: ['<场次>'] },
        { course: '英语', credit: 2, score: '', sessions: ['2026秋补考'] },
    ]);
    assert.doesNotMatch(html, /<高数>|<场次>/);
    assert.match(html, /&lt;高数&gt;/);
    assert.match(html, /&lt;场次&gt;/);
    assert.match(html, /class="score-low">0<\/td>/);
    assert.match(html, /暂未发布/);
});

test('feedback content preserves zero, escapes markup before inserting line breaks', () => {
    const context = page();
    assert.equal(context.formatFeedbackContent(0), '0');
    assert.equal(context.formatFeedbackContent('<img onerror="evil()">\n&'),
        '&lt;img onerror=&quot;evil()&quot;&gt;<br>&amp;');
});

test('feedback IDs cannot inject inline handlers or HTML attributes', () => {
    const context = page();
    const html = context.buildFeedbackCard({ id: '1);evil();//" autofocus onfocus="evil()',
        content: '<script>evil()</script>', username: '<img>', visibility: 'public' });
    assert.doesNotMatch(html, /onclick="[^"]*evil|autofocus|<script>|<img>/);
    assert.match(html, /&lt;script&gt;/);
    const normal = context.buildFeedbackCard({ id: 42, content: 0 });
    assert.match(normal, /toggleReplyBox\(42\)/);
    assert.match(normal, /id="reply-input-42"/);
});

test('semester options escape labels and keep values out of inline JavaScript', async () => {
    const context = page();
    installApi(context);
    const list = { innerHTML: '' };
    context.document.getElementById = id => id === 'semester-picker-list' ? list : {};
    context.fetch = async () => ({ json: async () => ({ success: true,
        semesters: ['2026\"><img src=x onerror=evil()>', "秋');evil();//"] }) });
    vm.runInContext("getDeviceId = () => 'device'; checkLoginStatus = async () => {}; openUiModal = () => {};", context);
    await context.gradesShowSemesterPicker();
    assert.doesNotMatch(list.innerHTML, /<img|onclick="[^"]*evil/);
    assert.match(list.innerHTML, /2026&quot;&gt;&lt;img/);
    assert.match(list.innerHTML, /秋&#39;\);evil\(\);\/\//);
});
