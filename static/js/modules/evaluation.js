import { pageResources } from './lifecycle.js';
import { checkLoginStatus, getDeviceId } from './auth.js';
import { state } from './store.js';
import { requestUiConfirmation, showUiToast } from './ui.js';
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
            resultDiv.innerHTML = `<div class="evaluation-success"><div class="evaluation-success-icon"><svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><use href="/static/icons/lucide.svg#circle-check"/></svg></div><div class="evaluation-success-message">${escapeHtml(data.message || '没有未评估的课程')}</div></div>`;
            btn.disabled = false; btn.textContent = '完成教学评估'; return;
        }

        // 显示找到的课程
        let coursesHtml = '<div class="evaluation-course-preview">';
        data.courses.forEach(course => {
            coursesHtml += `<div class="evaluation-course evaluation-course-compact"><span class="evaluation-course-name">${escapeHtml(course['未评课程'])}</span><span class="evaluation-course-teacher evaluation-course-teacher-inline">教师: ${escapeHtml(course['教师'])}</span></div>`;
        });
        coursesHtml += '</div>';
        resultDiv.innerHTML = coursesHtml + '<div class="loading">正在提交评教...</div>';

        const evalResponse = await operation.wait(resources.fetch('/api/evaluation', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-ID': getDeviceId() }, body: JSON.stringify({ courses: data.courses }) }));
        const evalData = await operation.wait(evalResponse.json());

        if (evalData.success) {
            state.unevaluatedCoursesData = [];
            resultDiv.className = 'evaluation-result result-success';
            resultDiv.innerHTML = `<div class="evaluation-success"><div class="evaluation-success-icon"><svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><use href="/static/icons/lucide.svg#circle-check"/></svg></div><div class="evaluation-success-message">${escapeHtml(evalData.message || '评估成功')}</div></div>`;
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
                resultDiv.innerHTML = `<div class="evaluation-success"><div class="evaluation-success-icon"><svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><use href="/static/icons/lucide.svg#circle-check"/></svg></div><div class="evaluation-success-message">${escapeHtml(data.message)}</div></div>`;
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
    let html = '<div class="unevaluated-courses"><h3 class="evaluation-courses-title">未评估课程列表</h3>';
    courses.forEach(course => {
        html += `<div class="evaluation-course"><div class="evaluation-course-name evaluation-course-heading">${escapeHtml(course['未评课程'])}</div><div class="evaluation-course-teacher">教师: ${escapeHtml(course['教师'])}</div></div>`;
    });
    html += '<div class="evaluation-course-actions"><button class="btn-primary" onclick="doEvaluation()">完成评估</button></div></div>';
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
    const courses = [...state.unevaluatedCoursesData];
    const confirmed = await operation.wait(requestUiConfirmation({
        title: '确认完成评估',
        message: `即将对列表中的 ${courses.length} 项待评课程提交默认好评，该操作不可撤销，是否继续？`,
        confirmText: '提交评估',
        danger: true,
    }));
    if (!confirmed || !scope.isActive()) return;
    resultDiv.innerHTML = '<div class="loading">正在提交评教...</div>';
    try {
        const response = await operation.wait(resources.fetch('/api/evaluation', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-ID': getDeviceId() }, body: JSON.stringify({ courses }) }));
        const data = await operation.wait(response.json());
        if (data.success) {
            state.unevaluatedCoursesData = [];
            resultDiv.className = 'evaluation-result result-success';
            resultDiv.innerHTML = `<div class="evaluation-success"><div class="evaluation-success-icon"><svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><use href="/static/icons/lucide.svg#circle-check"/></svg></div><div class="evaluation-success-message">${escapeHtml(data.message || '评价完成')}</div></div>`;
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
    const confirmed = await operation.wait(requestUiConfirmation({
        title: '确认一键评教',
        message: '即将对本学期所有待评教师提交默认好评，该操作不可撤销，是否继续？',
        confirmText: '继续评教',
        danger: true,
    }));
    if (!confirmed || !scope.isActive()) return;
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
            resultDiv.innerHTML = `<div class="evaluation-success"><div class="evaluation-success-icon"><svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><use href="/static/icons/lucide.svg#circle-check"/></svg></div><div class="evaluation-success-message">没有未评估的课程</div></div>`;
            btn.disabled = false; btn.textContent = '一键评教'; return;
        }
        resultDiv.innerHTML = '<div class="loading">正在提交评教...</div>';
        const evalResponse = await operation.wait(resources.fetch('/api/evaluation', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-ID': getDeviceId() }, body: JSON.stringify({ courses: data.courses }) }));
        const evalData = await operation.wait(evalResponse.json());
        if (evalData.success) {
            state.unevaluatedCoursesData = [];
            resultDiv.className = 'evaluation-result result-success';
            resultDiv.innerHTML = `<div class="evaluation-success"><div class="evaluation-success-icon"><svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><use href="/static/icons/lucide.svg#circle-check"/></svg></div><div class="evaluation-success-message">${escapeHtml(evalData.message)}</div></div>`;
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
