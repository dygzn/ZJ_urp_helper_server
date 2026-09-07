const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const mainSource = fs.readFileSync(
    path.join(__dirname, '..', 'static', 'js', 'main.js'),
    'utf8',
);
const URPUI = require('../static/js/ui-ux.js');

function makeClassList(initialClasses = []) {
    const classes = new Set(initialClasses);
    return {
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
        toggle(name, force) {
            const shouldAdd = typeof force === 'boolean' ? force : !classes.has(name);
            if (shouldAdd) classes.add(name);
            else classes.delete(name);
            return shouldAdd;
        },
        contains(name) { return classes.has(name); },
    };
}

function createNavigationHarness({ search = '', storedPage = null, loginSuccess = false } = {}) {
    const homePage = { classList: makeClassList(['active']) };
    const scheduleGate = { hidden: true, innerHTML: '' };
    const schedulePage = {
        classList: makeClassList(),
        innerHTML: '<div id="schedule-sentinel">保留当前页面内容</div>',
        querySelector(selector) {
            return selector === '[data-page-access-gate]' ? scheduleGate : null;
        },
    };
    const pageTitle = { textContent: '' };
    const sidebarUsername = { textContent: '' };
    const loginModal = { classList: makeClassList() };
    const homeNav = {
        classList: makeClassList(['active']),
        getAttribute(name) { return name === 'data-page' ? 'home' : null; },
    };
    const scheduleNav = {
        classList: makeClassList(),
        getAttribute(name) { return name === 'data-page' ? 'schedule' : null; },
    };
    const elements = {
        'page-home': homePage,
        'page-schedule': schedulePage,
        'page-title': pageTitle,
        'sidebar-username': sidebarUsername,
        'login-modal': loginModal,
        username: { value: 'student' },
        password: { value: 'password' },
        'login-error': { textContent: '' },
    };
    const storage = new Map();
    storage.set('device_id', 'test-device');
    if (storedPage !== null) storage.set('current_page', storedPage);
    const loadedPages = [];

    const context = {
        URLSearchParams,
        console,
        document: {
            addEventListener() {},
            getElementById(id) { return elements[id] || null; },
            querySelector() { return null; },
            querySelectorAll(selector) {
                if (selector === '.page') return [homePage, schedulePage];
                if (selector === '.nav-item') return [homeNav, scheduleNav];
                return [];
            },
        },
        fetch: async url => {
            if (url === '/api/announcements') {
                return { json: async () => ({ success: true, announcements: [] }) };
            }
            if (url === '/api/invitation/link') {
                return { ok: false, json: async () => ({ success: false }) };
            }
            if (url === '/api/login') {
                assert.equal(loginSuccess, true);
                return {
                    json: async () => ({ success: true, username: 'student' }),
                };
            }
            assert.equal(url, '/api/check_bind');
            return {
                json: async () => ({
                    success: true,
                    bound: true,
                    username: 'student',
                    rebind_notifications: [],
                }),
            };
        },
        localStorage: {
            getItem(key) { return storage.has(key) ? storage.get(key) : null; },
            setItem(key, value) { storage.set(key, value); },
            removeItem(key) { storage.delete(key); },
        },
        URPUI,
        window: { location: { search } },
    };

    vm.createContext(context);
    vm.runInContext(mainSource, context, { filename: 'static/js/main.js' });
    const realLoadPageData = context.loadPageData;
    context.loadPageData = pageName => loadedPages.push(pageName);

    return {
        context,
        homePage,
        schedulePage,
        pageTitle,
        homeNav,
        scheduleNav,
        scheduleGate,
        loginModal,
        storage,
        loadedPages,
        realLoadPageData,
    };
}

function assertHomeFallback(harness) {
    assert.equal(harness.homePage.classList.contains('active'), true);
    assert.equal(harness.schedulePage.classList.contains('active'), false);
    assert.equal(harness.pageTitle.textContent, '首页');
    assert.equal(harness.homeNav.classList.contains('active'), true);
    assert.equal(harness.scheduleNav.classList.contains('active'), false);
    assert.equal(harness.storage.get('current_page'), 'home');
    assert.deepEqual(harness.loadedPages, ['home']);
}

test('switchPage 对任意不存在的页面目标统一回退首页', () => {
    const harness = createNavigationHarness();

    harness.context.switchPage('removed-or-unknown-page');

    assertHomeFallback(harness);
});

test('绑定恢复遇到旧 localStorage 问卷页面状态时回退首页', async () => {
    const harness = createNavigationHarness({ storedPage: 'surveys' });

    await harness.context.checkBindStatus();

    assertHomeFallback(harness);
});

test('绑定恢复遇到旧 URL 问卷页面状态时回退首页', async () => {
    const harness = createNavigationHarness({
        search: '?page=surveys',
        storedPage: 'schedule',
    });

    await harness.context.checkBindStatus();

    assertHomeFallback(harness);
});

test('绑定恢复后保存学号供广告复制事件直接提交', async () => {
    const harness = createNavigationHarness();

    await harness.context.checkBindStatus();

    assert.equal(harness.storage.get('urp_bound_username'), 'student');
});

test('访客切换受限页面保留原内容并显示绑定提示', () => {
    const harness = createNavigationHarness();

    harness.context.skipBind();
    harness.realLoadPageData('schedule');

    assert.match(harness.schedulePage.innerHTML, /schedule-sentinel/);
    assert.equal(harness.schedulePage.classList.contains('is-access-locked'), true);
    assert.equal(harness.scheduleGate.hidden, false);
    assert.match(harness.scheduleGate.innerHTML, /立即绑定/);
});

test('登录成功后恢复用户登录前所在页面', async () => {
    const harness = createNavigationHarness({ storedPage: 'schedule', loginSuccess: true });
    const switchedPages = [];
    let urgentEventLoads = 0;
    harness.context.switchPage = pageName => switchedPages.push(pageName);
    harness.context.loadUrgentEvent = () => { urgentEventLoads += 1; };

    await harness.context.handleLogin({ preventDefault() {} });

    assert.deepEqual(switchedPages, ['schedule']);
    assert.equal(urgentEventLoads, 0);
});
