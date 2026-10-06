// Native action dialog and real touch gestures; all resources and APIs are local fixtures.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts/appearance-preview');
const html = fs.readFileSync(path.join(root, 'templates/index.html'), 'utf8')
    .replace(/{%[\s\S]*?%}/g, '').replace(/{{[\s\S]*?}}/g, '演示活动');

async function workspace(browser, theme) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await context.addInitScript(value => {
        localStorage.setItem('urp_ui_template', value);
        localStorage.setItem('current_page', 'schedule');
    }, theme);
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
        if (url.pathname.startsWith('/static/')) return route.fulfill({ path: root + url.pathname });
        return route.fulfill({ json: { success: true, bound: true, username: '202600001', logged_in: true,
            announcements: [], exams: [], semester_start: '2026-09-28',
            data: { semester_start: '2026-09-28', exams: [], schedule: { '1': [
                { '星期': 1, '节次': 1, '节数': 2, '课程名': '高等数学', '位置': '教学楼 A201' },
                { '星期': 3, '节次': 5, '节数': 2, '课程名': '程序设计基础', '位置': '实验楼 302' },
            ] }, semesters: [], courses: [] } } });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://urp.test/');
    await page.locator('.is-current .course-card').first().waitFor();
    await page.evaluate(() => { document.getElementById('header-ad-slot').hidden = true; });
    const cdp = await context.newCDPSession(page);
    const swipeUp = async () => {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 280, y: 650 }] });
        for (const y of [600, 550, 500, 450, 400, 350]) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 280, y }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(300);
    };
    return { context, page, errors, swipeUp };
}

(async () => {
    fs.mkdirSync(output, { recursive: true });
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const glass = await workspace(browser, 'glass');
        const { page } = glass;
        const menu = page.locator('#schedule-action-menu');
        assert.equal(await page.locator('#page-schedule').evaluate(el => el.classList.contains('has-glass-action-menu')), true);
        assert.equal(await page.locator('.schedule-gesture-help').isVisible(), false);
        const initialHeight = await page.locator('.is-current .schedule-grid').evaluate(el => el.getBoundingClientRect().height);
        await glass.swipeUp();
        assert.equal(await menu.isVisible(), false, 'vertical swiping must not open the glass action menu');
        assert.equal(await page.locator('#schedule-actions').evaluate(el => el.classList.contains('is-open')), false);

        for (const [width, height] of [[390, 844], [320, 568], [820, 900]]) {
            await page.setViewportSize({ width, height });
            await page.waitForTimeout(100);
            const gridBefore = await page.locator('.is-current .schedule-grid').evaluate(el => el.getBoundingClientRect().height);
            await page.locator('#schedule-mobile-more').click();
            assert.ok(await menu.isVisible());
            assert.equal(await menu.locator('[data-schedule-command]').count(), 4);
            assert.ok(Math.abs(await page.locator('.is-current .schedule-grid').evaluate(el => el.getBoundingClientRect().height) - gridBefore) < .5, 'menu does not resize the timetable');
            const bounds = await menu.boundingBox();
            assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= height);
            await page.screenshot({ path: path.join(output, `glass-schedule-menu-${width}.png`) });
            await page.keyboard.press('Tab');
            assert.ok(await page.evaluate(() => document.getElementById('schedule-action-menu').contains(document.activeElement)));
            await page.keyboard.press('Escape');
            await page.waitForTimeout(50);
            assert.equal(await menu.isVisible(), false);
            assert.equal(await page.evaluate(() => document.activeElement.id), 'schedule-mobile-more');
        }

        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(100);
        await page.locator('#schedule-mobile-more').click();
        await page.mouse.click(2, 2);
        await page.waitForTimeout(50);
        assert.equal(await menu.isVisible(), false, 'backdrop closes the menu');
        await page.locator('#schedule-mobile-more').click();
        await menu.locator('[data-schedule-command="exams"]').click();
        await page.locator('#exams-modal.active').waitFor();
        await page.waitForTimeout(50);
        assert.equal(await menu.isVisible(), false);
        assert.ok(await page.evaluate(() => document.getElementById('exams-modal').contains(document.activeElement)), 'closing the menu must not steal focus from the opened exam dialog');
        await page.keyboard.press('Escape');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'schedule-mobile-more');

        await page.locator('#schedule-mobile-more').click();
        await menu.locator('[data-schedule-command="history"]').click();
        await page.locator('#historical-schedule-modal.active').waitFor();
        assert.equal(await menu.isVisible(), false);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(50);

        await page.locator('#schedule-mobile-more').click();
        await menu.locator('[data-schedule-command="export"]').click();
        await page.locator('#calendar-export-modal.active').waitFor();
        assert.equal(await menu.isVisible(), false);
        assert.ok(await page.evaluate(() => document.getElementById('calendar-export-modal').contains(document.activeElement)));
        await page.keyboard.press('Escape');
        await page.waitForTimeout(50);

        await page.setViewportSize({ width: 820, height: 900 });
        await page.waitForTimeout(100);
        let releaseUpdate;
        await page.route('**/api/update_schedule', async route => {
            await new Promise(resolve => { releaseUpdate = resolve; });
            await route.fulfill({ json: { success: true } });
        });
        await page.locator('#schedule-mobile-more').click();
        await menu.locator('[data-schedule-command="update"]').click();
        await page.waitForFunction(() => document.getElementById('update-schedule-btn').disabled);
        await page.locator('#schedule-mobile-more').click();
        assert.equal(await menu.locator('[data-schedule-command="update"]').isDisabled(), true);
        releaseUpdate();
        await page.waitForFunction(() => document.querySelector('[data-schedule-command="update"]')?.disabled === false);
        assert.equal(await menu.locator('[data-schedule-command="update"]').textContent(), '更新课程表');
        await menu.locator('.schedule-action-menu-close').click();
        await page.unroute('**/api/update_schedule');

        await page.locator('#schedule-mobile-more').click();
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.waitForTimeout(100);
        assert.equal(await menu.isVisible(), false);
        assert.ok(await page.locator('#update-schedule-btn').isVisible());
        await page.locator('#schedule-more summary').click();
        assert.ok(await page.locator('#schedule-exams-btn').isVisible(), 'desktop retains its existing action menu');
        await page.keyboard.press('Escape');
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(100);
        await page.locator('#schedule-mobile-more').click();
        await page.evaluate(() => { document.documentElement.dataset.uiTemplate = 'workspace'; });
        await page.waitForTimeout(100);
        assert.equal(await menu.isVisible(), false);
        assert.equal(await page.locator('.schedule-gesture-help').isVisible(), true);
        assert.equal(await page.locator('#schedule-mobile-more').getAttribute('aria-controls'), 'schedule-action-menu');
        await page.evaluate(() => { document.documentElement.dataset.uiTemplate = 'glass'; });
        await page.waitForTimeout(100);
        assert.ok(Math.abs(await page.locator('.is-current .schedule-grid').evaluate(el => el.getBoundingClientRect().height) - initialHeight) < .5);
        assert.deepEqual(glass.errors, []);
        await glass.context.close();

        const simple = await workspace(browser, 'workspace');
        await simple.swipeUp();
        assert.equal(await simple.page.locator('#schedule-actions').evaluate(el => el.classList.contains('is-open')), true, 'simple appearance retains its existing gesture');
        await simple.page.locator('#schedule-mobile-more').click();
        assert.equal(await simple.page.locator('#schedule-action-menu').isVisible(), true, 'simple appearance also opens the shared action sheet');
        assert.equal(await simple.page.locator('#schedule-action-menu [data-schedule-command]').count(), 4);
        assert.deepEqual(simple.errors, []);
        await simple.context.close();
        console.log('PASS: shared contextual menu, fixed grid height, menu bounds, focus/close, original actions, desktop fallback and simple-theme gesture');
    } finally {
        await browser.close();
    }
})();
