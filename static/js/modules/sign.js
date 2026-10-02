import { pageResources } from './lifecycle.js';
import { getDeviceId } from './auth.js';
import { state } from './store.js';
const resources = pageResources('sign');

export function mountSign() { return signCheckStatus(); }
export function unmountSign() { signStopStream(); resources.dispose(); }

export async function signCheckStatus() {
    const operation = resources.capture();
    try {
        const resp = await operation.wait(resources.fetch('/api/sign/status', {
            headers: { 'X-Device-ID': getDeviceId() },
        }));
        const data = await operation.wait(resp.json());
        if (data.success && data.classes && data.classes.length > 0) {
            state.signClasses = data.classes;
            signShowControlCard(state.signClasses);
            if (data.running) {
                document.getElementById('sign-start-btn').style.display = 'none';
                document.getElementById('sign-stop-btn').style.display = '';
                document.getElementById('sign-log-card').style.display = '';
                signStartStream();
            }
        }
    } catch (e) {
        if (e?.name === 'AbortError') return; /* 忽略 */ }
}

export function signAppendLog(msg) {
    const el = document.getElementById('sign-log-content');
    if (!el) return;
    el.textContent += msg + '\n';
    el.scrollTop = el.scrollHeight;
}

export async function signLogin() {
    const operation = resources.capture();
    const username = document.getElementById('sign-username').value.trim();
    const password = document.getElementById('sign-password').value.trim();
    const errDiv = document.getElementById('sign-login-error');
    errDiv.style.display = 'none';
    if (!username || !password) {
        errDiv.textContent = '请输入用户名和密码';
        errDiv.style.display = 'block';
        return;
    }
    try {
        const resp = await operation.wait(resources.fetch('/api/sign/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Device-ID': getDeviceId() },
            body: JSON.stringify({ username, password }),
        }));
        const data = await operation.wait(resp.json());
        if (data.success) {
            state.signClasses = data.classes || [];
            signShowControlCard(state.signClasses);
        } else {
            errDiv.textContent = data.msg || '登录失败';
            errDiv.style.display = 'block';
        }
    } catch (e) {
        if (e?.name === 'AbortError') return;
        errDiv.textContent = '网络错误，请重试';
        errDiv.style.display = 'block';
    }
}

export async function signLoginLink() {
    const operation = resources.capture();
    const link = document.getElementById('sign-wechat-link').value.trim();
    const errDiv = document.getElementById('sign-login-error');
    errDiv.style.display = 'none';
    if (!link) {
        errDiv.textContent = '请粘贴微信跳转链接';
        errDiv.style.display = 'block';
        return;
    }
    try {
        const resp = await operation.wait(resources.fetch('/api/sign/login_link', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Device-ID': getDeviceId() },
            body: JSON.stringify({ link }),
        }));
        const data = await operation.wait(resp.json());
        if (data.success) {
            state.signClasses = data.classes || [];
            signShowControlCard(state.signClasses);
        } else {
            errDiv.textContent = data.msg || '登录失败';
            errDiv.style.display = 'block';
        }
    } catch (e) {
        if (e?.name === 'AbortError') return;
        errDiv.textContent = '网络错误，请重试';
        errDiv.style.display = 'block';
    }
}

export function signShowControlCard(classes) {
    document.getElementById('sign-login-card').style.display = 'none';
    document.getElementById('sign-control-card').style.display = '';

    const select = document.getElementById('sign-course-select');
    select.innerHTML = '';
    classes.forEach(c => {
        const opt = document.createElement('option');
        opt.value = JSON.stringify({ course_id: c.CourseID, class_id: c.TClassID });
        opt.textContent = c.CourseName + (c.ClassName ? ' - ' + c.ClassName : '');
        select.appendChild(opt);
    });
}

export function signLogout() {
    state.signClasses = [];
    signStopStream();
    document.getElementById('sign-control-card').style.display = 'none';
    document.getElementById('sign-log-card').style.display = 'none';
    document.getElementById('sign-login-card').style.display = '';
    document.getElementById('sign-login-error').style.display = 'none';
    document.getElementById('sign-username').value = '';
    document.getElementById('sign-password').value = '';
    document.getElementById('sign-wechat-link').value = '';
}

export async function signStart() {
    const operation = resources.capture();
    const errDiv = document.getElementById('sign-control-error');
    errDiv.style.display = 'none';

    const selected = document.getElementById('sign-course-select').value;
    if (!selected) {
        errDiv.textContent = '请选择课程';
        errDiv.style.display = 'block';
        return;
    }
    const { course_id, class_id } = JSON.parse(selected);
    const seconds = parseInt(document.getElementById('sign-seconds').value) || 10;
    const duration = parseInt(document.getElementById('sign-duration').value) || 180;
    const notify_email = document.getElementById('sign-email').value.trim();

    try {
        const resp = await operation.wait(resources.fetch('/api/sign/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Device-ID': getDeviceId() },
            body: JSON.stringify({ course_id, class_id, seconds, duration, notify_email }),
        }));
        const data = await operation.wait(resp.json());
        if (data.success) {
            document.getElementById('sign-start-btn').style.display = 'none';
            document.getElementById('sign-stop-btn').style.display = '';
            document.getElementById('sign-log-card').style.display = '';
            document.getElementById('sign-log-content').textContent = '';
            signStartStream();
        } else {
            errDiv.textContent = data.msg || '启动失败';
            errDiv.style.display = 'block';
        }
    } catch (e) {
        if (e?.name === 'AbortError') return;
        errDiv.textContent = '网络错误，请重试';
        errDiv.style.display = 'block';
    }
}

export async function signStop() {
    const operation = resources.capture();
    try {
        await operation.wait(resources.fetch('/api/sign/stop', {
            method: 'POST',
            headers: { 'X-Device-ID': getDeviceId() },
        }));
    } catch (e) {
        if (e?.name === 'AbortError') return; /* ignore */ }
    signStopStream();
    document.getElementById('sign-start-btn').style.display = '';
    document.getElementById('sign-stop-btn').style.display = 'none';
}

export function signStopStream() {
    if (state.signStreamController) {
        state.signStreamController.abort();
        state.signStreamController = null;
    }
}

export async function signStartStream() {
    const operation = resources.capture();
    signStopStream();
    const controller = new AbortController();
    state.signStreamController = controller;

    try {
        const resp = await operation.wait(resources.fetch('/api/sign/stream', {
            headers: { 'X-Device-ID': getDeviceId() },
            signal: controller.signal,
        }));
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
            const { done, value } = await operation.wait(reader.read());
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const line of lines) {
                if (line.startsWith('data:')) {
                    const raw = line.slice(5).trim();
                    try {
                        const obj = JSON.parse(raw);
                        if (obj.msg !== undefined) signAppendLog(obj.msg);
                    } catch (_) {
        if (_?.name === 'AbortError') return;
                        if (raw) signAppendLog(raw);
                    }
                }
            }
        }
    } catch (e) {
        if (e?.name === 'AbortError') return;
        if (e.name !== 'AbortError') {
            signAppendLog('[连接断开]');
        }
    }
    document.getElementById('sign-start-btn').style.display = '';
    document.getElementById('sign-stop-btn').style.display = 'none';
}
