// Real admin template and scripts; every request is intercepted with offline fixtures.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.env.URP_TEST_ROOT || path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts/withdrawal-text-preview');
const html = fs.readFileSync(path.join(root, 'templates/admin.html'), 'utf8')
    .replace(/{{\s*static_versioned\('([^']+)'\)\s*}}/g, (_, file) => `/static/${file}`)
    .replace(/{%[\s\S]*?%}|{{[\s\S]*?}}/g, '');
const markup = '<img src=x onerror="window.withdrawalInjected=true">';
const row = { id: 7, username: `offline-student`, real_name: `离线姓名 ${markup}`,
    alipay_account: `offline-long-payment-account-${markup}-&-"收款"`,
    amount: '2.98', earned: '8.00', withdrawn: '3.00', available_after: '2.02',
    status: 'pending', create_time: '2026-10-18T01:00:00', review_time: null };
(async () => {
    fs.mkdirSync(output, { recursive: true });
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        for (const theme of ['workspace', 'glass', 'paper', 'garden', 'clay']) {
            for (const scheme of ['light', 'dark']) {
                const width = scheme === 'light' ? 1440 : 320;
                const context = await browser.newContext({ colorScheme: scheme, reducedMotion: 'reduce', viewport: { width, height: 900 } });
                await context.addInitScript(theme => localStorage.setItem('urp_ui_template', theme), theme);
                const posts = [], errors = [];
                let result = { success: true, data: [row] }, hold, release;
                await context.route('**/*', async route => {
                    const request = route.request();
                    const pathname = new URL(request.url()).pathname;
                    if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
                    if (pathname.startsWith('/static/')) return route.fulfill({ path: root + pathname });
                    assert.equal(request.headers()['x-admin-key'], 'offline-review-key');
                    if (pathname === '/api/admin/withdrawals') {
                        if (hold) await new Promise(resolve => { release = resolve; });
                        return route.fulfill({ json: result });
                    }
                    if (/\/api\/admin\/withdrawals\/7\/(approve|reject)$/.test(pathname)) {
                        posts.push({ pathname, method: request.method() });
                        return route.fulfill({ json: { success: true } });
                    }
                    const fixtures = {
                        '/api/admin/monitor/online': { success: true, users: [], count: 0 },
                        '/api/admin/users': { success: false, message: '当前为提现页面离线预览' },
                        '/api/admin/commission_stats': { success: true, data: { users: [], summary: {} } },
                    };
                    return route.fulfill({ json: fixtures[pathname] || { success: true, data: [] } });
                });
                const page = await context.newPage();
                page.on('pageerror', error => errors.push(error.message));
                await page.goto('http://urp.test/');
                await page.locator('#admin-key').fill('offline-review-key');
                await page.locator('#admin-login-form button[type="submit"]').click();
                await page.locator('#admin-panel').waitFor({ state: 'visible' });
                hold = true;
                await page.getByRole('tab', { name: '提现管理', exact: true }).click();
                const list = page.locator('#withdrawals-list');
                await list.getByText('加载中...', { exact: true }).waitFor();
                const shot = name => page.screenshot({ path: path.join(output, `${theme}-${scheme}-${width}-${name}.png`), fullPage: true, animations: 'disabled' });
                await shot('loading');
                assert.ok(release); hold = false; release();
                await list.locator('.withdraw-payee').waitFor();
                const safe = async () => {
                    assert.equal(await list.locator('img,svg,script,iframe').count(), 0);
                    assert.equal(await page.evaluate(() => Boolean(window.withdrawalInjected)), false);
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
                };
                await safe();
                assert.equal(await list.locator('.withdraw-payee').textContent(), row.real_name);
                assert.equal(await list.locator('[data-label="收款信息"] .commission-muted').textContent(), row.alipay_account);
                assert.ok((await list.textContent()).includes('¥2.98'));
                const approve = list.getByRole('button', { name: '通过', exact: true });
                const reject = list.getByRole('button', { name: '拒绝', exact: true });
                await approve.scrollIntoViewIfNeeded();
                await approve.focus();
                await shot('records');
                page.once('dialog', dialog => dialog.dismiss());
                await approve.press('Enter');
                assert.equal(posts.length, 0);
                page.once('dialog', dialog => dialog.accept());
                await approve.click();
                await page.getByRole('status').getByText('提现审核已通过', { exact: true }).waitFor();
                page.once('dialog', dialog => dialog.accept());
                await reject.click();
                await page.getByRole('status').getByText('提现申请已拒绝', { exact: true }).waitFor();
                assert.deepEqual(posts, [{ pathname: '/api/admin/withdrawals/7/approve', method: 'POST' },
                    { pathname: '/api/admin/withdrawals/7/reject', method: 'POST' }]);
                const refresh = page.locator('#tab-withdrawals .section-header').getByRole('button', { name: '刷新', exact: true });
                result = { success: false, message: `离线错误 ${markup}` };
                await refresh.click();
                await page.waitForFunction(message => document.querySelector('#withdrawals-list').textContent === message, result.message);
                await safe();
                await shot('error');
                result = { success: true, data: [] };
                await refresh.click();
                await list.getByText('暂无提现申请', { exact: true }).waitFor();
                await safe();
                await shot('empty');
                assert.deepEqual(errors, []);
                console.log(`PASS admin ${theme}/${scheme}/${width}: literal payee/account, layout, loading/empty/error, cancel/approve/reject, offline authorization, no script errors`);
                await context.close();
            }
        }
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
