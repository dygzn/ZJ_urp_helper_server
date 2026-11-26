import { getDeviceId } from './auth.js';
import { pageResources } from './lifecycle.js';

const resources = pageResources('lab');

let pending = null;
let busy = false;
let taskButtons = [];
let currentListing = null;
const el = id => document.getElementById(id);
const headers = () => ({ 'X-Device-ID': getDeviceId() });

function message(value, error = false) {
    const box = el('lab-message');
    box.textContent = value;
    box.classList.toggle('lab-error', error);
}

function setBusy(value) {
    busy = value;
    ['lab-query', 'lab-semester', 'lab-mode', 'lab-course', 'lab-refresh', 'lab-disconnect'].forEach(id => { el(id).disabled = value; });
    el('lab-unbind').disabled = value || el('lab-disconnect').hidden;
    taskButtons.forEach(({ button, available }) => { button.disabled = value || !available; });
}

async function api(url, options = {}) {
    const operation = resources.capture();
    const response = await operation.wait(resources.fetch(url, { ...options, headers: { ...headers(), ...(options.headers || {}) } }));
    const type = response.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await operation.wait(response.json()) : null;
    if (!response.ok || !data || !data.success) {
        if (data?.code === 'LAB_SESSION_EXPIRED') {
            el('lab-connection').hidden = false;
            el('lab-results').hidden = true;
            el('lab-convert').hidden = true;
            pending = null;
            el('lab-password').focus?.();
        }
        throw new Error(data?.message || '实验站请求失败');
    }
    return data;
}

function byCourse(data) {
    return (data.modes?.find(option => option.value === data.mode)?.label || data.mode) === '按课程';
}

function resultSummary(data) {
    const kind = byCourse(data) ? '条课程实验任务（按课程）' : '项实验项目';
    return `已查询到 ${data.items.length} ${kind}`;
}

function conversionFor(filename) {
    const name = filename.toLowerCase();
    if (/\.docx?$/.test(name)) return ['Word', 'https://www.ilovepdf.com/zh-cn/word_to_pdf'];
    if (/\.(jpe?g|png)$/.test(name)) return ['图片', 'https://www.ilovepdf.com/zh-cn/jpg_to_pdf'];
    return null;
}

function fillSelect(select, options, value) {
    select.replaceChildren();
    options.forEach(item => {
        const option = document.createElement('option');
        option.value = item.value;
        option.textContent = item.label;
        select.append(option);
    });
    select.value = value ?? options[0]?.value ?? '';
}

function listingQuery(semester, mode, course) {
    let query = 'semester=' + encodeURIComponent(semester);
    if (mode) query += '&mode=' + encodeURIComponent(mode);
    if (course != null) query += '&course=' + encodeURIComponent(course);
    return query;
}

function render(data) {
    currentListing = data;
    el('lab-convert').hidden = true;
    fillSelect(el('lab-semester'), data.semesters, data.semester);
    fillSelect(el('lab-mode'), data.modes || [], data.mode);
    el('lab-mode-field').hidden = !data.modes?.length;
    fillSelect(el('lab-course'), data.courses || [], data.course);
    el('lab-course-field').hidden = !data.courses?.length;
    const list = el('lab-list');
    list.replaceChildren();
    taskButtons = [];
    if (!data.items.length) list.textContent = byCourse(data) ? '当前条件下暂无课程实验任务'
        : (data.courses?.length && !data.course ? '请选择课程查看实验项目' : '当前条件下暂无实验项目');
    data.items.forEach(item => {
        const card = document.createElement('article');
        card.className = 'lab-item';
        const title = document.createElement('strong');
        const headers = data.headers || [];
        const preferred = byCourse(data) ? /课程名称|^课程$/ : /项目名称|实验项目|实验名称|^项目$/;
        let titleIndex = headers.findIndex(header => preferred.test(header));
        if (titleIndex < 0) titleIndex = headers.findIndex(header => /课程|项目|实验名称/.test(header));
        const fallbackIndex = item.cells.findIndex(value => value && !/^\d+$/.test(value));
        const nameIndex = titleIndex >= 0 && item.cells[titleIndex] ? titleIndex : fallbackIndex;
        title.textContent = item.cells[nameIndex] || '实验任务';
        card.append(title);
        const controls = document.createElement('div');
        controls.className = 'lab-actions';
        [['pre', '提交预习报告'], ['report', '提交实验报告']].forEach(([kind, label]) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn-primary';
            button.textContent = item.reports?.[kind]?.status === 'submitted' ? label.replace('提交', '重新提交') : label;
            button.disabled = busy || !item[kind];
            taskButtons.push({ button, available: item[kind] });
            if (!item[kind]) button.title = '实验站未提供此报告入口';
            resources.listen(button, 'click', () => {
                if (busy) return;
                pending = { itemId: item.id, taskKey: item.task_key, semester: data.semester,
                    mode: data.mode, course: data.courses?.length ? data.course : null, kind };
                el('lab-convert').hidden = true;
                el('lab-file').click();
            });
            controls.append(button);
        });
        card.append(controls);
        const details = document.createElement('div');
        details.className = 'lab-item-details';
        item.cells.forEach((value, index) => {
            if (!value || index === nameIndex || /^(预习报告\s*)?(实验报告)?$/.test(value)) return;
            const detail = document.createElement('span');
            detail.textContent = headers[index] ? `${headers[index]}：${value}` : value;
            details.append(detail);
        });
        if (!item.pre && !item.report) {
            const note = document.createElement('span');
            note.textContent = '实验站未提供提交入口';
            details.append(note);
        }
        if (item.task_key || item.reports) {
            const statuses = document.createElement('div');
            statuses.className = 'lab-report-statuses';
            [['pre', '预习报告'], ['report', '实验报告']].forEach(([kind, label]) => {
                const report = item.reports?.[kind];
                const status = document.createElement('span');
                status.className = `lab-report-state${report?.status === 'submitted' ? ' lab-submitted' : ''}`;
                status.textContent = `${label}：${report?.label || '尚未查询'}${report?.file_name ? ` · 文件：${report.file_name}` : ''}`;
                statuses.append(status);
            });
            details.append(statuses);
        }
        card.append(details);
        list.append(card);
    });
    el('lab-results').hidden = false;
    el('lab-connection').hidden = true;
}

async function displayTasks(data) {
    render(data);
    if (data.items.some(item => item.task_key)) {
        message('正在读取报告提交状态…');
        const query = listingQuery(data.semester, data.mode, data.courses?.length ? data.course : null);
        const result = await api(`/api/lab/submission-status?${query}`);
        render(result.data);
    }
}

export async function loadLabPage() {
    const operation = resources.capture();
    el('lab-connection').hidden = true;
    el('lab-results').hidden = true;
    el('lab-convert').hidden = true;
    pending = null;
    setBusy(true);
    message('正在检查会员和实验站密码状态…');
    try {
        const state = await operation.wait(api('/api/lab/status'));
        el('lab-student').textContent = state.student_id;
        el('lab-bound').textContent = state.password_bound ? '已绑定实验站密码' : '未绑定实验站密码';
        el('lab-unbind').disabled = !state.password_bound;
        el('lab-disconnect').hidden = !state.password_bound;
        el('lab-password').value = '';
        el('lab-save').checked = false;
        if (state.logged_in && state.data) await operation.wait(displayTasks(state.data));
        else if (state.password_bound) {
            message('正在使用已绑定密码重新登录实验站…');
            const result = await operation.wait(api('/api/lab/query', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
            }));
            await operation.wait(displayTasks(result.data));
        } else el('lab-connection').hidden = false;
        message('');
    } catch (error) {
            if (error.name === 'AbortError') return;
        el('lab-connection').hidden = false;
        message(error.message, true);
    } finally { if (operation.isActive()) setBusy(false); }
}

export function initializeLab() {
    resources.listen(el('lab-disconnect'), 'click', () => el('lab-unbind').click());
    resources.listen(el('lab-convert-reselect'), 'click', () => el('lab-file').click());
    resources.listen(el('lab-password'), 'keydown', event => {
        if (event.key === 'Enter' && !busy) {
            event.preventDefault?.();
            el('lab-query').click();
        }
    });
    resources.listen(el('lab-query'), 'click', async () => {
        if (busy) return;
    const operation = resources.capture();
        setBusy(true);
        message('正在登录实验站并查询实验…');
        try {
            const result = await operation.wait(api('/api/lab/query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: el('lab-password').value,
                    bind_password: el('lab-save').checked }),
            }));
            await operation.wait(displayTasks(result.data));
            el('lab-password').value = '';
            if (el('lab-save').checked) {
                el('lab-bound').textContent = '已绑定实验站密码';
                el('lab-unbind').disabled = false;
                el('lab-disconnect').hidden = false;
            }
            message(resultSummary(result.data));
            el('lab-semester').focus?.();
        } catch (error) {
            if (error.name === 'AbortError') return;
            message(error.message, true);
        } finally { if (operation.isActive()) setBusy(false); }
    });
    const refreshTasks = async (semester, mode, course) => {
        if (busy) return;
        const operation = resources.capture();
        setBusy(true);
        pending = null;
        el('lab-convert').hidden = true;
        el('lab-list').hidden = true;
        message('正在查询实验任务…');
        try {
            const result = await operation.wait(api(`/api/lab/experiments?${listingQuery(semester, mode, course)}`));
            await operation.wait(displayTasks(result.data));
            message(resultSummary(result.data));
        } catch (error) {
            if (error.name === 'AbortError') return;
            if (currentListing && !el('lab-results').hidden) render(currentListing);
            message(error.message, true);
        } finally {
            if (operation.isActive()) {
                el('lab-list').hidden = false;
                setBusy(false);
            }
        }
    };
    resources.listen(el('lab-semester'), 'change', event => refreshTasks(event.target.value, currentListing?.mode));
    resources.listen(el('lab-mode'), 'change', event => refreshTasks(el('lab-semester').value, event.target.value));
    const refreshCourse = () => refreshTasks(el('lab-semester').value, currentListing?.mode,
        currentListing?.courses?.length ? el('lab-course').value : null);
    resources.listen(el('lab-course'), 'change', refreshCourse);
    resources.listen(el('lab-refresh'), 'click', refreshCourse);
    resources.listen(el('lab-unbind'), 'click', async () => {
        if (busy) return;
    const operation = resources.capture();
        try {
            await operation.wait(api('/api/lab/credential', { method: 'DELETE' }));
            el('lab-bound').textContent = '未绑定实验站密码';
            el('lab-unbind').disabled = true;
            el('lab-disconnect').hidden = true;
            el('lab-connection').hidden = false;
            el('lab-convert').hidden = true;
            pending = null;
            el('lab-password').focus?.();
            el('lab-results').hidden = true;
            message('已解除密码绑定，请输入密码重新查询');
        } catch (error) {
            if (error.name === 'AbortError') return; message(error.message, true); }
    });
    resources.listen(el('lab-file'), 'change', async event => {
    const operation = resources.capture();
        const file = event.target.files[0];
        event.target.value = '';
        if (!file || !pending) return;
        const conversion = conversionFor(file.name);
        if (conversion) {
            el('lab-convert-text').textContent = `所选${conversion[0]}文件不能直接提交。转换需由你自行将文件上传至第三方 iLovePDF；下载 PDF 后返回此页重新选择。`;
            el('lab-convert-link').href = conversion[1];
            el('lab-convert').hidden = false;
            el('lab-convert').scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
            message('请先将文件转换为 PDF，转换后再提交');
            return;
        }
        el('lab-convert').hidden = true;
        if (!file.name.toLowerCase().endsWith('.pdf')) {
            message('仅支持 PDF 格式文件（最大 20MB）', true); return;
        }
        if (file.size > 20 * 1024 * 1024) {
            message('所选 PDF 超过 20MB 限制，请压缩后再提交', true); return;
        }
        const form = new FormData();
        form.append('item_id', pending.itemId);
        form.append('kind', pending.kind);
        form.append('semester', pending.semester);
        if (pending.mode) form.append('mode', pending.mode);
        if (pending.course != null) form.append('course', pending.course);
        if (pending.taskKey) form.append('task_key', pending.taskKey);
        form.append('file', file);
        pending = null;
        if (busy) return;
        setBusy(true);
        message('正在上传，请不要重复点击…');
        try {
            const result = await operation.wait(api('/api/lab/upload', { method: 'POST', body: form }));
            if (result.data?.listing) render(result.data.listing);
            message(result.message);
        } catch (error) {
            if (error.name === 'AbortError') return; message(error.message, true);
        } finally { if (operation.isActive()) setBusy(false); }
    });
}

export function mountLab() {
    initializeLab();
    return loadLabPage();
}
export function unmountLab() {
    resources.dispose();
    pending = null;
    taskButtons = [];
    currentListing = null;
    el('lab-list').hidden = false;
    busy = false;
}
