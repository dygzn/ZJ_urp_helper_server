const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
    document.getElementById('grades-back-btn');
    document.getElementById('grades-menu').contains = node => node === action;
    document.getElementById('grades-menu').querySelector = selector =>
        selector === '.grade-action-btn' ? action : null;
    document.activeElement = action;

    const source = fs.readFileSync(path.join(__dirname, '../static/js/main.js'), 'utf8');
    const localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
    const context = vm.createContext({ document, localStorage, window: {}, console, TextEncoder });
    vm.runInContext(source, context);
    return { context, document, nodes, action };
}

test('entering a grade result shows its title as the only page heading and focuses return', () => {
    const { context, document, nodes } = createGradesPage();
    vm.runInContext("gradesShowResult('一键查本学期成绩')", context);

    assert.equal(nodes.get('grades-page-title').hidden, true);
    assert.equal(nodes.get('grades-menu').style.display, 'none');
    assert.equal(nodes.get('grades-result').style.display, '');
    assert.equal(nodes.get('grades-result-title').textContent, '一键查本学期成绩');
    assert.equal(document.activeElement, nodes.get('grades-back-btn'));
});

test('return from a picker restores focus to the query choices', () => {
    const { context, document, action } = createGradesPage();
    document.activeElement = { isConnected: true };
    vm.runInContext("gradesShowResult('本学期成绩')", context);
    vm.runInContext('gradesBackToMenu()', context);

    assert.equal(document.activeElement, action);
});

test('returning from a grade result restores query choices and keyboard focus', () => {
    const { context, document, nodes, action } = createGradesPage();
    vm.runInContext("gradesShowResult('一键查本学期成绩')", context);
    document.activeElement = nodes.get('grades-back-btn');
    vm.runInContext('gradesBackToMenu()', context);

    assert.equal(nodes.get('grades-page-title').hidden, false);
    assert.equal(nodes.get('grades-menu').style.display, '');
    assert.equal(nodes.get('grades-result').style.display, 'none');
    assert.equal(document.activeElement, action);
});
