// NODE_PATH=/path/to/node_modules node tests/browser_schedule_swipe.cjs
// Uses production HTML, styles and modules with local HTTP fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'templates/index.html'), 'utf8')
    .replace(/{{\s*static_versioned\('([^']+)'\)\s*}}/g, (_, file) => `/static/${file}`)
    .replace(/{%[\s\S]*?%}/g, '').replace(/{{[\s\S]*?}}/g, '');
const schedule = {
    '3': [{ '课程名': '上一周课程', '星期': 1, '节次': 1, '节数': 2, '位置': 'A201' }],
    '4': [
        { '课程名': '本周课程', '星期': 1, '节次': 1, '节数': 2, '位置': 'A201' },
        { '课程名': '周末晚课', '星期': 7, '节次': 9, '节数': 2, '位置': 'B202' },
    ],
    '5': [],
};
const fixtures = {
    '/api/check_bind': { success: true, bound: true, username: 'swipe-test' },
    '/api/check_login_status': { success: true, logged_in: true },
    '/api/announcements': { success: true, announcements: [] },
    '/api/schedule': { success: true, account: 'swipe-test', data: {
        schedule, semester_start: '2026-09-07', is_freshman: false,
        exams: [{ exam_name: '下周考试', course: '数学', week: 5, day: 2,
            time: '08:20-10:00', location: 'C303' }],
    } },
};

async function assertFullPanels(page, phase) {
    const geometry = await page.evaluate(() => {
        const track = document.getElementById('schedule-swipe-track').getBoundingClientRect();
        return Array.from(document.querySelectorAll('.schedule-week-panel'), panel => ({
            week: panel.dataset.week,
            height: panel.getBoundingClientRect().height,
            trackHeight: track.height,
            gridHeight: panel.querySelector('.schedule-grid').getBoundingClientRect().height,
            rows: getComputedStyle(panel.querySelector('.schedule-grid')).getPropertyValue('--schedule-visible-rows').trim(),
        }));
    });
    for (const panel of geometry) {
        assert.ok(panel.gridHeight > 100, `${phase}: week ${panel.week} grid collapsed to ${panel.gridHeight}px`);
        assert.ok(Math.abs(panel.height - panel.trackHeight) < 1,
            `${phase}: week ${panel.week} does not fill the swipe track`);
        assert.equal(panel.rows, panel.week === '4' ? '10' : '8');
    }
}

(async () => {
    const browser = await chromium.launch({ headless: true,
        ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: 'chrome' }),
    });
    try {
        for (const [width, height] of [[390, 844], [320, 568], [820, 1180], [1440, 900]]) {
            for (const template of ['workspace', 'glass']) {
                const page = await browser.newPage({ viewport: { width, height }, hasTouch: true, isMobile: width < 1100 });
                const errors = [];
                let scheduleRequests = 0;
                page.on('pageerror', error => errors.push(error.message));
                await page.addInitScript(template => {
                    localStorage.setItem('current_page', 'schedule');
                    localStorage.setItem('urp_ui_template', template);
                }, template);
                await page.route('**/*', route => {
                    const url = new URL(route.request().url());
                    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
                    if (url.pathname.startsWith('/static/')) return route.fulfill({ path: path.join(root, url.pathname) });
                    if (url.pathname === '/api/schedule') scheduleRequests++;
                    return route.fulfill({ json: fixtures[url.pathname] || { success: false } });
                });
                await page.goto('http://urp.test/');
                await page.waitForFunction(() => URP?.store.getState().cachedSchedule != null);
                await page.evaluate(() => jumpToWeek(4));
                const cdp = await page.context().newCDPSession(page);
                await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
                const label = `${template} ${width}x${height}`;
                await assertFullPanels(page, `${label} before dragging`);
                for (const direction of [-1, 1, 1, -1]) {
                    const week = await page.evaluate(() => URP.store.getState().currentWeek);
                    const viewport = await page.locator('#schedule-content').boundingBox();
                    const startX = viewport.x + (direction > 0 ? viewport.width - 20 : 20);
                    const y = viewport.y + 100;
                    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: startX, y }] });
                    for (const ratio of [0.12, 0.25, 0.45]) {
                        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: startX - direction * viewport.width * ratio, y }] });
                        await assertFullPanels(page, `${label} dragging`);
                    }
                    await page.screenshot({ path: `/tmp/urp-swipe-${template}-${width}-drag.png` });
                    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
                    await assertFullPanels(page, `${label} settling`);
                    await page.waitForFunction(expected => URP.store.getState().currentWeek === expected
                        && !URP.store.getState().scheduleSwipeTransition, week + direction);
                    await assertFullPanels(page, `${label} after switching`);
                    assert.equal(await page.locator('#week-select').inputValue(), String(week + direction));
                    if (week + direction === 5) {
                        const exam = page.locator('.schedule-week-panel.is-current .schedule-exam-card');
                        assert.equal(await exam.count(), 1, 'exam-only weeks still render the exam card');
                        assert.match(await exam.innerText(), /数学/);
                        assert.match(await page.locator('.schedule-week-panel.is-current .schedule-unplaced-exams').innerText(), /C303/);
                    }
                    assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1));
                }
                assert.equal(scheduleRequests, 1, 'cached week switching must not wait for another schedule request');
                // Course details still work after the swipe has settled.
                await page.locator('.schedule-week-panel.is-current .course-card').first().click();
                await page.locator('#course-detail-modal.active').waitFor();
                await page.keyboard.press('Escape');
                assert.deepEqual(errors, []);
                console.log(`PASS ${label}: complete adjacent grids before/during/after touch swipes; 8/10 rows; exams; details; no extra requests`);
                await page.close();
            }
        }
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
