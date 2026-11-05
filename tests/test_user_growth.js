const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('static/js/admin.js', 'utf8');

function page(stats, clock = '2026-10-24T17:00:00Z') {
  const elements = new Map();
  const timers = new Map(), events = {};
  let elapsed = 0, nextTimer = 0;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [Date.parse(clock) + elapsed])); }
    static now() { return Date.parse(clock) + elapsed; }
  }
  const context = vm.createContext({
    Date: Clock, Intl, AbortController, adminKey: 'test',
    setTimeout(callback, delay) { timers.set(++nextTimer, {callback, delay, due: elapsed + delay}); return nextTimer; },
    clearTimeout: id => timers.delete(id),
    escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    document: {visibilityState: 'visible', addEventListener: (name, callback) => {events[name] = callback;}, getElementById(id) {
      if (!elements.has(id)) elements.set(id, {innerHTML: '', textContent: '', classList: {contains: () => id === 'tab-users'}});
      return elements.get(id);
    }},
    userStatsData: stats, userChartMode: 'new',
  });
  const start = source.indexOf('let userChartMode =');
  vm.runInContext(source.slice(start, source.indexOf('async function loadAdStats()', start)), context);
  const renderStart = source.indexOf('function renderUserDashboard()');
  vm.runInContext(source.slice(renderStart, source.indexOf('// ==================== 系统配置管理', renderStart)), context);
  return {context, elements, timers, events, html: () => elements.get('users-list').innerHTML,
    async advance(milliseconds) {
      elapsed += milliseconds;
      const due = [...timers.entries()].filter(([, timer]) => timer.due <= elapsed);
      for (const [id, timer] of due) {
        timers.delete(id);
        await timer.callback();
      }
    },
  };
}

function stats() {
  return {success: true, date: '2026-10-25', generated_at: '2026-10-25T01:00:00+08:00',
    total: 16, classes: [], daily: [
      {date: '2026-09-25', count: 2, total: 2},
      {date: '2026-09-26', count: 3, total: 5},
      {date: '2026-10-10', count: 4, total: 9},
      {date: '2026-10-18', count: 1, total: 10},
      {date: '2026-10-19', count: 2, total: 12},
      {date: '2026-10-25', count: 4, total: 16},
    ]};
}

test('growth uses the server Beijing date and includes exactly 7/30 calendar days', () => {
  // 浏览器时钟故意停在前一天；服务端日期才是本次统计的日期。
  const s = page(stats());
  s.context.renderUserDashboard();
  const values = [...s.html().matchAll(/ud-card-value">([^<]+)/g)].map(match => match[1]);
  assert.deepEqual(values, ['16', '+4', '+6', '+14']);
  const dates = [...s.html().matchAll(/ud-col-date">([^<]+)/g)].map(match => match[1]);
  assert.equal(dates.length, 14);
  assert.equal(dates[0], '10/12');
  assert.equal(dates.at(-1), '10/25');
});

test('grade pie chart shows user counts and membership rates without major details', () => {
  const s = page({...stats(), membership_rates: {
    total: {users: 16, members: 3},
    grades: [{grade: '2023', users: 4, members: 1}, {grade: null, users: 1, members: 0}],
    majors: [{major: '011', users: 4, members: 1}],
    grade_majors: [{grade: '2023', major: '011', users: 4, members: 1}],
  }});
  s.context.renderUserDashboard();
  assert.match(s.html(), /年级人数分布/);
  assert.match(s.html(), /conic-gradient/);
  assert.match(s.html(), /2023 级/);
  assert.match(s.html(), /1\s*\/\s*4/);
  assert.match(s.html(), /25\.0%/);
  assert.match(s.html(), /未识别/);
  assert.doesNotMatch(s.html(), /按专业|专业 011|总会员率/);
  assert.match(s.html(), /增长趋势/);
});

test('membership growth compares the last seven days with the preceding seven days', () => {
  const s = page({...stats(), membership_growth: {current: 6, previous: 4, rate: 50}});
  s.context.renderUserDashboard();
  assert.match(s.html(), /会员增长率/);
  assert.match(s.html(), /\+50\.0%/);
  assert.match(s.html(), /近 7 日.*6 人/s);
  assert.match(s.html(), /前 7 日.*4 人/s);
  const noBaseline = page({...stats(), membership_growth: {current: 3, previous: 0, rate: null}});
  noBaseline.context.renderUserDashboard();
  assert.match(noBaseline.html(), /前 7 日为 0，无法计算/);
});

test('cumulative growth carries all registrations before the chart even across empty days', () => {
  const s = page(stats(), '2026-10-25T04:00:00Z');
  s.context.switchChartMode('total');
  const labels = [...s.html().matchAll(/font-size="12">([^<]+)/g)].map(match => match[1]).slice(-14);
  assert.deepEqual(labels, ['9','9','9','9','9','9','10','12','12','12','12','12','12','16']);
});

test('refresh merges pending requests, bypasses cache and updates the displayed snapshot time', async () => {
  const s = page(null);
  const requests = [];
  s.context.fetch = (url, options) => new Promise(resolve => {
    requests.push({url, options, resolve});
  });
  const first = s.context.loadUsers();
  const repeated = s.context.loadUsers();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/admin/users');
  assert.equal(requests[0].options.cache, 'no-store');
  assert.equal(requests[0].options.headers['X-Admin-Key'], 'test');
  requests[0].resolve({ok: true, text: async () => JSON.stringify(stats())});
  await Promise.all([first, repeated]);
  assert.match(s.elements.get('users-stats-status').textContent, /2026.*10.*25.*01:00:00/);
  const refreshed = s.context.loadUsers();
  assert.equal(requests.length, 2);
  requests[1].resolve({ok: true, text: async () => JSON.stringify({...stats(), total: 17, generated_at: '2026-10-25T01:02:00+08:00'})});
  await refreshed;
  assert.match(s.html(), /ud-card-value">17</);
  assert.match(s.elements.get('users-stats-status').textContent, /01:02:00/);
});

test('failed refresh releases the request and can be retried', async () => {
  const s = page(null);
  s.context.fetch = async () => { throw new Error('offline'); };
  await s.context.loadUsers();
  assert.match(s.html(), /offline/);
  s.context.fetch = async () => ({ok: true, text: async () => JSON.stringify(stats())});
  await s.context.loadUsers();
  assert.match(s.html(), /ud-card-value">16</);
});

test('23:59 daily additions reset at Beijing midnight with one refresh instead of polling', async () => {
  const s = page(null, '2031-01-01T00:00:00Z'); // 客户端时钟不能影响换日。
  let calls = 0;
  s.context.fetch = async () => ({ok: true, text: async () => JSON.stringify({
    ...stats(), total: 10, daily: [{date: '2026-10-25', count: 10, total: 10}],
    date: ++calls === 1 ? '2026-10-25' : '2026-10-26',
    generated_at: calls === 1 ? '2026-10-25T23:59:59+08:00' : '2026-10-26T00:00:00+08:00',
  })});
  await s.context.loadUsers();
  assert.deepEqual([...s.html().matchAll(/ud-card-value">([^<]+)/g)].map(m => m[1]), ['10', '+10', '+10', '+10']);
  assert.deepEqual([...s.timers.values()].map(t => t.delay), [1000]);
  await s.advance(1000);
  assert.equal(calls, 2);
  assert.deepEqual([...s.html().matchAll(/ud-card-value">([^<]+)/g)].map(m => m[1]), ['10', '+0', '+10', '+10']);
  assert.deepEqual([...s.timers.values()].map(t => t.delay), [86400000]);
});

test('hidden pages stop the rollover timer and refresh once on return after midnight', async () => {
  const s = page(null);
  let calls = 0;
  s.context.fetch = async () => ({ok: true, text: async () => JSON.stringify({
    ...stats(), date: ++calls === 1 ? '2026-10-25' : '2026-10-26',
    generated_at: calls === 1 ? '2026-10-25T23:59:59+08:00' : '2026-10-26T00:00:01+08:00',
  })});
  await s.context.loadUsers();
  s.context.document.visibilityState = 'hidden';
  s.events.visibilitychange();
  assert.equal(s.timers.size, 0);
  await s.advance(2000);
  assert.equal(calls, 1);
  s.context.document.visibilityState = 'visible';
  s.events.visibilitychange();
  await s.context.loadUsers();
  assert.equal(calls, 2);
  s.events.visibilitychange();
  assert.equal(calls, 2);
  assert.equal(s.timers.size, 1);
});

test('a failed midnight refresh leaves no automatic retry loop', async () => {
  const s = page(null);
  let calls = 0;
  s.context.fetch = async () => {
    calls++;
    if (calls > 1) throw new Error('offline');
    return {ok: true, text: async () => JSON.stringify({...stats(), generated_at: '2026-10-25T23:59:59+08:00'})};
  };
  await s.context.loadUsers();
  await s.advance(1000);
  assert.equal(calls, 2);
  assert.equal(s.timers.size, 0);
  await s.advance(86400000);
  assert.equal(calls, 2);
  assert.match(s.elements.get('users-stats-status').textContent, /刷新失败/);
});
