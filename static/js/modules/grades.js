import { pageResources } from './lifecycle.js';
import { closeUiModal, focusUiElement, openUiModal } from './ui.js';
import { state } from './store.js';
import { checkLoginStatus } from './auth.js';
const resources = pageResources('grades');

export function mountGrades() { loadGrades(); }

export function unmountGrades() {
    resources.dispose();
    resources.api.cancelRequest('grades');
    for (const id of ['semester-picker-modal', 'exam-picker-modal']) {
        closeUiModal(document.getElementById(id), { restoreFocus: false });
    }
    state.gradesReturnFocus = null;
}

export function gradesBackToMenu({ restoreFocus = true } = {}) {
    resources.api.cancelRequest('grades');
    const menu = document.getElementById('grades-menu');
    menu.style.display = '';
    document.getElementById('grades-result').style.display = 'none';
    const pageTitle = document.getElementById('grades-page-title');
    if (pageTitle) pageTitle.hidden = false;

    const focusTarget = state.gradesReturnFocus;
    state.gradesReturnFocus = null;
    if (restoreFocus && focusTarget?.isConnected !== false) {
        focusUiElement(focusTarget);
    }
}

export function gradesShowResult(title) {
    const menu = document.getElementById('grades-menu');
    const activeElement = document.activeElement;
    state.gradesReturnFocus = menu.contains?.(activeElement)
        ? activeElement : menu.querySelector?.('.grade-action-btn') || null;
    menu.style.display = 'none';
    const pageTitle = document.getElementById('grades-page-title');
    if (pageTitle) pageTitle.hidden = true;
    const result = document.getElementById('grades-result');
    result.style.display = '';
    document.getElementById('grades-result-title').textContent = title;
    document.getElementById('grades-content').innerHTML = '<div class="loading">加载中</div>';
    result.scrollIntoView?.({ block: 'start' });
    focusUiElement(document.getElementById('grades-back-btn'));
}

export function gradesScoreClass(scoreValue) {
    const score = parseFloat(scoreValue);
    if (isNaN(score)) return 'score-medium';
    if (score >= 90) return 'score-high';
    if (score < 60) return 'score-low';
    return 'score-medium';
}

export function gradesBuildSimpleTable(grades) {
    let html = '<table class="grades-table"><thead><tr><th>课程名称</th><th>成绩</th></tr></thead><tbody>';
    grades.forEach(grade => {
        const scoreClass = gradesScoreClass(grade.score);
        html += `<tr><td>${escapeHtml(grade.course || '-')}</td><td class="${scoreClass}">${escapeHtml(grade.score ?? '-')}</td></tr>`;
    });
    return html + '</tbody></table>';
}

export function gradesFormatExamTime(value) {
    const s = String(value || '').trim();
    return s.length === 8 ? `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` : (s || '-');
}

export function gradesBuildFailedTable(list) {
    let html = '<table class="grades-table"><thead><tr><th>课程名称</th><th>学分</th><th>成绩</th><th>考试时间</th></tr></thead><tbody>';
    list.forEach(g => {
        html += `<tr><td>${escapeHtml(g.course || '-')}</td><td>${escapeHtml(g.credit ?? '-')}</td><td class="score-low">${escapeHtml(g.score ?? '-')}</td><td>${escapeHtml(gradesFormatExamTime(g.exam_time))}</td></tr>`;
    });
    return html + '</tbody></table>';
}

export async function gradesLoadLatestSummary() {
    const operation = resources.capture();
    const request = resources.api.beginRequest('grades');
    const generation = state.academicCacheGeneration;
    const isCurrent = () => request.isCurrent() && generation === state.academicCacheGeneration;
    await operation.wait(checkLoginStatus());
    if (!isCurrent()) return;
    gradesShowResult('一键查本学期成绩');
    try {
        const resp = await operation.wait(resources.api.request('/api/grades/latest_summary', { signal: request.signal }));
        const data = await operation.wait(resp.json());
        if (!isCurrent()) return;
        if (!data.success) {
            document.getElementById('grades-content').innerHTML = `<p style="text-align:center;color:var(--error);">${escapeHtml(data.message || '查询失败')}</p>`;
            return;
        }

        const passed = data.passed || [];
        const failed = data.failed || {};
        const currentFailed = failed.current || [];
        const pastFailed = failed.past || [];
        const semester = data.semester || '最新学期';
        let html = `
            <div class="grade-summary-meta">
                <span>最新学期：${escapeHtml(semester)}</span>
                <span>及格 ${passed.length} 门</span>
                <span>尚不及格 ${currentFailed.length} 门</span>
                <span>曾不及格 ${pastFailed.length} 门</span>
            </div>
        `;

        html += '<div class="failed-section">';
        html += '<div class="failed-section-title passed-latest">最新学期及格成绩</div>';
        html += passed.length ? gradesBuildSimpleTable(passed) : '<p class="grade-summary-empty">最新学期暂无及格成绩数据</p>';
        html += '</div>';

        html += '<div class="failed-section">';
        html += '<div class="failed-section-title failed-current">尚不及格</div>';
        html += currentFailed.length ? gradesBuildFailedTable(currentFailed) : '<p class="grade-summary-empty">暂无尚不及格成绩</p>';
        html += '</div>';

        html += '<div class="failed-section">';
        html += '<div class="failed-section-title failed-past">曾不及格</div>';
        html += pastFailed.length ? gradesBuildFailedTable(pastFailed) : '<p class="grade-summary-empty">暂无曾不及格成绩</p>';
        html += '</div>';

        document.getElementById('grades-content').innerHTML = html;
    } catch (e) {
        if (e?.name === 'AbortError') return;
        if (!isCurrent() || e.name === 'AbortError') return;
        document.getElementById('grades-content').innerHTML = `<p style="text-align:center;color:var(--error);">${escapeHtml(e.message || '加载失败')}</p>`;
    }
}

export async function gradesShowCurrentSemester() {
    const operation = resources.capture();
    const request = resources.api.beginRequest('grades');
    const generation = state.academicCacheGeneration;
    const isCurrent = () => request.isCurrent() && generation === state.academicCacheGeneration;
    await operation.wait(checkLoginStatus());
    if (!isCurrent()) return;
    gradesShowResult('本学期成绩');
    try {
        const resp = await operation.wait(resources.api.request('/api/grades/current', { signal: request.signal }));
        const data = await operation.wait(resp.json());
        if (!isCurrent()) return;
        if (data.success && data.grades && data.grades.length > 0) {
            displayGrades(data.grades);
        } else if (!data.success) {
            document.getElementById('grades-content').innerHTML = `<p style="text-align:center;color:var(--error);">${data.message || '查询失败'}</p>`;
        } else {
            document.getElementById('grades-content').innerHTML = '<p style="text-align:center;color:var(--text-tertiary);">暂无成绩数据</p>';
        }
    } catch (e) {
        if (e?.name === 'AbortError') return;
        if (!isCurrent() || e.name === 'AbortError') return;
        document.getElementById('grades-content').innerHTML = `<p style="text-align:center;color:var(--error);">${escapeHtml(e.message || '加载失败')}</p>`;
    }
}

export async function gradesShowSemesterPicker() {
    const operation = resources.capture();
    const request = resources.api.beginRequest('grades');
    const generation = state.academicCacheGeneration;
    const isCurrent = () => request.isCurrent() && generation === state.academicCacheGeneration;
    await operation.wait(checkLoginStatus());
    if (!isCurrent()) return;
    const modal = document.getElementById('semester-picker-modal');
    const list = document.getElementById('semester-picker-list');
    list.innerHTML = '<div class="loading">加载中...</div>';
    openUiModal(modal);
    try {
        const resp = await operation.wait(resources.api.request('/api/grades/semesters', { signal: request.signal }));
        const data = await operation.wait(resp.json());
        if (!isCurrent()) return;
        if (!data.success) {
            list.innerHTML = `<p style="color:var(--error);text-align:center;">${escapeHtml(data.message || '查询失败')}</p>`;
            return;
        }
        if (!Array.isArray(data.semesters) || data.semesters.length === 0) {
            list.innerHTML = '<p style="color:var(--text-tertiary);text-align:center;">暂无学期数据</p>';
            return;
        }
        list.innerHTML = data.semesters.map(s => `
            <button class="semester-option-btn" data-semester="${escapeHtml(s)}" onclick="gradesPickSemester(this.dataset.semester)">${escapeHtml(s)}</button>
        `).join('');
    } catch (e) {
        if (e?.name === 'AbortError') return;
        if (!isCurrent() || e.name === 'AbortError') return;
        list.innerHTML = `<p style="color:var(--error);text-align:center;">${escapeHtml(e.message || '加载失败')}</p>`;
    }
}

export function closeSemesterPicker() {
    resources.api.cancelRequest('grades');
    closeUiModal(document.getElementById('semester-picker-modal'));
}

export async function gradesPickSemester(semester) {
    const operation = resources.capture();
    closeSemesterPicker();
    const request = resources.api.beginRequest('grades');
    const generation = state.academicCacheGeneration;
    const isCurrent = () => request.isCurrent() && generation === state.academicCacheGeneration;
    gradesShowResult(`及格成绩（${semester}）`);
    try {
        const resp = await operation.wait(resources.api.request(`/api/grades/by_semester?semester=${encodeURIComponent(semester)}`, { signal: request.signal }));
        const data = await operation.wait(resp.json());
        if (!isCurrent()) return;
        if (!data.success) {
            document.getElementById('grades-content').innerHTML = `<p style="text-align:center;color:var(--error);">${escapeHtml(data.message || '查询失败')}</p>`;
        } else if (Array.isArray(data.grades) && data.grades.length > 0) {
            displayGrades(data.grades);
        } else {
            document.getElementById('grades-content').innerHTML = '<p style="text-align:center;color:var(--text-tertiary);">该学期暂无成绩数据</p>';
        }
    } catch (e) {
        if (e?.name === 'AbortError') return;
        if (!isCurrent() || e.name === 'AbortError') return;
        document.getElementById('grades-content').innerHTML = `<p style="text-align:center;color:var(--error);">${escapeHtml(e.message || '加载失败')}</p>`;
    }
}

export async function gradesLoadFailed() {
    const operation = resources.capture();
    const request = resources.api.beginRequest('grades');
    const generation = state.academicCacheGeneration;
    const isCurrent = () => request.isCurrent() && generation === state.academicCacheGeneration;
    await operation.wait(checkLoginStatus());
    if (!isCurrent()) return;
    gradesShowResult('不及格成绩');
    try {
        const resp = await operation.wait(resources.api.request('/api/grades/failed', { signal: request.signal }));
        const data = await operation.wait(resp.json());
        if (!isCurrent()) return;
        if (!data.success) {
            document.getElementById('grades-content').innerHTML = `<p style="text-align:center;color:var(--error);">${escapeHtml(data.message || '查询失败')}</p>`;
            return;
        }
        const current = data.current || [];
        const past = data.past || [];
        if (current.length === 0 && past.length === 0) {
            document.getElementById('grades-content').innerHTML = '<p style="text-align:center;color:var(--text-tertiary);">没有不及格成绩，继续加油！</p>';
            return;
        }
        let html = '';
        if (current.length > 0) {
            html += `<div class="failed-section"><div class="failed-section-title failed-current">尚不及格</div>${gradesBuildFailedTable(current)}</div>`;
        }
        if (past.length > 0) {
            html += `<div class="failed-section"><div class="failed-section-title failed-past">曾不及格</div>${gradesBuildFailedTable(past)}</div>`;
        }
        document.getElementById('grades-content').innerHTML = html;
    } catch (e) {
        if (e?.name === 'AbortError') return;
        if (!isCurrent() || e.name === 'AbortError') return;
        document.getElementById('grades-content').innerHTML = `<p style="text-align:center;color:var(--error);">${escapeHtml(e.message || '加载失败')}</p>`;
    }
}

export function buildGpaDetailTable(details) {
    if (!Array.isArray(details) || details.length === 0) {
        return '';
    }

    const rows = details.filter(row => row && typeof row === 'object' && Object.keys(row).length > 0);
    if (rows.length === 0) {
        return '';
    }

    const preferredColumns = ['学年学期', '学分绩点', '学位绩点', '加权学分学位绩点', '学年', '学期', '平均学分绩点', '平均学位绩点', '总学分', '获得学分', '学分'];
    const allColumns = Array.from(new Set(rows.flatMap(row => Object.keys(row))));
    const columns = [
        ...preferredColumns.filter(column => allColumns.includes(column)),
        ...allColumns.filter(column => !preferredColumns.includes(column))
    ];

    let html = '<div class="gpa-detail-card">';
    html += '<h3 class="gpa-title">学期绩点明细</h3>';
    html += '<div class="grades-table-wrap"><table class="grades-table gpa-detail-table"><thead><tr>';
    columns.forEach(column => {
        html += `<th>${escapeHtml(column)}</th>`;
    });
    html += '</tr></thead><tbody>';
    rows.forEach(row => {
        html += '<tr>';
        columns.forEach(column => {
            html += `<td>${escapeHtml(row[column])}</td>`;
        });
        html += '</tr>';
    });
    html += '</tbody></table></div></div>';
    return html;
}

export async function gradesLoadGpa() {
    const operation = resources.capture();
    const request = resources.api.beginRequest('grades');
    const generation = state.academicCacheGeneration;
    const isCurrent = () => request.isCurrent() && generation === state.academicCacheGeneration;
    await operation.wait(checkLoginStatus());
    if (!isCurrent()) return;
    gradesShowResult('学分绩点');
    try {
        const resp = await operation.wait(resources.api.request('/api/grades/gpa', { signal: request.signal }));
        const data = await operation.wait(resp.json());
        if (!isCurrent()) return;
        if (!data.success) {
            document.getElementById('grades-content').innerHTML = `<p style="text-align:center;color:var(--error);">${escapeHtml(data.message || '查询失败')}</p>`;
            return;
        }
        const gpa = data.gpa || {};
        const creditGpa = gpa['学分绩点'];
        const degreeGpa = gpa['学位绩点'];
        const weightedGpa = gpa['加权学分学位绩点'];
        const semesterDetails = gpa['学期绩点明细'] || gpa.semester_details || [];
        let html = '<div class="gpa-info-card"><h3 class="gpa-title">绩点信息</h3><div class="gpa-items">';
        if (creditGpa !== null && creditGpa !== undefined) {
            html += `<div class="gpa-item"><span class="gpa-label">学分绩点</span><span class="gpa-value">${escapeHtml(creditGpa)}</span></div>`;
        }
        if (degreeGpa !== null && degreeGpa !== undefined) {
            html += `<div class="gpa-item"><span class="gpa-label">学位绩点</span><span class="gpa-value">${escapeHtml(degreeGpa)}</span></div>`;
        }
        if (weightedGpa !== null && weightedGpa !== undefined) {
            html += `<div class="gpa-item"><span class="gpa-label">加权学分学位绩点</span><span class="gpa-value">${escapeHtml(weightedGpa)}</span></div>`;
        }
        if ((creditGpa === null || creditGpa === undefined) && (degreeGpa === null || degreeGpa === undefined) && (weightedGpa === null || weightedGpa === undefined)) {
            html += '<p class="gpa-empty">暂未查询到总体绩点</p>';
        }
        html += '</div></div>';
        html += buildGpaDetailTable(semesterDetails);
        document.getElementById('grades-content').innerHTML = html;
    } catch (e) {
        if (e?.name === 'AbortError') return;
        if (!isCurrent() || e.name === 'AbortError') return;
        document.getElementById('grades-content').innerHTML = `<p style="text-align:center;color:var(--error);">${escapeHtml(e.message || '加载失败')}</p>`;
    }
}

export async function gradesShowExamPicker() {
    const operation = resources.capture();
    const request = resources.api.beginRequest('grades');
    const generation = state.academicCacheGeneration;
    const isCurrent = () => request.isCurrent() && generation === state.academicCacheGeneration;
    await operation.wait(checkLoginStatus());
    if (!isCurrent()) return;
    const modal = document.getElementById('exam-picker-modal');
    document.getElementById('exam-picker-title').textContent = '选择学期';
    const body = document.getElementById('exam-picker-body');
    body.innerHTML = '<div class="loading">加载中...</div>';
    openUiModal(modal);

    if (!state._examSessions) {
        try {
            const resp = await operation.wait(resources.api.request('/api/grades/exam_sessions', { signal: request.signal }));
            const data = await operation.wait(resp.json());
            if (!isCurrent()) return;
            if (!data.success) {
                body.innerHTML = `<p style="color:var(--error);text-align:center;">${data.message || '加载失败'}</p>`;
                return;
            }
            state._examSessions = data;
        } catch (e) {
        if (e?.name === 'AbortError') return;
            if (!isCurrent() || e.name === 'AbortError') return;
            body.innerHTML = `<p style="color:var(--error);text-align:center;">${escapeHtml(e.message || '加载失败')}</p>`;
            return;
        }
    }

    // 倒序取最新 8 个学期
    const semesters = [...state._examSessions.semesters].reverse().slice(0, 8);
    body.innerHTML = semesters.map(s =>
        `<button class="semester-option-btn" data-semester-id="${escapeHtml(s.value)}" data-semester-label="${escapeHtml(s.text)}" onclick="examPickSemester(this.dataset.semesterId, this.dataset.semesterLabel)">${escapeHtml(s.text)}</button>`
    ).join('');
}

export function examPickSemester(jxzxjh, semesterText) {
    document.getElementById('exam-picker-title').textContent = semesterText;
    const exams = (state._examSessions.exams || []).filter(e => e.jxzxjh === jxzxjh);
    const body = document.getElementById('exam-picker-body');
    if (exams.length === 0) {
        body.innerHTML = '<p style="color:var(--text-tertiary);text-align:center;">该学期暂无考试记录</p>';
        return;
    }
    body.innerHTML = exams.map(e =>
        `<button class="semester-option-btn" data-semester-id="${escapeHtml(e.jxzxjh)}" data-exam-id="${escapeHtml(e.ksbh)}" data-exam-name="${escapeHtml(e.name)}" onclick="examPickExam(this.dataset.semesterId, this.dataset.examId, this.dataset.examName)">${escapeHtml(e.name)}</button>`
    ).join('');
}

export async function examPickExam(jxzxjh, ksbh, examName) {
    const operation = resources.capture();
    closeExamPicker();
    const request = resources.api.beginRequest('grades');
    const generation = state.academicCacheGeneration;
    const isCurrent = () => request.isCurrent() && generation === state.academicCacheGeneration;
    gradesShowResult(examName);
    try {
        const resp = await operation.wait(resources.api.request(`/api/grades/exam_scores?jxzxjh=${encodeURIComponent(jxzxjh)}&ksbh=${encodeURIComponent(ksbh)}`, {
            signal: request.signal
        }));
        const data = await operation.wait(resp.json());
        if (!isCurrent()) return;
        if (!data.success) {
            document.getElementById('grades-content').innerHTML = `<p style="text-align:center;color:var(--error);">${escapeHtml(data.message || '查询失败')}</p>`;
            return;
        }
        if (!data.grades || data.grades.length === 0) {
            document.getElementById('grades-content').innerHTML = '<p style="text-align:center;color:var(--text-tertiary);">暂无成绩数据</p>';
            return;
        }
        let html = '<table class="grades-table"><thead><tr><th>课程名称</th><th>学分</th><th>成绩</th></tr></thead><tbody>';
        data.grades.forEach(g => {
            const scoreClass = (parseFloat(g.score) < 60) ? 'score-low' : '';
            html += `<tr><td>${escapeHtml(g.course)}</td><td>${escapeHtml(g.credit)}</td><td class="${scoreClass}">${escapeHtml(g.score ?? '-')}</td></tr>`;
        });
        html += '</tbody></table>';
        document.getElementById('grades-content').innerHTML = html;
    } catch (e) {
        if (e?.name === 'AbortError') return;
        if (!isCurrent() || e.name === 'AbortError') return;
        document.getElementById('grades-content').innerHTML = `<p style="text-align:center;color:var(--error);">${escapeHtml(e.message || '加载失败')}</p>`;
    }
}

export function closeExamPicker() {
    resources.api.cancelRequest('grades');
    closeUiModal(document.getElementById('exam-picker-modal'));
}

export function loadGrades() {
    gradesBackToMenu({ restoreFocus: false });
}

export function displayGrades(grades) {
    const contentDiv = document.getElementById('grades-content');

    // 分离出学分绩点和学位绩点
    let creditGpa = null;
    let degreeGpa = null;
    const courseGrades = [];

    grades.forEach(grade => {
        const courseName = String(grade.course ?? '').trim();
        if (courseName === '学分绩点') {
            creditGpa = grade.score;
        } else if (courseName === '学位绩点') {
            degreeGpa = grade.score;
        } else {
            courseGrades.push(grade);
        }
    });

    // 构建课程成绩表格
    let html = '<table class="grades-table"><thead><tr>';
    html += '<th>课程名称</th><th>成绩</th>';
    html += '</tr></thead><tbody>';

    courseGrades.forEach(grade => {
        // 根据成绩设置颜色
        let scoreClass = 'score-medium';
        const score = parseFloat(grade.score);
        if (!isNaN(score)) {
            if (score >= 90) scoreClass = 'score-high';
            else if (score < 60) scoreClass = 'score-low';
        }

        html += `
            <tr>
                <td>${escapeHtml(grade.course)}</td>
                <td class="${scoreClass}">${escapeHtml(grade.score)}</td>
            </tr>
        `;
    });

    html += '</tbody></table>';

    // 添加绩点信息卡片
    if (creditGpa !== null || degreeGpa !== null) {
        html += '<div class="gpa-info-card">';
        html += '<h3 class="gpa-title">绩点信息</h3>';
        html += '<div class="gpa-items">';

        if (creditGpa !== null) {
            html += `
                <div class="gpa-item">
                    <span class="gpa-label">学分绩点</span>
                    <span class="gpa-value">${escapeHtml(creditGpa)}</span>
                </div>
            `;
        }

        if (degreeGpa !== null) {
            html += `
                <div class="gpa-item">
                    <span class="gpa-label">学位绩点</span>
                    <span class="gpa-value">${escapeHtml(degreeGpa)}</span>
                </div>
            `;
        }

        html += '</div></div>';
    }

    contentDiv.innerHTML = html;
}
