// Real touch events against local templates and mocked academic APIs.
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
    await context.addInitScript(value => localStorage.setItem('urp_ui_template', value), theme);
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
        if (url.pathname.startsWith('/static/')) return route.fulfill({ path: root + url.pathname });
        const data = { success: true, bound: true, username: '202600001', logged_in: true,
            announcements: [], courses: [], feedbacks: [], event: { current: null, next: null, upcoming: [] },
            data: { schedule: {}, exams: [], semester_start: '2026-09-28' } };
        return route.fulfill({ json: data });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://urp.test/');
    await page.waitForFunction(() => document.getElementById('sidebar-username').textContent === '202600001');
    await page.evaluate(() => {
        document.getElementById('header-ad-slot').hidden = true;
        window.navigationCommits = [];
        URP.store.subscribe((state, key) => {
            if (key === 'currentPage' && state.currentPage) window.navigationCommits.push(state.currentPage);
        });
    });
    const cdp = await context.newCDPSession(page);
    const touch = async (type, points = []) => {
        await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((point, index) => ({ id: index, x: point.x, y: point.y })) });
        await page.waitForTimeout(30);
    };
    const center = async index => page.locator('#mobile-bottom-nav .mobile-nav-item').nth(index).evaluate(el => {
        const bounds = el.getBoundingClientRect();
        return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    });
    const drag = async (from, to, end = 'touchEnd') => {
        await touch('touchStart', [await center(from)]);
        await touch('touchMove', [await center(to)]);
        await touch(end);
    };
    return { context, page, errors, center, touch, drag };
}

(async () => {
    fs.mkdirSync(output, { recursive: true });
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const glass = await workspace(browser, 'glass');
        const { page, center, touch, drag } = glass;
        const activePage = () => page.locator('.page.active').getAttribute('id');
        const commits = () => page.evaluate(() => window.navigationCommits);
        assert.ok(await page.locator('.mobile-nav-lens').isVisible(), 'glass navigation has a shared moving selection lens');

        await touch('touchStart', [await center(0)]);
        await touch('touchMove', [await center(1)]);
        await touch('touchMove', [await center(2)]);
        assert.equal(await activePage(), 'page-home', 'dragging only previews a destination');
        assert.deepEqual(await commits(), [], 'preview must not query intermediate pages');
        const target = await center(2);
        const lens = await page.locator('.mobile-nav-lens').boundingBox();
        assert.ok(Math.abs(lens.x + lens.width / 2 - target.x) < 3, `lens follows the finger: ${JSON.stringify({ lens, target, nav: await page.locator('#mobile-bottom-nav').evaluate(el => ({ className: el.className, preview: el.dataset.navPreview, x: el.style.getPropertyValue('--nav-lens-x'), width: el.style.getPropertyValue('--nav-lens-width') })) })}`);
        await page.screenshot({ path: path.join(output, 'glass-nav-dragging-390.png') });
        await touch('touchEnd');
        assert.equal(await activePage(), 'page-grades');
        assert.deepEqual(await commits(), ['grades'], 'release commits once');
        assert.equal(await page.locator('#mobile-bottom-nav [data-page="grades"]').getAttribute('aria-current'), 'page');

        await touch('touchStart', [await center(2)]);
        const schedule = await center(1);
        await touch('touchMove', [schedule]);
        await touch('touchMove', [{ x: schedule.x, y: schedule.y - 100 }]);
        await touch('touchEnd');
        assert.equal(await activePage(), 'page-grades', 'releasing outside cancels');
        assert.deepEqual(await commits(), ['grades']);
        await drag(2, 0, 'touchCancel');
        assert.equal(await activePage(), 'page-grades', 'pointer cancellation restores selection');
        assert.deepEqual(await commits(), ['grades']);

        await touch('touchStart', [await center(2)]);
        await touch('touchMove', [await center(1)]);
        await touch('touchStart', [await center(1), await center(0)]);
        await touch('touchEnd');
        assert.deepEqual(await commits(), ['grades'], 'multi-touch never chooses a page');

        await drag(2, 3);
        assert.equal(await page.locator('#sidebar').getAttribute('aria-hidden'), 'false');
        assert.equal(await activePage(), 'page-grades');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#sidebar').getAttribute('aria-hidden'), 'true');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'mobile-nav-more');
        await page.waitForTimeout(350);
        await page.locator('#mobile-bottom-nav [data-page="home"]').tap();
        assert.equal(await activePage(), 'page-home', 'ordinary tapping still works');
        await page.locator('#mobile-bottom-nav [data-page="schedule"]').focus();
        await page.keyboard.press('Enter');
        assert.equal(await activePage(), 'page-schedule', 'keyboard activation remains available');

        const beforeResize = await commits();
        await touch('touchStart', [await center(1)]);
        await touch('touchMove', [await center(2)]);
        await page.setViewportSize({ width: 820, height: 900 });
        await touch('touchEnd');
        assert.deepEqual(await commits(), beforeResize, 'resizing cancels a drag');
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(50);
        await touch('touchStart', [await center(1)]);
        await touch('touchMove', [await center(2)]);
        await page.evaluate(() => { document.documentElement.dataset.uiTemplate = 'workspace'; });
        await page.waitForTimeout(50);
        await touch('touchEnd');
        assert.deepEqual(await commits(), beforeResize, 'changing appearance cancels a drag');
        assert.equal(await page.locator('.mobile-nav-lens').isVisible(), false);
        await page.locator('#mobile-bottom-nav [data-page="home"]').tap();
        assert.equal(await activePage(), 'page-home', 'a fresh simple-theme tap works immediately after cancelling a drag');
        await page.evaluate(() => { document.documentElement.dataset.uiTemplate = 'glass'; });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.waitForTimeout(50);
        assert.equal(await page.locator('.mobile-nav-lens').evaluate(el => getComputedStyle(el).transitionProperty), 'none');
        await drag(0, 2);
        assert.equal(await activePage(), 'page-grades', 'reduced motion retains gesture functionality');
        const beforeHeightResize = await commits();
        await touch('touchStart', [await center(2)]);
        await touch('touchMove', [await center(0)]);
        await page.setViewportSize({ width: 390, height: 820 });
        await touch('touchEnd');
        assert.deepEqual(await commits(), beforeHeightResize, 'height-only resizing cancels a drag');
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: path.join(output, 'glass-nav-selected-390.png') });
        assert.deepEqual(glass.errors, []);
        await glass.context.close();

        const simple = await workspace(browser, 'workspace');
        assert.equal(await simple.page.locator('.mobile-nav-lens').isVisible(), false);
        await simple.drag(0, 2);
        assert.deepEqual(await simple.page.evaluate(() => window.navigationCommits), [], 'simple appearance keeps tap-only navigation');
        await simple.page.locator('#mobile-bottom-nav [data-page="grades"]').tap();
        assert.equal(await simple.page.locator('.page.active').getAttribute('id'), 'page-grades');
        assert.deepEqual(simple.errors, []);
        await simple.context.close();
        console.log('PASS: themed navigation, finger tracking, release-only activation, cancellation, multi-touch, More/focus, tap/keyboard, resize/theme cleanup and reduced motion');
    } finally {
        await browser.close();
    }
})();
