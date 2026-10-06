const { readAppSource } = require('./helpers/app-source');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { installApi } = require('./helpers/browser-api');

test('unchecked login opens normal pages and clears the tab after ten minutes', async () => {
    const nodes = new Map();
    const saved = new Map();
    const timers = [];
    let reloads = 0;
    let openedPage = null;
    const document = {
        addEventListener() {},
        getElementById(id) { return nodes.get(id) || null; },
    };
    nodes.set('username', { value: 'student' });
    nodes.set('password', { value: 'secret' });
    nodes.set('bind-account', { checked: false });
    nodes.set('login-error', { textContent: '' });
    nodes.set('sidebar-username', { textContent: '' });
    const context = vm.createContext({
        document, console, TextEncoder,
        localStorage: {
            getItem: key => saved.get(key) || null,
            setItem: (key, value) => saved.set(key, value),
            removeItem: key => saved.delete(key),
        },
        window: { location: { reload() { reloads++; } } },
        setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
        clearTimeout() {},
        fetch: async () => ({ json: async () => ({
            success: true, bound: false, temporary: true,
            username: 'student', expires_at: Math.floor(Date.now() / 1000) + 600,
        }) }),
    });
    installApi(context);
    vm.runInContext(readAppSource(), context);
    context.getDeviceId = () => 'device';
    context.hideLoginModal = () => {};
    context.getAvailablePageNames = () => ['home', 'schedule'];
    context.switchPage = page => { openedPage = page; };
    context.showUiToast = () => {};

    await context.handleLogin({ preventDefault() {} });

    assert.equal(vm.runInContext('isGuestMode', context), false);
    assert.equal(vm.runInContext('currentUsername', context), 'student');
    assert.equal(openedPage, 'home');
    assert.equal(nodes.get('sidebar-username').textContent, 'student · 临时');
    assert.equal(nodes.get('password').value, '');
    assert.equal(saved.has('urp_bound_username'), false);
    assert.equal(timers.length, 1);
    assert.ok(timers[0].delay > 590000 && timers[0].delay <= 600050);
    timers[0].callback();
    assert.equal(reloads, 1);

    let loginPrompts = 0;
    const statusDot = { className: '' };
    const statusText = { textContent: '' };
    document.querySelector = selector => selector === '.status-dot' ? statusDot : statusText;
    context.showLoginModal = () => { loginPrompts++; };
    context.fetch = async () => ({ json: async () => ({
        success: true, logged_in: false, requires_relogin: true,
        message: '登录已失效，请重新输入学号和密码。',
    }) });
    await context.checkLoginStatus();
    await context.checkLoginStatus();
    assert.equal(loginPrompts, 1);
    assert.equal(nodes.get('login-error').textContent, '登录已失效，请重新输入学号和密码。');
});
