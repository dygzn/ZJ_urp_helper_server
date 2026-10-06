const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'templates/index.html'), 'utf8')
    .replace(/{%[\s\S]*?%}/g, '').replace(/{{[\s\S]*?}}/g, '');
const output = path.join(root, 'artifacts/grades-preview');
const term = '2025-2026学年春(两学期)';
const semesters = Array.from({ length: 10 }, (_, index) => ({
    value: `${2017 + index}-${2018 + index}-1-1`, text: `${2017 + index}秋学期`,
}));
const fixtures = {
    '/api/check_bind': { success: true, bound: true, username: 'grade-test' },
    '/api/check_login_status': { success: true, logged_in: true },
    '/api/grades/latest_summary': { success: true, semester: term,
        passed: [{ course: '概率与统计', credit: '3', score: '86' }, { course: '电子技术基础', credit: '3', score: '75' }],
        failed: { current: [{ course: '大学英语', credit: '2', score: '40', exam_time: '20260110' }],
            past: [{ course: '高等数学', credit: '5', score: '52', exam_time: '20250110' }] } },
    '/api/grades/gpa': { success: true, gpa: {
        '学分绩点': '3.28', '学位绩点': '3.52', '加权学分学位绩点': '3.38',
        '学期绩点明细': [{ '学年学期': term, '学分绩点': '3.45', '学位绩点': '3.68', '总学分': '6' }],
    } },
    '/api/grades/current': { success: false, message: '本学期成绩查询未开放' },
    '/api/grades/failed': { success: true,
        current: [{ course: '大学英语', credit: '2', score: '40' }],
        past: [{ course: '高等数学', credit: '5', score: '52' }] },
    '/api/grades/semesters': { success: true, semesters: [term, '2024-2025学年秋(两学期)'] },
    '/api/grades/by_semester': { success: true, grades: [{ course: '历史学期课程', credit: '3', score: '80' }] },
    '/api/grades/exam_sessions': { success: true, semesters, exams: [
        { name: '2026秋学期补考', ksbh: 'makeup', jxzxjh: '2026-2027-1-1' },
    ] },
    '/api/grades/exam_scores': { success: true, grades: [
        { course: '按场次补考课程', credit: '2', score: '0' },
        { course: '未发布课程', credit: '3', score: '' },
    ] },
};
const makeup = { success: true,
    latest_session: { period: '2026-2027-1', label: '2026-2027学年秋学期', status: 'no_results' },
    latest_published: { period: '2025-2026-1', label: '2025-2026学年秋学期', results: [
        { course: '最近补考课程', credit: '3', score: '85', sessions: ['2025秋学期补考'] },
    ] },
};

(async () => {
    fs.mkdirSync(output, { recursive: true });
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        for (const [width, height, theme, dark] of [[1440, 900, 'workspace', false], [390, 844, 'workspace', false],
            [320, 568, 'workspace', true], [390, 844, 'glass', false], [320, 568, 'glass', true]]) {
            const context = await browser.newContext({ viewport: { width, height }, colorScheme: dark ? 'dark' : 'light' });
            await context.addInitScript(theme => {
                localStorage.setItem('urp_ui_template', theme);
                localStorage.setItem('current_page', 'grades');
            }, theme);
            let release;
            let delayed = new Promise(resolve => { release = resolve; });
            const requests = [];
            await context.route('**/*', async route => {
                const pathname = new URL(route.request().url()).pathname;
                if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
                if (pathname.startsWith('/static/')) return route.fulfill({ path: root + pathname });
                requests.push(pathname);
                if (pathname === '/api/grades/latest_makeup') { await delayed; return route.fulfill({ json: makeup }); }
                return route.fulfill({ json: fixtures[pathname] || { success: true, announcements: [], data: {} } });
            });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.goto('http://urp.test/');
            await page.locator('#grades-content').getByText('概率与统计').waitFor();
            assert.match(await page.locator('#grades-content').innerText(), /正在查询补考/);
            assert.equal(requests.includes('/api/grades/current'), false);
            release(); delayed = Promise.resolve();
            await page.locator('#grades-content').getByText('最近补考课程').waitFor();
            await page.waitForFunction(() => document.getElementById('grades-kpi-gpa').textContent === '3.45');
            assert.equal(await page.locator('#grades-kpi-credits').innerText(), '6');
            const assertTablesFit = async () => {
                const overflow = await page.locator('#grades-content').evaluate(root => {
                    return Array.from(root.querySelectorAll('table, .grades-table-wrap')).filter(element =>
                        element.scrollWidth > element.clientWidth + 1
                        || element.getBoundingClientRect().right > innerWidth + 1
                    ).map(element => element.className);
                });
                assert.deepEqual(overflow, [], `tables must fit ${theme} ${width}px`);
            };
            await page.evaluate(() => {
                const longName = '习近平新时代中国特色社会主义思想概论与实践课程';
                const tables = document.querySelectorAll('#grades-content .grades-table');
                for (const table of tables) {
                    const firstCell = table.querySelector('tbody td');
                    if (firstCell) firstCell.textContent = longName;
                }
            });
            await assertTablesFit();
            await page.screenshot({ path: path.join(output, `${theme}-grades-${width}.png`), fullPage: true, animations: 'disabled' });
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            const options = page.locator('#grades-query-options');
            const openMenu = async () => { await page.locator('#grades-query-summary').click(); assert.equal(await options.getAttribute('open') !== null, true); };
            await openMenu();
            assert.equal(await page.locator('#grades-query-menu button').count(), 5);
            await page.screenshot({ path: path.join(output, `${theme}-menu-${width}.png`), animations: 'disabled' });
            await page.keyboard.press('Tab');
            await page.keyboard.press('Escape');
            assert.equal(await options.getAttribute('open'), null);
            assert.equal(await page.evaluate(() => document.activeElement.id), 'grades-query-summary');
            await openMenu();
            await page.locator('#grades-query-menu [data-grade-query="current"]').click();
            await page.locator('#grades-content').getByText('本学期成绩查询未开放').waitFor();
            assert.match(await page.locator('#grades-result-description').innerText(), /教务系统里面/);
            assert.equal(await options.getAttribute('open'), null);
            await openMenu();
            await page.locator('#grades-query-menu [data-grade-query="semester"]').click();
            await page.locator('#semester-picker-list button').first().click();
            await page.locator('#grades-content').getByText('历史学期课程').waitFor();
            await openMenu();
            await page.locator('#grades-query-menu [data-grade-query="failed"]').click();
            await page.locator('#grades-content').getByText('尚不及格', { exact: true }).waitFor();
            assert.match(await page.locator('#grades-content').innerText(), /曾不及格/);
            await page.locator('#grades-gpa-quick').click();
            await page.locator('#grades-content').getByText('3.28', { exact: true }).waitFor();
            for (const label of ['学位绩点', '加权学分学位绩点', '学期绩点明细']) assert.match(await page.locator('#grades-content').innerText(), new RegExp(label));
            await assertTablesFit();
            await page.screenshot({ path: path.join(output, `${theme}-gpa-${width}.png`), fullPage: true, animations: 'disabled' });
            await openMenu();
            await page.locator('#grades-query-menu [data-grade-query="exam"]').click();
            await page.locator('#exam-picker-body button').first().waitFor();
            assert.equal(await page.locator('#exam-picker-body button').count(), 10);
            await page.locator('#exam-picker-body button').first().click();
            await page.locator('#exam-picker-body button').first().click();
            await page.locator('#grades-content').getByText('按场次补考课程').waitFor();
            assert.match(await page.locator('#grades-content').innerText(), /暂未发布/);
            assert.deepEqual(errors, []);
            console.log(`PASS ${theme} ${width}px: progressive loading, 5 queries, GPA fields, historical sessions, focus and no overflow`);
            await context.close();
        }
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
