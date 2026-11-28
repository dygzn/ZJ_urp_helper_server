// Offline lab workflow: all school requests and uploads are intercepted.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { createServer } = require('node:http');
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
    modes: ['按课程', '按实验项目'].map(value => ({ value, label: value })),
    semesters: [{ value: 'autumn', label: '2026-2027学年秋（两学期）' }, { value: 'spring', label: '2025-2026学年春（两学期）' }],
    items: [{ id: '0', task_key: 'measurement', cells: ['7', '公差配合与测量技术 [01435011]', '01', '实验教师', '工业工程班', '预习报告 实验报告'],
        pre: true, report: true }],
};
const reports = {
    pre: { status: 'unknown', label: '未见已上传文件', file_name: '', supports_attachment: false, status_read: true },
    report: { status: 'submitted', label: '待评阅', file_name: '课程实验报告_长文件名与状态换行验证_2026年秋季学期.pdf',
        supports_attachment: true, status_read: true, attachment_name: '原始附件<测量数据>_2026年秋.zip', attachment_hint: '(文件大小不超过20M)' },
};
const withStatus = () => ({ ...tasks, items: tasks.items.map(item => ({ ...item, reports })) });
const report = { name: `report-${'measurement-data-'.repeat(9)}.pdf`, mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7\n offline') };
const attachment = { name: `attachment-${'long-'.repeat(25)}.zip`, mimeType: 'application/zip', buffer: Buffer.from('offline ZIP') };

(async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    let uploadHandler;
    const server = createServer((request, response) => uploadHandler(request, response));
    const output = process.env.LAB_PREVIEW_DIR || '/tmp/urp-lab-submission-preview';
    fs.mkdirSync(output, { recursive: true });
    try {
        await once(server.listen(0, '127.0.0.1'), 'listening');
        const origin = `http://127.0.0.1:${server.address().port}`;
        const scenarios = [
            [1440, 'workspace', 'light'], [1100, 'workspace', 'dark'], [1099, 'glass', 'light'],
            [769, 'garden', 'dark'], [768, 'clay', 'light'], [390, 'workspace', 'light'],
            [320, 'workspace', 'dark'], [1440, 'glass', 'dark'], [390, 'glass', 'light'],
            [320, 'glass', 'dark'], [320, 'paper', 'light'],
        ];
        for (const [width, theme, colorScheme] of scenarios) {
            const context = await browser.newContext({ colorScheme, reducedMotion: 'reduce', viewport: { width, height: width <= 768 ? 600 : 850 } });
            await context.addInitScript(theme => {
                localStorage.setItem('urp_ui_template', theme);
                localStorage.setItem('urp_miniapp_notice_dismissed', '1');
            }, theme);
            let logins = 0, uploads = 0, statusReads = 0, expire = false, failedStatus = false;
            let releaseUpload;
            const uploadGate = new Promise(resolve => { releaseUpload = resolve; });
            const errors = [];
            uploadHandler = async (request, response) => {
                try {
                    assert.equal(request.url, '/api/lab/upload');
                    const chunks = [];
                    for await (const chunk of request) chunks.push(chunk);
                    const body = Buffer.concat(chunks).toString();
                    assert.ok(body.includes('measurement') && body.includes('autumn'));
                    assert.ok(request.headers['x-device-id']);
                    assert.ok(body.includes('name="file"') && body.includes('name="attachment"'));
                    uploads++;
                    if (uploads === 1) {
                        response.writeHead(400, { 'Content-Type': 'application/json' });
                        response.end(JSON.stringify({ success: false, field: 'attachment', message: '附件校验失败，请重新选择' }));
                        return;
                    }
                    await uploadGate;
                    response.writeHead(200, { 'Content-Type': 'application/json' });
                    if (uploads === 2) {
                        response.end(JSON.stringify({
                            success: true,
                            message: '文件已发送，但提交状态刷新失败，请刷新任务或到实验站核对，勿重复提交',
                            data: { listing: withStatus(), confirmed: false, status_refreshed: false },
                        }));
                    } else {
                        response.end(JSON.stringify({
                            success: true,
                            message: '文件已发送并已刷新状态，请核对下方文件名与原站状态',
                            data: { listing: withStatus(), confirmed: false, status_refreshed: true },
                        }));
                    }
                } catch (error) {
                    errors.push(error.message);
                    response.writeHead(500).end();
                }
            };
            await context.route('**/*', async route => {
                const url = new URL(route.request().url());
                if (url.origin !== origin) return route.abort();
                const p = url.pathname;
                const project = url.searchParams.get('mode') === '按实验项目';
                const course = url.searchParams.get('course') || '';
                const projectTasks = { ...tasks, mode: '按实验项目', course, courses: [
                    {value: '', label: '请选择'}, {value: 'c1', label: '测量技术'},
                ], headers: ['课程', '实验项目'], items: course ? [{
                    id: '0', task_key: 'project-1', cells: ['测量技术', '长度测量'], pre: false, report: true,
                }] : [] };
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
                    const data = project ? projectTasks : withStatus();
                    if (failedStatus) data.items[0].reports = {
                        pre: { status: 'unknown', label: '状态读取失败，请刷新重试' },
                        report: { status: 'unknown', label: '状态读取失败，请刷新重试' },
                    };
                    return route.fulfill({ json: { success: true, data } });
                }
                if (p === '/api/lab/experiments') return route.fulfill({ json: expire
                    ? { success: false, code: 'LAB_SESSION_EXPIRED', message: '请重新输入实验站密码查询，无需解绑' }
                    : { success: true, data: project ? projectTasks : tasks } });
                if (p === '/api/lab/upload') return route.continue();
                return route.fulfill({ json: p === '/api/member/status'
                    ? { success: true, data: { is_member: true, member_type: 'basic', expire_time: '2028-01-01T00:00:00' } }
                    : { success: true, bound: true, username: 'offline', logged_in: true, data: {}, announcements: [], event: { upcoming: [] } } });
            });
            const page = await context.newPage();
            page.on('pageerror', error => errors.push(error.message));
            await page.goto(origin);
            await page.waitForFunction(() => window.URP?.store.getState().currentUsername === 'offline');
            await page.evaluate(() => switchPage('lab'));
            await page.locator('.lab-submitted').waitFor();
            assert.equal(logins, 1);
            assert.equal(statusReads, 1);
            await page.getByLabel('报告类型', {exact:true}).selectOption('按实验项目');
            await page.getByText('请选择课程查看实验项目', {exact:true}).waitFor();
            await page.locator('#lab-course').selectOption('c1');
            await page.locator('#lab-list strong').getByText('长度测量').waitFor();
            assert.ok(await page.getByRole('button', {name:'提交预习报告', exact:true}).isDisabled());
            await page.getByLabel('报告类型', {exact:true}).selectOption('按课程');
            await page.locator('.lab-submitted').waitFor();
            assert.ok(await page.locator('#lab-course').isHidden());
            assert.equal(await page.locator('#lab-connection').isVisible(), false);
            assert.match(await page.locator('#lab-list').innerText(), /实验报告：待评阅.*长文件名/);
            assert.match(await page.locator('#lab-list').innerText(), /预习报告：未见已上传文件/);
            assert.equal(await page.locator('.lab-report-attachment').count(), 1);
            await page.getByText('附件：原始附件<测量数据>_2026年秋.zip', { exact: true }).waitFor();
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}/${theme} overflow`);
            const buttons = await page.locator('#lab-results button').evaluateAll(buttons => buttons.map(b => b.getBoundingClientRect().height));
            assert.ok(buttons.every(height => height >= 44));
            const dialog = page.getByRole('dialog', { name: '重新提交实验报告' });
            const submit = page.locator('#lab-upload-submit');
            const trigger = page.getByRole('button', { name: '重新提交实验报告', exact: true });
            const preview = `${output}/${width}-${theme}-${colorScheme}`;
            await page.getByRole('button', { name: '提交预习报告', exact: true }).click();
            await page.getByRole('dialog', { name: '提交预习报告' }).waitFor();
            assert.ok(await page.locator('#lab-attachment-slot').isHidden());
            await page.keyboard.press('Escape');
            assert.equal(await page.evaluate(() => document.activeElement.textContent), '提交预习报告');
            await trigger.click();
            await dialog.waitFor();
            await page.mouse.click(2, 2);
            assert.ok(await dialog.isHidden());
            assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
            await trigger.click();
            await dialog.waitFor();
            assert.ok(await submit.isDisabled());
            assert.ok(await page.locator('#lab-attachment-slot').isVisible());
            assert.match(await page.locator('#lab-upload-context').innerText(), /公差配合与测量技术.*2026-2027学年秋/);
            assert.match(await page.locator('#lab-upload-existing-hint').innerText(), /原站已有附件/);
            const close = dialog.getByRole('button', { name: '关闭', exact: true });
            const closeSize = await close.boundingBox();
            assert.deepEqual([closeSize.width, closeSize.height], [72, 44]);
            await page.keyboard.press('Tab');
            assert.equal(await page.evaluate(() => document.activeElement.id), 'lab-upload-close');
            await page.keyboard.press('Shift+Tab');
            assert.equal(await page.evaluate(() => document.activeElement.id), 'lab-upload-cancel');
            const box = await page.locator('#lab-upload-form').boundingBox();
            if (width <= 768) {
                assert.ok(box.width >= width - 2 && Math.abs(box.y + box.height - 600) <= 1);
                assert.ok(await page.locator('.lab-upload-drag-copy').first().isHidden());
                assert.ok((await page.locator('#lab-file-choose').boundingBox()).height >= 48);
            } else {
                assert.ok(box.width > 520 && box.width <= 541);
                assert.ok(Math.abs(box.x + box.width / 2 - width / 2) <= 1);
                assert.ok(await page.locator('.lab-upload-drag-copy').first().isVisible());
            }
            await page.screenshot({ path: `${preview}-empty.png` });
            if (width > 768) {
                const transfer = await page.evaluateHandle(file => {
                    const source = new DataTransfer();
                    source.items.add(new File(['%PDF-1.7'], file.name, { type: file.mimeType }));
                    return source;
                }, { name: report.name, mimeType: report.mimeType });
                await page.locator('#lab-file-drop').dispatchEvent('drop', { dataTransfer: transfer });
                await transfer.dispose();
            } else {
                const chooser = page.waitForEvent('filechooser');
                await page.locator('#lab-file-choose').click();
                await (await chooser).setFiles(report);
            }
            await page.locator('#lab-attachment').setInputFiles(attachment);
            assert.equal(uploads, 0);
            assert.equal(await submit.textContent(), '提交报告与附件');
            assert.equal(await page.locator('#lab-file-name').textContent(), report.name);
            assert.ok(await page.locator('#lab-upload-form').evaluate(form =>
                [form, ...form.querySelectorAll('.lab-upload-file-info, .lab-upload-body')]
                    .every(element => element.scrollWidth <= element.clientWidth + 1)));
            assert.ok(await page.locator('.lab-upload-file-actions button').evaluateAll(buttons =>
                buttons.every(button => button.offsetWidth >= 44 && button.offsetHeight >= 44)));
            if (width === 320) {
                const pinned = await page.locator('#lab-upload-form').evaluate(form => {
                    const header = form.querySelector('header');
                    const footer = form.querySelector('footer');
                    const body = form.querySelector('.lab-upload-body');
                    const before = [header.offsetTop, footer.offsetTop];
                    body.scrollTop = body.scrollHeight;
                    return body.scrollTop > 0 && before.every((offset, index) => offset === [header.offsetTop, footer.offsetTop][index]);
                });
                assert.ok(pinned);
            }
            await page.screenshot({ path: `${preview}-selected.png` });
            await submit.click();
            await page.getByText('附件校验失败，请重新选择', { exact: true }).waitFor();
            assert.equal(uploads, 1);
            assert.equal(await page.locator('#lab-file-name').textContent(), report.name);
            assert.ok(await page.locator('#lab-attachment-name').isHidden());
            await page.locator('#lab-attachment').setInputFiles(attachment);
            await submit.click();
            await page.getByText('文件已送达服务器，正在提交至实验站…', { exact: true }).waitFor();
            assert.equal(await page.locator('#lab-upload-progress').evaluate(element => element.value), 100);
            assert.ok(await close.isDisabled());
            assert.ok(await page.locator('#lab-upload-cancel').isDisabled());
            assert.ok(await submit.isDisabled());
            await page.keyboard.press('Escape');
            await page.mouse.click(2, 2);
            await page.locator('#lab-upload-form').dispatchEvent('submit');
            assert.ok(await dialog.isVisible());
            assert.equal(uploads, 2);
            await page.screenshot({ path: `${preview}-uploading.png` });
            releaseUpload();
            await page.getByText('文件已发送，但提交状态刷新失败，请刷新任务或到实验站核对，勿重复提交', { exact: true }).waitFor();
            assert.ok(await dialog.isHidden());
            assert.ok(await trigger.isDisabled());
            failedStatus = true;
            await page.locator('#lab-refresh').click();
            await page.getByText('实验报告：状态读取失败，请刷新重试', { exact: true }).waitFor();
            assert.equal(await page.locator('.lab-submitted').count(), 0);
            await page.getByText('实验报告提交结果待核实，请刷新任务与状态', { exact: true }).waitFor();
            failedStatus = false;
            await page.locator('#lab-refresh').click();
            await page.waitForFunction(() => [...document.querySelectorAll('#lab-list button')]
                .some(button => button.textContent === '重新提交实验报告' && !button.disabled));
            assert.equal(await page.locator('.lab-report-unverified').count(), 0);
            await trigger.click();
            await dialog.waitFor();
            await page.locator('#lab-file').setInputFiles(report);
            await page.locator('#lab-attachment').setInputFiles(attachment);
            await submit.click();
            await page.getByText('文件已发送并已刷新状态，请核对下方文件名与原站状态', { exact: true }).waitFor();
            assert.ok(await dialog.isHidden());
            assert.equal(await page.locator('#lab-message').evaluate(el => el.classList.contains('lab-error')), false);
            assert.equal(await trigger.isDisabled(), false);
            expire = true;
            await page.locator('#lab-semester').selectOption('spring');
            await page.locator('#lab-password').waitFor({ state: 'visible' });
            assert.equal(await page.locator('#lab-password').evaluate(el => el === document.activeElement), true);
            assert.equal(await page.locator('#lab-unbind').isEnabled(), true);
            assert.equal(uploads, 3);
            assert.deepEqual(errors, []);
            await context.close();
        }
        console.log(`Lab submission: ${scenarios.length} desktop/tablet/mobile/theme scenarios passed; previews: ${output}`);
    } finally {
        await browser.close();
        server.close();
    }
})().catch(error => { console.error(error); process.exit(1); });
