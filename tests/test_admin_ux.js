const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { syncTabAriaState } = require('../static/js/ui-ux.js');

function makeClassList() {
    const values = new Set();
    return {
        add(value) { values.add(value); },
        remove(value) { values.delete(value); },
        toggle(value, force) {
            if (force) values.add(value);
            else values.delete(value);
        },
        contains(value) { return values.has(value); },
    };
}

function makeTab(name) {
    const attributes = {};
    return {
        dataset: { tab: name },
        classList: makeClassList(),
        setAttribute(key, value) { attributes[key] = value; },
        getAttribute(key) { return attributes[key] || null; },
        attributes,
    };
}

function makePanel(name) {
    const attributes = {};
    return {
        id: `tab-${name}`,
        classList: makeClassList(),
        setAttribute(key, value) { attributes[key] = value; },
        attributes,
    };
}

test('切换管理员标签时只保留一个 aria-selected 面板', () => {
    const tabs = ['users', 'members', 'config'].map(makeTab);
    const panels = ['users', 'members', 'config'].map(makePanel);

    syncTabAriaState(tabs, panels, 'members');

    assert.deepEqual(tabs.map(tab => tab.attributes['aria-selected']), ['false', 'true', 'false']);
    assert.equal(tabs[1].classList.contains('active'), true);
    assert.equal(panels[1].classList.contains('active'), true);
    assert.equal(panels[1].attributes['aria-labelledby'], 'tab-members-button');
});

test('管理员模板和样式为登录与标签操作保留可触控结构', () => {
    const template = fs.readFileSync(path.join(__dirname, '..', 'templates', 'admin.html'), 'utf8');
    const stylesheet = fs.readFileSync(path.join(__dirname, '..', 'static', 'css', 'admin.css'), 'utf8');
    const script = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'admin.js'), 'utf8');

    assert.match(template, /role="tablist"/);
    assert.match(template, /class="login-btn"/);
    assert.match(template, /id="admin-toast-region"/);
    assert.match(script, /function showAdminToast/);
    assert.doesNotMatch(script, /\balert\(/);
    assert.match(stylesheet, /:where\(button, \[role="button"\]\)[\s\S]*min-width:\s*44px[\s\S]*min-height:\s*44px/);
    assert.match(stylesheet, /input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\),\s*select,\s*textarea[\s\S]*min-height:\s*48px/);
    assert.match(stylesheet, /\.tab-btn[\s\S]*min-height:\s*44px/);
    assert.match(stylesheet, /\.login-btn[\s\S]*min-height:\s*48px/);
});

test('管理员窄屏标题不会被布局规则撑出异常空白', () => {
    const stylesheet = fs.readFileSync(path.join(__dirname, '..', 'static', 'css', 'admin.css'), 'utf8');
    const uxCloseBlock = stylesheet.split('/* ==================== UX 收口：管理员端触控与窄屏布局 ==================== */')[1] || '';

    assert.doesNotMatch(
        uxCloseBlock,
        /\.section-header\s+h2[\s\S]*?flex:\s*1\s+1\s+180px/,
        '窄屏 section 标题不应使用 180px 的 flex 基准高度'
    );
});
