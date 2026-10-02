// One scope per mount. Retained callbacks and response bodies belong to that mount.
export function createScope(host = globalThis.window || globalThis) {
    const lifetime = new AbortController();
    const cleanups = new Set();
    const timers = new Map();
    const frames = new Map();
    const isActive = () => !lifetime.signal.aborted;
    const abortError = () => new DOMException('页面已离开或请求已取消', 'AbortError');
    const assertActive = () => { if (!isActive()) throw abortError(); };
    const call = (name, ...args) => (host[name] || globalThis[name]).call(host, ...args);

    function addCleanup(cleanup) {
        if (!isActive()) { cleanup(); return () => {}; }
        cleanups.add(cleanup);
        return () => cleanups.delete(cleanup);
    }

    async function wait(work) {
        // Observe work even if the mount is already gone, avoiding detached rejections.
        const pending = Promise.resolve(work);
        let onAbort;
        const aborted = new Promise((resolve, reject) => {
            onAbort = () => reject(abortError());
            lifetime.signal.addEventListener('abort', onAbort, { once: true });
            if (!isActive()) onAbort();
        });
        try {
            const result = await Promise.race([pending, aborted]);
            assertActive();
            return result;
        } finally { lifetime.signal.removeEventListener('abort', onAbort); }
    }

    function clearTimer(id) {
        const cleanup = timers.get(id);
        if (cleanup) { cleanup(); cleanups.delete(cleanup); timers.delete(id); }
    }

    function timer(kind, callback, delay) {
        if (!isActive()) return null;
        const id = call(kind, (...args) => {
            if (kind === 'setTimeout') { cleanups.delete(timers.get(id)); timers.delete(id); }
            if (isActive()) callback(...args);
        }, delay);
        const cleanup = () => call(kind === 'setTimeout' ? 'clearTimeout' : 'clearInterval', id);
        timers.set(id, cleanup);
        addCleanup(cleanup);
        return id;
    }

    async function request(url, options = {}, transport = host.fetch || globalThis.fetch) {
        assertActive();
        const controller = new AbortController();
        const external = options.signal;
        const cancel = () => controller.abort(external?.reason);
        const release = addCleanup(cancel);
        external?.addEventListener('abort', cancel, { once: true });
        if (external?.aborted) cancel();
        let rejectAbort;
        const aborted = new Promise((resolve, reject) => { rejectAbort = reject; });
        const onAbort = () => rejectAbort(abortError());
        controller.signal.addEventListener('abort', onAbort, { once: true });
        const finish = () => {
            release();
            external?.removeEventListener('abort', cancel);
            controller.signal.removeEventListener('abort', onAbort);
        };
        const guard = async work => {
            if (controller.signal.aborted) throw abortError();
            const result = await Promise.race([work, aborted]);
            assertActive();
            if (controller.signal.aborted) throw abortError();
            return result;
        };
        try {
            if (controller.signal.aborted) throw abortError();
            const response = await guard(transport.call(host, url, { ...options, signal: controller.signal }));
            // Keep the cancellation link until the body is consumed, including SSE.
            return new Proxy(response, {
                get(target, key) {
                    const value = Reflect.get(target, key, target);
                    if (['json', 'text', 'blob', 'arrayBuffer', 'formData'].includes(key)) {
                        return async (...args) => {
                            try { return await guard(value.apply(target, args)); }
                            finally { finish(); }
                        };
                    }
                    if (key === 'body' && value?.getReader) {
                        return new Proxy(value, {
                            get(body, property) {
                                if (property === 'getReader') return (...args) => {
                                    const reader = body.getReader(...args);
                                    return new Proxy(reader, {
                                        get(owner, method) {
                                            if (method === 'read') return async () => {
                                                try {
                                                    const chunk = await guard(owner.read());
                                                    if (chunk.done) finish();
                                                    return chunk;
                                                } catch (error) { finish(); throw error; }
                                            };
                                            const fn = Reflect.get(owner, method, owner);
                                            return typeof fn === 'function' ? fn.bind(owner) : fn;
                                        },
                                    });
                                };
                                const item = Reflect.get(body, property, body);
                                return typeof item === 'function' ? item.bind(body) : item;
                            },
                        });
                    }
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
        } catch (error) { finish(); throw error; }
    }

    return {
        signal: lifetime.signal, isActive, addCleanup, wait, fetch: request, request,
        setTimeout: (callback, delay) => timer('setTimeout', callback, delay),
        setInterval: (callback, delay) => timer('setInterval', callback, delay),
        clearTimeout: clearTimer, clearInterval: clearTimer,
        requestAnimationFrame(callback) {
            if (!isActive()) return null;
            let id;
            let completed = false;
            id = call('requestAnimationFrame', time => {
                completed = true;
                cleanups.delete(frames.get(id)); frames.delete(id);
                if (isActive()) callback(time);
            });
            const cleanup = () => call('cancelAnimationFrame', id);
            if (!completed) { frames.set(id, cleanup); addCleanup(cleanup); }
            return id;
        },
        cancelAnimationFrame(id) {
            const cleanup = frames.get(id);
            if (cleanup) { cleanup(); cleanups.delete(cleanup); frames.delete(id); }
        },
        listen(target, type, listener, options) {
            if (!target?.addEventListener || !isActive()) return;
            target.addEventListener(type, listener, options);
            addCleanup(() => target.removeEventListener?.(type, listener, options));
        },
        observe(observer) { addCleanup(() => observer.disconnect()); return observer; },
        dispose() {
            if (!isActive()) return;
            lifetime.abort();
            // One failed cleanup must not leave other resources alive.
            for (const cleanup of cleanups) {
                try { cleanup(); } catch (error) { console.error('页面资源清理失败:', error); }
            }
            cleanups.clear(); timers.clear(); frames.clear();
        },
    };
}

const owners = new Map();

// A stable facade lets handlers use the current mount without retaining its old scope.
export function pageResources(key) {
    if (owners.has(key)) return owners.get(key);
    let scope = createScope();
    const owner = {
        capture: () => scope,
        activate() { scope.dispose(); scope = createScope(); return scope; },
        dispose: () => scope.dispose(),
        api: {
            request(url, options) {
                return scope.request(url, options, (...args) => globalThis.apiClient.request(...args));
            },
            beginRequest(key) {
                const current = scope;
                const request = globalThis.apiClient.beginRequest(key);
                current.addCleanup(() => request.cancel());
                return { ...request, isCurrent: () => current.isActive() && request.isCurrent() };
            },
            cancelRequest: key => globalThis.apiClient.cancelRequest(key),
        },
    };
    for (const method of ['fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
        'requestAnimationFrame', 'cancelAnimationFrame', 'listen', 'observe', 'addCleanup']) {
        owner[method] = (...args) => scope[method](...args);
    }
    owners.set(key, owner);
    return owner;
}
