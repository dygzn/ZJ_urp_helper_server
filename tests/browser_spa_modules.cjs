// Run with Playwright available: NODE_PATH=/path/to/node_modules node tests/browser_spa_modules.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const start = '2026-09-07';
const course = { '课程名': '模块验证课程', '星期': '1', '节次': '1', '节数': '2', '位置': 'A201' };
const schedule = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [index + 1, [course]]));
const fixtures = {
    '/api/check_bind': { success: true, bound: true, username: 'module-test' },
    '/api/check_login_status': { success: true, logged_in: true },
    '/api/invitation/link': { success: false },
    '/api/announcements': { success: true, announcements: [] },
    '/api/urgent_event': { success: true, event: {
        current: { title: '首页计时课程', location: 'A201', time: `${today} 08:20-10:00`, remaining: 20 },
        upcoming: [], is_freshman: false,
    } },
    '/api/schedule': { success: true, account: 'module-test', data: { schedule, semester_start: start, is_freshman: false } },
    '/api/exams': { success: true, account: 'module-test', semester_start: start, exams: [
        { exam_name: '模块验证考试', course: '数学', week: '4', day: '5', time: '08:20-10:00', location: 'A202' },
    ] },
    '/api/grades/latest_summary': { success: true, semester: '2026-2027-1',
        passed: [{ course: '模块验证成绩', credit: 3, score: 90 }],
        failed: { current: [], past: [] } },
    '/api/grades/current': { success: true, grades: [{ course: '模块验证成绩', credit: 3, score: 90 }] },
    '/api/grades/gpa': { success: true, gpa: { '学分绩点': 3.25,
        '学期绩点明细': [{ '学年学期': '2026-2027-1', '学分绩点': 3.5 }] } },
    '/api/grades/failed': { success: true, current: [], past: [] },
    '/api/grades/latest_makeup': { success: true,
        latest_session: { period: '2026-2027-1', label: '2026-2027学年秋学期', sessions: ['2026秋学期补考'], status: 'published' },
        latest_published: { period: '2026-2027-1', label: '2026-2027学年秋学期',
            results: [{ course: '模块补考成绩', credit: '2', score: '75', sessions: ['2026秋学期补考'] }] } },
    '/api/lab/status': { success: true, student_id: 'module-test', password_bound: false },
    '/api/feedback': { success: true, my_feedbacks: [], public_feedbacks: [] },
    '/api/member/status': { success: true, data: { is_member: false } },
    '/api/member/orders': { success: true, data: [] },
    '/api/member/api-key': { success: true, data: { has_key: false } },
};
const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname.startsWith('/api/')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(fixtures[pathname] || { success: false, message: '测试空状态', data: {} }));
        return;
    }
    const file = path.join(root, pathname === '/' ? 'templates/index.html' : pathname);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    let body = fs.readFileSync(file);
    if (pathname === '/') {
        // Preserve the production HTML and scripts, rendering only template markers
        // with test values; HTTP boundaries are local fixtures, never real accounts.
        body = body.toString().replace(/{%[\s\S]*?%}/g, '').replace(/{{[\s\S]*?}}/g, '');
    }
    res.end(body);
});

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ headless: true,
            ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
        for (const width of [1440, 390]) {
            const context = await browser.newContext({ viewport: { width, height: 900 } });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => { errors.push(error.message); console.error('Browser:', error.message); });
            await page.addInitScript(() => {
                const intervals = new Set();
                const set = window.setInterval.bind(window), clear = window.clearInterval.bind(window);
                window.setInterval = (...args) => { const id = set(...args); intervals.add(id); return id; };
                window.clearInterval = id => { intervals.delete(id); clear(id); };
                const observers = new Set();
                const Native = window.MutationObserver;
                window.MutationObserver = class extends Native {
                    observe(...args) { observers.add(this); return super.observe(...args); }
                    disconnect() { observers.delete(this); return super.disconnect(); }
                };
                const requests = [];
                const fetch = window.fetch.bind(window);
                window.fetch = (url, options) => { requests.push({ url, signal: options?.signal }); return fetch(url, options); };
                window.__audit = { intervals, observers, requests };
                localStorage.setItem('current_page', 'home');
                localStorage.setItem('ui_template', 'glass');
            });
            await page.goto(`http://127.0.0.1:${server.address().port}/`);
            await page.waitForFunction(() => window.URP?.store.getState().countdownTimer != null);
            assert.equal(await page.evaluate(() => __audit.intervals.size), 1);
            const baseObservers = await page.evaluate(() => __audit.observers.size);
            await page.evaluate(() => switchPage('schedule', { scheduleWeek: 4 }));
            await page.waitForSelector('.schedule-week-panel[data-week="4"] .course-card');
            assert.equal(await page.evaluate(() => __audit.intervals.size), 0);
            assert.equal(await page.evaluate(() => __audit.observers.size), baseObservers + 2);
            await page.locator('.schedule-week-panel[data-week="4"] .course-card').first().click();
            await page.waitForSelector('#course-detail-modal.active');
            await page.locator('#course-detail-modal .modal-close').click();
            await page.waitForSelector('#course-detail-modal.active', { state: 'hidden' });
            await page.evaluate(() => switchPage('grades'));
            assert.equal(await page.evaluate(() => __audit.observers.size), baseObservers);
            assert.equal(await page.locator('#schedule-action-menu').count(), 0);
            await page.waitForFunction(() => document.getElementById('grades-kpi-gpa').textContent === '3.5');
            assert.match(await page.locator('#grades-content').innerText(), /模块验证成绩/);
            assert.match(await page.locator('#grades-content').innerText(), /模块补考成绩/);
            assert.equal(await page.locator('#grades-kpi-credits').innerText(), '3');
            assert.equal(await page.locator('#grades-kpi-failed').innerText(), '0');
            assert.equal(await page.locator('#grades-one-click').isVisible(), true);
            assert.equal(await page.locator('#grades-gpa-quick').isVisible(), true);
            await page.locator('#grades-query-summary').click();
            assert.equal(await page.locator('#grades-query-menu button').count(), 5);
            assert.match(await page.locator('#grades-query-menu').innerText(), /教务系统里面的本学期成绩/);
            await page.locator('#grades-query-summary').click();
            await page.evaluate(() => gradesLoadGpa());
            assert.match(await page.locator('#grades-content').innerText(), /3\.25/);
            await page.evaluate(() => openScheduleExams());
            await page.waitForSelector('#exams-modal.active');
            assert.match(await page.locator('#exams-content').innerText(), /模块验证考试/);
            await page.locator('#exams-close-btn').click();
            await page.evaluate(() => switchPage('schedule', { scheduleWeek: 4 }));
            await page.waitForSelector('.schedule-week-panel[data-week="4"] .course-card');
            assert.equal(await page.evaluate(() => __audit.observers.size), baseObservers + 2);
            await page.evaluate(() => switchPage('lab'));
            await page.waitForFunction(() => document.getElementById('lab-student').textContent === 'module-test');
            await page.evaluate(() => switchPage('shortcut-api'));
            await page.waitForFunction(() => document.getElementById('shortcut-api-member-status').textContent.includes('您当前没有会员'));
            await page.route('**/api/member/status', route => route.fulfill({ json: {
                success: true, data: { is_member: true, member_type: 'basic' },
            } }));
            let issued = false;
            await page.route('**/api/member/api-key', route => {
                const post = route.request().method() === 'POST';
                if (post) issued = true;
                return route.fulfill({ json: { success: true, data: post
                    ? { key: 'browser-test-secret' } : { has_key: issued, key_prefix: 'browser-test' } } });
            });
            await page.evaluate(() => switchPage('shortcut-api'));
            await page.waitForFunction(() => document.getElementById('shortcut-api-status').textContent.includes('暂未生成'));
            await page.locator('#shortcut-api-status button').click();
            await page.waitForFunction(() => document.getElementById('shortcut-api-status').textContent.includes('当前密钥'));
            assert.match(await page.locator('#shortcut-api-key').innerText(), /browser-test-secret/);

            let releaseEvaluation;
            const evaluation = new Promise(resolve => { releaseEvaluation = resolve; });
            await page.route('**/api/unevaluated_courses', async route => {
                await evaluation;
                await route.fulfill({ json: { success: true, has_courses: false } }).catch(() => {});
            });
            await page.evaluate(() => { switchPage('evaluation'); void oneClickEvaluation(); });
            await page.locator('#ui-confirm-confirm').click();
            await page.waitForFunction(() => document.getElementById('one-click-eval-btn').disabled);
            await page.evaluate(() => { switchPage('grades'); switchPage('evaluation'); });
            assert.equal(await page.locator('#one-click-eval-btn').isEnabled(), true);
            assert.equal(await page.locator('#one-click-eval-btn').innerText(), '一键评教');
            releaseEvaluation();
            await page.unroute('**/api/unevaluated_courses');

            await page.evaluate(() => URP.auth.setTemporarySession(Math.floor(Date.now() / 1000) + 600));
            const sessionTimer = await page.evaluate(() => URP.store.getState().temporarySessionTimer);
            await page.evaluate(() => switchPage('home'));
            await page.waitForFunction(() => URP.store.getState().countdownTimer != null);
            assert.equal(await page.evaluate(() => __audit.intervals.size), 1);
            assert.equal(await page.evaluate(() => URP.store.getState().temporarySessionTimer), sessionTimer);
            await page.evaluate(() => URP.auth.setTemporarySession(null));

            let release;
            const delayed = new Promise(resolve => { release = resolve; });
            await page.route('**/api/urgent_event', async route => {
                await delayed;
                await route.fulfill({ json: fixtures['/api/urgent_event'] }).catch(() => {});
            });
            await page.evaluate(() => { void refreshUrgentEvent(); });
            await page.waitForFunction(() => __audit.requests.filter(item => item.url === '/api/urgent_event').length >= 3);
            await page.evaluate(() => switchPage('grades'));
            assert.equal(await page.evaluate(() => __audit.requests.filter(item => item.url === '/api/urgent_event').at(-1).signal.aborted), true);
            release();
            await page.unroute('**/api/urgent_event');
            assert.equal(await page.evaluate(() => __audit.intervals.size), 0);
            await page.evaluate(() => URP.auth.openLogin());
            await page.waitForSelector('#login-modal.active');
            assert.deepEqual(errors, [], `browser errors at ${width}px`);
            console.log(`PASS ${width}px: native modules, legacy entries, remount, timers, observers, request abort`);
            await context.close();
        }
    } finally {
        await browser?.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
