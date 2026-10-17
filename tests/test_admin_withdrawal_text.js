const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const payload = '<img src=x onerror="globalThis.injected=true"> & "收款"';
const escaped = '&lt;img src=x onerror="globalThis.injected=true"&gt; &amp; "收款"';
const withdrawal = { id: 7, username: payload, real_name: payload, alipay_account: payload,
    amount: '2.98', earned: '8.00', withdrawn: '3.00', available_after: '2.02', status: 'pending',
    create_time: '2026-10-18T01:00:00', review_time: null };
function adminPage(response) {
    const node = { innerHTML: '' };
    const context = vm.createContext({ window: {}, console,
        document: { addEventListener() {}, getElementById: () => node,
            // Native text-node serialization only; real browser coverage accompanies this adapter.
            createElement() { return { textContent: '', get innerHTML() {
                return String(this.textContent ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            } }; },
        },
        fetch: async () => {
            if (response instanceof Error) throw response;
            return { json: async () => response };
        },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/js/admin.js'), 'utf8'), context);
    return { context, node };
}
test('后台提现申请将用户姓名、收款账号和学号作为文本展示', async () => {
    const { context, node } = adminPage({ success: true, data: [withdrawal] });
    await context.loadAdminWithdrawals();
    assert.doesNotMatch(node.innerHTML, /<img\b/);
    assert.equal(node.innerHTML.split(escaped).length - 1, 3);
    assert.match(node.innerHTML, /¥2\.98/);
    assert.match(node.innerHTML, /¥8\.00/);
    assert.match(node.innerHTML, /通过后剩 ¥2\.02/);
    assert.match(node.innerHTML, /onclick="approveWithdrawal\(7\)"/);
    assert.match(node.innerHTML, /onclick="rejectWithdrawal\(7\)"/);
});
test('未知提现状态和返回时间也不能插入页面标记', async () => {
    const { context, node } = adminPage({ success: true, data: [{ ...withdrawal,
        username: 'offline-student', real_name: '离线姓名', alipay_account: 'offline-account',
        status: payload, create_time: '<img src=x>', review_time: '<svg onload=x>' }] });
    await context.loadAdminWithdrawals();
    assert.doesNotMatch(node.innerHTML, /<img\b|<svg\b/);
    assert.ok(node.innerHTML.includes(escaped));
    assert.match(node.innerHTML, /&lt;img src=x&gt;/);
    assert.match(node.innerHTML, /&lt;svg onload=x&gt;/);
    assert.doesNotMatch(node.innerHTML, /approveWithdrawal\(/);
});
for (const [name, response] of [['接口错误', { success: false, message: payload }], ['请求异常', new Error(payload)]]) {
    test(`后台提现${name}显示纯文本`, async () => {
        const { context, node } = adminPage(response);
        await context.loadAdminWithdrawals();
        assert.doesNotMatch(node.innerHTML, /<img\b/);
        assert.ok(node.innerHTML.includes(escaped));
    });
}
