const { readAppSource } = require('./helpers/app-source');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { installApi } = require('./helpers/browser-api');

function createGradesPage() {
    const nodes = new Map();
    const document = {
        activeElement: null,
        addEventListener() {},
        getElementById(id) {
            if (!id.startsWith('grades-')) return null;
            if (!nodes.has(id)) {
                const node = {
                    style: {}, hidden: false, textContent: '', innerHTML: '', isConnected: true,
                    focus() { document.activeElement = this; },
                };
                nodes.set(id, node);
            }
            return nodes.get(id);
        },
    };
    const action = { focus() { document.activeElement = this; }, isConnected: true };
    document.getElementById('grades-page-title');
    document.activeElement = action;

    const source = readAppSource();
    const localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
    const context = vm.createContext({ document, localStorage, window: {}, console, TextEncoder });
    installApi(context);
    vm.runInContext(source, context);
    return { context, document, nodes, action };
}

test('grade queries replace the dashboard table inline without hiding its page heading', () => {
    const { context, nodes } = createGradesPage();
    vm.runInContext("gradesShowResult('不及格成绩')", context);

    assert.equal(nodes.get('grades-page-title').hidden, false);
    assert.equal(nodes.get('grades-result-title').textContent, '不及格成绩');
    assert.match(nodes.get('grades-content').innerHTML, /加载中/);
});
