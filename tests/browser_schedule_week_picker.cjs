// Real module bridge + production CSS; no school service or account is used.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = execFileSync(process.env.PYTHON || path.join(root, '.venv/bin/python'),
    [path.join(__dirname, 'helpers/render-template.py'), 'index.html'], { encoding: 'utf8' });

(async () => {
    const browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const failures = [];
    try {
        for (const theme of ['workspace', 'glass', 'paper', 'garden', 'clay']) {
            for (const mode of ['light', 'dark']) {
                const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
                const errors = [];
                page.on('pageerror', error => errors.push(error.message));
                await page.addInitScript(({ theme, mode }) => {
                    localStorage.setItem('current_page', 'schedule');
                    localStorage.setItem('urp_ui_template', theme);
                    localStorage.setItem('urp_ui_color_mode', mode);
                }, { theme, mode });
                await page.route('**/*', route => {
                    const pathname = new URL(route.request().url()).pathname;
                    if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
                    if (pathname.startsWith('/static/')) return route.fulfill({ path: root + pathname });
                    const schedule = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [i + 1,
                        [{ '课程名': `周次课程${i + 1}`, '星期': 1, '节次': 1, '节数': 2, '位置': 'A201' }]]));
                    return route.fulfill({ json: { success: true, bound: true, logged_in: true,
                        username: 'offline', announcements: [], exams: [], event: { current: null, upcoming: [] },
                        data: { schedule, exams: [], semester_start: '2026-09-28' } } });
                });
                await page.goto('http://urp.test/');
                await page.waitForFunction(() => window.URP?.store.getState().currentUsername === 'offline');
                await page.evaluate(() => switchPage('schedule'));
                await page.waitForFunction(() => window.URP?.store.getState().cachedSchedule);
                await page.emulateMedia({ reducedMotion: 'reduce' });
                for (const width of [320, 390, 820, 1440]) {
                    await page.setViewportSize({ width, height: 900 });
                    for (const week of [1, 12, 25]) {
                        await page.selectOption('#week-select', String(week));
                        const actual = await page.evaluate(() => URP.store.getState().currentWeek);
                        if (actual !== week) failures.push(`${theme}/${mode}/${width}: selected ${week}, displayed ${actual}`);
                        else {
                            assert.equal(await page.locator('.schedule-week-panel.is-current').getAttribute('data-week'), String(week));
                            assert.match(await page.locator('.is-current .course-card').innerText(), new RegExp(`周次课程${week}`));
                        }
                    }
                    const style = await page.locator('.week-select-wrap').evaluate(el => {
                        const select = el.querySelector('select'), inner = getComputedStyle(select);
                        const arrow = getComputedStyle(el, '::after');
                        const outerRect = el.getBoundingClientRect(), innerRect = select.getBoundingClientRect();
                        return { bg: inner.backgroundColor, image: inner.backgroundImage,
                            border: inner.borderWidth, shadow: inner.boxShadow,
                            contained: innerRect.top >= outerRect.top && innerRect.bottom <= outerRect.bottom,
                            arrowWidth: arrow.width, arrowEvents: arrow.pointerEvents,
                            appearance: inner.appearance, overflow: document.documentElement.scrollWidth > innerWidth };
                    });
                    try {
                        assert.equal(style.bg, 'rgba(0, 0, 0, 0)', 'inner select must not paint a white box');
                        assert.equal(style.image, 'none', 'only the wrapper paints the material');
                        assert.equal(style.border, '0px');
                        assert.equal(style.shadow, 'none');
                        assert.equal(style.contained, true, 'select must stay within its wrapper');
                        assert.equal(style.arrowWidth, '6px');
                        assert.equal(style.arrowEvents, 'none');
                        assert.equal(style.appearance, 'none', 'avoid duplicate native arrow');
                        assert.equal(style.overflow, false);
                    } catch (error) { failures.push(`${theme}/${mode}/${width}: ${error.message}`); }
                    if (width === 390 && ['workspace', 'glass'].includes(theme)) {
                        await page.screenshot({ path: `/tmp/urp-week-fixed-${theme}-${mode}.png` });
                    }
                    if (width === 1440) {
                        await page.locator('#week-select').focus();
                        await page.keyboard.press('Tab');
                        await page.keyboard.press('Shift+Tab');
                        assert.equal(await page.evaluate(() => document.activeElement.id), 'week-select');
                        const focus = await page.locator('.week-select-wrap').evaluate(el => ({
                            width: getComputedStyle(el).outlineWidth,
                            shadow: getComputedStyle(el.querySelector('select')).boxShadow,
                        }));
                        assert.equal(focus.width, '3px', 'keyboard focus remains visible on the wrapper');
                        assert.equal(focus.shadow, 'none', 'no nested focus box');
                    }
                }
                if (errors.length) failures.push(`${theme}/${mode}: ${errors.join(', ')}`);
                await page.close();
            }
        }
        assert.deepEqual(failures, []);
        console.log('PASS: week selection and single-surface controls across 5 themes, 2 modes and 4 widths');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
