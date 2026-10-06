const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

function client(overrides = {}) {
    assert.ok(fs.existsSync(path.join(__dirname, '../static/js/api.js')), 'the shared API client must exist');
    const saved = new Map();
    const document = new EventTarget();
    const context = vm.createContext({ document, Headers, AbortController, DOMException,
        crypto: webcrypto, setTimeout, clearTimeout,
        CustomEvent: class extends Event {
            constructor(type, options) { super(type); this.detail = options.detail; }
        },
        localStorage: { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value) },
        fetch: async () => json({ success: true }), ...overrides });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/js/api.js'), 'utf8'), context);
    return { api: context.apiClient, context, saved, document };
}
const json = (data, status = 200) => new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
});

test('existing device bindings survive the secure generator migration', () => {
    const { api, saved } = client({ crypto: undefined });
    saved.set('device_id', 'legacy-device');
    assert.equal(api.getDeviceId(), 'legacy-device');
});

test('new device IDs use randomUUID and persist across reads', () => {
    let calls = 0;
    const { api, saved } = client({ crypto: { randomUUID() { calls++; return '5ebc8eed-f056-49f0-af4d-fae993ff5ca8'; } } });
    assert.equal(api.getDeviceId(), '5ebc8eed-f056-49f0-af4d-fae993ff5ca8');
    assert.equal(api.getDeviceId(), saved.get('device_id'));
    assert.equal(calls, 1);
});

test('getRandomValues fallback sets UUID version and variant without weak randomness', () => {
    const { api } = client({ crypto: { getRandomValues(bytes) { bytes.fill(255); return bytes; } } });
    assert.equal(api.getDeviceId(), 'ffffffff-ffff-4fff-bfff-ffffffffffff');
});

test('missing secure randomness stops new identity creation', () => {
    const { api, saved } = client({ crypto: undefined });
    assert.throws(() => api.getDeviceId(), error => error.code === 'DEVICE_ID_UNAVAILABLE' && /安全/.test(error.message));
    assert.equal(saved.has('device_id'), false);
});

test('base URL and headers merge while business fields remain intact', async () => {
    let sent;
    const { api, saved } = client({ fetch: async (url, options) => {
        sent = { url, options };
        return json({ success: true, grades: [{ course: '数学', score: '90' }], gpa: { '学分绩点': 3.5 } });
    } });
    saved.set('device_id', 'bound-device');
    api.configure({ baseURL: '/gateway/', headers: { 'X-Test': 'default' } });
    const response = await api.request('/api/grades/current', { headers: new Headers({ 'x-test': 'override' }) });
    assert.equal(sent.url, '/gateway/api/grades/current');
    assert.equal(sent.options.headers.get('X-Device-ID'), 'bound-device');
    assert.equal(sent.options.headers.get('Content-Type'), 'application/json');
    assert.equal(sent.options.headers.get('X-Test'), 'override');
    assert.deepEqual(await response.json(), { success: true, grades: [{ course: '数学', score: '90' }], gpa: { '学分绩点': 3.5 } });
});

for (const [data, status] of [
    [{ message: '失效' }, 401],
    [{ success: false, code: 'EXPIRED', message: '失效' }, 200],
    [{ success: true, logged_in: false, requires_relogin: true, message: '失效' }, 200],
    [{ success: false, message: '登录已失效，请重新绑定' }, 200],
]) {
    test(`auth expiry publishes one global event for ${status}/${JSON.stringify(data)}`, async () => {
        const { api, document } = client({ fetch: async () => json(data, status) });
        const events = [];
        document.addEventListener('api:auth-expired', event => events.push(event.detail));
        const responses = await Promise.all([api.request('/one'), api.request('/two')]);
        assert.equal(events.length, 1);
        assert.equal(events[0].message, data.message);
        assert.equal(events[0].status, status);
        assert.deepEqual(await responses[0].json(), data);
        api.resetAuthState();
        await api.request('/three');
        assert.equal(events.length, 2);
    });
}

test('membership expiry and ordinary business errors do not trigger relogin', async () => {
    const { api, document } = client({ fetch: async () => json({ success: false, message: '您的会员已过期', require_member: 'basic' }) });
    let events = 0;
    document.addEventListener('api:auth-expired', () => events++);
    await api.request('/api/member/status');
    assert.equal(events, 0);
});

test('configured headers override defaults regardless of casing', async () => {
    let contentType;
    const { api } = client({ fetch: async (url, options) => {
        contentType = options.headers.get('Content-Type');
        return json({ success: true });
    } });
    api.configure({ headers: { 'content-type': 'application/custom+json' } });
    await api.request('/configured');
    assert.equal(contentType, 'application/custom+json');
});

test('settled requests clear timeout and external abort subscriptions', async () => {
    const timers = new Set();
    const controller = new AbortController();
    let subscriptions = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = (...args) => { subscriptions++; return add(...args); };
    controller.signal.removeEventListener = (...args) => { subscriptions--; return remove(...args); };
    const { api } = client({ setTimeout() { timers.add(1); return 1; }, clearTimeout(id) { timers.delete(id); } });
    await api.request('/success', { signal: controller.signal });
    assert.equal(timers.size, 0);
    assert.equal(subscriptions, 0);
});

test('network errors expose a consistent Chinese error object', async () => {
    const { api } = client({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
    await assert.rejects(api.request('/network'), error => error.success === false && error.code === 'NETWORK_ERROR' && /网络/.test(error.message));
});

test('default timeout aborts fetch and clears its timer', async () => {
    const timers = new Map();
    let signal;
    const { api } = client({
        setTimeout(callback, delay) { timers.set(1, { callback, delay }); return 1; },
        clearTimeout(id) { timers.delete(id); },
        fetch: async (url, options) => { signal = options.signal; return new Promise(() => {}); },
    });
    const pending = api.request('/slow');
    assert.equal(timers.get(1).delay, 10000);
    timers.get(1).callback();
    await assert.rejects(pending, error => error.code === 'TIMEOUT' && /超时/.test(error.message));
    assert.equal(signal.aborted, true);
    assert.equal(timers.size, 0);
});

test('external cancellation wins over a stalled fetch and preserves AbortError semantics', async () => {
    const controller = new AbortController();
    let signal;
    const { api } = client({ fetch: async (url, options) => { signal = options.signal; return new Promise(() => {}); } });
    const pending = api.request('/cancel', { signal: controller.signal });
    controller.abort('navigation');
    await assert.rejects(pending, error => error.code === 'CANCELLED' && error.name === 'AbortError');
    assert.equal(signal.aborted, true);
});

test('pre-aborted signals never send a request', async () => {
    let requests = 0;
    const { api } = client({ fetch: async () => { requests++; return json({}); } });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(api.request('/cancel', { signal: controller.signal }), { code: 'CANCELLED' });
    assert.equal(requests, 0);
});

test('timeout remains active until the JSON body finishes', async () => {
    let expire;
    const body = new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('{')); } });
    const { api } = client({ setTimeout(callback) { expire = callback; return 1; }, clearTimeout() {},
        fetch: async () => new Response(body, { headers: { 'Content-Type': 'application/json' } }) });
    const pending = api.request('/slow-body');
    await new Promise(resolve => setImmediate(resolve));
    expire();
    await assert.rejects(pending, { code: 'TIMEOUT' });
});

test('same view requests invalidate old results without cancelling other views', () => {
    const { api } = client();
    const first = api.beginRequest('grades');
    const schedule = api.beginRequest('schedule');
    const second = api.beginRequest('grades');
    assert.equal(first.signal.aborted, true);
    assert.equal(first.isCurrent(), false);
    assert.equal(second.isCurrent(), true);
    assert.equal(schedule.isCurrent(), true);
    api.cancelRequest('grades');
    assert.equal(second.isCurrent(), false);
});
