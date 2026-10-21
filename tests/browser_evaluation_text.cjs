// Real page and module graph, intercepted APIs only; no school or payment traffic.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.env.URP_TEST_ROOT || path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts/evaluation-text-preview');
const html = fs.readFileSync(path.join(root, 'templates/index.html'), 'utf8')
    .replace(/{{\s*static_versioned\('([^']+)'\)\s*}}/g, (_, file) => `/static/${file}`)
    .replace(/{%[\s\S]*?%}|{{[\s\S]*?}}/g, '');
const markup = '<img src=x onerror="window.evaluationInjected=true">';
const message = `评估完成，保留 <课程> & "说明" ${markup}`;
const courses = [{ '未评课程': `面向复杂工程问题的跨学科课程设计与综合实践 ${markup} & "项目"`,
    '教师': `联合授课教师与校外实践指导教师 ${markup}`, wjbm: 'offline-form', bpr: 'offline-teacher', pgnr: 'offline-course', oper: 'wjShow' }];

(async () => {
    fs.mkdirSync(output, { recursive: true });
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        for (const theme of ['workspace', 'glass', 'paper', 'garden', 'clay']) {
            for (const scheme of ['light', 'dark']) {
                const width = scheme === 'light' ? 1440 : theme === 'workspace' ? 320 : 390;
                const context = await browser.newContext({ colorScheme: scheme,
                    reducedMotion: 'reduce', viewport: { width, height: 900 } });
                await context.addInitScript(theme => {
                    localStorage.setItem('urp_ui_template', theme);
                    localStorage.setItem('device_id', 'offline-evaluation-device');
                }, theme);
                const posts = [], errors = [], loadedModules = [];
                let result = { success: true, has_courses: true, courses };
                let holdQuery, holdSubmit, releaseQuery, releaseSubmit;
                await context.route('**/*', async route => {
                    const request = route.request();
                    const url = new URL(request.url());
                    const pathname = url.pathname;
                    if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
                    if (pathname.startsWith('/static/')) {
                        if (pathname.endsWith('/evaluation.js')) loadedModules.push(url.search);
                        return route.fulfill({ path: root + pathname });
                    }
                    if (pathname === '/api/unevaluated_courses') {
                        if (holdQuery) await new Promise(resolve => { releaseQuery = resolve; });
                        return route.fulfill({ json: result });
                    }
                    if (pathname === '/api/evaluation') {
                        posts.push(request.postDataJSON());
                        if (holdSubmit) await new Promise(resolve => { releaseSubmit = resolve; });
                        return route.fulfill({ json: { success: true, message } });
                    }
                    const fixtures = {
                        '/api/check_bind': { success: true, bound: true, username: 'offline-preview' },
                        '/api/check_login_status': { success: true, logged_in: true },
                        '/api/member/status': { success: true, data: { is_member: true, member_type: 'basic' } },
                    };
                    return route.fulfill({ json: fixtures[pathname] || {
                        success: true, announcements: [], unread_count: 0, event: { current: null, upcoming: [] }, data: {},
                    } });
                });
                const page = await context.newPage();
                page.on('pageerror', error => errors.push(error.message));
                await page.goto('http://urp.test/');
                await page.waitForFunction(() => window.URP?.store.getState().currentUsername === 'offline-preview');
                await page.evaluate(() => switchPage('evaluation'));
                const resultNode = page.locator('#evaluation-result');
                const query = page.getByRole('button', { name: '查询待评课程', exact: true });
                const modal = page.locator('#ui-confirm-modal');
                const confirm = page.locator('#ui-confirm-confirm');
                const shot = name => page.screenshot({ path: path.join(output, `${theme}-${scheme}-${width}-${name}.png`), fullPage: true, animations: 'disabled' });
                const assertSafe = async () => {
                    assert.equal(await resultNode.locator('img, svg, iframe, script').count(), 0);
                    assert.equal(await page.evaluate(() => Boolean(window.evaluationInjected)), false);
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
                };
                assert.equal(await resultNode.textContent(), '');
                holdQuery = true;
                await query.click();
                await resultNode.getByText('正在查询未评估课程...', { exact: true }).waitFor();
                await page.waitForFunction(() => true);
                await shot('loading');
                assert.ok(releaseQuery);
                holdQuery = false; releaseQuery();
                await resultNode.locator('.evaluation-course').waitFor();
                assert.equal(await resultNode.locator('.evaluation-course-name').textContent(), courses[0]['未评课程']);
                assert.equal(await resultNode.locator('.evaluation-course-teacher').textContent(), `教师: ${courses[0]['教师']}`);
                await assertSafe();
                await shot('courses');
                const complete = page.getByRole('button', { name: '完成评估', exact: true });
                for (const dismiss of ['cancel', 'escape', 'backdrop']) {
                    await complete.click();
                    await modal.waitFor({ state: 'visible' });
                    assert.equal(posts.length, 0);
                    assert.equal(await page.locator('#ui-confirm-cancel').evaluate(el => el === document.activeElement), true);
                    if (dismiss === 'cancel') await page.locator('#ui-confirm-cancel').click();
                    if (dismiss === 'escape') await page.keyboard.press('Escape');
                    if (dismiss === 'backdrop') await modal.click({ position: { x: 4, y: 4 } });
                    await modal.waitFor({ state: 'hidden' });
                    assert.equal(await complete.evaluate(el => el === document.activeElement), true);
                    assert.equal(posts.length, 0);
                }
                await complete.focus();
                await page.keyboard.press('Enter');
                await modal.waitFor({ state: 'visible' });
                await page.keyboard.press('Shift+Tab');
                assert.equal(await confirm.evaluate(el => el === document.activeElement), true);
                await shot('confirmation');
                holdSubmit = true;
                await confirm.click();
                await resultNode.getByText('正在提交评教...', { exact: true }).waitFor();
                await shot('submitting');
                assert.ok(releaseSubmit);
                holdSubmit = false; releaseSubmit();
                await page.waitForFunction(message => document.querySelector('.evaluation-success-message')?.textContent === message, message);
                await assertSafe();
                assert.deepEqual(posts, [{ courses }]);
                await shot('success');
                result = { success: false, message };
                await query.click();
                await page.waitForFunction(message => document.querySelector('#evaluation-result').textContent === message, message);
                await assertSafe();
                await shot('error');
                result = { success: true, has_courses: false, message };
                await query.click();
                await page.waitForFunction(message => document.querySelector('.evaluation-success-message')?.textContent === message, message);
                await assertSafe();
                await shot('empty');
                result = { success: true, has_courses: true, courses };
                await page.getByRole('button', { name: '一键评教', exact: true }).click();
                await modal.waitFor({ state: 'visible' });
                await confirm.click();
                await page.waitForFunction(message => document.querySelector('.evaluation-success-message')?.textContent === message, message);
                await assertSafe();
                // Compatibility entry still previews and submits unchanged raw values.
                holdSubmit = true; releaseSubmit = null;
                await page.evaluate(() => { window.evaluationWork = doFullEvaluation(); });
                await resultNode.locator('.evaluation-course-preview').waitFor();
                assert.equal(await resultNode.locator('.evaluation-course-name').textContent(), courses[0]['未评课程']);
                await assertSafe();
                await shot('preview');
                assert.ok(releaseSubmit);
                holdSubmit = false; releaseSubmit();
                await page.evaluate(() => window.evaluationWork);
                await assertSafe();
                assert.deepEqual(posts, [{ courses }, { courses }, { courses }]);
                assert.equal(await page.getByRole('button', { name: '一键评教', exact: true }).isEnabled(), true);
                assert.equal(await page.locator('#do-eval-btn').isEnabled(), true);
                assert.ok(loadedModules.includes('?v=20261018-safe-text'));
                assert.deepEqual(errors, []);
                console.log(`PASS ${theme}/${scheme}/${width}: literal text, loading/empty/error, confirmation, three submission paths, raw payload, version, focus, no script errors`);
                await context.close();
            }
        }
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
