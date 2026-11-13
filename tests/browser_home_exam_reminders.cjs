const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const html = execFileSync(path.join(root, '.venv/bin/python'), [path.join(__dirname, 'helpers/render-template.py'), 'index.html'], { encoding: 'utf8' });
const exams = [1, 2, 3].map((n) => ({ type: 'exam', title: `第${n}场：计算机网络与系统设计期末考试`,
    time: `2026-11-${14 + n} 08:30-10:30`, location: '第一教学楼 A201 考场', seat: String(10 + n) }));
(async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const output = '/tmp/urp-home-exams';
    fs.mkdirSync(output, { recursive: true });
    try {
        const context = await browser.newContext({ reducedMotion: 'reduce' });
        await context.addInitScript(() => localStorage.setItem('urp_miniapp_notice_dismissed', '1'));
        await context.route('**/*', route => {
            const p = new URL(route.request().url()).pathname;
            if (p === '/') return route.fulfill({ contentType: 'text/html', body: html });
            if (p.startsWith('/static/')) return route.fulfill({ path: root + p });
            if (p === '/api/urgent_event') return route.fulfill({ json: { success: true, event: {
                next: { type: 'class', title: '今日课程', time: '2026-11-13 08:20-10:00', location: '实验楼' },
                upcoming_exams: exams, upcoming: [],
            } } });
            return route.fulfill({ json: { success: true, bound: true, username: 'offline', data: {}, announcements: [] } });
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto('http://urp.test/');
        await page.locator('.event-card-exam').first().waitFor();
        for (const width of [320, 390, 1440]) {
            await page.setViewportSize({ width, height: 900 });
            for (const theme of ['workspace', 'glass']) {
                await page.evaluate(theme => {
                    document.documentElement.dataset.uiTemplate = theme;
                }, theme);
                assert.equal(await page.locator('.event-card-exam').count(), 3);
                for (const exam of exams) assert.ok((await page.locator('#urgent-content').innerText()).includes(exam.title));
                assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}/${theme} overflow`);
                await page.screenshot({ path: `${output}/${width}-${theme}.png`, fullPage: true });
            }
        }
        assert.deepEqual(errors, []);
        console.log('Home exam reminders: 3 viewports × 2 templates passed; previews: ' + output);
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
