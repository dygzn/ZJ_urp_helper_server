import { pageResources } from './lifecycle.js';
import { closeUiModal, focusUiElement, openUiModal } from './ui.js';
import { state } from './store.js';
import { checkLoginStatus } from './auth.js';
const resources = pageResources('grades');

export function mountGrades() {
    const options = document.getElementById('grades-query-options');
    resources.listen(document, 'pointerdown', event => {
        if (options?.open && !options.contains(event.target)) gradesCloseQueryMenu();
    });
    resources.listen(options, 'keydown', event => {
        if (event.key === 'Escape' && options.open) {
            event.preventDefault();
            event.stopPropagation();
            gradesCloseQueryMenu();
            focusUiElement(document.getElementById('grades-query-summary'));
        }
    });
    void gradesLoadDashboard().catch(error => {
        if (error?.name !== 'AbortError') console.error('成绩仪表盘加载失败:', error);
    });
}

export function unmountGrades() {
    gradesCloseQueryMenu();
    resources.dispose();
    resources.api.cancelRequest('grades');
    for (const id of ['semester-picker-modal', 'exam-picker-modal']) {
        closeUiModal(document.getElementById(id), { restoreFocus: false });
    }
    state.gradesReturnFocus = null;
}

export function gradesBackToMenu({ restoreFocus = true } = {}) {
    resources.api.cancelRequest('grades');
    const pageTitle = document.getElementById('grades-page-title');
    if (pageTitle) pageTitle.hidden = false;
    const trigger = state.gradesReturnFocus;
    state.gradesReturnFocus = null;
    const loading = gradesLoadDashboard();
    if (restoreFocus) focusUiElement(trigger?.isConnected !== false ? trigger || pageTitle : pageTitle);
    return loading;
}

export function gradesCloseQueryMenu() {
    const options = document.getElementById('grades-query-options');
    if (options?.open) {
        if (options.querySelector?.('#grades-query-menu')?.contains(document.activeElement)) {
            focusUiElement(document.getElementById('grades-query-summary'));
        }
        options.open = false;
    }
}

export function gradesSelectQuery(query) {
    gradesCloseQueryMenu();
    document.querySelectorAll?.('[data-grade-query]').forEach(button => {
        const selected = button.dataset.gradeQuery === query;
        button.setAttribute('aria-pressed', String(selected));
    });
}

export function gradesShowResult(title) {
    const query = title === '一键查本学期成绩' ? 'summary'
        : title === '学分绩点' ? 'gpa'
        : title === '本学期成绩' ? 'current'
        : title === '不及格成绩' ? 'failed'
        : title.startsWith('及格成绩（') ? 'semester' : 'exam';
    if (query !== 'summary') {
        const active = document.activeElement;
        const menu = document.getElementById('grades-query-menu');
        state.gradesReturnFocus = menu?.contains?.(active)
            ? document.getElementById('grades-query-summary') : active;
    }
    gradesSelectQuery(query);
    const back = document.getElementById('grades-result-back');
    if (back) back.hidden = query === 'summary';
    const pageTitle = document.getElementById('grades-page-title');
    if (pageTitle) pageTitle.hidden = false;
    const result = document.getElementById('grades-result');
    result.style.display = '';
    document.getElementById('grades-result-title').textContent = title;
    const descriptions = {
        summary: '汇总最新学期成绩，并自动查询最新补考状态和最近已发布的补考成绩。',
        gpa: '总体学分绩点、学位绩点、加权学分学位绩点与各学期明细。',
        current: '教务系统里面的本学期成绩，查询未开放时可使用“一键查本学期成绩”。',
        failed: '全部学期的不及格记录：“尚不及格”为仍未通过，“曾不及格”为后续已通过的历史记录。',
        semester: '教务系统成绩总览中所选学期的及格成绩；不及格和补考记录可通过其他查询查看。',
        exam: '所选考试场次的成绩，空白成绩表示暂未发布。',
    };
    const description = document.getElementById('grades-result-description');
    if (description) description.textContent = descriptions[query];
    document.getElementById('grades-content').innerHTML = '<div class="loading">加载中</div>';
}

export function gradesCurrentSemesterGpa(gpa = {}, semester = '') {
    const details = Array.isArray(gpa['学期绩点明细'])
        ? gpa['学期绩点明细']
        : Array.isArray(gpa.semester_details) ? gpa.semester_details : [];
    const cnTerms = { '一': 1, '二': 2, '三': 3, '四': 4 };
    const semesterKey = (row, index) => {
        const text = String(row?.['学年学期'] || '');
        const years = Array.from(text.matchAll(/(?:19|20)\d{2}/g), match => Number(match[0]));
        const year = years.length ? Math.max(...years) : -1;
        const termMatch = text.match(/第\s*([一二三四\d]+)\s*学期/) || text.match(/\d{4}-\d{4}-([1-4])(?:-|$)/);
        const rawTerm = termMatch?.[1] || '';
        const term = /^\d+$/.test(rawTerm) ? Number(rawTerm)
            : cnTerms[rawTerm] || (/[下春]/.test(text) ? 2 : /[上秋]/.test(text) ? 1 : 0);
        return [year, term, index];
    };
    if (semester) {
        const [year, term] = semesterKey({ '学年学期': semester }, 0);
        const matched = details.find(row => {
            const [rowYear, rowTerm] = semesterKey(row, 0);
            return year >= 0 && term > 0 && rowYear === year && rowTerm === term;
        });
        return matched?.['学分绩点'] ?? matched?.['平均学分绩点'] ?? null;
    }
    const latest = details.reduce((selected, row, index) => {
        if (!row || typeof row !== 'object') return selected;
        if (!selected) return { row, key: semesterKey(row, index) };
        const key = semesterKey(row, index);
        for (let part = 0; part < key.length; part++) {
            if (key[part] === selected.key[part]) continue;
            return key[part] > selected.key[part] ? { row, key } : selected;
        }
        return selected;
    }, null)?.row || {};
    return latest['学分绩点'] ?? latest['平均学分绩点'] ?? gpa['学分绩点'] ?? null;
}

export function gradesTotalCredits(grades = []) {
    const total = grades.reduce((sum, grade) => {
        const credit = Number.parseFloat(grade?.credit);
        return Number.isFinite(credit) ? sum + credit : sum;
    }, 0);
    return Math.round(total * 100) / 100;
}

export function renderGradesDashboard(summaryData, gpaData, makeupData) {
    const grades = Array.isArray(summaryData?.passed) ? summaryData.passed : [];
    const failed = summaryData?.failed || {};
    const currentFailed = Array.isArray(failed.current) ? failed.current : [];
    const gpa = gradesCurrentSemesterGpa(gpaData?.gpa || {}, summaryData?.semester || '');
    const hasAllCredits = grades.length > 0 && grades.every(grade => grade.credit !== ''
        && grade.credit != null && Number.isFinite(Number(grade.credit)));
    const credits = hasAllCredits ? gradesTotalCredits(grades) : null;
    const gpaNode = document.getElementById('grades-kpi-gpa');
    const creditsNode = document.getElementById('grades-kpi-credits');
    const failedNode = document.getElementById('grades-kpi-failed');
    const semesterNode = document.getElementById('grades-kpi-semester');
    if (semesterNode) semesterNode.textContent = summaryData?.semester || '最新成绩学期';
    if (gpaNode) gpaNode.textContent = gpa === null || gpa === '' ? '-' : String(gpa);
    if (creditsNode) creditsNode.textContent = credits !== null ? String(credits) : '-';
    if (failedNode) failedNode.textContent = String(currentFailed.length);
    failedNode?.parentElement?.classList?.toggle('has-failures', currentFailed.length > 0);
    document.getElementById('grades-content').innerHTML = gradesBuildLatestSummary(summaryData)
        + gradesBuildMakeupSummary(makeupData);
}

export async function gradesLoadDashboard() {
    const operation = resources.capture();
    const request = resources.api.beginRequest('grades');
    const generation = state.academicCacheGeneration;
    const isCurrent = () => request.isCurrent() && generation === state.academicCacheGeneration;
    document.getElementById('grades-content').innerHTML = '<div class="loading">加载中...</div>';
    await operation.wait(checkLoginStatus());
    if (!isCurrent()) return;
    gradesShowResult('一键查本学期成绩');
    for (const id of ['grades-kpi-gpa', 'grades-kpi-credits', 'grades-kpi-failed']) {
        const node = document.getElementById(id);
        if (node) node.textContent = '-';
    }
    try {
        const load = async (url, timeout = 10000) => {
            try {
                const response = await resources.api.request(url, { signal: request.signal, timeout });
                return await response.json();
            } catch (error) {
                if (error?.name === 'AbortError') throw error;
                return { success: false, message: error?.message || '加载失败' };
            }
        };
        let summaryData = null;
        let gpaData = {};
        let makeupData = null;
        const render = () => {
            if (!isCurrent()) return;
            if (summaryData?.success) {
                renderGradesDashboard(summaryData, gpaData, makeupData);
            } else {
                document.getElementById('grades-content').innerHTML = (summaryData
                    ? `<p class="grade-summary-empty result-error">${escapeHtml(summaryData.message || '成绩查询失败')}</p>`
                    : '<div class="loading">正在读取本学期成绩…</div>') + gradesBuildMakeupSummary(makeupData);
            }
        };
        render();
        await operation.wait(Promise.all([
            load('/api/grades/latest_summary').then(data => { summaryData = data; render(); }),
            load('/api/grades/gpa').then(data => { gpaData = data; render(); }),
            load('/api/grades/latest_makeup', 30000).then(data => { makeupData = data; render(); }),
        ]));
    } catch (error) {
        if (error?.name === 'AbortError' || !isCurrent()) return;
        document.getElementById('grades-content').innerHTML = `<p class="grade-summary-empty result-error">${escapeHtml(error.message || '加载失败')}</p>`;
    }
}

export function gradesChangeView(value) {
    if (value === 'failed') return gradesLoadFailed();
    return gradesLoadDashboard();
}

export function gradesScoreClass(scoreValue) {
    const score = parseFloat(scoreValue);
    if (isNaN(score)) return 'score-medium';
    if (score >= 90) return 'score-high';
    if (score < 60) return 'score-low';
    return 'score-medium';
}

export function gradesBuildSimpleTable(grades) {
    const hasCredit = grades.some(grade => grade.credit !== null
        && grade.credit !== undefined && String(grade.credit).trim() !== '');
    let html = `<div class="grades-table-wrap"><table class="grades-table grades-course-table"><thead><tr><th>课程名称</th>${hasCredit ? '<th>学分</th>' : ''}<th>成绩</th></tr></thead><tbody>`;
    grades.forEach(grade => {
        const scoreClass = gradesScoreClass(grade.score);
        html += `<tr><td>${escapeHtml(grade.course || '-')}</td>${hasCredit ? `<td>${escapeHtml(grade.credit ?? '-')}</td>` : ''}<td class="${scoreClass}">${escapeHtml(grade.score ?? '-')}</td></tr>`;
    });
    return html + '</tbody></table></div>';
}

export function gradesFormatExamTime(value) {
    const s = String(value || '').trim();
    return s.length === 8 ? `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` : (s || '-');
}

export function gradesBuildFailedTable(list) {
    let html = '<table class="grades-table grades-failed-table"><thead><tr><th>课程名称</th><th>学分</th><th>成绩</th><th>考试时间</th></tr></thead><tbody>';
    list.forEach(g => {
        html += `<tr><td>${escapeHtml(g.course || '-')}</td><td>${escapeHtml(g.credit ?? '-')}</td><td class="score-low">${escapeHtml(g.score ?? '-')}</td><td>${escapeHtml(gradesFormatExamTime(g.exam_time))}</td></tr>`;
    });
    return html + '</tbody></table>';
}

export function gradesBuildLatestSummary(data = {}) {
    const passed = Array.isArray(data.passed) ? data.passed : [];
    const failed = data.failed || {};
    const currentFailed = Array.isArray(failed.current) ? failed.current : [];
    const pastFailed = Array.isArray(failed.past) ? failed.past : [];
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
    return html;
}

export function gradesBuildMakeupSummary(data = {}) {
    if (data === null) {
        return '<section class="makeup-summary"><h3>补考成绩</h3><p class="loading" role="status">正在查询补考场次与成绩…</p></section>';
    }
    if (!data?.success) {
        return '<section class="makeup-summary"><h3>补考成绩</h3><p class="grade-summary-empty">补考成绩暂时无法查询，不影响本学期成绩。</p></section>';
    }
    const latest = data.latest_session;
    const published = data.latest_published;
    let html = '<section class="makeup-summary"><h3>补考成绩</h3>';
    if (!latest) {
        return html + '<p class="grade-summary-empty">暂未发现补考场次。</p></section>';
    }
    const label = escapeHtml(latest.label || '最新学期');
    const status = latest.status === 'error' ? `${label}补考查询失败，请稍后重试`
        : latest.status === 'partial' ? `${label}补考仅查询到部分场次`
        : latest.status === 'published'
        ? `${label}补考已查询到成绩`
        : latest.status === 'pending'
            ? `${label}补考成绩暂未发布`
            : `${label}补考暂无成绩`;
    html += `<p class="makeup-status">${status}</p>`;
    if (latest.pending_count) html += `<p class="grade-summary-empty">${Number(latest.pending_count) || 0} 条课程成绩暂未发布。</p>`;
    if (Array.isArray(latest.pending_results) && latest.pending_results.length) {
        html += gradesBuildMakeupTable(latest.pending_results);
    }
    if (data.errors?.length) html += '<p class="grade-summary-empty">部分场次查询失败，以下结果可能不完整。</p>';
    if (data.truncated) html += '<p class="grade-summary-empty">已查询最近部分补考学期，更早记录请按考试场次手动查询。</p>';
    if (!published || !Array.isArray(published.results) || !published.results.length) {
        return html + '<p class="grade-summary-empty">可在“其他查询”中按考试场次手动查看。</p></section>';
    }
    html += '<div class="makeup-published-heading"><h4>最近一次已发布的补考成绩</h4>';
    html += `<span>${escapeHtml(published.label || '')}</span></div>`;
    return html + gradesBuildMakeupTable(published.results) + '</section>';
}

export function gradesBuildMakeupTable(results) {
    let html = '<div class="grades-table-wrap"><table class="grades-table makeup-results-table"><thead><tr><th>课程名称</th><th>学分</th><th>成绩</th><th>考试场次</th></tr></thead><tbody>';
    results.forEach(row => {
        const sessions = Array.isArray(row.sessions) ? row.sessions.join('、') : '';
        const score = row.score === '' || row.score == null ? '暂未发布' : row.score;
        html += `<tr><td>${escapeHtml(row.course || '-')}</td><td>${escapeHtml(row.credit ?? '-')}</td><td class="${gradesScoreClass(row.score)}">${escapeHtml(score)}</td><td>${escapeHtml(sessions || '-')}</td></tr>`;
    });
    return html + '</tbody></table></div>';
}

export async function gradesLoadLatestSummary() {
    return gradesLoadDashboard();
}

export async function gradesShowCurrentSemester() {
    const operation = resources.capture();
    const request = resources.api.beginRequest('grades');
    const generation = state.academicCacheGeneration;
    const isCurrent = () => request.isCurrent() && generation === state.academicCacheGeneration;
    document.getElementById('grades-content').innerHTML = '<div class="loading">加载中...</div>';
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
            document.getElementById('grades-content').innerHTML = `<p style="text-align:center;color:var(--error);">${escapeHtml(data.message || '查询失败')}</p>`;
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
    gradesCloseQueryMenu();
    const operation = resources.capture();
    const request = resources.api.beginRequest('grades-picker');
    const generation = state.academicCacheGeneration;
    const isCurrent = () => request.isCurrent() && generation === state.academicCacheGeneration;
    const modal = document.getElementById('semester-picker-modal');
    const list = document.getElementById('semester-picker-list');
    list.innerHTML = '<div class="loading">加载中...</div>';
    openUiModal(modal);
    await operation.wait(checkLoginStatus());
    if (!isCurrent()) return;
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
    resources.api.cancelRequest('grades-picker');
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
    document.getElementById('grades-content').innerHTML = '<div class="loading">加载中...</div>';
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
            html += `<td data-label="${escapeHtml(column)}"><span class="gpa-cell-value">${escapeHtml(row[column])}</span></td>`;
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
    document.getElementById('grades-content').innerHTML = '<div class="loading">加载中...</div>';
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

function renderExamSemesterList() {
    document.getElementById('exam-picker-title').textContent = '选择学期';
    const body = document.getElementById('exam-picker-body');
    const semesters = [...(state._examSessions?.semesters || [])].sort((a, b) => b.value.localeCompare(a.value));
    if (semesters.length === 0) {
        body.innerHTML = '<p style="color:var(--text-tertiary);text-align:center;">暂无学期数据</p>';
        return;
    }
    body.innerHTML = semesters.map(s =>
        `<button class="semester-option-btn" type="button" data-semester-id="${escapeHtml(s.value)}" data-semester-label="${escapeHtml(s.text)}" onclick="examPickSemester(this.dataset.semesterId, this.dataset.semesterLabel)">${escapeHtml(s.text)}</button>`
    ).join('');
}

export function examBackToSemesters() {
    renderExamSemesterList();
    document.querySelector('#exam-picker-body .semester-option-btn')?.focus?.({ preventScroll: true });
}

export async function gradesShowExamPicker() {
    gradesCloseQueryMenu();
    const operation = resources.capture();
    const request = resources.api.beginRequest('grades-picker');
    const generation = state.academicCacheGeneration;
    const isCurrent = () => request.isCurrent() && generation === state.academicCacheGeneration;
    const modal = document.getElementById('exam-picker-modal');
    document.getElementById('exam-picker-title').textContent = '选择学期';
    const body = document.getElementById('exam-picker-body');
    body.innerHTML = '<div class="loading">加载中...</div>';
    openUiModal(modal);
    await operation.wait(checkLoginStatus());
    if (!isCurrent()) return;

    if (!state._examSessions) {
        try {
            const resp = await operation.wait(resources.api.request('/api/grades/exam_sessions', { signal: request.signal }));
            const data = await operation.wait(resp.json());
            if (!isCurrent()) return;
            if (!data.success) {
                body.innerHTML = `<p style="color:var(--error);text-align:center;">${escapeHtml(data.message || '加载失败')}</p>`;
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

    // 保留全部历史学期，按学年与学期排序，而非依赖服务器选项顺序。
    renderExamSemesterList();
}

export function examPickSemester(jxzxjh, semesterText) {
    document.getElementById('exam-picker-title').textContent = semesterText;
    const exams = (state._examSessions.exams || []).filter(e => e.jxzxjh === jxzxjh);
    const body = document.getElementById('exam-picker-body');
    const backBtn = '<button class="in-page-back" type="button" onclick="examBackToSemesters()" style="margin-bottom:12px;">← 返回选择学期</button>';
    if (exams.length === 0) {
        body.innerHTML = `${backBtn}<p style="color:var(--text-tertiary);text-align:center;">该学期暂无考试记录</p>`;
        return;
    }
    body.innerHTML = backBtn + exams.map(e =>
        `<button class="semester-option-btn" type="button" data-semester-id="${escapeHtml(e.jxzxjh)}" data-exam-id="${escapeHtml(e.ksbh)}" data-exam-name="${escapeHtml(e.name)}" onclick="examPickExam(this.dataset.semesterId, this.dataset.examId, this.dataset.examName)">${escapeHtml(e.name)}</button>`
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
        let html = '<div class="grades-table-wrap"><table class="grades-table grades-course-table"><thead><tr><th>课程名称</th><th>学分</th><th>成绩</th></tr></thead><tbody>';
        data.grades.forEach(g => {
            const scoreClass = typeof gradesScoreClass === 'function' ? gradesScoreClass(g.score) : ((parseFloat(g.score) < 60) ? 'score-low' : '');
            html += `<tr><td>${escapeHtml(g.course)}</td><td>${escapeHtml(g.credit)}</td><td class="${scoreClass}">${escapeHtml(g.score === '' || g.score == null ? '暂未发布' : g.score)}</td></tr>`;
        });
        html += '</tbody></table></div>';
        document.getElementById('grades-content').innerHTML = html;
    } catch (e) {
        if (e?.name === 'AbortError') return;
        if (!isCurrent() || e.name === 'AbortError') return;
        document.getElementById('grades-content').innerHTML = `<p style="text-align:center;color:var(--error);">${escapeHtml(e.message || '加载失败')}</p>`;
    }
}

export function closeExamPicker() {
    resources.api.cancelRequest('grades-picker');
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
    const hasCredit = courseGrades.some(grade => grade.credit !== null
        && grade.credit !== undefined && String(grade.credit).trim() !== '');
    let html = '<div class="grades-table-wrap"><table class="grades-table grades-course-table"><thead><tr>';
    html += `<th>课程名称</th>${hasCredit ? '<th>学分</th>' : ''}<th>成绩</th>`;
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
                ${hasCredit ? `<td>${escapeHtml(grade.credit ?? '-')}</td>` : ''}
                <td class="${scoreClass}">${escapeHtml(grade.score)}</td>
            </tr>
        `;
    });

    html += '</tbody></table></div>';

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
