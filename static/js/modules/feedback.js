import { pageResources } from './lifecycle.js';
import { getDeviceId } from './auth.js';
import { showUiToast } from './ui.js';
const resources = pageResources('feedback');

export function mountFeedback() { return loadFeedbackPage(); }
export function unmountFeedback() { resources.dispose(); }

export function formatFeedbackContent(value) {
    return escapeHtml(value).replace(/\n/g, '<br>');
}

export function formatFeedbackTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return '';
    }
    return date.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

export function renderRetryState(container, message, retry) {
    if (!container) return;
    container.innerHTML = `
        <div class="ui-retry-state" role="alert">
            <p>${escapeHtml(message || '加载失败')}</p>
            <button class="btn-secondary" type="button">重新加载</button>
        </div>`;
    const retryButton = container.querySelector('.ui-retry-state button');
    if (retryButton && typeof retry === 'function') {
        retryButton.addEventListener('click', () => { void retry(); });
    }
}

export async function loadFeedbackPage() {
    const operation = resources.capture();
    const contentDiv = document.getElementById('feedback-list-content');
    contentDiv.innerHTML = '<div class="loading">加载中...</div>';

    try {
        const response = await operation.wait(resources.fetch('/api/feedback', {
            headers: {
                'X-Device-ID': getDeviceId()
            }
        }));
        const data = await operation.wait(response.json());

        if (data.success) {
            displayFeedbackList(data.my_feedbacks || [], data.public_feedbacks || []);
        } else {
            renderRetryState(contentDiv, data.message || '反馈加载失败', loadFeedbackPage);
        }
    } catch (error) {
        if (error?.name === 'AbortError') return;
        console.error('加载反馈列表失败:', error);
        renderRetryState(contentDiv, '反馈加载失败，请重试', loadFeedbackPage);
    }
}

export async function submitNewFeedback() {
    const operation = resources.capture();
    const contentInput = document.getElementById('new-feedback-content');
    if (!contentInput) return;
    const content = contentInput.value.trim();
    const visibility = document.querySelector('input[name="feedback-visibility"]:checked')?.value || 'public';
    const submitButton = document.querySelector('.feedback-submit-btn');
    const status = document.getElementById('feedback-form-status');

    if (!content) {
        if (status) status.textContent = '先写一点反馈内容吧';
        showUiToast('先写一点反馈内容吧', 'error');
        contentInput.focus();
        return;
    }

    if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = '提交中...';
    }
    if (status) status.textContent = '正在提交反馈...';

    try {
        const response = await operation.wait(resources.fetch('/api/feedback', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Device-ID': getDeviceId()
            },
            body: JSON.stringify({ content, visibility })
        }));
        const data = await operation.wait(response.json());

        if (data.success) {
            contentInput.value = '';
            if (status) status.textContent = '反馈已提交，感谢你的建议。';
            showUiToast('反馈已提交', 'success');
            await operation.wait(loadFeedbackPage());
        } else {
            if (status) status.textContent = data.message || '提交失败，请稍后重试';
            showUiToast(data.message || '提交失败', 'error');
        }
    } catch (error) {
        if (error?.name === 'AbortError') return;
        console.error('提交反馈失败:', error);
        if (status) status.textContent = '网络错误，请重试';
        showUiToast('网络错误，请重试', 'error');
    } finally {
        if (submitButton) {
            submitButton.disabled = false;
            submitButton.textContent = '提交反馈';
        }
    }
}

export async function submitFeedbackReply(feedbackId) {
    const operation = resources.capture();
    const textarea = document.getElementById(`reply-input-${feedbackId}`);
    if (!textarea) return;
    const content = textarea.value.trim();

    if (!content) {
        showUiToast('请输入回复内容', 'error');
        textarea.focus();
        return;
    }

    try {
        const response = await operation.wait(resources.fetch(`/api/feedback/${feedbackId}/reply`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Device-ID': getDeviceId()
            },
            body: JSON.stringify({ content })
        }));
        const data = await operation.wait(response.json());

        if (data.success) {
            showUiToast('回复已发送', 'success');
            await operation.wait(loadFeedbackPage());
        } else {
            showUiToast(data.message || '回复失败', 'error');
        }
    } catch (error) {
        if (error?.name === 'AbortError') return;
        console.error('回复失败:', error);
        showUiToast('网络错误，请重试', 'error');
    }
}

export function toggleReplyBox(feedbackId) {
    const box = document.getElementById(`reply-box-${feedbackId}`);
    box.style.display = box.style.display === 'none' ? 'flex' : 'none';
}

export function displayFeedbackList(myFeedbacks, publicFeedbacks) {
    const contentDiv = document.getElementById('feedback-list-content');
    let html = '';

    if (myFeedbacks.length === 0 && publicFeedbacks.length === 0) {
        contentDiv.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon"><svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><use href="/static/icons/lucide.svg#message-square"/></svg></div>
                <div class="empty-state-text">还没有反馈</div>
                <div class="feedback-empty-hint">写下第一个问题或建议，管理员看到后就能跟进。</div>
            </div>
        `;
        return;
    }

    if (myFeedbacks.length > 0) {
        html += `<div class="feedback-section-title">我的反馈 <span class="feedback-soft-badge">${myFeedbacks.length} 条</span></div>`;
        myFeedbacks.forEach(fb => {
            html += buildFeedbackCard(fb);
        });
    }

    if (publicFeedbacks.length > 0) {
        html += `<div class="feedback-section-title">公开讨论 <span class="feedback-soft-badge">${publicFeedbacks.length} 条</span></div>`;
        publicFeedbacks.forEach(fb => {
            html += buildFeedbackCard(fb);
        });
    }

    contentDiv.innerHTML = html;
}

export function buildFeedbackCard(fb) {
    // 内联事件只允许服务端的整数 ID，文本转义不能替代 JavaScript 上下文验证。
    const feedbackId = Number(fb.id);
    const canReply = Number.isSafeInteger(feedbackId) && feedbackId > 0;
    const createTime = formatFeedbackTime(fb.create_time);
    const visLabel = fb.visibility === 'public' ? '公开' : '仅自己可见';
    const visClass = fb.visibility === 'public' ? 'feedback-visibility-badge is-public' : 'feedback-visibility-badge';
    const authorName = fb.is_own ? '我' : escapeHtml(fb.username || '同学');

    let html = `
        <div class="feedback-card">
            <div class="feedback-floor">
                <div class="feedback-floor-header">
                    <span class="feedback-floor-num">1楼</span>
                    <span class="feedback-username">${authorName}</span>
                    <span class="${visClass}">${visLabel}</span>
                </div>
                <div class="feedback-floor-content">${formatFeedbackContent(fb.content)}</div>
                <div class="feedback-floor-time">${createTime}</div>
            </div>
    `;

    if (fb.replies && fb.replies.length > 0) {
        fb.replies.forEach((reply, index) => {
            const replyTime = formatFeedbackTime(reply.create_time);
            const isAdmin = reply.username === '管理员';
            const replyName = isAdmin ? '管理员' : escapeHtml(reply.username || '同学');
            html += `
                <div class="feedback-floor ${isAdmin ? 'feedback-floor-admin' : ''}">
                    <div class="feedback-floor-header">
                        <span class="feedback-floor-num">${index + 2}楼</span>
                        <span class="feedback-username${isAdmin ? ' admin-tag' : ''}">${replyName}</span>
                    </div>
                    <div class="feedback-floor-content">${formatFeedbackContent(reply.content)}</div>
                    <div class="feedback-floor-time">${replyTime}</div>
                </div>
            `;
        });
    }

    if (canReply) html += `
            <div class="feedback-reply-bar">
                <button class="feedback-reply-btn" onclick="toggleReplyBox(${feedbackId})">回复这条反馈</button>
            </div>
            <div id="reply-box-${feedbackId}" class="feedback-reply-box" style="display:none;">
                <textarea id="reply-input-${feedbackId}" class="feedback-reply-textarea" rows="2" placeholder="补充说明或参与讨论..."></textarea>
                <button class="btn-primary btn-sm" onclick="submitFeedbackReply(${feedbackId})">发送</button>
            </div>
        </div>
    `;
    return html;
}
