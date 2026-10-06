// Uses local template/assets and synthetic announcements; never calls real APIs.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const root = require('node:path').resolve(__dirname, '..');
(async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const html = fs.readFileSync(`${root}/templates/index.html`, 'utf8')
            .replace(/{%[\s\S]*?%}/g, '').replace(/{{[\s\S]*?}}/g, '');
        const content = '这是完整公告正文，包含课程查询和使用说明。\n'.repeat(100) + '公告正文结束';
        let items = [{ id: 1, title: '系统使用说明', content, create_time: '2026-09-29T12:00:00', is_read: true }];
        let fail = false;
        await page.route('**/*', route => {
            const pathname = new URL(route.request().url()).pathname;
            if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
            if (pathname.startsWith('/static/')) return route.fulfill({ path: root + pathname });
            if (pathname === '/api/announcements') return route.fulfill({ json: fail ? { success: false } : { success: true, announcements: items } });
            return route.fulfill({ json: { success: true, bound: true, username: 'readability-test', logged_in: true,
                event: { current: null, upcoming: [] }, data: {} } });
        });
        await page.goto('http://urp.test/');
        await page.waitForFunction(() => window.URP?.store.getState().currentUsername === 'readability-test');
        await page.evaluate(() => {
            const today = getCalendarChinaToday();
            document.getElementById('sidebar-username').textContent = '演示账号';
            document.getElementById('login-status-indicator').innerHTML = '<span class="status-dot status-online"></span><span class="status-text">已登录</span>';
            displayUrgentEvent({
                current: { title: '高等数学（上）', location: '第一教学楼 · A201', time: `${today} 08:20-10:00`, remaining: 35 },
                next: { title: '大学英语', location: '第二教学楼 · B305', time: `${today} 10:20-11:55`, type: 'course', countdown: 55 },
            });
        });
        for (const [width, height] of [[1100, 800], [1366, 768], [1440, 900], [1920, 1080], [390, 844], [320, 568]]) {
            await page.setViewportSize({ width, height });
            await page.waitForTimeout(250);
            const box = await page.locator('.content-wrapper').boundingBox();
            if (width >= 1440) assert.equal(box.width, 1160);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            assert.equal(await page.locator('.schedule-dino-lane').count(), 0);
            await page.screenshot({ path: `/tmp/urp-home-${width}.png` });
            if (width <= 768) await page.locator('#mobile-nav-more').click();
            await page.locator('#announcement-trigger').click();
            await page.locator('#announcement-dialog-article').waitFor({ state: 'visible' });
            await page.waitForTimeout(350);
            assert.equal(await page.locator('#announcement-dialog-content').textContent(), content);
            assert.equal(await page.locator('#announcement-previous').isDisabled(), true);
            assert.equal(await page.locator('#announcement-next').isDisabled(), true);
            assert.equal(await page.locator('#announcement-dialog-time').evaluate(el => el.tagName), 'TIME');
            assert.equal(await page.locator('#announcement-dialog-time').evaluate(el => getComputedStyle(el).cursor), 'auto');
            const scroll = page.locator('#announcement-dialog-scroll');
            assert.ok(await scroll.evaluate(el => el.scrollHeight > el.clientHeight));
            await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; });
            assert.ok(await scroll.evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 1));
            assert.ok(await page.locator('#announcement-next').isVisible());
            await page.screenshot({ path: `/tmp/urp-announcement-${width}.png` });
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('#announcement-dialog').isVisible(), false);
            assert.equal(await page.evaluate(() => document.activeElement.id), 'announcement-trigger');
            if (width <= 768) await page.keyboard.press('Escape');
        }
        await page.setViewportSize({ width: 1440, height: 900 });
        items = [];
        await page.locator('#announcement-trigger').click();
        await page.waitForFunction(() => document.getElementById('announcement-dialog-status').textContent === '暂无公告');
        assert.equal(await page.locator('#announcement-next').isDisabled(), true);
        await page.keyboard.press('Escape');
        fail = true;
        await page.locator('#announcement-trigger').click();
        await page.locator('#announcement-retry').waitFor({ state: 'visible' });
        fail = false;
        items = [{ id: 1, title: '第一条', content: '完整内容', create_time: '2026-09-29', is_read: true }, { id: 2, title: '第二条', content: '较早内容', create_time: '2026-09-28', is_read: true }];
        await page.locator('#announcement-retry').click();
        await page.waitForFunction(() => !document.getElementById('announcement-next').disabled);
        await page.locator('#announcement-next').click();
        assert.equal(await page.locator('#announcement-dialog-title').textContent(), '第二条');
        assert.equal(await page.locator('#announcement-next').isDisabled(), true);
        await page.locator('#announcement-previous').click();
        assert.equal(await page.locator('#announcement-dialog-title').textContent(), '第一条');
        assert.deepEqual(errors, []);
        console.log('PASS: wide/mobile layout; no dinosaur; full scrollable announcements; dates; pagination; empty/error/retry; Escape and focus');
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exit(1); });
