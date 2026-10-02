import { pageResources } from './lifecycle.js';
import { checkLoginStatus, getDeviceId } from './auth.js';
import { state } from './store.js';
import { showUiToast } from './ui.js';
const resources = pageResources('evaluation');

export function mountEvaluation() {
    document.getElementById('evaluation-result').innerHTML = '';
}
export function unmountEvaluation() { resources.dispose(); }

export async function doFullEvaluation() {
    const operation = resources.capture();
    const scope = resources.capture();
    await operation.wait(checkLoginStatus());
    if (!scope.isActive()) return;
    const resultDiv = document.getElementById('evaluation-result');
    const btn = document.getElementById('do-eval-btn');
    const restoreButton = () => { btn.disabled = false; btn.textContent = '完成教学评估'; };
    const releaseButton = operation.addCleanup(restoreButton);
    btn.disabled = true; btn.textContent = '评估中...';
    resultDiv.innerHTML = '<div class="loading">正在查询未评估课程...</div>';

    try {
        const response = await operation.wait(resources.fetch('/api/unevaluated_courses', { headers: { 'X-Device-ID': getDeviceId() } }));
        const data = await operation.wait(response.json());

        if (!data.success) {
            resultDiv.className = 'evaluation-result result-error';
            resultDiv.textContent = data.message || '查询失败';
            btn.disabled = false; btn.textContent = '完成教学评估'; return;
        }

        if (!data.has_courses) {
            resultDiv.className = 'evaluation-result result-success';
            resultDiv.innerHTML = `<div style="text-align:center;padding:20px;"><div style="font-size:40px;margin-bottom:10px;color:var(--success);">✓</div><div style="font-size:17px;color:var(--success);font-weight:600;">${data.message || '没有未评估的课程'}</div></div>`;
            btn.disabled = false; btn.textContent = '完成教学评估'; return;
        }

        // 显示找到的课程
        let coursesHtml = '<div style="margin-bottom:15px;">';
        data.courses.forEach(course => {
            coursesHtml += `<div style="background:var(--bg-secondary);padding:10px 14px;margin-bottom:6px;border-radius:10px;"><span style="font-weight:600;">${course['未评课程']}</span><span style="color:var(--text-secondary);margin-left:10px;">教师: ${course['教师']}</span></div>`;
        });
        coursesHtml += '</div>';
        resultDiv.innerHTML = coursesHtml + '<div class="loading">正在提交评教...</div>';

        const evalResponse = await operation.wait(resources.fetch('/api/evaluation', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-ID': getDeviceId() }, body: JSON.stringify({ courses: data.courses }) }));
        const evalData = await operation.wait(evalResponse.json());

        if (evalData.success) {
            state.unevaluatedCoursesData = [];
            resultDiv.className = 'evaluation-result result-success';
            resultDiv.innerHTML = `<div style="text-align:center;padding:20px;"><div style="font-size:40px;margin-bottom:10px;color:var(--success);">✓</div><div style="font-size:17px;color:var(--success);font-weight:600;">${evalData.message || '评估成功'}</div></div>`;
        } else {
            resultDiv.className = 'evaluation-result result-error';
            resultDiv.textContent = evalData.message || '评价失败';
        }
    } catch (error) {
        if (error?.name === 'AbortError') return;
        resultDiv.className = 'evaluation-result result-error';
        resultDiv.textContent = '网络错误，请重试';
    } finally {
        releaseButton();
        if (operation.isActive()) restoreButton();
    }
}

export async function checkUnevaluatedCourses() {
    const operation = resources.capture();
    const scope = resources.capture();
    await operation.wait(checkLoginStatus());
    if (!scope.isActive()) return;
    const resultDiv = document.getElementById('evaluation-result');
    resultDiv.innerHTML = '<div class="loading">正在查询未评估课程...</div>';
    try {
        const response = await operation.wait(resources.fetch('/api/unevaluated_courses', { headers: { 'X-Device-ID': getDeviceId() } }));
        const data = await operation.wait(response.json());
        if (data.success) {
            if (data.has_courses) {
                state.unevaluatedCoursesData = data.courses;
                displayUnevaluatedCourses(data.courses);
            } else {
                state.unevaluatedCoursesData = [];
                resultDiv.className = 'evaluation-result result-success';
                resultDiv.innerHTML = `<div style="text-align:center;padding:20px;"><div style="font-size:40px;margin-bottom:10px;color:var(--success);">✓</div><div style="font-size:17px;color:var(--success);font-weight:600;">${data.message}</div></div>`;
            }
        } else {
            resultDiv.className = 'evaluation-result result-error';
            resultDiv.textContent = data.message || '查询失败';
        }
    } catch (error) {
        if (error?.name === 'AbortError') return;
        resultDiv.className = 'evaluation-result result-error';
        resultDiv.textContent = '网络错误，请重试';
    }
}

export function displayUnevaluatedCourses(courses) {
    const resultDiv = document.getElementById('evaluation-result');
    let html = '<div class="unevaluated-courses"><h3 style="margin-bottom:15px;font-weight:600;">未评估课程列表</h3>';
    courses.forEach(course => {
        html += `<div style="background:var(--bg-secondary);padding:14px 16px;margin-bottom:8px;border-radius:12px;"><div style="font-size:15px;font-weight:600;margin-bottom:4px;">${course['未评课程']}</div><div style="font-size:14px;color:var(--text-secondary);">教师: ${course['教师']}</div></div>`;
    });
    html += '<div style="text-align:center;margin-top:20px;"><button class="btn-primary" onclick="doEvaluation()">完成评估</button></div></div>';
    resultDiv.innerHTML = html;
}

export async function doEvaluation() {
    const operation = resources.capture();
    const scope = resources.capture();
    await operation.wait(checkLoginStatus());
    if (!scope.isActive()) return;
    const resultDiv = document.getElementById('evaluation-result');
    if (!state.unevaluatedCoursesData || state.unevaluatedCoursesData.length === 0) {
        showUiToast('没有未评估的课程', 'info');
        return;
    }
    resultDiv.innerHTML = '<div class="loading">正在提交评教...</div>';
    try {
        const response = await operation.wait(resources.fetch('/api/evaluation', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-ID': getDeviceId() }, body: JSON.stringify({ courses: state.unevaluatedCoursesData }) }));
        const data = await operation.wait(response.json());
        if (data.success) {
            state.unevaluatedCoursesData = [];
            resultDiv.className = 'evaluation-result result-success';
            resultDiv.innerHTML = `<div style="text-align:center;padding:20px;"><div style="font-size:40px;margin-bottom:10px;color:var(--success);">✓</div><div style="font-size:17px;color:var(--success);font-weight:600;">${data.message || '评价完成'}</div></div>`;
        } else {
            resultDiv.className = 'evaluation-result result-error';
            resultDiv.textContent = data.message || '评价失败';
        }
    } catch (error) {
        if (error?.name === 'AbortError') return;
        resultDiv.className = 'evaluation-result result-error';
        resultDiv.textContent = '网络错误，请重试';
    }
}

export async function oneClickEvaluation() {
    const operation = resources.capture();
    const scope = resources.capture();
    await operation.wait(checkLoginStatus());
    if (!scope.isActive()) return;
    const resultDiv = document.getElementById('evaluation-result');
    const btn = document.getElementById('one-click-eval-btn');
    const restoreButton = () => { btn.disabled = false; btn.textContent = '一键评教'; };
    const releaseButton = operation.addCleanup(restoreButton);
    btn.disabled = true; btn.textContent = '评教中...';
    resultDiv.innerHTML = '<div class="loading">正在查询未评估课程...</div>';
    try {
        const response = await operation.wait(resources.fetch('/api/unevaluated_courses', { headers: { 'X-Device-ID': getDeviceId() } }));
        const data = await operation.wait(response.json());
        if (!data.success) {
            resultDiv.className = 'evaluation-result result-error';
            resultDiv.textContent = data.message || '查询失败';
            btn.disabled = false; btn.textContent = '一键评教'; return;
        }
        if (!data.has_courses) {
            resultDiv.className = 'evaluation-result result-success';
            resultDiv.innerHTML = `<div style="text-align:center;padding:20px;"><div style="font-size:40px;margin-bottom:10px;color:var(--success);">✓</div><div style="font-size:17px;color:var(--success);font-weight:600;">没有未评估的课程</div></div>`;
            btn.disabled = false; btn.textContent = '一键评教'; return;
        }
        resultDiv.innerHTML = '<div class="loading">正在提交评教...</div>';
        const evalResponse = await operation.wait(resources.fetch('/api/evaluation', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-ID': getDeviceId() }, body: JSON.stringify({ courses: data.courses }) }));
        const evalData = await operation.wait(evalResponse.json());
        if (evalData.success) {
            state.unevaluatedCoursesData = [];
            resultDiv.className = 'evaluation-result result-success';
            resultDiv.innerHTML = `<div style="text-align:center;padding:20px;"><div style="font-size:40px;margin-bottom:10px;color:var(--success);">✓</div><div style="font-size:17px;color:var(--success);font-weight:600;">${evalData.message}</div></div>`;
        } else {
            resultDiv.className = 'evaluation-result result-error';
            resultDiv.textContent = evalData.message || '评价失败';
        }
    } catch (error) {
        if (error?.name === 'AbortError') return;
        resultDiv.className = 'evaluation-result result-error';
        resultDiv.textContent = '网络错误，请重试';
    } finally {
        releaseButton();
        if (operation.isActive()) restoreButton();
    }
}
