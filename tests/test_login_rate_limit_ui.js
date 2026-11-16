const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { readAppSource } = require('./helpers/app-source');

test('web login shows the 429 wait message, preserves credentials and does not retry automatically', async () => {
    const nodes = new Map([
        ['username', { value: 'student' }], ['password', { value: 'private-password' }],
        ['bind-account', { checked: true }], ['login-error', { textContent: '' }],
    ]);
    let requests = 0;
    const context = vm.createContext({
        Headers, AbortController, DOMException, setTimeout, clearTimeout,
        document: { addEventListener() {}, getElementById: id => nodes.get(id) || null },
        window: {}, console,
        localStorage: { getItem: () => 'existing-device' },
        fetch: async () => {
            requests++;
            return new Response(JSON.stringify({
                success: false, code: 'LOGIN_RATE_LIMITED', retry_after: 30,
                message: '登录尝试较频繁，请等待 30 秒后重试。',
            }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '30' } });
        },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/js/api.js'), 'utf8'), context);
    vm.runInContext(readAppSource(['auth']), context);
    await context.handleLogin({ preventDefault() {} });
    assert.equal(nodes.get('login-error').textContent, '登录尝试较频繁，请等待 30 秒后重试。');
    assert.equal(nodes.get('username').value, 'student');
    assert.equal(nodes.get('password').value, 'private-password');
    assert.equal(requests, 1);
});

test('mini program preserves the authenticated session and readable wait message on 429', async () => {
    const filename = path.join(__dirname, '../miniprogram/utils/request.js');
    let requests = 0;
    let cleared = false;
    const context = vm.createContext({
        module: { exports: {} }, require: createRequire(filename),
        wx: {
            getStorageSync: () => 'existing-session',
            removeStorageSync: () => { cleared = true; },
            request(options) {
                requests++;
                options.success({ statusCode: 429, data: {
                    success: false, code: 'LOGIN_RATE_LIMITED', retry_after: 30,
                    message: '登录尝试较频繁，请等待 30 秒后重试。',
                } });
            },
        },
    });
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context);
    await assert.rejects(context.module.exports({ path: '/api/wechat/bind', method: 'POST' }), error => {
        assert.equal(error.statusCode, 429);
        assert.equal(error.message, '登录尝试较频繁，请等待 30 秒后重试。');
        assert.equal(error.data.retry_after, 30);
        return true;
    });
    assert.equal(cleared, false);
    assert.equal(requests, 1);
});
