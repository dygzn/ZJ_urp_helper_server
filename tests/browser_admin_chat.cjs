const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'templates/admin.html'), 'utf8')
    .replace(/{{\s*static_versioned\('([^']+)'\)\s*}}/g, (_, file) => `/static/${file}`);
const username = '2315108133';
const payload = '<img src=x onerror="window.adminChatInjected=true">';
const settings = {
    enabled: true, readonly: false, pinned_notice: payload, max_length: 500,
    cooldown_seconds: 3, recall_seconds: 120, sensitive_words: ['刷屏'], settings_version: 7,
};
const message = {
    id: 461, username, display_name: '23级 同学#A3F9', show_student_id: false,
    sender_role: 'user', content: payload.repeat(5), status: 'normal', report_count: 1,
    create_time: '2026-11-27T06:20:00Z',
};
const report = {
    id: 19, message_id: 461, username, reporter_username: '2415108133', content: payload,
    reason: 'privacy', detail: payload, status: 'pending', create_time: message.create_time,
};
const list = (items, next_cursor = null) => ({ items, next_cursor, has_more: next_cursor !== null });

(async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        for (const [width, scheme, theme] of [[1440, 'light', 'workspace'], [320, 'dark', 'glass']]) {
            const context = await browser.newContext({ colorScheme: scheme, viewport: { width, height: 900 } });
            await context.addInitScript(theme => {
                sessionStorage.setItem('admin_key', 'offline-key');
                localStorage.setItem('urp_ui_template', theme);
            }, theme);
            const requests = [];
            const errors = [];
            let activeSettings = settings, muted = [], reported = [report], messageStatus = 'normal';
            let rejectOfficial = true;
            await context.route('**/*', async route => {
                const request = route.request();
                const url = new URL(request.url());
                if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
                if (url.pathname.startsWith('/static/')) return route.fulfill({ path: root + url.pathname });
                if (!url.pathname.startsWith('/api/admin/chat/')) return route.fulfill({ json: { success: false } });
                assert.equal(request.headers()['x-admin-key'], 'offline-key');
                const endpoint = url.pathname.slice('/api/admin/chat'.length);
                const method = request.method(), body = request.postDataJSON();
                requests.push({ endpoint, method, body, query: Object.fromEntries(url.searchParams) });
                let data;
                if (endpoint === '/settings') {
                    if (method === 'PUT') {
                        if (body.if_settings_version !== activeSettings.settings_version) return route.fulfill({
                            status: 409, json: { success: false, code: 'SETTINGS_CONFLICT', message: '配置已被修改' },
                        });
                        activeSettings = { ...activeSettings, ...body, settings_version: activeSettings.settings_version + 1 };
                    }
                    data = activeSettings;
                }
                if (endpoint === '/messages') {
                    if (method === 'POST') {
                        if (rejectOfficial) {
                            rejectOfficial = false;
                            return route.fulfill({ status: 503, json: { success: false, message: '发送暂时失败' } });
                        }
                        data = { id: 462, sender_role: 'admin', content: body.content };
                    } else {
                        data = url.searchParams.has('before_id')
                            ? list([{ ...message, id: 430, content: '较早消息' }])
                            : list([{ ...message, status: messageStatus }], 461);
                    }
                }
                if (endpoint === '/messages/461' && method === 'DELETE') {
                    messageStatus = 'deleted';
                    data = { id: 461, status: messageStatus };
                }
                if (endpoint === '/reports') data = list(reported);
                if (endpoint === '/reports/19/handle') {
                    reported = [];
                    data = { id: 19, status: 'ignored' };
                }
                if (endpoint === '/mutes') {
                    if (method === 'POST') muted = [{ ...body, muted_until: null }];
                    data = method === 'POST' ? muted[0] : list(muted);
                }
                if (endpoint === '/mutes/' + username && method === 'DELETE') {
                    muted = [];
                    data = { removed: true };
                }
                assert.ok(data, endpoint);
                return route.fulfill({ json: { success: true, data } });
            });
            const page = await context.newPage();
            page.on('pageerror', error => errors.push(error.message));
            await page.goto('http://urp.test/');
            await page.getByRole('tab', { name: '聊天室管理', exact: true }).click({ timeout: 3000 });
            const tab = page.locator('#tab-chat');
            const messages = tab.getByRole('region', { name: '消息审查' });
            const reports = tab.getByRole('region', { name: '待处理举报' });
            const mutes = tab.getByRole('region', { name: '禁言名单' });
            await messages.getByText(message.content, { exact: true }).waitFor({ timeout: 3500 });
            await reports.getByText(report.reporter_username, { exact: true }).waitFor();
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
            assert.equal(await tab.locator('img,script,iframe').count(), 0);
            assert.equal(await page.evaluate(() => Boolean(window.adminChatInjected)), false);
            assert.equal(await tab.getByLabel('置顶群公告').inputValue(), payload);
            const tabIds = await page.locator('.tab-btn').evaluateAll(tabs => tabs.map(t => t.getAttribute('aria-controls')));
            const panelIds = await page.locator('.tab-content').evaluateAll(panels => panels.map(p => p.id));
            assert.deepEqual(tabIds, panelIds);

            await messages.getByLabel('真实学号').fill(username);
            await messages.getByLabel('正文关键词').fill('实验&作业');
            await messages.getByLabel('消息状态').selectOption('reported');
            await Promise.all([
                page.waitForResponse(r => r.url().includes('status=reported')),
                messages.getByRole('button', { name: '查询', exact: true }).click(),
            ]);
            const lastSearch = requests.filter(r => r.endpoint === '/messages').at(-1);
            assert.equal(lastSearch.query.username, username);
            assert.equal(lastSearch.query.q, '实验&作业');
            await messages.getByRole('button', { name: '加载更多消息' }).click();
            await messages.getByText('较早消息', { exact: true }).waitFor();

            const remove = messages.getByRole('button', { name: '删除消息', exact: true }).first();
            await remove.click();
            const confirmation = page.getByRole('dialog', { name: '删除消息' });
            await confirmation.waitFor();
            await page.keyboard.press('Escape');
            await confirmation.waitFor({ state: 'hidden' });
            assert.equal(await remove.evaluate(el => document.activeElement === el), true);
            assert.equal(requests.filter(r => r.method === 'DELETE').length, 0);

            await messages.getByRole('button', { name: '禁言', exact: true }).first().click();
            const muteDialog = page.getByRole('dialog', { name: '禁言学号' });
            await muteDialog.getByLabel('禁言时长').selectOption('permanent');
            await muteDialog.getByLabel('禁言原因').fill(payload);
            await muteDialog.getByRole('button', { name: '禁言', exact: true }).click();
            await mutes.getByText(payload, { exact: true }).waitFor();
            const muteRequest = requests.find(r => r.endpoint === '/mutes' && r.method === 'POST');
            assert.deepEqual(muteRequest.body, { username, duration: 'permanent', reason: payload });

            await reports.getByRole('button', { name: '忽略举报', exact: true }).click();
            await reports.getByText('暂无待处理举报', { exact: true }).waitFor();
            await remove.click();
            await confirmation.getByRole('button', { name: '删除消息', exact: true }).click();
            await messages.locator('#admin-chat-messages-list').getByText('已删除', { exact: true }).waitFor();
            await mutes.getByRole('button', { name: '解除禁言', exact: true }).click();
            await page.getByRole('dialog', { name: '解除禁言' }).getByRole('button', { name: '解除禁言' }).click();
            await mutes.getByText('暂无生效中的禁言', { exact: true }).waitFor();

            await tab.getByRole('button', { name: '清空公告', exact: true }).click();
            await tab.getByRole('button', { name: '保存配置', exact: true }).click();
            await page.getByText('聊天室配置已保存', { exact: true }).waitFor();
            const save = requests.find(r => r.endpoint === '/settings' && r.method === 'PUT');
            assert.equal(save.body.if_settings_version, 7);
            assert.equal(save.body.pinned_notice, '');
            activeSettings = { ...activeSettings, pinned_notice: '其他管理员保存的公告', settings_version: 9 };
            await tab.getByLabel('置顶群公告').fill('当前草稿');
            await tab.getByRole('button', { name: '保存配置', exact: true }).click();
            const reload = tab.getByRole('button', { name: '读取最新配置', exact: true });
            await reload.waitFor();
            assert.equal(await tab.getByLabel('置顶群公告').inputValue(), '当前草稿');
            await reload.click();
            await page.waitForFunction(() => document.querySelector('#admin-chat-notice').value === '其他管理员保存的公告');

            const draft = tab.getByLabel('以管理员身份发送群消息');
            const send = tab.getByRole('button', { name: '发送消息', exact: true });
            await draft.fill('请勿公开同学学号。');
            await send.click();
            await tab.getByText('发送暂时失败', { exact: true }).waitFor();
            assert.equal(await draft.inputValue(), '请勿公开同学学号。');
            await send.click();
            await tab.getByText('官方消息已发送', { exact: true }).waitFor();
            const sends = requests.filter(r => r.endpoint === '/messages' && r.method === 'POST');
            assert.equal(sends.length, 2);
            assert.match(sends[0].body.client_msg_id, /^[0-9a-f-]{36}$/);
            assert.deepEqual(sends[0].body, sends[1].body);
            assert.deepEqual(errors, []);
            if (process.env.URP_ADMIN_CHAT_SCREENSHOTS) {
                const output = process.env.URP_ADMIN_CHAT_SCREENSHOTS;
                fs.mkdirSync(output, { recursive: true });
                await page.screenshot({ path: path.join(output, `admin-chat-${width}.png`), fullPage: true });
            }
            await context.close();
            console.log(`PASS admin chat ${theme}/${scheme}/${width}`);
        }
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
