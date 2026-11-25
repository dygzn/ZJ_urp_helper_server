import { pageResources } from './lifecycle.js';
import { state } from './store.js';
import { getDeviceId } from './auth.js';
import { renderRetryState } from './feedback.js';
import { closeUiModal, openUiModal, requestUiConfirmation, showUiToast } from './ui.js';
const resources = pageResources('member');

export function mountMember() { return loadMemberPage(); }
export function unmountMember() { resources.dispose(); }
export async function loadMemberPage() {
    const operation = resources.capture();
    const scope = resources.capture();
    await operation.wait(loadMemberStatus());
    if (!scope.isActive()) return;
    await operation.wait(Promise.all([
        loadMemberOrders(),
        loadInvitationEarnings(),
    ]));
}

export async function loadMemberStatus(targetId = 'member-status-card') {
    const operation = resources.capture();
    const card = document.getElementById(targetId);
    state.currentMemberStatus = null;
    if (!card) return;
    try {
        const resp = await operation.wait(resources.fetch('/api/member/status', {
            headers: { 'X-Device-ID': getDeviceId() }
        }));
        const data = await operation.wait(resp.json());
        if (!data.success) {
            renderRetryState(card, data.message || '会员状态加载失败', () => loadMemberStatus(targetId));
            return;
        }
        const d = data.data;
        state.currentMemberStatus = d || null;
        if (!d.is_member) {
            if (d.expire_time && d.is_expired) {
                const typeMap = { basic: '初级会员', advanced: '高级会员' };
                card.innerHTML = `<div class="member-status-expired"><span>您的${typeMap[d.member_type] || '会员'}已于 ${d.expire_time.slice(0, 10)} 到期</span><span>，请续费继续享受会员服务。</span></div>`;
            } else {
                card.innerHTML = `<div class="member-status-none">您当前没有会员，开通会员解锁更多功能。</div>`;
            }
        } else {
            const typeMap = { basic: '初级会员', advanced: '高级会员' };
            const badgeClass = d.member_type === 'advanced' ? 'member-badge-advanced' : 'member-badge-basic';
            card.innerHTML = `
                <div class="member-status-active">
                    <span class="member-badge ${badgeClass}">${typeMap[d.member_type] || '会员'}</span>
                    <span class="member-expire">有效期至：${d.expire_time ? d.expire_time.slice(0, 10) : '未知'}</span>
                </div>`;
        }
    } catch (e) {
        if (e?.name === 'AbortError') return;
        state.currentMemberStatus = null;
        renderRetryState(card, '会员状态加载失败，请重试', () => loadMemberStatus(targetId));
    }
}

export function renderInvitationLink(data, errorMessage = '') {
    const container = document.getElementById('invitation-link-content');
    if (!container) return;

    if (!data || data.has_link !== true || !data.invite_url) {
        const message = errorMessage
            ? `<span class="invitation-link-error">${escapeHtml(errorMessage)}</span>`
            : '<span>生成固定邀请链接，分享给新用户即可自动绑定邀请关系。</span>';
        container.innerHTML = `
            <div class="invitation-link-empty">
                ${message}
                <button class="btn-secondary" type="button" onclick="generateInvitationLink()">生成邀请链接</button>
            </div>`;
        return;
    }

    const safeUrl = escapeHtml(data.invite_url);
    container.innerHTML = `
        <div class="invitation-link-label">我的固定邀请链接</div>
        <div class="invitation-link-row">
            <input id="invitation-link-input" class="invitation-link-input" type="text" readonly value="${safeUrl}">
            <button id="invitation-link-copy" class="btn-secondary" type="button" onclick="copyInvitationLink()">复制链接</button>
        </div>`;
}

export async function generateInvitationLink() {
    const operation = resources.capture();
    const container = document.getElementById('invitation-link-content');
    if (container) container.innerHTML = '<div class="loading">正在生成...</div>';

    try {
        const response = await operation.wait(resources.fetch('/api/invitation/link', {
            method: 'POST',
            headers: { 'X-Device-ID': getDeviceId() },
        }));
        const data = await operation.wait(response.json().catch(() => ({ success: false })));
        if (!response.ok || !data.success || !data.data) {
            throw new Error(data.message || '生成邀请链接失败');
        }
        renderInvitationLink(data.data);
    } catch (error) {
        if (error?.name === 'AbortError') return;
        renderInvitationLink(null, error.message || '生成失败，请重试');
    }
}

export async function copyInvitationLink() {
    const operation = resources.capture();
    const input = document.getElementById('invitation-link-input');
    const button = document.getElementById('invitation-link-copy');
    if (!input) return;

    let copied = false;
    try {
        if (typeof ServiceStatusUI !== 'undefined' && typeof ServiceStatusUI.copyText === 'function') {
            copied = await operation.wait(ServiceStatusUI.copyText(input.value));
        } else if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await operation.wait(navigator.clipboard.writeText(input.value));
            copied = true;
        }
    } catch (error) {
        if (error?.name === 'AbortError') return;
        copied = false;
    }

    if (copied) {
        if (button) {
            button.textContent = '已复制';
            resources.setTimeout(() => {
                if (button.isConnected) button.textContent = '复制链接';
            }, 1500);
        }
    } else {
        input.select?.();
        if (button) {
            button.textContent = '复制失败，请手动复制';
            resources.setTimeout(() => {
                if (button.isConnected) button.textContent = '复制链接';
            }, 2500);
        }
    }
}

export async function loadInvitationEarnings() {
    const operation = resources.capture();
    const card = document.getElementById('invitation-card');
    const linkContent = document.getElementById('invitation-link-content');
    const content = document.getElementById('invitation-earnings-content');
    if (!card || !content) return;

    card.style.display = '';
    if (linkContent) linkContent.innerHTML = '<div class="loading">加载中...</div>';
    content.innerHTML = '<div class="loading">加载中...</div>';

    const fetchJson = async (url) => {
    const operation = resources.capture();
        try {
            const resp = await operation.wait(resources.fetch(url, { headers: { 'X-Device-ID': getDeviceId() } }));
            const data = await operation.wait(resp.json().catch(() => ({ success: false, message: '接口返回格式异常' })));
            if (!resp.ok) {
                return { success: false, message: data.message || `请求失败：${resp.status}` };
            }
            return data;
        } catch (e) {
        if (e?.name === 'AbortError') return;
            return { success: false, message: '网络请求失败' };
        }
    };

    const [inviterData, linkData, earningsData, withdrawalsData] = await operation.wait(Promise.all([
        fetchJson('/api/invitation/my_inviter'),
        fetchJson('/api/invitation/link'),
        fetchJson('/api/invitation/earnings'),
        fetchJson('/api/invitation/withdrawals')
    ]));

    if (linkData.success && linkData.data) {
        renderInvitationLink(linkData.data);
    } else {
        renderInvitationLink(null, linkData.message || '邀请链接加载失败，请重试');
    }

    if (!earningsData.success || !earningsData.data) {
        content.innerHTML = `<div class="error-message">收益加载失败：${escapeHtml(earningsData.message || '未知错误')}</div>`;
        return;
    }

    const data = earningsData.data;
    const inviteeTotal = parseFloat(data.invitee_total) || 0;
    const effectiveInviteCount = Number(data.effective_invite_count || 0);
    const currentReward = data.current_reward || '0.80';
    const earned = parseFloat(data.earned) || 0;
    const withdrawn = parseFloat(data.withdrawn) || 0;
    const available = parseFloat(data.available) || 0;

    let html = `<div class="invitation-promo"><strong>每成功邀请1位新付费用户，获得最高1.2元奖励。</strong></div>`;

    if (inviterData.success && inviterData.data && inviterData.data.inviter) {
        html += `<div class="inviter-info"><span class="inviter-label">邀请人：</span><span>${escapeHtml(inviterData.data.inviter)}</span></div>`;
    }

    let hasPending = false;
    if (withdrawalsData.success && withdrawalsData.data) {
        withdrawalsData.data.forEach(r => {
            if (r.status === 'pending') hasPending = true;
        });
    }

    let btnText, btnDisabled;
    if (hasPending) {
        btnText = '审核中';
        btnDisabled = true;
    } else if (available <= 0) {
        btnText = '暂无可提现';
        btnDisabled = true;
    } else {
        btnText = '提现';
        btnDisabled = false;
    }

    html += `<div class="earnings-summary">
        <div class="earnings-row"><span>有效邀请</span><span>${effectiveInviteCount} 人</span></div>
        <div class="earnings-row"><span>当前每人奖励</span><span class="earnings-rate">¥${escapeHtml(currentReward)}</span></div>
        <div class="earnings-row"><span>团队充值</span><span>¥${inviteeTotal.toFixed(2)}</span></div>
        <div class="earnings-row earnings-row-total"><span>累计收益</span><span class="earnings-amount">¥${earned.toFixed(2)}</span></div>
    </div>`;

    if (data.next_level_count !== null && data.next_level_count !== undefined) {
        const remaining = Math.max(Number(data.next_level_count) - effectiveInviteCount, 0);
        html += `<div class="invite-hint">再邀请 ${remaining} 位新付费用户，后续每人奖励提升至 ¥${escapeHtml(data.next_reward || '0.00')}。</div>`;
    } else {
        html += '<div class="invite-hint">已达到当前最高奖励档位，继续邀请仍可获得当前奖励。</div>';
    }

    if (Array.isArray(data.levels) && data.levels.length > 0) {
        html += '<div class="referral-levels"><div class="referral-section-title">奖励阶梯</div>';
        data.levels.forEach((level, index) => {
            const nextLevel = data.levels[index + 1];
            const range = nextLevel
                ? `${Number(level.min_count)}～${Number(nextLevel.min_count) - 1}人`
                : `${Number(level.min_count)}人以上`;
            html += `<div class="referral-level-row"><span>${range}</span><span>¥${escapeHtml(level.reward)} / 人</span></div>`;
        });
        html += '</div>';
    }

    if (Array.isArray(data.milestones) && data.milestones.length > 0) {
        html += '<div class="referral-milestones"><div class="referral-section-title">限时任务</div>';
        data.milestones.forEach(milestone => {
            const label = escapeHtml(milestone.label || milestone.id || '邀请任务');
            let status;
            if (milestone.completed) {
                status = milestone.rewarded ? '已完成，奖励已发放' : '已完成，奖励待发放';
            } else if (milestone.is_active) {
                status = `已完成 ${Number(milestone.count || 0)}/${Number(milestone.target_count || 0)}，还差 ${Number(milestone.remaining || 0)} 人`;
            } else {
                status = `目标 ${Number(milestone.target_count || 0)} 人，奖励 ¥${escapeHtml(milestone.bonus || '0.00')}`;
            }
            html += `<div class="referral-milestone-row"><div><strong>${label}</strong><span>${status}</span></div><span>额外 ¥${escapeHtml(milestone.bonus || '0.00')}</span></div>`;
        });
        html += '</div>';
    }

    const hasWithdrawalHistory = Boolean(withdrawalsData.success && Array.isArray(withdrawalsData.data) && withdrawalsData.data.length > 0);
    html += `<div class="earnings-total">
        <span class="earnings-label">可提现</span><span class="earnings-amount">¥${available.toFixed(2)}</span>
        <button class="btn-withdraw" type="button" onclick="showWithdrawDialog()" ${btnDisabled ? 'disabled' : ''}>${btnText}</button>
        ${(btnDisabled && hasWithdrawalHistory) ? '<button class="btn-secondary" type="button" onclick="showWithdrawDialog()">提现记录</button>' : ''}
    </div>`;
    if (withdrawn > 0) {
        html += `<div class="earnings-withdrawn"><span>已占用：¥${withdrawn.toFixed(2)}</span></div>`;
    }
    if (!withdrawalsData.success) {
        html += `<div class="invite-hint">提现记录加载失败：${escapeHtml(withdrawalsData.message || '未知错误')}</div>`;
    }

    if ((data.earnings && data.earnings.length > 0) || (data.milestone_earnings && data.milestone_earnings.length > 0)) {
        html += '<div class="earnings-list">';
        (data.earnings || []).forEach(e => {
            html += `<div class="earning-item"><span>${escapeHtml(e.invitee_username)} 首次付费</span><span class="earning-amount">+¥${(parseFloat(e.amount) || 0).toFixed(2)}</span><span class="earning-time">${e.create_time ? e.create_time.slice(0, 10) : ''}</span></div>`;
        });
        if (data.milestone_earnings && data.milestone_earnings.length > 0) {
            data.milestone_earnings.forEach(e => {
                html += `<div class="earning-item"><span>限时任务奖励</span><span class="earning-amount">+¥${(parseFloat(e.amount) || 0).toFixed(2)}</span><span class="earning-time">${e.create_time ? e.create_time.slice(0, 10) : ''}</span></div>`;
            });
        }
        html += '</div>';
    }

    html += '<div class="invite-hint">规则说明：每位被邀请用户首次完成付费时计为一次有效邀请，同一用户仅计一次；达到新档位后，后续邀请按新奖励计算，历史奖励不补差价。</div>';

    content.innerHTML = html;
}

export async function loadMemberOrders() {
    const operation = resources.capture();
    const container = document.getElementById('member-orders-content');
    const payLinksDiv = document.getElementById('active-pay-links');
    if (payLinksDiv) {
        payLinksDiv.style.display = 'none';
        payLinksDiv.innerHTML = '';
    }
    try {
        const resp = await operation.wait(resources.fetch('/api/member/orders', {
            headers: { 'X-Device-ID': getDeviceId() }
        }));
        const data = await operation.wait(resp.json());
        if (!data.success || !data.data.length) {
            container.innerHTML = '<p class="member-orders-empty">暂无购买记录</p>';
            return;
        }

        // 检查是否有有效支付链接
        const activeOrders = data.data.filter(o => o.active_pay_url);
        if (activeOrders.length > 0 && payLinksDiv) {
            const typeMap = { basic: '初级会员', advanced: '高级会员' };
            let linksHtml = '<div class="member-pay-links-title">有效期内的支付链接</div>';
            for (const order of activeOrders) {
                const expireMin = Math.ceil(order.expire_seconds / 60);
                linksHtml += `
                    <div class="member-pay-link-row">
                        <span>${typeMap[order.member_type]} ¥${order.amount} · <span class="member-order-error">剩余${expireMin}分钟</span></span>
                        <button type="button" data-member-type="${escapeHtml(order.member_type)}" data-pay-type="${escapeHtml(order.pay_type || 'alipay')}" onclick="resumeMemberPay(this)" class="btn-primary member-order-pay">立即支付</button>
                    </div>`;
            }
            payLinksDiv.innerHTML = linksHtml;
            payLinksDiv.style.display = 'block';
        }

        const typeMap = { basic: '初级会员', advanced: '高级会员' };
        const statusMap = { pending: '待支付', paid: '已支付', failed: '失败' };
        let html = '<div class="orders-list">';
        for (const order of data.data) {
            let payLinkHtml = order.active_pay_url ? ` <button type="button" class="btn-primary member-order-pay member-order-pay-compact" data-member-type="${escapeHtml(order.member_type)}" data-pay-type="${escapeHtml(order.pay_type || 'alipay')}" onclick="resumeMemberPay(this)">去支付</button>` : '';
            html += `
                <div class="order-item">
                    <div class="order-info">
                        <span class="order-type">${typeMap[order.member_type] || order.member_type}</span>
                        <span class="order-amount">¥${order.amount}</span>
                        <span class="order-status order-status-${order.status}">${statusMap[order.status] || order.status}${payLinkHtml}</span>
                    </div>
                    <div class="order-time">${order.create_time ? order.create_time.slice(0, 16) : ''}</div>
                </div>`;
        }
        html += '</div>';
        container.innerHTML = html;
    } catch (e) {
        if (e?.name === 'AbortError') return;
        container.innerHTML = '<p class="member-order-error">加载失败</p>';
    }
}

export function updatePayTypeUI() {
    document.querySelectorAll('.pay-type-option').forEach(option => {
        const input = option.querySelector('input[name="pay-type"]');
        option.classList.toggle('pay-type-option-active', !!input && input.checked);
    });
}

export function showPayDialog(memberType) {
    state._currentPayMemberType = memberType;
    const prices = { basic: '3', advanced: '5' };
    const typeNames = { basic: '初级会员', advanced: '高级会员' };
    const defaultPay = document.getElementById('pay-type-alipay');
    if (defaultPay) defaultPay.checked = true;
    updatePayTypeUI();
    document.getElementById('pay-modal-title').textContent = `开通${typeNames[memberType]}`;
    document.getElementById('pay-modal-desc').textContent = `价格：¥${prices[memberType]}/半年，续费会自动叠加到原到期日后`;
    document.getElementById('pay-error').textContent = '';
    document.getElementById('pay-confirm-btn').disabled = false;
    document.getElementById('pay-confirm-btn').textContent = '确认支付';
    const modal = document.getElementById('pay-modal');
    openUiModal(modal);
}

export function closePayDialog() {
    closeUiModal(document.getElementById('pay-modal'));
    state._currentPayMemberType = null;
}

async function createMemberPayment(memberType, payType) {
    const operation = resources.capture();
    const requestOrder = async (confirmed = false) => {
        const resp = await operation.wait(resources.fetch('/api/member/create_order', {
            method: 'POST',
            headers: { 'X-Device-ID': getDeviceId(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ member_type: memberType, pay_type: payType,
                operation_warning_confirmed: confirmed }),
        }));
        return operation.wait(resp.json());
    };
    let data = await requestOrder();
    if (data.requires_confirmation) {
        const payModal = document.getElementById('pay-modal');
        const restorePayModal = state.uiModalState.activeModal === payModal;
        const returnFocus = state.uiModalState.returnFocus;
        const confirmed = await operation.wait(requestUiConfirmation({
            title: '会员充值提醒',
            message: data.message,
            confirmText: '继续充值',
        }));
        if (restorePayModal) {
            openUiModal(payModal, { initialFocusSelector: '.modal-close' });
            state.uiModalState.returnFocus = returnFocus;
        }
        if (!confirmed) return null;
        data = await requestOrder(true);
    }
    if (!data.success) throw new Error(data.message || '创建订单失败');
    if (!data.data?.pay_url) throw new Error('获取支付链接失败，请重试');
    return data.data.pay_url;
}

export async function resumeMemberPay(button) {
    if (button.disabled) return;
    const operation = resources.capture();
    button.disabled = true;
    try {
        const payUrl = await createMemberPayment(button.dataset.memberType, button.dataset.payType || 'alipay');
        if (payUrl) window.location.href = payUrl;
    } catch (error) {
        if (error?.name === 'AbortError') return;
        showUiToast(error.message || '网络错误，请重试', 'error');
    } finally {
        if (operation.isActive()) {
            button.disabled = false;
            if (!state.uiModalState.activeModal) button.focus();
        }
    }
}

export async function confirmPay() {
    const operation = resources.capture();
    const memberType = state._currentPayMemberType;
    if (!memberType) return;
    const payType = document.querySelector('input[name="pay-type"]:checked')?.value || 'alipay';
    const btn = document.getElementById('pay-confirm-btn');
    const errDiv = document.getElementById('pay-error');
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '正在创建支付...';
    errDiv.textContent = '';
    let redirecting = false;
    try {
        const payUrl = await createMemberPayment(memberType, payType);
        if (payUrl) {
            redirecting = true;
            closePayDialog();
            window.location.href = payUrl;
        }
    } catch (e) {
        if (e?.name === 'AbortError') return;
        errDiv.textContent = e.message || '网络错误，请重试';
    } finally {
        if (!redirecting && operation.isActive()) {
            btn.disabled = false;
            btn.textContent = '确认支付';
            if (state.uiModalState.activeModal === document.getElementById('pay-modal')) btn.focus();
        }
    }
}

export async function showWithdrawDialog() {
    const operation = resources.capture();
    const modal = document.getElementById('withdraw-modal');
    const errDiv = document.getElementById('withdraw-error');
    const submitBtn = document.querySelector?.('#withdraw-form button[type="submit"]') || null;
    errDiv.textContent = '';
    document.getElementById('withdraw-real-name').value = '';
    document.getElementById('withdraw-alipay').value = '';
    document.getElementById('withdraw-available').innerHTML = '<div class="loading">加载中...</div>';
    document.getElementById('withdraw-history').innerHTML = '';
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = '提交提现申请';
    }
    openUiModal(modal);

    try {
        const [earningsResp, historyResp] = await operation.wait(Promise.all([
            resources.fetch('/api/invitation/earnings', { headers: { 'X-Device-ID': getDeviceId() } }),
            resources.fetch('/api/invitation/withdrawals', { headers: { 'X-Device-ID': getDeviceId() } })
        ]));
        const earningsData = await operation.wait(earningsResp.json());
        const historyData = await operation.wait(historyResp.json());

        const inviteeTotal = (earningsData.success && earningsData.data) ? (parseFloat(earningsData.data.invitee_total) || 0) : 0;
        const effectiveInviteCount = (earningsData.success && earningsData.data) ? (Number(earningsData.data.effective_invite_count) || 0) : 0;
        const currentReward = (earningsData.success && earningsData.data) ? (earningsData.data.current_reward || '0.80') : '0.80';
        const earned = (earningsData.success && earningsData.data) ? (parseFloat(earningsData.data.earned) || 0) : 0;
        const available = (earningsData.success && earningsData.data) ? (parseFloat(earningsData.data.available) || 0) : 0;

        state._withdrawAvailable = available;
        document.getElementById('withdraw-available').innerHTML = `
            <div class="withdraw-amount-row">
                <span>团队充值</span><span>¥${inviteeTotal.toFixed(2)}</span>
            </div>
            <div class="withdraw-amount-row">
                <span>有效邀请</span><span>${effectiveInviteCount} 人</span>
            </div>
            <div class="withdraw-amount-row">
                <span>当前每人奖励</span><span>¥${escapeHtml(currentReward)}</span>
            </div>
            <div class="withdraw-amount-row">
                <span>累计收益</span><span>¥${earned.toFixed(2)}</span>
            </div>
            <div class="withdraw-amount-row">
                <span>可提现金额</span><span class="withdraw-available-amount">¥${available.toFixed(2)}</span>
            </div>
        `;

        // 提现记录
        let hasPending = false;
        if (historyData.success && historyData.data && historyData.data.length > 0) {
            const statusMap = { pending: '审核中', approved: '已转账', rejected: '已拒绝' };
            let histHtml = '<div class="withdraw-history-title">提现记录</div>';
            historyData.data.forEach(r => {
                if (r.status === 'pending') hasPending = true;
                histHtml += `<div class="withdraw-history-item">
                    <span>¥${parseFloat(r.amount).toFixed(2)}</span>
                    <span class="withdraw-status withdraw-status-${escapeHtml(r.status)}">${escapeHtml(statusMap[r.status] || r.status)}</span>
                    <span class="withdraw-history-time">${escapeHtml(r.create_time ? r.create_time.slice(0, 10) : '')}</span>
                </div>`;
            });
            document.getElementById('withdraw-history').innerHTML = histHtml;
        }
        if (submitBtn) {
            submitBtn.disabled = hasPending || available <= 0;
            submitBtn.textContent = hasPending ? '已有申请审核中' : (available <= 0 ? '暂无可提现金额' : '提交提现申请');
        }
    } catch (e) {
        if (e?.name === 'AbortError') return;
        document.getElementById('withdraw-available').innerHTML = '';
        errDiv.textContent = '加载失败，请关闭后重试';
    }
}

export function closeWithdrawDialog() {
    closeUiModal(document.getElementById('withdraw-modal'));
}

export async function handleWithdraw(event) {
    const operation = resources.capture();
    event.preventDefault();
    const realName = document.getElementById('withdraw-real-name').value.trim();
    const alipay = document.getElementById('withdraw-alipay').value.trim();
    const errDiv = document.getElementById('withdraw-error');
    const submitBtn = document.querySelector?.('#withdraw-form button[type="submit"]') || null;
    if (submitBtn?.disabled) return;
    errDiv.textContent = '';

    if (state._withdrawAvailable <= 0) {
        errDiv.textContent = '暂无可提现金额';
        return;
    }

    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = '提交中...';
    }

    try {
        const resp = await operation.wait(resources.fetch('/api/invitation/withdraw', {
            method: 'POST',
            headers: { 'X-Device-ID': getDeviceId(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ real_name: realName, alipay_account: alipay })
        }));
        const data = await operation.wait(resp.json());
        if (data.success) {
            showUiToast(data.message || '提现申请已提交', 'success');
            closeWithdrawDialog();
            loadInvitationEarnings();
        } else {
            errDiv.textContent = data.message || '提现申请失败';
        }
    } catch (e) {
        if (e?.name === 'AbortError') return;
        errDiv.textContent = '网络错误，请重试';
    } finally {
        if (submitBtn && operation.isActive()) {
            submitBtn.disabled = false;
            submitBtn.textContent = '提交提现申请';
        }
    }
}
