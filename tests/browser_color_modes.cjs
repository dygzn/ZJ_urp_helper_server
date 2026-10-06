const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const template = name => fs.readFileSync(path.join(root, 'templates', name), 'utf8')
    .replace(/{%[\s\S]*?%}/g, '').replace(/{{[\s\S]*?}}/g, '');
const output = path.join(root, 'artifacts/color-mode-preview');

(async () => {
    fs.mkdirSync(output, { recursive: true });
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        for (const theme of ['workspace', 'glass']) {
            const context = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1440, height: 900 } });
            await context.addInitScript(theme => localStorage.setItem('urp_ui_template', theme), theme);
            const requests = [];
            await context.route('**/*', route => {
                const pathname = new URL(route.request().url()).pathname;
                if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: template('index.html') });
                if (pathname === '/admin') return route.fulfill({ contentType: 'text/html', body: template('admin.html') });
                if (pathname === '/ad') return route.fulfill({ contentType: 'text/html', body: template('ad_detail.html') });
                if (pathname === '/appearance-only') return route.fulfill({ contentType: 'text/html', body: template('index.html')
                    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
                    .replace('</head>', '<script src="/static/js/appearance.js"></script></head>') });
                if (pathname.startsWith('/static/')) return route.fulfill({ path: root + pathname });
                requests.push(pathname);
                return route.fulfill({ json: { success: true, bound: true, logged_in: true, username: 'color-mode-test',
                    announcements: [], event: { current: null, upcoming: [] }, data: {} } });
            });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            const setMode = async mode => {
                await page.locator(`.appearance-color-mode:has(input[value="${mode}"])`).click();
            };
            const assertDark = async dark => {
                await page.waitForFunction(dark => getComputedStyle(document.documentElement).getPropertyValue('--ui-color-scheme').trim() === (dark ? 'dark' : 'light'), dark);
                assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor),
                    dark ? 'rgb(15, 23, 42)' : theme === 'glass' ? 'rgb(233, 231, 226)' : 'rgb(243, 246, 250)');
                assert.equal(await page.locator('meta[name="theme-color"]').getAttribute('content'), dark ? '#0f172a' : theme === 'glass' ? '#e9e7e2' : '#f3f6fa');
            };
            await page.goto('http://urp.test/');
            await page.waitForFunction(() => window.URP?.store.getState().currentUsername === 'color-mode-test');
            await assertDark(true);
            await page.locator('.appearance-trigger-header').click();
            assert.equal(await page.locator('input[name="ui-color-mode"]').count(), 3);
            const before = requests.length;
            await setMode('light');
            await assertDark(false);
            await page.emulateMedia({ colorScheme: 'light' });
            await setMode('dark');
            await assertDark(true);
            await page.emulateMedia({ colorScheme: 'dark' });
            await assertDark(true);
            await setMode('system');
            await page.emulateMedia({ colorScheme: 'light' });
            await assertDark(false);
            await page.emulateMedia({ colorScheme: 'dark' });
            await assertDark(true);
            assert.equal(requests.length, before, 'changing color mode does not query academic data');
            await page.locator('input[name="ui-color-mode"][value="system"]').focus();
            await page.keyboard.press('ArrowLeft');
            assert.equal(await page.locator('input[name="ui-color-mode"][value="dark"]').isChecked(), true);
            await assertDark(true);
            await setMode('light');
            const peer = await context.newPage();
            await peer.goto('http://urp.test/ad');
            await peer.evaluate(() => localStorage.setItem('urp_ui_color_mode', 'dark'));
            await assertDark(true);
            assert.equal(await page.locator('input[name="ui-color-mode"][value="dark"]').isChecked(), true);
            await peer.evaluate(() => localStorage.setItem('urp_ui_color_mode', 'light'));
            await assertDark(false);
            await peer.close();
            await page.keyboard.press('Escape');
            assert.equal(await page.evaluate(() => document.activeElement.classList.contains('appearance-trigger-header')), true);
            await page.reload();
            await assertDark(false);
            await page.goto('http://urp.test/ad');
            await assertDark(false);
            await page.goto('http://urp.test/admin');
            await page.evaluate(() => {
                document.getElementById('admin-login').style.display = 'none';
                document.getElementById('admin-panel').style.display = 'block';
            });
            await page.locator('.appearance-trigger-admin').click();
            assert.equal(await page.locator('input[name="ui-color-mode"][value="light"]').isChecked(), true);
            await setMode('dark');
            await page.goto('http://urp.test/');
            await assertDark(true);
            await page.setViewportSize({ width: 320, height: 568 });
            await page.locator('#mobile-nav-more').click();
            await page.locator('.appearance-trigger-sidebar').click();
            await page.screenshot({ path: path.join(output, `${theme}-dark-mobile.png`), animations: 'disabled' });
            const boxes = await page.locator('.appearance-color-mode').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().width));
            assert.equal(boxes.length, 3);
            assert.ok(boxes.every(width => width >= 44));
            await setMode('light');
            await assertDark(false);
            await page.screenshot({ path: path.join(output, `${theme}-light-mobile.png`), animations: 'disabled' });
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            await page.keyboard.press('Escape');
            await page.evaluate(() => localStorage.setItem('urp_ui_color_mode', 'invalid'));
            await page.reload();
            await assertDark(true);
            // Storage failures still permit switching for this page session.
            await page.addInitScript(() => {
                Storage.prototype.getItem = () => { throw new Error('Storage disabled'); };
                Storage.prototype.setItem = () => { throw new Error('Storage disabled'); };
            });
            await page.setViewportSize({ width: 1440, height: 900 });
            await page.goto('http://urp.test/appearance-only');
            await assertDark(true);
            await page.locator('.appearance-trigger-header').click();
            await setMode('light');
            // The stored template cannot be recovered, so the default workspace applies.
            await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(243, 246, 250)');
            assert.deepEqual(errors, []);
            console.log(`PASS ${theme}: manual light/dark, reactive system mode, persistence, shared pages, mobile controls and focus`);
            await context.close();
        }
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
