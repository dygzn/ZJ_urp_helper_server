const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts/desktop-preview');

(async () => {
    fs.mkdirSync(output, { recursive: true });
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const event = { current: { title: '高等数学（上）', location: '第一教学楼 · A201',
            time: '08:20-10:00', remaining: 35 },
            next: { type: 'class', title: '大学英语', location: '第二教学楼 · B305',
                time: '2026-09-30 10:15', time_range: '10:15-11:55', countdown: 55 },
            upcoming_label: '今日安排', upcoming: [
                { title: '高等数学（上）', location: '第一教学楼 · A201', time: '08:20-10:00', status: 'current' },
                { title: '大学英语', location: '第二教学楼 · B305', time: '10:15-11:55', status: 'upcoming' },
                { title: '程序设计基础', location: '计算机实验楼 · 302', time: '14:10-15:50', status: 'upcoming' },
            ] };
        let response = { success: true, event };
        let html = fs.readFileSync(path.join(root, 'templates/index.html'), 'utf8')
            .replace(/{%[\s\S]*?%}/g, '').replace(/{{[\s\S]*?}}/g, '');
        await page.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
            if (url.pathname.startsWith('/static/')) {
                const file = root + url.pathname;
                if (fs.existsSync(file)) return route.fulfill({ path: file });
            }
            if (url.pathname === '/api/urgent_event') return route.fulfill({ json: response });
            return route.fulfill({ json: { success: true, bound: true, username: 'home-test', logged_in: true,
                announcements: [], data: {}, exams: [], semester_start: '2026-09-28' } });
        });
        await page.goto('http://urp.test/');
        await page.waitForFunction(() => window.URP?.store.getState().currentUsername === 'home-test');
        await page.evaluate(async () => {
            URP.store.setState({ isGuestMode: false, semesterStart: new Date('2026-09-28T00:00:00') });
            getCalendarChinaToday = () => '2026-09-30';
            document.querySelectorAll('.modal,.overlay').forEach(el => el.style.display = 'none');
            document.querySelector('#login-status-indicator .status-text').textContent = '已登录';
            document.querySelector('#login-status-indicator .status-dot').className = 'status-dot status-logged-in';
            await loadUrgentEvent();
        });
        assert.equal(await page.locator('.home-agenda-item').count(), 3);
        assert.match(await page.locator('.event-time-label').innerText(), /10:15-11:55/);
        const assertShortcutTextDoesNotOverlap = async () => {
            const collisions = await page.locator('#page-home .home-shortcut-copy').evaluateAll(copies => {
                const failures = [];
                const textRects = element => {
                    const range = document.createRange();
                    range.selectNodeContents(element);
                    return Array.from(range.getClientRects()).filter(rect => rect.width && rect.height);
                };
                for (const copy of copies) {
                    const title = copy.querySelector('strong');
                    const description = copy.querySelector(':scope > span');
                    const bounds = copy.closest('button').getBoundingClientRect();
                    const titles = textRects(title), descriptions = textRects(description);
                    for (const a of titles) for (const b of descriptions) {
                        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
                            && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) {
                            failures.push({ title: title.textContent, description: description.textContent, reason: 'overlap' });
                        }
                    }
                    for (const rect of [...titles, ...descriptions]) {
                        if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1
                            || rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1) {
                            failures.push({ title: title.textContent, reason: 'outside button' });
                        }
                    }
                }
                return failures;
            });
            assert.deepEqual(collisions, [], `shortcut text must not overlap at ${page.viewportSize().width}px`);
        };
        for (const [width, height] of [[1100, 700], [1366, 768], [1440, 900], [1920, 1080], [390, 844], [320, 568]]) {
            await page.setViewportSize({ width, height });
            await page.waitForTimeout(100);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: home fits horizontally`);
            assert.equal(await page.locator('.home-agenda').isVisible(), true);
            await assertShortcutTextDoesNotOverlap();
        }
        for (const theme of ['workspace', 'glass']) {
            await page.evaluate(theme => { document.documentElement.dataset.uiTemplate = theme; }, theme);
            for (const colorScheme of ['light', 'dark']) {
                await page.emulateMedia({ colorScheme });
                for (const width of [320, 390, 768, 820, 1100, 1440]) {
                    await page.setViewportSize({ width, height: 900 });
                    await page.waitForTimeout(100);
                    await assertShortcutTextDoesNotOverlap();
                    if (width === 390 || width === 1440) await page.screenshot({
                        path: path.join(output, `home-text-${theme}-${colorScheme}-${width}.png`),
                        fullPage: true, animations: 'disabled',
                    });
                }
            }
        }
        await page.evaluate(() => { document.documentElement.dataset.uiTemplate = 'workspace'; });
        await page.emulateMedia({ colorScheme: 'light' });
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.screenshot({ path: path.join(output, 'home-v3.png'), fullPage: true });

        // Long titles, locations and exam countdowns must remain readable.
        response = { success: true, event: { ...event, current: null, next: { type: 'exam',
            title: '计算机科学与技术专业综合课程设计理论考试', location: '仙林校区第二教学楼 B106（请提前到达考场）',
            time: '2026-09-30 14:00-16:00', seat: '50', countdown: 135 } } };
        await page.evaluate(() => loadUrgentEvent());
        assert.match(await page.locator('.countdown-label').innerText(), /后考试/);
        const single = await page.evaluate(() => {
            const card = document.querySelector('.event-card').getBoundingClientRect();
            const content = document.querySelector('.urgent-content').getBoundingClientRect();
            return { width: card.width, available: content.width };
        });
        assert.ok(single.width >= single.available - 1);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: path.join(output, 'home-long-exam.png'), fullPage: true });

        response = { success: false, message: '教务查询失败，请稍后重试' };
        await page.evaluate(() => loadUrgentEvent());
        assert.match(await page.locator('#urgent-content').innerText(), /查询失败/);
        assert.doesNotMatch(await page.locator('#urgent-content').innerText(), /好好休息/);
        response = { success: true, event: { current: null, next: null, upcoming: [] } };
        await page.evaluate(() => loadUrgentEvent());
        assert.match(await page.locator('#home-agenda-content').innerText(), /暂无后续课程/);
        await page.evaluate(() => { URP.store.setState({ isGuestMode: true }); return loadUrgentEvent(); });
        assert.ok(await page.locator('#urgent-content button').isVisible());
        await page.evaluate(() => { URP.store.setState({ isGuestMode: false }); });

        await page.evaluate(async () => {
            switchPage('schedule', { scheduleWeek: 1 });
            await URP.schedule.loadSchedule(1, true);
            URP.store.setState({ currentWeek: 1, cachedScheduleExams: [
                { course: '数据结构与算法', week: '1', day: '3', time: '14:10-15:50', location: '教B106', seat: '50' },
                { course: '大学物理', week: '1', day: '6', time: '08:20-10:00', location: '教C102' },
            ] });
            displaySchedule({ '1': [
                { '星期': 1, '节次': 1, '节数': 2, '课程名': '高等数学（上）', '位置': '第一教学楼 A201' },
                { '星期': 2, '节次': 3, '节数': 2, '课程名': '大学英语', '位置': '第二教学楼 B305' },
                { '星期': 3, '节次': 5, '节数': 2, '课程名': '程序设计基础', '位置': '计算机实验楼302' },
                { '星期': 4, '节次': 7, '节数': 2, '课程名': '大学物理', '位置': '第三教学楼 C102' },
                { '星期': 5, '节次': 9, '节数': 2, '课程名': '软件工程综合实践与课程设计', '位置': '工程实验中心 六楼601' },
            ] });
        });
        for (const [width, height] of [[1100, 700], [1366, 768], [1440, 900], [390, 844]]) {
            await page.setViewportSize({ width, height });
            await page.waitForTimeout(100);
            assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1));
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        }
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.waitForTimeout(350);
        await page.evaluate(() => document.activeElement.blur());
        await page.screenshot({ path: path.join(output, 'schedule-v3.png') });
        // Reusing the actual shortcut preserves page switching and modal opening.
        await page.evaluate(() => openHomeShortcut('grades'));
        assert.ok(await page.locator('#page-grades').evaluate(el => el.classList.contains('active')));
        assert.ok(await page.evaluate(() => Boolean(document.activeElement.closest('#page-grades'))), 'desktop shortcut focuses its destination');
        await page.evaluate(() => openHomeShortcut('exams'));
        assert.ok(await page.locator('#exams-modal').evaluate(el => el.classList.contains('active')));
        assert.deepEqual(errors, []);
        console.log('PASS: home course list, full time, long exam, error/empty/guest states, shortcuts, desktop/mobile dimensions; schedule weekend/exam/evening layout');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
