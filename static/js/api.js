/*
 * Shared browser API client. Load before main.js; responses retain the fetch API.
 * apiClient.configure({ baseURL: '', timeout: 10000, headers: {} });
 * const response = await apiClient.request('/api/schedule', { signal, timeout });
 * Errors expose { success: false, code, message }; cancellation keeps AbortError.
 * Listen on document for 'api:auth-expired'; resetAuthState() starts a new session.
 * beginRequest(viewKey) cancels that view's previous scope; check isCurrent()
 * after awaits, and cancelRequest(viewKey) when leaving a result view.
 */
(function (root) {
    'use strict';

    const config = { baseURL: '', timeout: 10000, headers: {} };
    const requests = new Map();
    let authExpired = false;
    let authGeneration = 0;

    function apiError(code, message, cause, name = 'ApiError') {
        const error = new Error(message);
        Object.assign(error, { name, success: false, code, cause });
        return error;
    }

    function getDeviceId() {
        let deviceId;
        try {
            deviceId = root.localStorage.getItem('device_id');
        } catch (cause) {
            throw apiError('STORAGE_UNAVAILABLE', '无法读取设备标识，请允许浏览器使用本地存储。', cause);
        }
        // Keep existing IDs so the security upgrade does not discard account bindings.
        if (deviceId) return deviceId;
        if (typeof root.crypto?.randomUUID === 'function') {
            deviceId = root.crypto.randomUUID();
        } else if (typeof root.crypto?.getRandomValues === 'function') {
            const bytes = root.crypto.getRandomValues(new Uint8Array(16));
            bytes[6] = (bytes[6] & 0x0f) | 0x40;
            bytes[8] = (bytes[8] & 0x3f) | 0x80;
            const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
            deviceId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        } else {
            throw apiError('DEVICE_ID_UNAVAILABLE', '浏览器不支持安全生成设备标识，请使用支持安全随机数的浏览器。');
        }
        try {
            root.localStorage.setItem('device_id', deviceId);
        } catch (cause) {
            throw apiError('STORAGE_UNAVAILABLE', '无法保存设备标识，请允许浏览器使用本地存储。', cause);
        }
        return deviceId;
    }

    function resetAuthState() {
        authExpired = false;
        authGeneration++;
    }

    function inspectAuth(response, data, url, generation) {
        const expired = response.status === 401 || data?.requires_relogin === true
            || (data?.success === false && (
                ['EXPIRED', 'AUTH_EXPIRED', 'SESSION_EXPIRED', 'TOKEN_EXPIRED', 'UNAUTHORIZED', 'URP_LOGIN_REQUIRED'].includes(data.code)
                || /登录(?:已)?(?:失效|过期)/.test(data.message || '')
            ));
        if (!expired || authExpired || generation !== authGeneration) return;
        authExpired = true;
        root.document.dispatchEvent(new root.CustomEvent('api:auth-expired', {
            detail: {
                success: false, code: data?.code || 'EXPIRED', status: response.status, url,
                message: data?.message || '登录已失效，请重新输入学号和密码。',
            },
        }));
    }

    function resolveURL(path) {
        if (/^(?:https?:)?\/\//i.test(path)) return path;
        return config.baseURL
            ? `${config.baseURL.replace(/\/$/, '')}/${String(path).replace(/^\//, '')}`
            : path;
    }

    async function request(path, options = {}) {
        const { signal: externalSignal, timeout = config.timeout, ...fetchOptions } = options;
        const controller = new root.AbortController();
        const generation = authGeneration;
        let timedOut = false;
        let timer = null;
        let rejectAbort;
        const aborted = new Promise((resolve, reject) => { rejectAbort = reject; });
        const abortError = () => timedOut
            ? apiError('TIMEOUT', '请求超时，请稍后重试。')
            : apiError('CANCELLED', '请求已取消。', externalSignal?.reason, 'AbortError');
        const onAbort = () => rejectAbort(abortError());
        const onExternalAbort = () => controller.abort(externalSignal.reason);

        controller.signal.addEventListener('abort', onAbort, { once: true });
        try {
            if (externalSignal?.aborted) throw abortError();
            externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
            const headers = new root.Headers({ 'Content-Type': 'application/json' });
            new root.Headers(config.headers).forEach((value, key) => headers.set(key, value));
            headers.set('X-Device-ID', getDeviceId());
            new root.Headers(fetchOptions.headers).forEach((value, key) => headers.set(key, value));
            if (timeout > 0) {
                timer = root.setTimeout(() => {
                    timedOut = true;
                    controller.abort();
                }, timeout);
            }
            const url = resolveURL(path);
            const response = await Promise.race([
                root.fetch(url, { ...fetchOptions, headers, signal: controller.signal }), aborted,
            ]);
            let data = null;
            // Inspect a clone so callers can still use json(), text(), blob(), etc.
            // JSON body download is part of the timeout; SSE is not buffered here.
            if (/\bjson\b/i.test(response.headers.get('Content-Type') || '')) {
                try {
                    data = await Promise.race([response.clone().json(), aborted]);
                } catch (error) {
                    if (error.name !== 'SyntaxError') throw error;
                }
            }
            if (controller.signal.aborted) throw abortError();
            inspectAuth(response, data, url, generation);
            return response;
        } catch (error) {
            if (controller.signal.aborted) throw abortError();
            if (error.name === 'TypeError') {
                throw apiError('NETWORK_ERROR', '网络连接失败，请检查网络后重试。', error);
            }
            throw error;
        } finally {
            if (timer !== null) root.clearTimeout(timer);
            externalSignal?.removeEventListener('abort', onExternalAbort);
            controller.signal.removeEventListener('abort', onAbort);
        }
    }

    // View scopes cover UI work before/after fetch as well as the fetch itself.
    function beginRequest(key) {
        cancelRequest(key);
        const controller = new root.AbortController();
        const scope = {
            signal: controller.signal,
            isCurrent: () => requests.get(key) === scope && !controller.signal.aborted,
            cancel: () => controller.abort(),
        };
        requests.set(key, scope);
        return scope;
    }

    function cancelRequest(key) {
        requests.get(key)?.cancel();
        requests.delete(key);
    }

    root.apiClient = {
        request, getDeviceId, beginRequest, cancelRequest, resetAuthState,
        configure(options = {}) {
            Object.assign(config, options);
        },
    };
})(globalThis);
