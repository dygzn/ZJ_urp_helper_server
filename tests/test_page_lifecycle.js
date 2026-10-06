const test = require('node:test');
const assert = require('node:assert/strict');

const lifecycle = () => import('../static/js/modules/lifecycle.js');
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

test('disposing a page clears timers, frames, observers and event listeners exactly once', async () => {
    const { createScope } = await lifecycle();
    const intervals = new Map(), timeouts = new Map(), frames = new Map();
    let next = 0, disconnected = 0, clicks = 0;
    const host = {
        setInterval: callback => { intervals.set(++next, callback); return next; },
        clearInterval: id => intervals.delete(id),
        setTimeout: callback => { timeouts.set(++next, callback); return next; },
        clearTimeout: id => timeouts.delete(id),
        requestAnimationFrame: callback => { frames.set(++next, callback); return next; },
        cancelAnimationFrame: id => frames.delete(id),
    };
    const scope = createScope(host);
    const target = new EventTarget();
    scope.listen(target, 'click', () => clicks++);
    scope.observe({ disconnect() { disconnected++; } });
    scope.setInterval(() => {}, 1000);
    scope.setTimeout(() => {}, 1000);
    scope.requestAnimationFrame(() => {});
    target.dispatchEvent(new Event('click'));
    scope.dispose();
    scope.dispose();
    target.dispatchEvent(new Event('click'));
    assert.equal(clicks, 1);
    assert.equal(disconnected, 1);
    assert.equal(intervals.size + timeouts.size + frames.size, 0);
    assert.equal(scope.isActive(), false);
});

test('unmount aborts a network request and rejects a late response from an uncooperative transport', async () => {
    const { createScope } = await lifecycle();
    const result = deferred();
    let signal;
    const scope = createScope({ fetch(url, options) { signal = options.signal; return result.promise; } });
    const request = scope.fetch('/slow');
    const rejected = assert.rejects(request, { name: 'AbortError' });
    scope.dispose();
    assert.equal(signal.aborted, true);
    result.resolve(new Response('{}'));
    await rejected;
});

test('unmount during JSON download rejects the old body before it can render', async () => {
    const { createScope } = await lifecycle();
    const body = deferred();
    let signal;
    const scope = createScope({ fetch: async (url, options) => {
        signal = options.signal;
        return { json: () => body.promise };
    } });
    const response = await scope.fetch('/slow-body');
    const parsing = response.json();
    const rejected = assert.rejects(parsing, { name: 'AbortError' });
    scope.dispose();
    assert.equal(signal.aborted, true);
    body.resolve({ success: true });
    await rejected;
});

test('a remounted page gets a fresh scope while its old query stays invalid', async () => {
    const { pageResources } = await lifecycle();
    const resources = pageResources('test-remount');
    const first = resources.capture();
    resources.dispose();
    resources.activate();
    assert.equal(first.isActive(), false);
    assert.equal(resources.capture().isActive(), true);
    resources.dispose();
});

test('completed one-shot callbacks are released and cannot execute after unmount', async () => {
    const { createScope } = await lifecycle();
    const callbacks = [];
    let calls = 0;
    const scope = createScope({
        setTimeout: callback => { callbacks.push(callback); return callbacks.length; }, clearTimeout() {},
    });
    scope.setTimeout(() => calls++, 1);
    callbacks[0]();
    scope.setTimeout(() => calls++, 1);
    scope.dispose();
    callbacks[1]();
    assert.equal(calls, 1);
});

test('external cancellation remains effective for a streaming body after response headers', async () => {
    const { createScope } = await lifecycle();
    let signal;
    const scope = createScope({ fetch: async (url, options) => {
        signal = options.signal;
        return { body: { getReader() {} } };
    } });
    const controller = new AbortController();
    await scope.fetch('/stream', { signal: controller.signal });
    controller.abort();
    assert.equal(signal.aborted, true);
    scope.dispose();
});

test('an operation waiting on shared login cannot resume in a later mount', async () => {
    const { pageResources } = await lifecycle();
    const resources = pageResources('test-login-wait');
    const login = deferred();
    const old = resources.capture();
    assert.equal(typeof old.wait, 'function');
    const waiting = old.wait(login.promise);
    const rejected = assert.rejects(waiting, { name: 'AbortError' });
    resources.dispose();
    resources.activate();
    login.resolve('logged in');
    await rejected;
    assert.equal(resources.capture().isActive(), true);
    resources.dispose();
});
