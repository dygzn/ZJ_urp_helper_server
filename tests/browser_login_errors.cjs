// Render the real login form with intercepted APIs; never contact the school.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.env.URP_TEST_ROOT || path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts/login-errors-preview');
const html = fs.readFileSync(path.join(root, 'templates/index.html'), 'utf8')
    .replace(/{{\s*static_versioned\('([^']+)'\)\s*}}/g, (_, file) => `/static/${file}`)
    .replace(/{%[\s\S]*?%}|{{[\s\S]*?}}/g, '');
const messages = [
    '学号或密码不正确，请核对后重试。',
    '学校教务系统响应超时，请稍后重试。',
    '登录验证码校验未通过，请重试。',
    '教务账号暂时被限制登录，请到学校教务系统确认账号状态。',
    '教务登录失败，请稍后重试，或先到学校教务系统确认账号能否登录。',
];

(async () => {
    fs.mkdirSync(output, { recursive: true });
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        for (const [theme, scheme, width, height] of [
            ['workspace', 'light', 1440, 900], ['workspace', 'dark', 320, 740],
            ['glass', 'light', 390, 844], ['glass', 'dark', 390, 844],
        ]) {
            const context = await browser.newContext({ colorScheme: scheme, viewport: { width, height } });
            await context.addInitScript(theme => {
                localStorage.setItem('urp_ui_template', theme);
                localStorage.setItem('device_id', 'offline-preview-device');
            }, theme);
            let current = '', hold = false, release, posts = 0;
            const errors = [];
            await context.route('**/*', async route => {
                const pathname = new URL(route.request().url()).pathname;
                if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
                if (pathname.startsWith('/static/')) return route.fulfill({ path: root + pathname });
                if (pathname === '/api/login') {
                    posts++;
                    const payload = route.request().postDataJSON();
                    assert.equal(payload.username, 'preview-student');
                    assert.equal(payload.password, 'preview-password');
                    if (hold) await new Promise(resolve => { release = resolve; });
                    return route.fulfill({ json: { success: false, message: current } });
                }
                const fixtures = {
                    '/api/check_bind': { success: true, bound: false },
                    '/api/check_login_status': { success: true, logged_in: false },
                    '/api/service-status': { success: true, status: {} },
                };
                return route.fulfill({ json: fixtures[pathname] || {
                    success: true, announcements: [], unread_count: 0, event: { current: null, upcoming: [] }, data: {},
                } });
            });
            const page = await context.newPage();
            page.on('pageerror', error => errors.push(error.message));
            await page.goto('http://urp.test/');
            await page.waitForFunction(() => window.URP?.auth);
            await page.evaluate(() => showLoginModal());
            const modal = page.locator('#login-modal');
            const error = page.locator('#login-error');
            const password = page.locator('#password');
            const submit = page.locator('#login-form button[type="submit"]');
            await page.locator('#username').fill('preview-student');
            await password.fill('preview-password');
            assert.equal(await error.textContent(), '');
            for (let i = 0; i < messages.length; i++) {
                current = messages[i];
                hold = i === 1;
                if (i === messages.length - 1) await password.press('Enter');
                else await submit.click();
                if (hold) {
                    await page.waitForFunction(() => document.querySelector('#login-error').textContent === '');
                    assert.equal(await modal.isVisible(), true);
                    for (let tries = 0; !release && tries < 20; tries++) await new Promise(resolve => setTimeout(resolve, 10));
                    assert.ok(release, 'intercepted login request must be pending');
                    release();
                }
                await page.waitForFunction(message => document.querySelector('#login-error').textContent === message, current);
                assert.equal(await password.inputValue(), 'preview-password');
                assert.equal(await submit.isEnabled(), true);
                assert.equal(await error.getAttribute('role'), 'alert');
                const bounds = await error.boundingBox();
                assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, 'error must fit horizontally');
                assert.equal(await modal.isVisible(), true);
            }
            assert.equal(posts, messages.length, 'one login request per user submission');
            await page.keyboard.press('Escape');
            assert.equal(await modal.isVisible(), true, 'login dialog keeps existing guest dismissal flow');
            await page.screenshot({ path: path.join(output, `${theme}-${scheme}-${width}.png`) });
            assert.deepEqual(errors, []);
            console.log(`PASS ${theme}/${scheme}/${width}: empty, pending, five failures, retry, keyboard, bounds`);
            await context.close();
        }
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
