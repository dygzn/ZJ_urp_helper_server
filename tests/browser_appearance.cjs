// Local templates and synthetic data only; no production requests or credentials.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts/appearance-preview');
const schedule = { '1': [
    { '星期': 1, '节次': 1, '节数': 2, '课程名': '高等数学', '位置': '教学楼 A201' },
    { '星期': 3, '节次': 5, '节数': 2, '课程名': '程序设计基础', '位置': '实验楼 302' },
] };

function template(name) {
    return fs.readFileSync(path.join(root, 'templates', name), 'utf8')
        .replace(/{%[\s\S]*?%}/g, '').replace(/{{[\s\S]*?}}/g, '演示活动');
}

async function assertCapsuleTextFits(page) {
    const spills = await page.evaluate(() => {
        const failures = [];
        const context = document.createElement('canvas').getContext('2d');
        const label = document.querySelector('.week-select-wrap');
        const select = document.getElementById('week-select');
        if (select?.getClientRects().length && label?.getClientRects().length) {
            const bounds = label.getBoundingClientRect();
            const input = select.getBoundingClientRect();
            const style = getComputedStyle(select);
            const text = select.selectedOptions[0]?.textContent || '';
            context.font = style.font;
            const metrics = context.measureText(text);
            const textHeight = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
            const radius = Math.min(bounds.height / 2, bounds.width / 2);
            const inset = radius - Math.sqrt(Math.max(0, radius * radius - textHeight * textHeight / 4));
            const textLeft = input.left + parseFloat(style.paddingLeft);
            const textRight = textLeft + metrics.width;
            const arrow = getComputedStyle(label, '::after');
            const arrowLeft = bounds.right - parseFloat(arrow.right) - parseFloat(arrow.width);
            if (textLeft < bounds.left + inset + 1 || textRight > arrowLeft - 4) failures.push({ text, textLeft, textRight, safeLeft: bounds.left + inset + 1, arrowLeft });
        }
        for (const element of document.querySelectorAll('button, summary')) {
            if (!element.getClientRects().length) continue;
            const bounds = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            const radius = Math.min(parseFloat(style.borderTopLeftRadius), bounds.height / 2, bounds.width / 2);
            if (radius < bounds.height / 2 - 1) continue;
            const inside = (x, y) => {
                const dx = Math.min(x - bounds.left, bounds.right - x);
                const dy = Math.min(y - bounds.top, bounds.bottom - y);
                return dx >= -1 && dy >= -1 && (dx >= radius || dy >= radius || (dx - radius) ** 2 + (dy - radius) ** 2 <= radius ** 2 + 2);
            };
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
                const node = walker.currentNode;
                if (!node.textContent.trim() || parseFloat(getComputedStyle(node.parentElement).fontSize) === 0) continue;
                const range = document.createRange();
                range.selectNodeContents(node);
                for (const rect of range.getClientRects()) {
                    if (!rect.width || !rect.height) continue;
                    if (![[rect.left, rect.top], [rect.right, rect.top], [rect.left, rect.bottom], [rect.right, rect.bottom]].every(([x, y]) => inside(x, y))) failures.push({ text: node.textContent.trim(), width: bounds.width, height: bounds.height, radius });
                }
            }
        }
        return failures;
    });
    assert.deepEqual(spills, [], `capsule text must stay inside its curved outline at ${page.viewportSize().width}px`);
}

(async () => {
    fs.mkdirSync(output, { recursive: true });
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await context.route('**/*', route => {
            const url = new URL(route.request().url());
            if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: template('index.html') });
            if (url.pathname === '/admin') return route.fulfill({ contentType: 'text/html', body: template('admin.html') });
            if (url.pathname === '/ad-detail') return route.fulfill({ contentType: 'text/html', body: template('ad_detail.html') });
            if (url.pathname.startsWith('/static/')) return route.fulfill({ path: root + url.pathname });
            const data = { success: true, bound: true, username: '202600001', logged_in: true,
                announcements: [], courses: [], feedbacks: [], exams: {}, schedule: {},
                event: { current: null, next: null, upcoming: [] } };
            if (url.pathname === '/api/schedule') data.data = { schedule, exams: [], semester_start: '2026-09-28' };
            if (url.pathname === '/api/admin/users') Object.assign(data, { total: 1284, classes: [{ class_id: '2615001', count: 704 }, { class_id: '2515002', count: 580 }], daily: Array.from({ length: 14 }, (_, index) => ({ date: new Date(Date.now() - (13 - index) * 86400000).toISOString().slice(0, 10), count: 14 + index, total: 940 + index * 27 })) });
            return route.fulfill({ json: data });
        });
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto('http://urp.test/');
        await page.waitForFunction(() => document.getElementById('sidebar-username').textContent === '202600001');
        await page.evaluate(() => {
            document.getElementById('header-ad-slot').hidden = true;
            displayUrgentEvent({
                current: { title: '高等数学（上）', location: '第一教学楼 · A201', time: '08:20-10:00', remaining: 35 },
                next: { type: 'class', title: '大学英语', location: '第二教学楼 · B305', time: '2026-10-02 10:20', time_range: '10:20-12:00', countdown: 55 },
                upcoming_label: '今日安排', upcoming: [
                    { title: '高等数学（上）', location: '第一教学楼 · A201', time: '08:20-10:00', status: 'current' },
                    { title: '大学英语', location: '第二教学楼 · B305', time: '10:20-12:00', status: 'upcoming' },
                ],
            });
        });
        const homeContent = await page.locator('#page-home').innerText();
        for (const choice of ['workspace', 'glass']) {
            await page.locator('.appearance-trigger-header').click();
            await page.locator(`input[name="ui-template"][value="${choice}"]`).check();
            assert.equal(await page.locator('html').getAttribute('data-ui-template'), choice);
            await page.keyboard.press('Tab');
            assert.equal(await page.evaluate(() => document.getElementById('appearance-dialog').contains(document.activeElement)), true);
            await page.locator('.appearance-close').click();
            assert.equal(await page.evaluate(() => document.activeElement.classList.contains('appearance-trigger-header')), true);
            assert.equal(await page.locator('#page-home').innerText(), homeContent);
            assert.equal(await page.locator('.liquid-glass-scene').isVisible(), choice === 'glass');
            if (choice === 'glass') {
                await page.locator('.event-card').first().hover();
                await page.waitForFunction(() => document.querySelector('.event-card').style.getPropertyValue('--glass-light-x') !== '');
                assert.notEqual(await page.locator('.event-card').first().evaluate(el => getComputedStyle(el).backdropFilter), 'none');
            }
            for (const [width, height] of [[1440, 900], [1100, 800], [820, 900], [390, 844], [320, 568]]) {
                await page.setViewportSize({ width, height });
                await page.waitForTimeout(100);
                assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${choice} ${width}: fits horizontally`);
                if (width >= 1100) {
                    assert.ok(await page.locator('.header').evaluate(el => el.getBoundingClientRect().height <= 80), `${choice} ${width}: desktop navigation stays on one line`);
                }
                if (width === 1440 || width === 390) await page.screenshot({ path: path.join(output, `${choice}-home-${width}.png`), fullPage: true });
            }
            await page.setViewportSize({ width: 1440, height: 900 });
        }

        await page.reload();
        assert.equal(await page.locator('html').getAttribute('data-ui-template'), 'glass');
        for (const width of [1100, 1440]) {
            await page.setViewportSize({ width, height: 900 });
            await page.waitForTimeout(100);
            assert.ok(await page.locator('#desktop-nav-more summary').evaluate(el => {
                const range = document.createRange();
                range.selectNodeContents(el);
                return range.getBoundingClientRect().height <= parseFloat(getComputedStyle(el).lineHeight) + 1;
            }), `${width}: more stays on one line with an ad`);
            assert.ok(await page.locator('.header').evaluate(el => Array.from(el.children).filter(child => child.getClientRects().length).every(child => child.getBoundingClientRect().right <= innerWidth)), `${width}: header actions remain on screen with an ad`);
        }
        // Appearance is independent from the system light/dark color preference.
        await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
        await page.waitForFunction(() => getComputedStyle(document.body).color === 'rgb(248, 250, 252)');
        assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).color), 'rgb(248, 250, 252)');
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
        await page.waitForTimeout(100);
        assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches), true);
        assert.equal(await page.locator('.header').evaluate(el => getComputedStyle(el).backdropFilter), 'none');
        await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-contrast', value: 'more' }] });
        await page.waitForTimeout(100);
        assert.equal(await page.locator('#page-home .refresh-btn').evaluate(el => getComputedStyle(el).borderTopColor), 'rgb(174, 191, 210)');
        await cdp.send('Emulation.setEmulatedMedia', { features: [] });
        await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('#mobile-nav-more').click();
        await page.locator('.appearance-trigger-sidebar').click();
        await page.screenshot({ path: path.join(output, 'glass-picker-390.png') });
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#appearance-dialog').isVisible(), false);
        assert.equal(await page.locator('#sidebar').getAttribute('aria-hidden'), 'false');
        assert.equal(await page.evaluate(() => document.activeElement.classList.contains('appearance-trigger-sidebar')), true);
        await page.locator('.appearance-trigger-sidebar').click();
        await page.mouse.click(5, 5);
        assert.equal(await page.locator('#appearance-dialog').isVisible(), false);
        await page.keyboard.press('Escape');

        // Full glass material must retain the one-screen timetable and readable events.
        await page.evaluate(() => {
            switchPage('schedule');
        });
        await page.locator('.is-current .course-card').first().waitFor();
        for (const width of [320, 390, 820, 1440]) {
            await page.setViewportSize({ width, height: 900 });
            await page.waitForTimeout(150);
            for (const week of [1, 12, 25]) {
                await page.evaluate(value => { document.getElementById('week-select').value = value; }, String(week));
                await assertCapsuleTextFits(page);
                if (week === 25 && (width === 320 || width === 390)) await page.locator('.week-select-wrap').screenshot({ path: path.join(output, `glass-week-selector-${width}.png`) });
            }
            await page.evaluate(() => { document.getElementById('week-select').value = '1'; });
            await page.evaluate(() => showScheduleActions());
            await assertCapsuleTextFits(page);
            if (width < 1100) {
                await page.waitForTimeout(200);
                await page.screenshot({ path: path.join(output, `glass-schedule-actions-${width}.png`) });
                assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1));
            }
            await page.evaluate(() => hideScheduleActions(false));
        }
        for (const [width, height] of [[390, 844], [320, 568], [1440, 900]]) {
            await page.setViewportSize({ width, height });
            await page.waitForTimeout(200);
            assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1));
            assert.equal(await page.locator('.is-current .course-card').first().evaluate(el => getComputedStyle(el).color), 'rgb(39, 44, 48)');
            assert.ok(await page.locator('.is-current .course-card').first().evaluate(el => getComputedStyle(el).backgroundImage.includes('gradient')));
            await page.screenshot({ path: path.join(output, `glass-schedule-${width}.png`) });
            if (width < 1100) {
                await page.evaluate(() => showScheduleActions());
                await page.waitForTimeout(500);
                assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1));
                assert.ok(await page.locator('.is-current .schedule-grid').evaluate(el => el.getBoundingClientRect().height > 100));
                assert.ok(await page.locator('#schedule-actions').evaluate(el => el.getBoundingClientRect().bottom <= document.getElementById('mobile-bottom-nav').getBoundingClientRect().top));
                await page.screenshot({ path: path.join(output, `glass-schedule-actions-${width}-${height}.png`) });
                await page.evaluate(() => hideScheduleActions(false));
            }
        }
        for (const width of [1440, 390]) {
            await page.setViewportSize({ width, height: 900 });
            const course = page.locator('.is-current .course-card').first();
            await course.click();
            await page.waitForTimeout(650);
            await page.screenshot({ path: path.join(output, `glass-course-detail-${width}.png`) });
            assert.ok(await page.locator('#course-detail-modal').isVisible());
            await page.keyboard.press('Escape');
            await page.waitForTimeout(300);
            await assertCapsuleTextFits(page);
            assert.equal(await page.locator('#course-detail-modal').isVisible(), false);
            assert.equal(await course.evaluate(el => el === document.activeElement), true);
        }

        for (const pageName of ['grades', 'evaluation', 'feedback', 'member', 'lab', 'service-status', 'shortcut-api']) {
            await page.evaluate(name => switchPage(name), pageName);
            await page.setViewportSize({ width: 320, height: 568 });
            await page.waitForTimeout(300);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${pageName}: mobile fits`);
            if (['grades', 'lab', 'feedback'].includes(pageName)) await page.screenshot({ path: path.join(output, `glass-${pageName}-320.png`), fullPage: true });
        }

        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto('http://urp.test/ad-detail');
        assert.equal(await page.locator('html').getAttribute('data-ui-template'), 'glass');
        assert.notEqual(await page.locator('.campaign-card').first().evaluate(el => getComputedStyle(el).backdropFilter), 'none');
        await page.screenshot({ path: path.join(output, 'glass-ad-1440.png'), fullPage: true });
        await page.goto('http://urp.test/admin');
        await page.evaluate(async () => {
            document.getElementById('admin-login').style.display = 'none';
            document.getElementById('admin-panel').style.display = 'block';
            adminKey = 'local-preview';
            await loadUsers();
        });
        assert.equal(await page.locator('html').getAttribute('data-ui-template'), 'glass');
        await page.screenshot({ path: path.join(output, 'glass-admin-1440.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(150);
        await page.screenshot({ path: path.join(output, 'glass-admin-390.png'), fullPage: true });
        await page.locator('.appearance-trigger-admin').click();
        await page.locator('input[value="workspace"]').check();
        await page.locator('.appearance-close').click();
        assert.equal(await page.locator('html').getAttribute('data-ui-template'), 'workspace');
        await page.setViewportSize({ width: 390, height: 844 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

        // Invalid storage values and unavailable storage recover to the default shared bootstrap.
        await page.evaluate(() => localStorage.setItem('urp_ui_template', 'unknown'));
        await page.goto('http://urp.test/');
        assert.equal(await page.locator('html').getAttribute('data-ui-template'), 'workspace');
        await context.addInitScript(() => {
            Storage.prototype.getItem = () => { throw new Error('Storage unavailable'); };
            Storage.prototype.setItem = () => { throw new Error('Storage unavailable'); };
        });
        await page.goto('http://urp.test/ad-detail');
        assert.equal(await page.locator('html').getAttribute('data-ui-template'), 'workspace');
        assert.deepEqual(errors, []);
        console.log('PASS: template switching, persistence, full glass surfaces, mobile Escape/backdrop/focus, responsive navigation, readable courses and fixed timetable');
    } finally {
        await browser.close();
    }
})();
