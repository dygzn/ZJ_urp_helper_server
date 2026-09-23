const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element() {
    return {
        textContent: '', value: '', checked: false, disabled: false, hidden: false,
        children: [], listeners: {}, classList: { toggle() {} },
        replaceChildren() { this.children = []; },
        append(child) { this.children.push(child); },
        addEventListener(type, listener) { this.listeners[type] = listener; },
    };
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
