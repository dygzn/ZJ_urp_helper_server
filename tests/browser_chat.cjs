const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const python = process.env.URP_PYTHON || path.join(root, '.venv/bin/python');
const render = enabled => execFileSync(python, ['-c', `
from jinja2 import Environment, FileSystemLoader
env = Environment(loader=FileSystemLoader('templates'), autoescape=True)
env.globals['static_versioned'] = lambda file: '/static/' + file
print(env.get_template('index.html').render(ad={'enabled': False}, chat_enabled=${enabled ? 'True' : 'False'}))
`], { cwd: root, encoding: 'utf8' });

(async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
        const enabled = render(true);
        const disabled = render(false);
        const calls = [];
        const errors = [];
        let guest = true;
        let open = true;
        let nextMessage = 2;
        let rejectedSubmission;
        const hostile = '<img src=x onerror=window.chatUnsafe=true>';
        const settings = { enabled: true, readonly: false, pinned_notice: '请保护个人信息。', max_length: 500, max_lines: 12, cooldown_seconds: 3, recall_seconds: 120 };
        const viewer = { show_student_id: false, display_name: '23级 同学#ABCD', viewer_key: 'private-test-key', mute: { active: false } };
        const message = (id, content, isOwn = false) => ({
            id, status: 'normal', author: { role: 'user', display_name: isOwn ? viewer.display_name : '24级 同学#CAFE' },
            is_own: isOwn, content, create_time: new Date().toISOString(), reply_to: null,
        });
        const response = (messages = [message(1, hostile)]) => ({
            messages, next_before_id: messages[0]?.id ?? null, next_after_id: messages.at(-1)?.id ?? 1,
            latest_id: messages.at(-1)?.id ?? 1, has_older: false, has_more: false,
            settings_version: 1, history_version: 1, server_time: new Date().toISOString(), mute: viewer.mute,
        });
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', route => {
            const request = route.request();
            const url = new URL(request.url());
            if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: open ? enabled : disabled });
            if (url.pathname.startsWith('/static/')) return route.fulfill({ path: path.join(root, url.pathname) });
            if (!url.pathname.startsWith('/api/')) return route.fulfill({ status: 204 });
            calls.push(url.pathname);
            const ok = data => route.fulfill({ json: { success: true, data } });
            if (url.pathname === '/api/check_bind') return route.fulfill({ json: { success: true, bound: !guest, username: 'fixture' } });
            if (url.pathname === '/api/announcements') return route.fulfill({ json: { success: true, announcements: [{ id: 1, is_read: false }] } });
            if (url.pathname === '/api/chat/bootstrap') return ok({ ...response(), settings, viewer, context: 'fixture-context' });
            if (url.pathname === '/api/chat/unread') return ok({ enabled: true, latest_id: 1, viewer_key: viewer.viewer_key });
            if (url.pathname === '/api/chat/messages') {
                assert.equal(request.headers()['x-chat-context'], 'fixture-context');
                if (request.method() === 'POST') {
                    const data = request.postDataJSON();
                    assert.match(data.client_msg_id, /^[\da-f-]{36}$/);
                    if (!rejectedSubmission) {
                        rejectedSubmission = data;
                        return route.fulfill({ status: 503, json: { success: false, message: '短暂断开连接' } });
                    }
                    assert.deepEqual(data, rejectedSubmission);
                    return ok({ message: message(nextMessage++, data.content, true), history_version: 1 });
                }
                return ok(response(url.searchParams.has('after_id') ? [] : undefined));
            }
            return route.fulfill({ json: { success: true, data: {}, event: null, exams: [] } });
        });
        await page.goto('http://urp.test/');
        await page.locator('#login-modal.active').waitFor();
        await page.evaluate(() => URP.auth.skipBind());
        assert.equal(await page.locator('#mobile-bottom-nav .nav-item').count(), 4);
        await page.locator('#mobile-nav-more').click();
        await page.locator('#more-chat-entry').click();
        await page.getByText('公共聊天室需要登录教务账号').waitFor();
        assert.equal(calls.some(name => name.startsWith('/api/chat/')), false);
        await page.getByRole('button', { name: '返回更多' }).click();
        assert.equal(await page.evaluate(() => document.activeElement.id), 'more-chat-entry');

        guest = false;
        await page.goto('http://urp.test/');
        await page.waitForFunction(() => !URP.store.getState().isGuestMode);
        await page.locator('#mobile-nav-more').click();
        await page.waitForFunction(() => document.querySelector('#mobile-nav-more').getAttribute('aria-label').includes('聊天室有新消息'));
        assert.match(await page.locator('#mobile-nav-more').getAttribute('aria-label'), /未读公告/);
        await page.locator('#more-chat-entry').click();
        await page.getByText(hostile, { exact: true }).waitFor();
        assert.equal(await page.locator('#page-chat img').count(), 0);
        assert.equal(await page.evaluate(() => Boolean(window.chatUnsafe)), false);
        await page.getByRole('textbox', { name: '输入消息' }).fill('收到，谢谢！');
        await page.getByRole('button', { name: '发送', exact: true }).click();
        await page.getByText('短暂断开连接').waitFor();
        assert.match(await page.locator('.chat-outgoing').innerText(), /发送失败/);
        assert.equal(await page.locator('#chat-content').inputValue(), '收到，谢谢！');
        await page.getByRole('button', { name: '重试', exact: true }).click();
        await page.locator('[data-message-id="2"]').getByText('收到，谢谢！', { exact: true }).waitFor();
        assert.equal(await page.locator('.chat-outgoing').count(), 0);
        assert.equal(await page.locator('#mobile-nav-more').getAttribute('aria-current'), 'true');
        assert.match(await page.locator('#mobile-nav-more').getAttribute('aria-label'), /未读公告/);
        assert.doesNotMatch(await page.locator('#mobile-nav-more').getAttribute('aria-label'), /聊天室有新消息/);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (process.env.CHAT_SCREENSHOT) {
            fs.mkdirSync(path.dirname(process.env.CHAT_SCREENSHOT), { recursive: true });
            await page.screenshot({ path: process.env.CHAT_SCREENSHOT });
        }
        await page.setViewportSize({ width: 1200, height: 900 });
        assert.equal(await page.locator('#desktop-nav-more .desktop-menu-items > :first-child').getAttribute('data-page'), 'chat');
        assert.ok(await page.locator('#desktop-nav-more').evaluate(el => el.classList.contains('has-active-child')));
        for (const width of [320, 768, 769, 1099, 1100, 1200]) {
            await page.setViewportSize({ width, height: 844 });
            for (const theme of ['workspace', 'glass', 'paper', 'garden', 'clay']) {
                for (const scheme of ['light', 'dark']) {
                    const metrics = await page.evaluate(({ theme, scheme }) => {
                        document.documentElement.dataset.uiTemplate = theme;
                        document.documentElement.dataset.colorScheme = scheme;
                        const style = getComputedStyle(document.querySelector('.is-own .chat-bubble'));
                        const linear = value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
                        const luminance = color => color.match(/[\d.]+/g).slice(0, 3)
                            .map(value => linear(Number(value) / 255))
                            .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
                        const luminances = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => a - b);
                        const feed = document.getElementById('chat-feed');
                        return {
                            contrast: (luminances[1] + 0.05) / (luminances[0] + 0.05),
                            overflow: document.documentElement.scrollWidth > innerWidth || feed.scrollWidth > feed.clientWidth,
                        };
                    }, { theme, scheme });
                    assert.equal(metrics.overflow, false, `${width}/${theme}/${scheme} overflows`);
                    assert.ok(metrics.contrast >= 4.5, `${width}/${theme}/${scheme} contrast is ${metrics.contrast}`);
                }
            }
        }
        await page.evaluate(() => {
            localStorage.setItem('urp_bound_username', 'other-tab-binding');
            window.dispatchEvent(new StorageEvent('storage', { key: 'urp_chat_session_change', newValue: 'new-generation' }));
        });
        await page.locator('#login-modal.active').waitFor();
        assert.equal(await page.locator('#chat-messages > li').count(), 0);
        assert.equal(await page.evaluate(() => localStorage.getItem('urp_bound_username')), 'other-tab-binding');
        open = false;
        await page.goto('http://urp.test/');
        assert.equal(await page.locator('#page-chat, [data-page="chat"]').count(), 0);
        assert.deepEqual(errors, []);
        console.log('聊天室入口、门控、消息转义、发送和未读联动通过');
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
