const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup() {
  const source = fs.readFileSync('static/js/admin.js', 'utf8');
  const timers = new Map(), elements = new Map();
  let next = 0, calls = 0, release;
  const ctx = vm.createContext({
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { textContent: '' });
      return elements.get(id);
    } },
    AbortController, adminKey: 'test',
    setTimeout(f, ms) { timers.set(++next, {f, ms}); return next; },
    clearTimeout: id => timers.delete(id),
    fetch(url, options) {
      assert.equal(url, '/api/admin/activity/today');
      assert.equal(options.headers['X-Admin-Key'], 'test');
      calls++;
      return new Promise(resolve => { release = payload => resolve({ok: true, json: async () => payload}); });
    },
  });
  vm.runInContext(source.slice(source.indexOf('let activityPending ='), source.indexOf('// ==================== 会员管理')), ctx);
  return { ctx, timers, elements, get calls() { return calls; }, release: payload => release(payload) };
}

test('activity refresh merges duplicate clicks and leaves no polling timer', async () => {
  const s = setup();
  const first = s.ctx.loadTodayActivity(), second = s.ctx.loadTodayActivity();
  assert.equal(s.calls, 1);
  assert.equal(s.elements.get('today-activity-status').textContent, '加载中...');
  s.release({success: true, data: {date: '2026-10-25', active_users: 23}});
  await Promise.all([first, second]);
  assert.equal(s.elements.get('today-active-count').textContent, 23);
  assert.match(s.elements.get('today-activity-status').textContent, /2026-10-25/);
  assert.equal(s.timers.size, 0);
  const refreshed = s.ctx.loadTodayActivity();
  s.release({success: true, data: {date: '2026-10-26', active_users: 0}});
  await refreshed;
  assert.equal(s.calls, 2);
  assert.equal(s.elements.get('today-active-count').textContent, 0);
  assert.equal(s.timers.size, 0);
});

test('activity failure shows retry guidance and does not schedule retries', async () => {
  const s = setup();
  s.ctx.fetch = async () => { throw new Error('offline'); };
  await s.ctx.loadTodayActivity();
  assert.equal(s.elements.get('today-active-count').textContent, '-');
  assert.match(s.elements.get('today-activity-status').textContent, /加载失败.*刷新/);
  assert.equal(s.timers.size, 0);
});
