const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadPage(name, responses) {
  const calls = [];
  let page;
  let app;
  const request = async options => {
    calls.push(options);
    if (!Object.hasOwn(responses, options.path)) throw new Error(`未知接口 ${options.path}`);
    const response = responses[options.path];
    return typeof response === 'function' ? response(options) : response;
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/app.js'), 'utf8'), {
    App: definition => { app = definition; },
    require: module => module.endsWith('auth.js')
      ? { ensureSession: async () => ({}), clearSession() {} } : request,
  });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages', name, 'index.js'), 'utf8'), {
    getApp: () => app,
    Page: definition => { page = definition; },
    require: module => module.endsWith('auth.js') ? { ensureSession: async () => ({}) }
      : module.endsWith('request.js') ? request : require('../miniprogram/utils/format.js'),
    wx: { showToast() {}, stopPullDownRefresh() {}, navigateTo() {}, switchTab() {},
      showModal: options => options.success({ confirm: true }) },
    setTimeout: fn => fn(),
  });
  page.setData = patch => Object.assign(page.data, patch);
  return { page, calls, app };
}

const binding = { success: true, bound: true, username: 'synthetic-student' };
test('home reads the independent WeChat account and urgent event', async () => {
  const { page, calls } = loadPage('home', {
    '/api/wechat/account': binding,
    '/api/wechat/urgent_event': { success: true, event: { type: 'exam' } },
  });
  await page.loadHome();
  assert.equal(page.data.bound, true);
  assert.equal(page.data.urgent.type, 'exam');
  assert.deepEqual(calls.map(call => call.path), ['/api/wechat/account', '/api/wechat/urgent_event']);
});
test('schedule reads and updates through dedicated WeChat endpoints', async () => {
  const { page, calls } = loadPage('schedule', {
    '/api/wechat/account': binding,
    '/api/wechat/schedule': { success: true, data: { semester_start: '', schedule: { 1: [{ 星期: 1, 课程名: '数学', 节次: 1 }] } } },
    '/api/wechat/update_schedule': { success: true },
  });
  await page.loadInitialSchedule();
  assert.equal(page.data.groups[0].courses[0].courseName, '数学');
  await page.loadWeek(1);
  await page.refreshSchedule();
  assert.equal(calls.find(call => call.path === '/api/wechat/update_schedule').method, 'POST');
  assert.equal(page.data.errorMessage, '');
});
test('grades read the existing summary and current grade response shapes', async () => {
  const { page } = loadPage('grades', {
    '/api/wechat/account': binding,
    '/api/wechat/grades/latest_summary': { success: true, semester: '2026秋', passed: [{ course: '数学', score: 90 }], failed: { current: [], past: [] } },
    '/api/wechat/grades/current': { success: true, grades: [{ course: '英语', score: 85 }] },
  });
  await page.loadGrades();
  assert.equal(page.data.summary.passed[0].displayScore, '90');
  assert.equal(page.data.currentGrades[0].displayScore, '85');
});
test('exam refresh preserves the separate exam update operation', async () => {
  const { page, calls } = loadPage('exams', {
    '/api/wechat/account': binding,
    '/api/wechat/exams': { success: true, exams: [{ exam_name: '数学', time: '09:00', location: 'A101' }] },
    '/api/wechat/update_exams': { success: true },
  });
  await page.refreshExams();
  assert.equal(page.data.exams[0].displayLocation, 'A101');
  assert.equal(calls[0].path, '/api/wechat/update_exams');
  assert.equal(calls[0].method, 'POST');
});
test('account rebind deletes only the WeChat association', async () => {
  const { page, calls } = loadPage('account', { '/api/wechat/binding': { success: true, bound: false } });
  page.rebind();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[0].path, '/api/wechat/binding');
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(page.data.rebindLoading, false);
});

test('request keeps actionable 403 and 409 messages and clears only expired sessions', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../miniprogram/utils/request.js'), 'utf8');
  for (const [statusCode, code, message, cleared] of [
    [403, 'MEMBER_REQUIRED', '请前往网页端续费会员', false],
    [409, 'URP_LOGIN_REQUIRED', '请解绑后重新验证学号和密码', false],
    [401, 'WECHAT_SESSION_REQUIRED', '微信登录已失效，请重新登录', true],
  ]) {
    let tokenCleared = false;
    const module = { exports: {} };
    vm.runInNewContext(source, {
      module,
      require: () => ({ tokenStorageKey: 'token', apiBaseUrl: 'https://test.invalid', requestTimeout: 10 }),
      wx: { getStorageSync: () => 'synthetic-token', removeStorageSync: () => { tokenCleared = true; },
        request: options => {
          assert.equal(options.header.Authorization, 'Bearer synthetic-token');
          options.success({ statusCode, data: { success: false, code, message } });
        } },
    });
    await assert.rejects(module.exports({ path: '/api/wechat/grades/current' }), error =>
      error.statusCode === statusCode && error.message === message && error.data.code === code);
    assert.equal(tokenCleared, cleared);
  }
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const account = username => ({ success: true, bound: true, username });
const accountPages = [
  { name: 'grades', load: 'loadGrades', endpoint: '/api/wechat/grades/current',
    payload: name => ({ success: true, grades: [{ course: name, score: '90' }] }),
    read: page => page.data.currentGrades[0]?.course || '',
    extra: { '/api/wechat/grades/latest_summary': { success: true, passed: [], failed: { current: [], past: [] } } } },
  { name: 'schedule', load: 'loadInitialSchedule', endpoint: '/api/wechat/schedule',
    payload: name => ({ success: true, data: { semester_start: '', schedule: { 1: [{ 星期: 1, 课程名: name, 节次: 1 }] } } }),
    read: page => page.data.groups[0]?.courses[0]?.courseName || '', extra: {} },
  { name: 'exams', load: 'loadExams', endpoint: '/api/wechat/exams',
    payload: name => ({ success: true, exams: [{ exam_name: name, time: '09:00' }] }),
    read: page => page.data.exams[0]?.exam_name || '', extra: {} },
];
for (const spec of accountPages) {
  test(`${spec.name}: same Page clears A on unbind and loads B while keeping same-account tab cache`, async () => {
    let username = 'A';
    const responses = { ...spec.extra, '/api/wechat/account': () => account(username), [spec.endpoint]: () => spec.payload(username) };
    const { page, calls, app } = loadPage(spec.name, responses);
    await page[spec.load]();
    assert.equal(spec.read(page), 'A');
    const previousCalls = calls.length;
    page.onShow();
    await settle();
    assert.equal(calls.length, previousCalls, '同账号切Tab应复用缓存');
    app.updateBinding({ bound: false });
    assert.equal(spec.read(page), '', '解绑时立即清除旧账号显示');
    assert.equal(page.data.bound, false);
    username = 'B';
    app.updateBinding(account('B'));
    page.onShow();
    await settle();
    assert.equal(spec.read(page), 'B');
    assert.equal(app.globalData.username, 'B');
    assert.ok(calls.length > previousCalls);
  });
  test(`${spec.name}: late A account response cannot restore A after B binds`, async () => {
    const oldAccount = deferred();
    let first = true;
    const responses = { ...spec.extra,
      '/api/wechat/account': () => first ? (first = false, oldAccount.promise) : account('B'),
      [spec.endpoint]: spec.payload('B') };
    const { page, app } = loadPage(spec.name, responses);
    app.updateBinding(account('A'));
    const oldLoad = page[spec.load]();
    await settle();
    app.updateBinding({ bound: false });
    app.updateBinding(account('B'));
    page.onShow();
    await settle();
    assert.equal(spec.read(page), 'B');
    oldAccount.resolve(account('A'));
    await oldLoad;
    assert.equal(app.globalData.username, 'B');
    assert.equal(spec.read(page), 'B');
  });
  for (const fails of [false, true]) {
    test(`${spec.name}: late A business ${fails ? 'failure' : 'response'} cannot overwrite B`, async () => {
      const oldBusiness = deferred();
      let username = 'A';
      const responses = { ...spec.extra, '/api/wechat/account': () => account(username),
        [spec.endpoint]: () => username === 'A' ? oldBusiness.promise : spec.payload('B') };
      const { page, app } = loadPage(spec.name, responses);
      const oldLoad = page[spec.load]();
      await settle();
      app.updateBinding({ bound: false });
      username = 'B';
      app.updateBinding(account('B'));
      page.onShow();
      await settle();
      assert.equal(spec.read(page), 'B');
      if (fails) oldBusiness.reject({ message: 'A的过期错误' });
      else oldBusiness.resolve(spec.payload('A'));
      await oldLoad;
      assert.equal(spec.read(page), 'B');
      assert.equal(page.data.errorMessage, '');
      assert.equal(app.globalData.username, 'B');
    });
  }
}
test('schedule keeps selected week when returning to the same-account tab and ignores an older week response', async () => {
  const oldWeek = deferred();
  const responses = { '/api/wechat/account': account('A'),
    '/api/wechat/schedule': options => options.data?.week === 2 ? oldWeek.promise
      : { success: true, data: { semester_start: '', schedule: { [options.data?.week || 1]: [{ 星期: 1, 课程名: `week-${options.data?.week || 1}`, 节次: 1 }] } } } };
  const { page, calls } = loadPage('schedule', responses);
  await page.loadInitialSchedule();
  const oldLoad = page.loadWeek(2);
  await page.loadWeek(3);
  oldWeek.resolve({ success: true, data: { schedule: { 2: [{ 星期: 1, 课程名: 'week-2', 节次: 1 }] } } });
  await oldLoad;
  assert.equal(page.data.week, 3);
  assert.equal(page.data.groups[0].courses[0].courseName, 'week-3');
  const count = calls.length;
  page.onShow();
  await settle();
  assert.equal(page.data.week, 3);
  assert.equal(calls.length, count);
});

for (const name of ['home', 'account']) {
  test(`${name}: a late account lookup cannot restore A after B binds`, async () => {
    const oldAccount = deferred();
    let first = true;
    const responses = {
      '/api/wechat/account': () => first ? (first = false, oldAccount.promise) : account('B'),
      '/api/wechat/urgent_event': { success: true, event: { owner: 'B' } },
    };
    const { page, app } = loadPage(name, responses);
    app.updateBinding(account('A'));
    const load = name === 'home' ? 'loadHome' : 'loadBinding';
    const oldLoad = page[load]();
    await settle();
    app.updateBinding({ bound: false });
    assert.equal(page.data.username, '');
    app.updateBinding(account('B'));
    await page[load]();
    oldAccount.resolve(account('A'));
    await oldLoad;
    assert.equal(app.globalData.username, 'B');
    assert.equal(page.data.username, 'B');
  });
}
test('bootstrap cannot restore A after a later unbind and B binding', async () => {
  const oldAccount = deferred();
  const { app } = loadPage('home', { '/api/wechat/account': oldAccount.promise });
  app.updateBinding(account('A'));
  const startup = app.bootstrapSession();
  await settle();
  app.updateBinding({ bound: false });
  app.updateBinding(account('B'));
  oldAccount.resolve(account('A'));
  await startup;
  assert.equal(app.globalData.username, 'B');
  assert.equal(app.globalData.bound, true);
});
test('home ignores A urgent payload after B binds and clears it at unbind', async () => {
  let username = 'A';
  const oldUrgent = deferred();
  const { page, app } = loadPage('home', {
    '/api/wechat/account': () => account(username),
    '/api/wechat/urgent_event': () => username === 'A' ? oldUrgent.promise : { success: true, event: { owner: 'B' } },
  });
  const oldLoad = page.loadHome();
  await settle();
  app.updateBinding({ bound: false });
  assert.equal(page.data.urgent, null);
  username = 'B';
  app.updateBinding(account('B'));
  await page.loadHome();
  oldUrgent.resolve({ success: true, event: { owner: 'A' } });
  await oldLoad;
  assert.equal(page.data.urgent.owner, 'B');
});
test('initial bootstrap and page lookup race still loads the established account', async () => {
  const bootAccount = deferred();
  const pageAccount = deferred();
  let count = 0;
  const { page, app } = loadPage('home', {
    '/api/wechat/account': () => ++count === 1 ? bootAccount.promise : count === 2 ? pageAccount.promise : account('A'),
    '/api/wechat/urgent_event': { success: true, event: { owner: 'A' } },
  });
  const boot = app.bootstrapSession();
  await settle();
  const load = page.loadHome();
  await settle();
  bootAccount.resolve(account('A'));
  await boot;
  pageAccount.resolve(account('A'));
  await load;
  await settle();
  assert.equal(app.globalData.username, 'A');
  assert.equal(page.data.urgent.owner, 'A');
});
for (const spec of accountPages.filter(item => item.name !== 'grades')) {
  test(`${spec.name}: late A update cannot launch a reload after B has loaded`, async () => {
    let username = 'A';
    const oldUpdate = deferred();
    const update = spec.name === 'schedule' ? 'refreshSchedule' : 'refreshExams';
    const endpoint = spec.name === 'schedule' ? '/api/wechat/update_schedule' : '/api/wechat/update_exams';
    const { page, calls, app } = loadPage(spec.name, {
      '/api/wechat/account': () => account(username),
      [spec.endpoint]: () => spec.payload(username),
      [endpoint]: oldUpdate.promise,
    });
    await page[spec.load]();
    const pending = page[update]();
    await settle();
    app.updateBinding({ bound: false });
    username = 'B';
    app.updateBinding(account('B'));
    await page[spec.load]();
    const count = calls.length;
    oldUpdate.resolve({ success: true });
    await pending;
    assert.equal(calls.length, count);
    assert.equal(spec.read(page), 'B');
    assert.equal(page.data.updating, false);
  });
}
