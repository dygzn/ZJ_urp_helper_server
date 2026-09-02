const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const mainSource = fs.readFileSync(
    path.join(__dirname, '..', 'static', 'js', 'main.js'),
    'utf8',
);

function createUrlHarness({ search, fetchResponse = null } = {}) {
    const storage = new Map();
    let replacedUrl = null;
    const context = {
        URL,
        URLSearchParams,
        console,
        document: { addEventListener() {} },
        localStorage: {
            getItem(key) { return storage.get(key) ?? null; },
            setItem(key, value) { storage.set(key, value); },
        },
        sessionStorage: {
            getItem(key) { return storage.get(key) ?? null; },
            setItem(key, value) { storage.set(key, value); },
            removeItem(key) { storage.delete(key); },
        },
        window: {
            location: {
                href: `https://example.com/${search}`,
                search,
                origin: 'https://example.com',
                pathname: '/',
                hash: '',
            },
            history: {
                state: null,
                replaceState(_state, _title, url) { replacedUrl = url; },
            },
        },
        fetch: async () => ({
            ok: true,
            json: async () => fetchResponse,
        }),
        setTimeout,
    };

    vm.createContext(context);
    vm.runInContext(mainSource, context, { filename: 'static/js/main.js' });
    return {
        context,
        storage,
        get replacedUrl() { return replacedUrl; },
    };
}

test('支付参数从地址栏清除但邀请 token 和页面参数保留', () => {
    const harness = createUrlHarness({
        search: '?page=member&invite=incoming-token&out_trade_no=order-1&sign=abc',
    });

    harness.context.capturePendingInvitationToken();
    harness.context.sanitizeIndexUrl();

    assert.equal(harness.storage.get('pending_invitation_token'), 'incoming-token');
    assert.equal(harness.replacedUrl, '/?page=member&invite=incoming-token');
});

test('绑定后地址栏同步当前账号自己的邀请 token', async () => {
    const harness = createUrlHarness({
        search: '?page=member&invite=incoming-token',
        fetchResponse: {
            success: true,
            data: { invite_url: 'https://example.com/?invite=own-token' },
        },
    });

    await harness.context.ensureOwnInvitationTokenInUrl();

    assert.equal(harness.replacedUrl, '/?page=member&invite=own-token');
});

test('自己的邀请 token 不会被暂存为下一次绑定的待归因 token', () => {
    const harness = createUrlHarness({ search: '?invite=own-token' });
    harness.storage.set('own_invitation_token', 'own-token');

    harness.context.capturePendingInvitationToken();

    assert.equal(harness.storage.get('pending_invitation_token'), undefined);
});

test('同步自己的邀请 token 后清除同值的待归因 token', async () => {
    const harness = createUrlHarness({
        search: '?invite=own-token',
        fetchResponse: {
            success: true,
            data: { invite_url: 'https://example.com/?invite=own-token' },
        },
    });
    harness.storage.set('pending_invitation_token', 'own-token');

    await harness.context.ensureOwnInvitationTokenInUrl();

    assert.equal(harness.storage.get('pending_invitation_token'), undefined);
    assert.equal(harness.storage.get('own_invitation_token'), 'own-token');
});
