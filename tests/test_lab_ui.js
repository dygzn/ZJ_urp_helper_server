const { readDomainSource } = require('./helpers/app-source');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element() {
    return {
        textContent: '', value: '', checked: false, disabled: false, hidden: false,
        href: '', children: [], listeners: {}, classList: { toggle() {} },
        replaceChildren() { this.children = []; },
        append(child) { this.children.push(child); },
        addEventListener(type, listener) { this.listeners[type] = listener; },
        click() { if (!this.disabled) return this.listeners.click?.(); },
    };
}

function labPage(items = [{ id: '0', cells: ['1', '课程甲'], pre: true, report: true }], replies = {}) {
    const nodes = new Map();
    const get = id => {
        if (!nodes.has(id)) nodes.set(id, element());
        return nodes.get(id);
    };
    const document = {
        getElementById: get,
        createElement: element,
        addEventListener(type, listener) {
            if (type === 'DOMContentLoaded') listener();
        },
    };
    const data = {
        semester: '2026-2027-1-1', mode: '按课程',
        semesters: [{ value: '2026-2027-1-1', label: '2026-2027学年秋' }],
        headers: ['编号', '课程', '状态'], items,
    };
    const requests = [];
    const source = readDomainSource('lab') + '\ninitializeLab();\nglobalThis.remountLabForTest = () => { unmountLab(); labResources.activate(); return mountLab(); };';
    const context = {
        document, window: {}, getDeviceId: () => 'device',
        FormData: class {
            constructor() { this.fields = {}; }
            append(key, value) { this.fields[key] = value; }
        },
        fetch: async (url, options) => {
            requests.push({ url, options });
            return { ok: true, headers: { get: () => 'application/json' },
                json: async () => typeof replies[url] === 'function' ? replies[url]()
                    : replies[url] || ({ success: true, data, message: '已发送' }) };
        },
    };
    vm.runInNewContext(source, context);
    return { get, requests, load: () => context.loadLabPage(), remount: () => context.remountLabForTest() };
}

test('submitted status remains visible alongside available upload buttons', async () => {
    const { get } = labPage([{ id: '0', cells: ['1', '课程甲', '已提交'], pre: true, report: true }]);
    await get('lab-query').listeners.click();
    const item = get('lab-list').children[0];
    assert.equal(item.children[0].textContent, '课程甲');
    assert.equal(item.children[1].children[1].disabled, false);
    assert.equal(item.children[2].children[1].textContent, '状态：已提交');
});

test('course query labels returned rows as course experiment tasks', async () => {
    const nodes = new Map();
    const get = id => {
        if (!nodes.has(id)) nodes.set(id, element());
        return nodes.get(id);
    };
    const document = {
        getElementById: get,
        createElement: element,
        addEventListener(type, listener) {
            if (type === 'DOMContentLoaded') listener();
        },
    };
    const data = {
        semester: '2026-2027-1-1', mode: '按课程',
        semesters: [{ value: '2026-2027-1-1', label: '2026-2027学年秋' }],
        items: [{ id: '0', cells: ['1', '课程甲'], pre: true, report: true }],
    };
    const source = readDomainSource('lab') + '\ninitializeLab();';
    vm.runInNewContext(source, {
        document, window: {}, getDeviceId: () => 'device',
        fetch: async () => ({ ok: true, headers: { get: () => 'application/json' },
            json: async () => ({ success: true, data }) }),
    });

    await get('lab-query').listeners.click();

    assert.equal(get('lab-mode').textContent, '按课程展示实验任务');
    assert.equal(get('lab-message').textContent, '已查询到 1 条课程实验任务（按课程）');
    assert.equal(get('lab-list').children.length, 1);
});

for (const [filename, expectedUrl] of [
    ['report.docx', 'https://www.ilovepdf.com/zh-cn/word_to_pdf'],
    ['report.doc', 'https://www.ilovepdf.com/zh-cn/word_to_pdf'],
    ['report.jpg', 'https://www.ilovepdf.com/zh-cn/jpg_to_pdf'],
    ['report.jpeg', 'https://www.ilovepdf.com/zh-cn/jpg_to_pdf'],
    ['report.png', 'https://www.ilovepdf.com/zh-cn/jpg_to_pdf'],
]) {
    test(`${filename} offers the correct external conversion without uploading`, async () => {
        const { get, requests } = labPage();
        await get('lab-query').listeners.click();
        get('lab-list').children[0].children[1].children[0].click();
        await get('lab-file').listeners.change({ target: {
            files: [{ name: filename, size: 1024 }], value: filename,
        } });

        assert.equal(get('lab-convert').hidden, false);
        assert.equal(get('lab-convert-link').href, expectedUrl);
        assert.match(get('lab-convert-text').textContent, /第三方/);
        assert.equal(requests.filter(request => request.url === '/api/lab/upload').length, 0);
    });
}

test('PDF still uploads to the selected report after conversion guidance', async () => {
    const { get, requests } = labPage();
    await get('lab-query').listeners.click();
    get('lab-list').children[0].children[1].children[1].click();
    await get('lab-file').listeners.change({ target: {
        files: [{ name: 'report.docx', size: 1024 }], value: 'report.docx',
    } });
    const pdf = { name: 'report.pdf', size: 1024 };
    await get('lab-file').listeners.change({ target: { files: [pdf], value: 'report.pdf' } });

    assert.equal(get('lab-convert').hidden, true);
    const uploads = requests.filter(request => request.url === '/api/lab/upload');
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].options.body.fields.item_id, '0');
    assert.equal(uploads[0].options.body.fields.kind, 'report');
    assert.equal(uploads[0].options.body.fields.file, pdf);
});

 test('successful query hides login while keeping results available', async () => {
    const { get } = labPage();
    await get('lab-query').listeners.click();
    assert.equal(get('lab-connection').hidden, true);
    assert.equal(get('lab-results').hidden, false);
 });
 test('reentry restores server session and expired operations restore login', async () => {
    const replies = {};
    const { get, load } = labPage([], replies);
    replies['/api/lab/status'] = {success:true, password_bound:true, logged_in:true, data:{items:[],semesters:[],mode:'按课程'}};
    await load();
    assert.equal(get('lab-connection').hidden, true);
    replies['/api/lab/experiments?semester=old'] = {success:false,code:'LAB_SESSION_EXPIRED',message:'请重新登录'};
    await get('lab-semester').listeners.change({target:{value:'old'}});
    assert.equal(get('lab-connection').hidden, false);
    assert.equal(get('lab-results').hidden, true);
 });
 test('saved password triggers a real login before expired session tasks are rendered', async () => {
    const { get, load, requests } = labPage([], {'/api/lab/status':{success:true,password_bound:true,logged_in:false}});
    await load();
    assert.equal(get('lab-connection').hidden, true);
    assert.equal(get('lab-results').hidden, false);
    const query = requests.find(r => r.url === '/api/lab/query');
    assert.equal(query.options.method, 'POST');
    assert.deepEqual(JSON.parse(query.options.body), {});
 });

test('report status reads show the existing filename and pending review without hiding original fields', async () => {
    const items = [{ id: '0', task_key: 'course-a', cells: ['1', '课程甲', '原始状态'], pre: true, report: true }];
    const { get, requests } = labPage(items, {
        '/api/lab/submission-status?semester=2026-2027-1-1': { success: true, data: {
            semester: '2026-2027-1-1', mode: '按课程', headers: ['编号', '课程', '状态'],
            semesters: [{ value: '2026-2027-1-1', label: '秋' }],
            items: [{ ...items[0], reports: {
                pre: { status: 'unknown', label: '未见已上传文件', file_name: '' },
                report: { status: 'submitted', label: '待评阅', file_name: '已交报告.pdf' },
            } }],
        } },
    });
    await get('lab-query').listeners.click();
    const card = get('lab-list').children[0];
    const texts = node => [node.textContent, ...(node.children || []).flatMap(texts)];
    assert.ok(texts(card).some(text => text.includes('待评阅') && text.includes('已交报告.pdf')));
    assert.ok(texts(card).includes('状态：原始状态'));
    assert.ok(texts(card).includes('重新提交实验报告'));
    assert.equal(requests.filter(r => r.url.includes('submission-status')).length, 1);
});

test('PDF request carries the original task identity and renders the refreshed submission state', async () => {
    const items = [{ id: '0', task_key: 'course-a', cells: ['1', '课程甲'], pre: true, report: true }];
    const { get, requests } = labPage(items, {
        '/api/lab/upload': { success: true, message: '文件已发送，请核对状态', data: { listing: {
            semester: '2026-2027-1-1', mode: '按课程', semesters: [],
            items: [{ ...items[0], reports: { report: { status: 'submitted', label: '待评阅', file_name: '报告.pdf' } } }],
        } } },
    });
    await get('lab-query').listeners.click();
    get('lab-list').children[0].children[1].children[1].click();
    await get('lab-file').listeners.change({ target: { files: [{ name: 'report.pdf', size: 100 }], value: '' } });
    const request = requests.find(r => r.url === '/api/lab/upload');
    assert.equal(request.options.body.fields.task_key, 'course-a');
    assert.equal(request.options.body.fields.semester, '2026-2027-1-1');
    assert.equal(get('lab-list').children[0].children[1].children[1].textContent, '重新提交实验报告');
});

test('an aborted previous mount cannot unlock controls while the new mount is still loading', async () => {
    let resolveStatus;
    const response = new Promise(resolve => { resolveStatus = resolve; });
    const { get, load, remount } = labPage([], { '/api/lab/status': () => response });
    const oldLoad = load();
    const newLoad = remount();
    await oldLoad;
    assert.equal(get('lab-query').disabled, true);
    assert.equal(get('lab-semester').disabled, true);
    resolveStatus({ success: true, password_bound: false, logged_in: false });
    await newLoad;
    assert.equal(get('lab-query').disabled, false);
});
