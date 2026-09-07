const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    normalizePageName,
    getGuestAccessCopy,
    isModalDismissible,
    getFocusableElements,
} = require('../static/js/ui-ux.js');

test('未知页面会回退到首页而不是写入非法页面状态', () => {
    assert.equal(
        normalizePageName('surveys', ['home', 'schedule', 'feedback']),
        'home',
    );
});

test('受限页面会返回明确的绑定提示', () => {
    assert.deepEqual(getGuestAccessCopy('grades'), {
        title: '成绩查询需要绑定教务账号',
        description: '绑定后即可查询成绩，并保留当前页面操作。',
        button: '立即绑定',
    });
});

test('登录弹窗不可被遮罩误关闭，普通弹窗可以关闭', () => {
    assert.equal(isModalDismissible({ id: 'login-modal', dataset: {} }), false);
    assert.equal(isModalDismissible({ id: 'course-detail-modal', dataset: {} }), true);
});

test('焦点筛选只返回可见且未禁用的控件', () => {
    const enabled = { disabled: false, hidden: false, getClientRects: () => [1] };
    const disabled = { disabled: true, hidden: false, getClientRects: () => [1] };
    const hidden = { disabled: false, hidden: true, getClientRects: () => [1] };
    const container = {
        querySelectorAll: () => [enabled, disabled, hidden],
    };
    assert.deepEqual(getFocusableElements(container), [enabled]);
});

test('用户弹窗都有可被辅助技术识别的标题', () => {
    const template = fs.readFileSync(path.join(__dirname, '..', 'templates', 'index.html'), 'utf8');
    const modalRoots = template.match(/<div id="[^"]+" class="[^"]*\bmodal\b[^"]*" role="dialog"[^>]*>/g) || [];

    assert.ok(modalRoots.length >= 10);
    modalRoots.forEach(root => assert.match(root, /aria-labelledby="[^"]+"/));
});

test('窄屏未单独命名的按钮和输入框也有足够触控高度', () => {
    const stylesheet = fs.readFileSync(path.join(__dirname, '..', 'static', 'css', 'style.css'), 'utf8');

    assert.match(stylesheet, /:where\(button, \[role="button"\]\)[\s\S]*min-width:\s*var\(--touch-target\)[\s\S]*min-height:\s*var\(--touch-target\)/);
    assert.match(stylesheet, /input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\),\s*select,\s*textarea[\s\S]*min-height:\s*var\(--touch-target-strong\)/);
});
