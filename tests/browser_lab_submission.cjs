// Offline lab workflow: all school requests and uploads are intercepted.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const html = execFileSync(path.join(root, '.venv/bin/python'), ['-c', `
from jinja2 import Environment, FileSystemLoader
env = Environment(loader=FileSystemLoader('templates'))
env.globals['static_versioned'] = lambda filename: '/static/' + filename
print(env.get_template('index.html').render(ad={'enabled': False}))
`], { cwd: root, encoding: 'utf8' });
const tasks = {
    semester: 'autumn', mode: '按课程', headers: ['编号', '课程', '课序号', '教师', '班级', '考核'],
    semesters: [{ value: 'autumn', label: '2026-2027学年秋（两学期）' }, { value: 'spring', label: '2025-2026学年春（两学期）' }],
    items: [{ id: '0', task_key: 'measurement', cells: ['7', '公差配合与测量技术 [01435011]', '01', '实验教师', '工业工程班', '预习报告 实验报告'],
        pre: true, report: true }],
};
const reports = {
    pre: { status: 'unknown', label: '未见已上传文件', file_name: '' },
    report: { status: 'submitted', label: '待评阅', file_name: '课程实验报告_长文件名与状态换行验证_2026年秋季学期.pdf' },
};
const withStatus = () => ({ ...tasks, items: tasks.items.map(item => ({ ...item, reports })) });

(async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const output = '/tmp/urp-lab-submission-preview';
    fs.mkdirSync(output, { recursive: true });
    try {
        for (const [width, theme, colorScheme] of [
            [1440, 'workspace', 'light'], [390, 'workspace', 'light'], [320, 'workspace', 'dark'],
            [1440, 'glass', 'dark'], [390, 'glass', 'light'], [320, 'glass', 'dark'],
        ]) {
            const context = await browser.newContext({ colorScheme, reducedMotion: 'reduce', viewport: { width, height: 900 } });
            await context.addInitScript(theme => {
                localStorage.setItem('urp_ui_template', theme);
                localStorage.setItem('urp_miniapp_notice_dismissed', '1');
            }, theme);
            let logins = 0, uploads = 0, statusReads = 0, expire = false, failedStatus = false;
            const errors = [];
            await context.route('**/*', async route => {
                const p = new URL(route.request().url()).pathname;
                if (p === '/') return route.fulfill({ contentType: 'text/html', body: html });
                if (p.startsWith('/static/')) return route.fulfill({ path: root + p });
                if (p === '/api/lab/status') return route.fulfill({ json: {
                    success: true, student_id: 'offline', password_bound: true, logged_in: false,
                } });
                if (p === '/api/lab/query') {
                    logins++;
                    return route.fulfill({ json: { success: true, data: tasks } });
                }
                if (p === '/api/lab/submission-status') {
                    statusReads++;
                    const data = withStatus();
                    if (failedStatus) data.items[0].reports = {
                        pre: { status: 'unknown', label: '状态读取失败，请刷新重试' },
                        report: { status: 'unknown', label: '状态读取失败，请刷新重试' },
                    };
                    return route.fulfill({ json: { success: true, data } });
                }
                if (p === '/api/lab/experiments') return route.fulfill({ json: expire
                    ? { success: false, code: 'LAB_SESSION_EXPIRED', message: '请重新输入实验站密码查询，无需解绑' }
                    : { success: true, data: tasks } });
                if (p === '/api/lab/upload') {
                    uploads++;
                    const body = route.request().postDataBuffer().toString();
                    assert.ok(body.includes('measurement') && body.includes('autumn'));
                    return route.fulfill({ json: { success: true, message: '文件已发送，请核对报告状态', data: { listing: withStatus(), confirmed: false } } });
                }
                return route.fulfill({ json: p === '/api/member/status'
                    ? { success: true, data: { is_member: true, member_type: 'basic', expire_time: '2028-01-01T00:00:00' } }
                    : { success: true, bound: true, username: 'offline', logged_in: true, data: {}, announcements: [], event: { upcoming: [] } } });
            });
            const page = await context.newPage();
            page.on('pageerror', error => errors.push(error.message));
            await page.goto('http://urp.test/');
            await page.waitForFunction(() => window.URP?.store.getState().currentUsername === 'offline');
            await page.evaluate(() => switchPage('lab'));
            await page.locator('.lab-submitted').waitFor();
            assert.equal(logins, 1);
            assert.equal(statusReads, 1);
            assert.equal(await page.locator('#lab-connection').isVisible(), false);
            assert.match(await page.locator('#lab-list').innerText(), /实验报告：待评阅.*长文件名/);
            assert.match(await page.locator('#lab-list').innerText(), /预习报告：未见已上传文件/);
            assert.equal(await page.getByRole('button', { name: '重新提交实验报告', exact: true }).isEnabled(), true);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}/${theme} overflow`);
            const buttons = await page.locator('#lab-results button').evaluateAll(buttons => buttons.map(b => b.getBoundingClientRect().height));
            assert.ok(buttons.every(height => height >= 44));
            await page.screenshot({ path: `${output}/${width}-${theme}-${colorScheme}.png`, fullPage: true });
            await page.locator('#lab-file').setInputFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n offline') });
            assert.equal(uploads, 0); // Selecting without a report action must never upload.
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', { name: '重新提交实验报告', exact: true }).click();
            await (await chooser).setFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n offline') });
            await page.getByText('文件已发送，请核对报告状态', { exact: true }).waitFor();
            assert.equal(uploads, 1);
            failedStatus = true;
            await page.locator('#lab-refresh').click();
            await page.getByText('实验报告：状态读取失败，请刷新重试', { exact: true }).waitFor();
            assert.equal(await page.locator('.lab-submitted').count(), 0);
            expire = true;
            await page.locator('#lab-semester').selectOption('spring');
            await page.locator('#lab-password').waitFor({ state: 'visible' });
            assert.equal(await page.locator('#lab-password').evaluate(el => el === document.activeElement), true);
            assert.equal(await page.locator('#lab-unbind').isEnabled(), true);
            assert.equal(uploads, 1);
            assert.deepEqual(errors, []);
            await context.close();
        }
        console.log('Lab submission: 6 desktop/mobile/theme scenarios passed; previews: ' + output);
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
