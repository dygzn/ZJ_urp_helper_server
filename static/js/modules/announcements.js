import { pageResources } from './lifecycle.js';
import { state } from './store.js';
import { getDeviceId } from './auth.js';
import { closeUiModal, openUiModal } from './ui.js';
const resources = pageResources('announcements');
let initialized = false;
let indicatorRequest = null;
let announcementUnreadCount = 0;
let chatHasUnread = false;

export const locallyReadAnnouncementIds = new Set();

export function initializeAnnouncements() {
    const refresh = () => {
        if (document.visibilityState === 'hidden'
            || state.uiModalState.activeModal?.id === 'announcement-dialog') return;
        return loadAnnouncementIndicator();
    };
    if (!initialized) {
        initialized = true;
        resources.listen(document, 'visibilitychange', refresh);
        resources.listen(window, 'pageshow', refresh);
        resources.setInterval(refresh, 60_000);
    }
    return refresh();
}

export function updateAnnouncementIndicator(items = state.announcementItems) {
    const trigger = document.getElementById('announcement-trigger');
    const unreadCount = items.filter(item => !item.is_read).length;
    trigger?.classList.toggle('has-unread', unreadCount > 0);
    trigger?.setAttribute('aria-label', unreadCount > 0
        ? `系统公告，${unreadCount} 条未读`
        : '系统公告，无未读公告');
    announcementUnreadCount = unreadCount;
    updateMoreIndicator();
    const count = document.getElementById('mobile-announcement-count');
    if (count) count.textContent = unreadCount > 0 ? `${unreadCount} 条未读` : '';
}

export function setChatUnreadIndicator(unread) {
    chatHasUnread = unread;
    updateMoreIndicator();
}

function updateMoreIndicator() {
    const more = document.getElementById('mobile-nav-more');
    if (!more) return;
    const parts = ['更多功能与账号'];
    if (announcementUnreadCount) parts.push(`${announcementUnreadCount} 条未读公告`);
    if (chatHasUnread) parts.push('聊天室有新消息');
    more.classList.toggle('has-unread', announcementUnreadCount > 0 || chatHasUnread);
    more.setAttribute('aria-label', parts.join('，'));
}

export function rememberAnnouncements(items) {
    state.announcementItems = items.map(item => ({
        ...item,
        is_read: item.is_read || locallyReadAnnouncementIds.has(item.id),
    })).sort((a, b) => (Date.parse(b.create_time) || 0) - (Date.parse(a.create_time) || 0));
    updateAnnouncementIndicator();
    return state.announcementItems;
}

export function loadAnnouncementIndicator() {
    if (indicatorRequest) return indicatorRequest;
    const operation = resources.capture();
    indicatorRequest = (async () => {
        try {
            const response = await operation.wait(resources.api.request('/api/announcements', {
                headers: { 'X-Device-ID': getDeviceId() },
                cache: 'no-store',
            }));
            const data = await operation.wait(response.json());
            if (data.success && state.uiModalState.activeModal?.id !== 'announcement-dialog') {
                rememberAnnouncements(data.announcements || []);
            }
        } catch (error) {
            if (error?.name === 'AbortError') return;
            console.error('更新公告提示失败:', error);
        }
    })().finally(() => { indicatorRequest = null; });
    return indicatorRequest;
}

export async function openAnnouncementDialog() {
    const operation = resources.capture();
    const modal = document.getElementById('announcement-dialog');
    if (!modal) return;
    openUiModal(modal, { initialFocusSelector: '#announcement-dialog-close' });
    await operation.wait(loadAnnouncementsForDialog());
}

export function closeAnnouncementDialog() {
    closeUiModal(document.getElementById('announcement-dialog'));
}

export async function loadAnnouncementsForDialog() {
    const operation = resources.capture();
    const status = document.getElementById('announcement-dialog-status');
    const article = document.getElementById('announcement-dialog-article');
    const retry = document.getElementById('announcement-retry');
    const previous = document.getElementById('announcement-previous');
    const next = document.getElementById('announcement-next');
    if (!status || !article || !retry || !previous || !next) return;

    status.hidden = false;
    status.textContent = '加载中...';
    article.hidden = true;
    retry.hidden = true;
    previous.disabled = true;
    next.disabled = true;

    try {
        const response = await operation.wait(resources.fetch('/api/announcements', {
            headers: { 'X-Device-ID': getDeviceId() },
        }));
        const data = await operation.wait(response.json());
        if (!data.success) throw new Error(data.message || '公告加载失败');
        const items = rememberAnnouncements(data.announcements || []);
        if (items.length === 0) {
            status.textContent = '暂无公告';
            return;
        }
        await operation.wait(showAnnouncementAt(0));
    } catch (error) {
        if (error?.name === 'AbortError') return;
        console.error('加载公告失败:', error);
        status.textContent = '公告加载失败，请重试';
        retry.hidden = false;
    }
}

export async function showAnnouncementAt(index) {
    const operation = resources.capture();
    if (index < 0 || index >= state.announcementItems.length) return;
    state.announcementDialogIndex = index;
    const item = state.announcementItems[index];
    const date = new Date(item.create_time);
    const time = document.getElementById('announcement-dialog-time');
    const status = document.getElementById('announcement-dialog-status');
    const article = document.getElementById('announcement-dialog-article');
    const scroll = document.getElementById('announcement-dialog-scroll');

    status.hidden = true;
    article.hidden = false;
    time.textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN');
    document.getElementById('announcement-dialog-title').textContent = String(item.title ?? '');
    document.getElementById('announcement-dialog-content').textContent = String(item.content ?? '');
    document.getElementById('announcement-dialog-position').textContent = `${index + 1} / ${state.announcementItems.length}`;
    document.getElementById('announcement-previous').disabled = index === 0;
    document.getElementById('announcement-next').disabled = index === state.announcementItems.length - 1;
    if (scroll) scroll.scrollTop = 0;
    await operation.wait(markAnnouncementRead(item));
}

export function showPreviousAnnouncement() {
    return showAnnouncementAt(state.announcementDialogIndex - 1);
}

export function showNextAnnouncement() {
    return showAnnouncementAt(state.announcementDialogIndex + 1);
}

export async function markAnnouncementRead(item) {
    const operation = resources.capture();
    if (item.is_read) return;
    try {
        const response = await operation.wait(resources.fetch(`/api/announcements/${item.id}/read`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Device-ID': getDeviceId() },
            body: JSON.stringify({ never_show: false }),
        }));
        const data = await operation.wait(response.json());
        if (!data.success) throw new Error(data.message || '标记已读失败');
        locallyReadAnnouncementIds.add(item.id);
        state.announcementItems.forEach(announcement => {
            if (announcement.id === item.id) announcement.is_read = true;
        });
        updateAnnouncementIndicator();
    } catch (error) {
        if (error?.name === 'AbortError') return;
        console.error('标记公告已读失败:', error);
    }
}
