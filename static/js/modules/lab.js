import { getDeviceId } from './auth.js';
import { pageResources } from './lifecycle.js';
import { closeUiModal, openUiModal, registerModalCleanup } from './ui.js';

const resources = pageResources('lab');

let pending = null;
let busy = false;
let taskButtons = [];
let currentListing = null;
let currentStudentId = '';
const uploadStates = new Map();
const el = id => document.getElementById(id);
const headers = () => ({ 'X-Device-ID': getDeviceId() });
const uploadModal = () => el('lab-upload-modal');
const uploadFields = ['file', 'attachment'];
const maxFileSize = 20 * 1024 * 1024;
const unverifiedMessage = '未能确认文件上传结果，请先刷新任务或到实验站核对，勿重复提交';

function focusElement(node) {
    if (!node || typeof node.focus !== 'function') return;
    try { node.focus({ preventScroll: true }); } catch { node.focus(); }
}

function message(value, error = false) {
    const box = el('lab-message');
    box.textContent = value;
    box.classList.toggle('lab-error', error);
}

function setBusy(value) {
    busy = value;
    ['lab-query', 'lab-semester', 'lab-mode', 'lab-course', 'lab-refresh', 'lab-disconnect'].forEach(id => { el(id).disabled = value; });
    el('lab-unbind').disabled = value || el('lab-disconnect').hidden;
    taskButtons.forEach(({ button, available, key }) => {
        button.disabled = value || !available || uploadStates.has(key);
    });
}

function showLabLogin() {
    el('lab-connection').hidden = false;
    el('lab-results').hidden = true;
    el('lab-password').focus?.();
}

async function api(url, options = {}) {
    const operation = resources.capture();
    const response = await operation.wait(resources.fetch(url, { ...options, headers: { ...headers(), ...(options.headers || {}) } }));
    const type = response.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await operation.wait(response.json()) : null;
    if (!response.ok || !data || !data.success) {
        if (data?.code === 'LAB_SESSION_EXPIRED') showLabLogin();
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

function uploadKey(data, item, kind) {
    return JSON.stringify([currentStudentId, data.semester, data.mode, data.course, item.task_key || item.id, kind]);
}

function render(data) {
    currentListing = data;
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
            const report = item.reports?.[kind];
            const key = uploadKey(data, item, kind);
            button.textContent = report?.status === 'submitted' ? label.replace('提交', '重新提交') : label;
            button.disabled = busy || !item[kind] || uploadStates.has(key);
            taskButtons.push({ button, available: item[kind], key });
            if (!item[kind]) button.title = '实验站未提供此报告入口';
            resources.listen(button, 'click', () => {
                if (busy) return;
                const semesterLabel = data.semesters.find(option => option.value === data.semester)?.label || data.semester;
                const courseLabel = data.courses?.find(option => option.value === data.course)?.label;
                const context = [...new Set([courseLabel, title.textContent, semesterLabel].filter(Boolean))].join(' · ');
                openLabUpload(button, report, context, {
                    itemId: item.id, taskKey: item.task_key, semester: data.semester,
                    mode: data.mode, course: data.courses?.length ? data.course : null, kind, key,
                });
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
        if (item.task_key || item.reports || ['pre', 'report'].some(kind => uploadStates.has(uploadKey(data, item, kind)))) {
            const statuses = document.createElement('div');
            statuses.className = 'lab-report-statuses';
            [['pre', '预习报告'], ['report', '实验报告']].forEach(([kind, label]) => {
                const report = item.reports?.[kind];
                const status = document.createElement('span');
                status.className = `lab-report-state${report?.status === 'submitted' ? ' lab-submitted' : ''}`;
                status.textContent = `${label}：${report?.label || '尚未查询'}${report?.file_name ? ` · 文件：${report.file_name}` : ''}`;
                statuses.append(status);
                if (report?.attachment_name) {
                    const attachment = document.createElement('span');
                    attachment.className = 'lab-report-attachment';
                    attachment.textContent = `附件：${report.attachment_name}`;
                    statuses.append(attachment);
                }
                if (uploadStates.get(uploadKey(data, item, kind)) === 'unverified') {
                    const warning = document.createElement('span');
                    warning.className = 'lab-report-unverified';
                    warning.textContent = `${label}提交结果待核实，请刷新任务与状态`;
                    statuses.append(warning);
                }
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
        for (const item of result.data.items) {
            for (const kind of ['pre', 'report']) {
                const report = item.reports?.[kind];
                const key = uploadKey(result.data, item, kind);
                if (uploadStates.get(key) === 'unverified' && report?.status_read) uploadStates.delete(key);
            }
        }
        render(result.data);
    }
}

export async function loadLabPage() {
    const operation = resources.capture();
    el('lab-connection').hidden = true;
    el('lab-results').hidden = true;
    pending = null;
    setBusy(true);
    message('正在检查会员和实验站密码状态…');
    try {
        const state = await operation.wait(api('/api/lab/status'));
        const nextStudent = state.student_id || '';
        if (currentStudentId && nextStudent !== currentStudentId) uploadStates.clear();
        currentStudentId = nextStudent;
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

function uploadStatus(text, error = false) {
    const status = el('lab-upload-status');
    if (status.textContent !== text) status.textContent = text;
    status.classList.toggle('lab-upload-error', error);
}

function syncUploadDialog() {
    const { files, uploading } = pending;
    uploadModal().dataset.dismissible = String(!uploading);
    el('lab-upload-close').disabled = uploading;
    el('lab-upload-cancel').disabled = uploading;
    for (const field of uploadFields) {
        const file = files[field];
        el(`lab-${field}-choose`).hidden = Boolean(file);
        el(`lab-${field}-selection`).hidden = !file;
        el(`lab-${field}-name`).textContent = file?.name || '';
        el(`lab-${field}-size`).textContent = file ? formatUploadSize(file.size) : '';
        for (const action of ['choose', 'replace', 'remove']) el(`lab-${field}-${action}`).disabled = uploading;
    }
    const submit = el('lab-upload-submit');
    submit.disabled = uploading || !files.file;
    submit.textContent = files.attachment ? '提交报告与附件' : '提交报告';
}

function formatUploadSize(size) {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function openLabUpload(button, report, context, task) {
    pending = { ...task, files: {}, uploading: false };
    el('lab-upload-title').textContent = button.textContent;
    el('lab-upload-context').textContent = context;
    el('lab-attachment-slot').hidden = !report?.supports_attachment;
    el('lab-attachment-hint').textContent = report?.attachment_hint
        ? `${report.attachment_hint.replace(/^[（(]|[）)]$/g, '')} · 格式由实验站判定`
        : '最大 20 MB · 格式由实验站判定';
    const previous = [['report', report?.file_name, '已交报告'], ['attachment', report?.attachment_name, '已有附件']];
    for (const [field, name, label] of previous) {
        const line = el(`lab-upload-old-${field}`);
        line.hidden = !name;
        line.textContent = name ? `${label}：${name}` : '';
    }
    el('lab-upload-existing').hidden = !previous.some(([, name]) => name);
    const warning = el('lab-upload-existing-hint');
    warning.hidden = !report?.attachment_name && Boolean(report?.status_read);
    warning.textContent = report?.attachment_name
        ? '原站已有附件。重新提交可能影响旧附件，请保留备份并在提交后核对。'
        : '未能核实原站提交与附件状态。如需附带附件或核对旧附件，请关闭弹窗后先点击“刷新任务与状态”。';
    el('lab-upload-progress').hidden = true;
    el('lab-convert').hidden = true;
    for (const field of uploadFields) el(`lab-${field}-error`).textContent = '';
    uploadStatus('');
    syncUploadDialog();
    button.focus?.();
    openUiModal(uploadModal(), { initialFocusSelector: '#lab-upload-title' });
}

function selectUploadFile(field, files) {
    if (!pending || pending.uploading || el(`lab-${field}-slot`).hidden) return;
    const file = files[0];
    const label = field === 'file' ? '报告' : '附件';
    let error = '';
    if (field === 'file') el('lab-convert').hidden = true;
    if (files.length > 1) error = `每次只能选择一份${label}`;
    else if (file && field === 'file' && !/\.pdf$/i.test(file.name)) {
        const conversion = conversionFor(file.name);
        if (conversion) {
            el('lab-convert-text').textContent = `所选${conversion[0]}需先转换为 PDF。转换时请自行将文件上传至第三方 iLovePDF。`;
            el('lab-convert-link').href = conversion[1];
            el('lab-convert').hidden = false;
        } else error = '请选择 PDF 报告';
        pending.files[field] = null;
    } else if (file && !file.size) error = `${label}是空文件，请重新选择`;
    else if (file?.size > maxFileSize) error = `${label}大小不能超过 20 MB`;
    else pending.files[field] = file || null;
    if (error) pending.files[field] = null;
    el(`lab-${field}-error`).textContent = error;
    uploadStatus('');
    syncUploadDialog();
    focusElement(el(`lab-${field}-${pending.files[field] ? 'replace' : 'choose'}`));
}

function sendLabUpload(form, task) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/lab/upload');
        xhr.responseType = 'json';
        xhr.timeout = 300000;
        xhr.setRequestHeader('X-Device-ID', getDeviceId());
        const progress = el('lab-upload-progress');
        xhr.upload.onprogress = event => {
            if (pending !== task || !event.lengthComputable || !event.total) return;
            const percent = Math.floor(100 * event.loaded / event.total);
            progress.value = percent;
            uploadStatus(`正在上传文件 ${percent}%…`);
        };
        xhr.upload.onload = () => {
            if (pending !== task) return;
            progress.value = 100;
            uploadStatus('文件已送达服务器，正在提交至实验站…');
        };
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 500 && xhr.response?.success !== undefined) resolve(xhr.response);
            else if (xhr.status === 413) resolve({ success: false, field: 'request',
                message: '上传请求超过服务器大小限制，请检查报告和附件大小后重试' });
            else reject(new Error(unverifiedMessage));
        };
        xhr.onabort = xhr.onerror = xhr.ontimeout = () => reject(new Error(unverifiedMessage));
        xhr.send(form);
    });
}

async function submitLabUpload(event) {
    event.preventDefault();
    if (!pending?.files.file || pending.uploading || busy) return;
    const operation = resources.capture();
    const task = pending;
    const form = new FormData();
    form.append('item_id', task.itemId);
    form.append('kind', task.kind);
    form.append('semester', task.semester);
    if (task.mode) form.append('mode', task.mode);
    if (task.course != null) form.append('course', task.course);
    if (task.taskKey) form.append('task_key', task.taskKey);
    for (const field of uploadFields) if (task.files[field]) form.append(field, task.files[field]);

    task.uploading = true;
    uploadStates.set(task.key, 'uploading');
    setBusy(true);
    syncUploadDialog();
    el('lab-upload-title').focus?.();
    el('lab-upload-progress').removeAttribute('value');
    el('lab-upload-progress').hidden = false;
    uploadStatus('正在上传文件…');
    const preventUnload = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener?.('beforeunload', preventUnload);

    let response;
    try {
        response = await sendLabUpload(form, task);
    } catch {
        response = { success: false, code: 'LAB_UPLOAD_UNVERIFIED', message: unverifiedMessage };
    } finally {
        window.removeEventListener?.('beforeunload', preventUnload);
    }
    const refreshed = Boolean(response.success && response.data?.status_refreshed);
    const unverified = response.code === 'LAB_UPLOAD_UNVERIFIED'
        || (response.success && response.data?.confirmed === false && !refreshed);
    if (unverified) uploadStates.set(task.key, 'unverified');
    else uploadStates.delete(task.key);
    if (!operation.isActive() || pending !== task) return;

    task.uploading = false;
    el('lab-upload-progress').hidden = true;
    setBusy(false);
    syncUploadDialog();
    if (response.success || unverified || response.code === 'LAB_SESSION_EXPIRED') {
        closeUiModal(uploadModal());
        if (response.data?.listing) render(response.data.listing);
        else if (unverified && currentListing) render(currentListing);
        if (response.code === 'LAB_SESSION_EXPIRED') showLabLogin();
        else {
            const trigger = taskButtons.find(entry => entry.key === task.key)?.button;
            (trigger && !trigger.disabled ? trigger : el('lab-refresh')).focus?.();
        }
        message(response.message || unverifiedMessage, !response.success || unverified);
        return;
    }
    if (uploadFields.includes(response.field)) {
        selectUploadFile(response.field, []);
        el(`lab-${response.field}-error`).textContent = response.message;
    } else {
        uploadStatus(response.message || '提交失败，请检查后重试', true);
        el('lab-upload-submit').focus?.();
    }
}

function initializeLabUpload() {
    registerModalCleanup('lab-upload-modal', () => { pending = null; });
    const close = () => { if (!pending?.uploading) closeUiModal(uploadModal()); };
    resources.listen(el('lab-upload-close'), 'click', close);
    resources.listen(el('lab-upload-cancel'), 'click', close);
    resources.listen(el('lab-upload-form'), 'submit', submitLabUpload);
    for (const field of uploadFields) {
        const input = el(`lab-${field}`);
        const drop = el(`lab-${field}-drop`);
        const choose = () => { if (pending && !pending.uploading) input.click(); };
        resources.listen(el(`lab-${field}-choose`), 'click', choose);
        resources.listen(el(`lab-${field}-replace`), 'click', choose);
        resources.listen(el(`lab-${field}-remove`), 'click', () => selectUploadFile(field, []));
        resources.listen(input, 'change', event => {
            const files = Array.from(event.target.files);
            event.target.value = '';
            if (files.length) selectUploadFile(field, files);
        });
        resources.listen(drop, 'dragover', event => {
            event.preventDefault();
            event.dataTransfer.dropEffect = pending?.uploading ? 'none' : 'copy';
            drop.classList.toggle('is-dragging', Boolean(pending && !pending.uploading));
        });
        resources.listen(drop, 'dragleave', event => {
            if (!drop.contains(event.relatedTarget)) drop.classList.toggle('is-dragging', false);
        });
        resources.listen(drop, 'drop', event => {
            event.preventDefault();
            drop.classList.toggle('is-dragging', false);
            const files = Array.from(event.dataTransfer.files);
            if (files.length) selectUploadFile(field, files);
        });
    }
    resources.listen(uploadModal(), 'dragover', event => event.preventDefault());
    resources.listen(uploadModal(), 'drop', event => event.preventDefault());
}

export function initializeLab() {
    initializeLabUpload();
    resources.listen(el('lab-disconnect'), 'click', () => el('lab-unbind').click());
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
            uploadStates.clear();
            el('lab-bound').textContent = '未绑定实验站密码';
            el('lab-unbind').disabled = true;
            el('lab-disconnect').hidden = true;
            el('lab-connection').hidden = false;
            pending = null;
            el('lab-password').focus?.();
            el('lab-results').hidden = true;
            message('已解除密码绑定，请输入密码重新查询');
        } catch (error) {
            if (error.name === 'AbortError') return; message(error.message, true); }
    });
}

export function mountLab() {
    initializeLab();
    return loadLabPage();
}
export function unmountLab() {
    if (pending) closeUiModal(uploadModal(), { restoreFocus: false });
    resources.dispose();
    pending = null;
    taskButtons = [];
    currentListing = null;
    el('lab-list').hidden = false;
    busy = false;
}
