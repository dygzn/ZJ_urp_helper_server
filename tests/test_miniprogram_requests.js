const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadPage(name, responses) {
  const calls = [];
  let page;
  const app = { globalData: {}, updateBinding() {}, navigateToBind() {} };
  const request = async options => {
    calls.push(options);
    if (!Object.hasOwn(responses, options.path)) throw new Error(`未知接口 ${options.path}`);
    return responses[options.path];
  };
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
  return { page, calls };
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
