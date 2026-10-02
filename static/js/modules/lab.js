import { getDeviceId } from './auth.js';
import { pageResources } from './lifecycle.js';

const resources = pageResources('lab');

let pending = null;
const el = id => document.getElementById(id);
const headers = () => ({ 'X-Device-ID': getDeviceId() });

function message(value, error = false) {
    const box = el('lab-message');
    box.textContent = value;
    box.classList.toggle('lab-error', error);
}

async function api(url, options = {}) {
    const operation = resources.capture();
    const response = await operation.wait(resources.fetch(url, { ...options, headers: { ...headers(), ...(options.headers || {}) } }));
    const type = response.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await operation.wait(response.json()) : null;
    if (!response.ok || !data || !data.success) throw new Error(data?.message || '实验站请求失败');
    return data;
}

function resultSummary(data) {
    const kind = data.mode === '按课程' ? '条课程实验任务（按课程）' : '项实验项目';
    return `已查询到 ${data.items.length} ${kind}`;
}

function conversionFor(filename) {
    const name = filename.toLowerCase();
    if (/\.docx?$/.test(name)) return ['Word', 'https://www.ilovepdf.com/zh-cn/word_to_pdf'];
    if (/\.(jpe?g|png)$/.test(name)) return ['图片', 'https://www.ilovepdf.com/zh-cn/jpg_to_pdf'];
    return null;
}

function render(data) {
    el('lab-convert').hidden = true;
    const byCourse = data.mode === '按课程';
    el('lab-mode').textContent = byCourse ? '按课程展示原站可提交的实验任务' : '按原站实验项目展示';
    const term = el('lab-semester');
    term.replaceChildren();
    data.semesters.forEach(item => {
        const option = document.createElement('option');
        option.value = item.value;
        option.textContent = item.label;
        term.append(option);
    });
    term.value = data.semester || data.semesters[0]?.value || '';
    const list = el('lab-list');
    list.replaceChildren();
    if (!data.items.length) list.textContent = byCourse ? '这个学期暂无课程实验任务' : '这个学期暂无实验项目';
    data.items.forEach(item => {
        const card = document.createElement('article');
        card.className = 'lab-item';
        const title = document.createElement('strong');
        title.textContent = item.cells.filter(Boolean).join(' · ');
        card.append(title);
        const controls = document.createElement('div');
        controls.className = 'lab-actions';
        [['pre', '提交预习报告'], ['report', '提交实验报告']].forEach(([kind, label]) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn-primary';
            button.textContent = label;
            button.disabled = !item[kind];
            if (!item[kind]) button.title = '实验站未提供此报告入口';
            resources.listen(button, 'click', () => {
                pending = { itemId: item.id, kind };
                el('lab-convert').hidden = true;
                el('lab-file').click();
            });
            controls.append(button);
        });
        card.append(controls);
        list.append(card);
    });
    el('lab-results').hidden = false;
}

export async function loadLabPage() {
    const operation = resources.capture();
    el('lab-results').hidden = true;
    el('lab-convert').hidden = true;
    pending = null;
    message('正在检查会员和实验站密码状态…');
    try {
        const state = await operation.wait(api('/api/lab/status'));
        el('lab-student').textContent = state.student_id;
        el('lab-bound').textContent = state.password_bound ? '已绑定实验站密码' : '未绑定实验站密码';
        el('lab-unbind').disabled = !state.password_bound;
        el('lab-password').value = '';
        el('lab-save').checked = false;
        message('请输入实验站密码，然后手动点击“查询实验”。验证码将在后台自动识别；已绑定密码可留空。');
    } catch (error) {
            if (error.name === 'AbortError') return;
        message(error.message, true);
    }
}

export function initializeLab() {
    resources.listen(el('lab-convert-reselect'), 'click', () => el('lab-file').click());
    resources.listen(el('lab-query'), 'click', async () => {
    const operation = resources.capture();
        const button = el('lab-query');
        button.disabled = true;
        message('正在登录实验站并查询实验…');
        try {
            const result = await operation.wait(api('/api/lab/query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: el('lab-password').value,
                    bind_password: el('lab-save').checked }),
            }));
            render(result.data);
            el('lab-password').value = '';
            if (el('lab-save').checked) {
                el('lab-bound').textContent = '已绑定实验站密码';
                el('lab-unbind').disabled = false;
            }
            message(resultSummary(result.data));
        } catch (error) {
            if (error.name === 'AbortError') return;
            message(error.message, true);
        } finally { button.disabled = false; }
    });
    resources.listen(el('lab-semester'), 'change', async event => {
    const operation = resources.capture();
        message('正在读取学期实验…');
        try {
            const result = await operation.wait(api(`/api/lab/experiments?semester=${encodeURIComponent(event.target.value)}`));
            render(result.data);
            message(resultSummary(result.data));
        } catch (error) {
            if (error.name === 'AbortError') return; message(error.message, true); }
    });
    resources.listen(el('lab-unbind'), 'click', async () => {
    const operation = resources.capture();
        try {
            await operation.wait(api('/api/lab/credential', { method: 'DELETE' }));
            el('lab-bound').textContent = '未绑定实验站密码';
            el('lab-unbind').disabled = true;
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
            message('请先将文件转换为 PDF，转换后再提交');
            return;
        }
        el('lab-convert').hidden = true;
        if (!file.name.toLowerCase().endsWith('.pdf') || file.size > 20 * 1024 * 1024) {
            message('仅支持 20MB 以内的 PDF 文件', true); return;
        }
        const form = new FormData();
        form.append('item_id', pending.itemId);
        form.append('kind', pending.kind);
        form.append('file', file);
        pending = null;
        message('正在上传，请不要重复点击…');
        try {
            const result = await operation.wait(api('/api/lab/upload', { method: 'POST', body: form }));
            message(result.message);
        } catch (error) {
            if (error.name === 'AbortError') return; message(error.message, true); }
    });
}

export function mountLab() {
    initializeLab();
    return loadLabPage();
}
export function unmountLab() {
    resources.dispose();
    pending = null;
}
