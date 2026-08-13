const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const mainSource = fs.readFileSync(
    path.join(__dirname, '..', 'static', 'js', 'main.js'),
    'utf8',
);

function makeClassList(initialClasses = []) {
    const classes = new Set(initialClasses);
    return {
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
        contains(name) { return classes.has(name); },
    };
}

function createNavigationHarness({ search = '', storedPage = null } = {}) {
    const homePage = { classList: makeClassList(['active']) };
    const schedulePage = { classList: makeClassList() };
    const pageTitle = { textContent: '' };
    const sidebarUsername = { textContent: '' };
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
        },
        window: { location: { search } },
    };

    vm.createContext(context);
    vm.runInContext(mainSource, context, { filename: 'static/js/main.js' });
    context.loadPageData = pageName => loadedPages.push(pageName);

    return {
        context,
        homePage,
        schedulePage,
        pageTitle,
        homeNav,
        scheduleNav,
        storage,
        loadedPages,
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
