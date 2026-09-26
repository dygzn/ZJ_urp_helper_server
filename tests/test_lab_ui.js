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
        click() { this.listeners.click?.(); },
    };
}

function labPage() {
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
    const requests = [];
    const source = fs.readFileSync(path.join(__dirname, '../static/js/lab.js'), 'utf8');
    vm.runInNewContext(source, {
        document, window: {}, getDeviceId: () => 'device',
        FormData: class {
            constructor() { this.fields = {}; }
            append(key, value) { this.fields[key] = value; }
        },
        fetch: async (url, options) => {
            requests.push({ url, options });
            return { ok: true, headers: { get: () => 'application/json' },
                json: async () => ({ success: true, data, message: '已发送' }) };
        },
    });
    return { get, requests };
}

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
    const source = fs.readFileSync(path.join(__dirname, '../static/js/lab.js'), 'utf8');
    vm.runInNewContext(source, {
        document, window: {}, getDeviceId: () => 'device',
        fetch: async () => ({ ok: true, headers: { get: () => 'application/json' },
            json: async () => ({ success: true, data }) }),
    });

    await get('lab-query').listeners.click();

    assert.equal(get('lab-mode').textContent, '按课程展示原站可提交的实验任务');
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
