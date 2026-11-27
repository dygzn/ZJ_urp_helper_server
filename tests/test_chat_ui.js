const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const ui = require('../static/js/ui-ux.js');

test('chat visitors receive a login gate and the mobile primary navigation has four entries', () => {
    assert.equal(ui.getGuestAccessCopy('chat').title, '公共聊天室需要登录教务账号');
    const html = readFileSync(new URL('../templates/index.html', 'file://' + __filename), 'utf8');
    const primary = html.match(/<nav id="mobile-bottom-nav"[\s\S]*?<\/nav>/)[0];
    assert.deepEqual(Array.from(primary.matchAll(/data-page="([^"]+)"/g), match => match[1]), ['home', 'schedule', 'grades', 'more']);
});

test('message separators use Beijing days and five-minute intervals', async () => {
    const { chatDateLabel, needsChatDate } = await import('../static/js/modules/chat.js');
    const now = Date.parse('2026-11-27T00:00:00Z');
    assert.equal(chatDateLabel('2026-11-26T15:59:00Z', now), '昨天 23:59');
    assert.equal(chatDateLabel('2026-11-26T16:01:00Z', now), '今天 00:01');
    assert.equal(needsChatDate('2026-11-26T15:59:00Z', '2026-11-26T16:01:00Z'), true);
    assert.equal(needsChatDate('2026-11-26T16:01:00Z', '2026-11-26T16:05:00Z'), false);
    assert.equal(needsChatDate('2026-11-26T16:01:00Z', '2026-11-26T16:06:00Z'), true);
});
