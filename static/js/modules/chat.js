import { setChatUnreadIndicator } from './announcements.js';
import { chatSessionChangeKey, expireChatSession } from './auth.js';
import { pageResources } from './lifecycle.js';
import { state, store } from './store.js';
import { closeUiModal, focusUiElement, openUiModal, requestUiConfirmation, resolveUiConfirmation, showUiToast } from './ui.js';

const resources = pageResources('chat');
const indicatorResources = pageResources('chat-indicator');
const seenPrefix = 'urp_chat_last_seen_id:';
const readInMemory = new Map();
const pollDelays = [4000, 8000, 12000];
const timeZone = 'Asia/Shanghai';
const dateFormat = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFormat = new Intl.DateTimeFormat('zh-CN', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fullTimeFormat = new Intl.DateTimeFormat('zh-CN', { timeZone, dateStyle: 'medium', timeStyle: 'short' });

let enabled = true;
let mounted = null;
let viewerKey = '';
let latestUnreadId = 0;

const byId = id => document.getElementById(id);
const now = room => Date.now() + room.clockOffset;
const eligible = () => Boolean(state.currentUsername && !state.isGuestMode && !state.chatSessionStale
    && (!state.temporarySessionExpiresAt || state.temporarySessionExpiresAt > Date.now()));

export function chatDateLabel(value, reference = Date.now()) {
    const date = Date.parse(value);
    if (!Number.isFinite(date)) return '';
    const day = dateFormat.format(date);
    const time = timeFormat.format(date);
    if (day === dateFormat.format(reference)) return `今天 ${time}`;
    if (day === dateFormat.format(reference - 86_400_000)) return `昨天 ${time}`;
    const [year, month, dayOfMonth] = day.split('-').map(Number);
    const yearLabel = String(year) === dateFormat.format(reference).slice(0, 4) ? '' : `${year}年`;
    return `${yearLabel}${month}月${dayOfMonth}日 ${time}`;
}

export function needsChatDate(previous, current) {
    const date = Date.parse(current);
    if (!Number.isFinite(date)) return false;
    const before = Date.parse(previous);
    return !Number.isFinite(before) || date - before >= 300_000
        || dateFormat.format(before) !== dateFormat.format(date);
}

function seenId(key) {
    if (!key) return 0;
    const memory = readInMemory.get(key) || 0;
    try {
        return Math.max(memory, Number(localStorage.getItem(seenPrefix + key)) || 0);
    } catch {
        return memory;
    }
}

function setUnread(unread) {
    const entry = byId('more-chat-entry');
    const dot = entry?.querySelector('.chat-entry-dot');
    if (dot) dot.hidden = !unread;
    if (entry) entry.setAttribute('aria-label', unread ? '公共聊天室，有新消息' : '公共聊天室');
    setChatUnreadIndicator(unread);
}

function rememberRead(room) {
    if (document.hidden || !room.viewer?.viewer_key || room.resync || !atBottom(room.feed)) return;
    const key = room.viewer.viewer_key;
    const id = Math.max(room.cursor, seenId(key));
    readInMemory.set(key, id);
    try { localStorage.setItem(seenPrefix + key, String(id)); } catch { /* In-memory state still works. */ }
    room.newIds.clear();
    updateNewButton(room);
    viewerKey = key;
    setUnread(latestUnreadId > id);
}

function disableChat() {
    enabled = false;
    document.querySelectorAll('[data-page="chat"]').forEach(entry => { entry.hidden = true; });
    setUnread(false);
    if (!mounted) return;
    const { page } = mounted;
    unmountChat();
    page.querySelector('#chat-status-text').textContent = '公共聊天室暂未开放';
    page.querySelector('#chat-status').hidden = false;
}

export function initializeChatIndicators() {
    if (!byId('page-chat')) return;
    let request = null;
    const refresh = async () => {
        if (request || !enabled || !eligible() || document.hidden || state.currentPage === 'chat') return;
        const username = state.currentUsername;
        const expiry = state.temporarySessionExpiresAt;
        const controller = new AbortController();
        request = controller;
        const timeout = indicatorResources.setTimeout(() => controller.abort(), 10000);
        try {
            const response = await indicatorResources.fetch('/api/chat/unread', {
                cache: 'no-store', signal: controller.signal,
                headers: { 'X-Device-ID': apiClient.getDeviceId() },
            });
            const payload = await response.json();
            if (controller.signal.aborted || !eligible() || username !== state.currentUsername
                || expiry !== state.temporarySessionExpiresAt || state.currentPage === 'chat' || document.hidden) return;
            if (payload.code === 'CHAT_DISABLED' || payload.data?.enabled === false) {
                disableChat();
            } else if (payload.success) {
                viewerKey = payload.data.viewer_key;
                latestUnreadId = payload.data.latest_id || 0;
                setUnread(latestUnreadId > seenId(viewerKey));
            } else if (response.status === 401) {
                latestUnreadId = 0;
                setUnread(false);
            }
        } catch {
            // The next scheduled status check can recover silently.
        } finally {
            indicatorResources.clearTimeout(timeout);
            if (request === controller) request = null;
        }
    };
    const syncAccount = () => {
        const entry = byId('home-chat-entry');
        if (entry) entry.hidden = !enabled || !eligible();
        viewerKey = '';
        latestUnreadId = 0;
        setUnread(false);
        request?.abort();
        request = null;
        refresh();
    };
    indicatorResources.addCleanup(store.subscribe((_value, key) => {
        if (['currentUsername', 'isGuestMode', 'temporarySessionExpiresAt', 'chatSessionStale'].includes(key)) syncAccount();
        if (key === 'currentPage' && state.currentPage === 'chat') {
            request?.abort();
            request = null;
        }
    }));
    indicatorResources.listen(document, 'visibilitychange', () => {
        if (document.hidden) request?.abort();
        else refresh();
    });
    indicatorResources.listen(window, 'pageshow', refresh);
    indicatorResources.listen(window, 'storage', event => {
        if (event.key === seenPrefix + viewerKey) setUnread(eligible() && latestUnreadId > seenId(viewerKey));
        if ((event.key === chatSessionChangeKey || event.key === 'device_id') && event.oldValue !== event.newValue) {
            state.chatSessionStale = true;
            if (mounted) expireChatSession('账号会话已在其他页面变更，请重新登录。');
        }
    });
    indicatorResources.setInterval(refresh, 60_000);
    syncAccount();
}

function create(tag, className = '', value = '') {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = value ?? '';
    return element;
}

function button(className, label) {
    const element = create('button', className, label);
    element.type = 'button';
    return element;
}

function statusLabel(status) {
    return status === 'recalled' ? '原消息已撤回' : '原消息已删除';
}

function live(room, text) {
    room.live.textContent = text;
}

function showStatus(room, text, retry = false) {
    room.status.hidden = !text;
    room.statusText.textContent = text;
    room.retry.hidden = !retry;
}

function atBottom(feed) {
    return feed.scrollHeight - feed.clientHeight - feed.scrollTop < 30;
}

function captureAnchor(room) {
    if (atBottom(room.feed)) return { bottom: true };
    const top = room.feed.getBoundingClientRect().top;
    const row = Array.from(room.list.children).find(element =>
        element.dataset.messageId && element.getBoundingClientRect().bottom > top);
    return { id: row?.dataset.messageId, offset: row ? row.getBoundingClientRect().top - top : 0, top: room.feed.scrollTop };
}

function restoreAnchor(room, anchor) {
    if (anchor.bottom) {
        room.feed.scrollTop = room.feed.scrollHeight;
        return;
    }
    const row = anchor.id && room.list.querySelector(`[data-message-id="${anchor.id}"]`);
    room.feed.scrollTop = row
        ? room.feed.scrollTop + row.getBoundingClientRect().top - room.feed.getBoundingClientRect().top - anchor.offset
        : anchor.top;
}

function updateNewButton(room) {
    const count = room.newIds.size;
    room.newButton.hidden = count === 0;
    room.newButton.textContent = count ? `有 ${count} 条新消息 ↓` : '';
}

function canSend(room) {
    return room.ready && !room.settings.readonly && !room.mute?.active;
}

function syncControls(room) {
    const showNotice = Boolean(room.settings.pinned_notice);
    room.tools.hidden = !room.ready;
    room.rules.hidden = !showNotice;
    room.notice.hidden = !showNotice || !room.noticeVisible;
    room.noticeText.textContent = room.settings.pinned_notice || '';
    room.rules.setAttribute('aria-expanded', String(showNotice && room.noticeVisible));
    room.notice.classList.toggle('is-expanded', room.noticeExpanded);
    room.noticeToggle.setAttribute('aria-expanded', String(room.noticeExpanded));
    room.noticeToggle.textContent = room.noticeExpanded ? '折叠' : '展开';
    room.noticeHide.hidden = !room.noticeExpanded;

    room.privacyOpen.textContent = `显示学号：${room.viewer?.show_student_id ? '开启' : '关闭'}`;
    room.composer.hidden = !canSend(room);
    room.muteStatus.hidden = !room.ready || (!room.settings.readonly && !room.mute?.active);
    const restrictions = [];
    if (room.settings.readonly) restrictions.push('当前聊天室已开启全员禁言，仅可浏览消息');
    if (room.mute?.active) {
        const until = Date.parse(room.mute.until);
        const when = Number.isFinite(until) ? `解禁时间 ${fullTimeFormat.format(until)}` : '永久禁言';
        restrictions.push(`你已被禁言 · ${when}${room.mute.reason ? ` · ${room.mute.reason}` : ''}`);
    }
    room.muteStatus.textContent = restrictions.join('。');
    if (!room.composer.hidden) syncDraft(room);
}

function syncDraft(room) {
    const limit = room.settings.max_length || 500;
    const lines = room.settings.max_lines || 12;
    const raw = room.input.value;
    const length = Array.from(raw.trim()).length;
    const tooManyLines = raw.trim().split('\n').length > lines;
    room.send.disabled = room.sending || length < 1 || length > limit || tooManyLines;
    room.send.textContent = room.sending ? '发送中…' : '发送';
    room.input.readOnly = room.sending;
    room.input.setAttribute('aria-invalid', String(length > limit || tooManyLines));
    room.count.hidden = !tooManyLines && length < limit * 0.8;
    room.count.textContent = tooManyLines ? `每条消息最多 ${lines} 行` : `${length}/${limit} 字`;
    const follow = atBottom(room.feed);
    room.input.style.height = '0px';
    room.input.style.height = `${Math.min(120, room.input.scrollHeight + 2)}px`;
    if (follow) room.feed.scrollTop = room.feed.scrollHeight;
}

function syncReply(room) {
    const reply = room.messages.get(room.replyId);
    room.reply.hidden = !reply;
    room.replyName.textContent = reply ? `回复 ${reply.author?.display_name || '消息'}` : '';
    room.replySummary.textContent = !reply ? '' : reply.status === 'normal' ? reply.content : statusLabel(reply.status);
}

function renderMessage(room, message) {
    const row = create('li', 'chat-message');
    row.dataset.messageId = message.id;
    if (message.status !== 'normal') {
        row.classList.add('chat-tombstone');
        row.append(create('span', '', statusLabel(message.status)));
        return row;
    }
    const own = Boolean(message.is_own);
    const official = message.author?.role === 'admin';
    if (own) row.classList.add('is-own');
    if (!own) {
        const displayName = message.author?.display_name || '';
        const gradeMatch = displayName.match(/^([0-9]{2})级/) || displayName.match(/^([0-9]{2})[0-9]{5,}$/);
        const avatar = create('span', 'chat-avatar', official ? '管' : gradeMatch?.[1] || '同');
        avatar.setAttribute('aria-hidden', 'true');
        row.append(avatar);
    }
    const content = create('div', 'chat-message-content');
    const header = create('div', 'chat-message-header');
    header.append(create('strong', '', own ? '我' : message.author?.display_name || '同学'));
    if (own) header.append(create('small', '', room.viewer?.show_student_id ? '已公开学号' : '已隐藏学号'));
    if (official) {
        header.classList.add('is-official');
        if (message.author?.display_name !== '管理员') header.append(create('small', '', '管理员'));
    }

    const bubble = create('div', 'chat-bubble');
    if (message.reply_to) {
        const quote = message.reply_to;
        const exists = room.messages.has(quote.id);
        const box = exists ? button('chat-quote', '') : create('div', 'chat-quote');
        if (exists) {
            box.dataset.chatAction = 'jump';
            box.dataset.target = quote.id;
            box.setAttribute('aria-label', '定位被引用的消息');
        }
        if (quote.status === 'normal') {
            box.append(create('strong', '', quote.display_name), create('span', '', quote.excerpt));
        } else {
            box.append(create('span', '', statusLabel(quote.status)));
        }
        bubble.append(box);
    }
    bubble.append(create('p', 'chat-message-text', message.content));

    const details = create('details', 'chat-message-actions');
    const summary = create('summary', '', '⋯');
    summary.setAttribute('aria-label', '消息操作');
    const actions = create('div', 'chat-action-list');
    const candidates = [];
    if (canSend(room)) candidates.push(['reply', '回复']);
    candidates.push(['copy', '复制']);
    if (own && now(room) - Date.parse(message.create_time) < (room.settings.recall_seconds || 120) * 1000) {
        candidates.push(['recall', '撤回']);
    }
    if (!own && !official) candidates.push(['report', '举报']);
    for (const [action, label] of candidates) {
        const control = button('chat-action', label);
        control.dataset.chatAction = action;
        actions.append(control);
    }
    details.append(summary, actions);
    content.append(header, bubble);
    row.append(content, details);
    return row;
}

function renderOutgoing(room) {
    const row = create('li', 'chat-message is-own chat-outgoing');
    const content = create('div', 'chat-message-content');
    const header = create('div', 'chat-message-header');
    header.append(create('strong', '', '我'), create('small', '', room.sending ? '发送中…' : '发送失败'));
    const bubble = create('div', 'chat-bubble');
    bubble.append(create('p', 'chat-message-text', room.outgoing.content));
    content.append(header, bubble);
    row.append(content);
    if (!room.sending && canSend(room)) {
        const retry = button('chat-text-button', '重试');
        retry.dataset.chatAction = 'retry';
        row.append(retry);
    }
    return row;
}

function renderFeed(room, anchor = captureAnchor(room)) {
    const active = document.activeElement;
    const focusedRow = active?.closest?.('[data-message-id]');
    const focusedAction = active?.dataset?.chatAction;
    const oldMenu = active?.closest?.('details')?.open;
    const fragment = document.createDocumentFragment();
    let previous = null;
    const messages = Array.from(room.messages.values()).sort((a, b) => a.id - b.id);
    for (const message of messages) {
        if (needsChatDate(previous, message.create_time)) {
            const row = create('li', 'chat-date');
            const time = create('time', '', chatDateLabel(message.create_time, now(room)));
            time.dateTime = message.create_time;
            row.append(time);
            fragment.append(row);
        }
        fragment.append(renderMessage(room, message));
        previous = message.create_time;
    }
    if (room.outgoing) fragment.append(renderOutgoing(room));
    room.list.replaceChildren(fragment);
    room.history.hidden = messages.length === 0;
    room.older.disabled = room.loadingOlder || !room.hasOlder;
    room.older.textContent = room.loadingOlder ? '正在读取更早消息…'
        : room.hasOlder ? '加载更早消息' : '已到最早消息';
    if (focusedRow) {
        const row = room.list.querySelector(`[data-message-id="${focusedRow.dataset.messageId}"]`);
        const summary = row?.querySelector('summary');
        if (summary && oldMenu) summary.parentElement.open = true;
        const action = focusedAction && row?.querySelector(`[data-chat-action="${focusedAction}"]`);
        focusUiElement(action || summary || room.feed);
    }
    restoreAnchor(room, anchor);
    syncReply(room);
    updateNewButton(room);
}

async function requestChat(room, endpoint, { method = 'GET', body, signal } = {}) {
    const response = await resources.api.request(`/api/chat/${endpoint}`, {
        cache: 'no-store', method, signal,
        headers: room.context ? { 'X-Chat-Context': room.context } : {},
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json();
    if (!room.scope.isActive()) throw new DOMException('页面已离开', 'AbortError');
    if (payload.code === 'CHAT_DISABLED' || payload.data?.enabled === false) {
        disableChat();
        throw new DOMException('聊天室停用', 'AbortError');
    }
    if (response.status === 401 || payload.code === 'AUTH_EXPIRED') {
        expireChatSession(payload.message);
        throw new DOMException('登录已失效', 'AbortError');
    }
    if (!response.ok || !payload.success) {
        throw Object.assign(new Error(payload.message || '操作失败，请重试。'), {
            code: payload.code, data: payload.data, retryAfter: Number(response.headers.get('Retry-After')),
        });
    }
    if (method === 'GET' && payload.data.history_version < room.historyFloor) {
        throw new DOMException('聊天记录已变化', 'AbortError');
    }
    return payload.data;
}

function updateRoomPolicy(room, data) {
    const previous = [room.settings.readonly, room.mute?.active, room.settings.recall_seconds, room.viewer?.show_student_id].join();
    if (data.settings) Object.assign(room.settings, data.settings);
    if (data.viewer || data.privacy) room.viewer = { ...room.viewer, ...data.viewer, ...data.privacy };
    if (data.mute || data.viewer?.mute) room.mute = data.mute || data.viewer.mute;
    if (data.settings_version != null) room.settingsVersion = data.settings_version;
    if (data.history_version != null) room.historyFloor = Math.max(room.historyFloor, data.history_version);
    const time = Date.parse(data.server_time);
    if (Number.isFinite(time)) room.clockOffset = time - Date.now();
    latestUnreadId = Math.max(latestUnreadId, data.latest_id || 0);
    syncControls(room);
    return previous !== [room.settings.readonly, room.mute?.active, room.settings.recall_seconds, room.viewer?.show_student_id].join();
}

function pageQuery(room, query) {
    return `messages?${new URLSearchParams({
        limit: 30, settings_version: room.settingsVersion, history_version: room.historyVersion, ...query,
    })}`;
}

async function reloadHistory(room, version, signal) {
    if (!room.resync) {
        const ids = Array.from(room.messages.keys());
        room.resync = {
            anchor: captureAnchor(room),
            start: Math.max(0, (ids.length ? Math.min(...ids) : 1) - 1),
            end: Math.max(room.cursor, ...ids),
            clear: version !== room.historyVersion,
        };
    }
    const saved = room.resync;
    const updated = new Map();
    let cursor = saved.start;
    let restarts = 0;
    const clearOldFeed = () => {
        room.messages.clear();
        room.list.replaceChildren();
        room.reply.hidden = true;
        room.history.hidden = true;
        showStatus(room, '正在同步聊天记录…');
    };

    try {
        do {
            const data = await requestChat(room, pageQuery(room, { after_id: cursor, limit: 100, history_version: version }), { signal });
            updateRoomPolicy(room, data);
            if (data.resync_required || data.history_version !== version) {
                if (++restarts > 3) throw new Error('消息变化较多，请重试。');
                version = data.history_version;
                updated.clear();
                cursor = saved.start;
                saved.clear = true;
                continue;
            }
            for (const message of data.messages || []) {
                if (message.id > saved.end) break;
                updated.set(message.id, message);
                if (message.status !== 'normal') room.newIds.delete(message.id);
            }
            const next = data.next_after_id ?? cursor;
            if (!data.has_more || next <= cursor || next >= saved.end) {
                cursor = updated.size ? Array.from(updated.keys()).at(-1) : cursor;
                break;
            }
            cursor = next;
        } while (true);
    } catch (error) {
        // 历史版本已变化且同步失败时清理旧 DOM，防止撤回内容或已隐藏学号残留。
        if (error.name !== 'AbortError' && saved.clear) clearOldFeed();
        throw error;
    }

    room.historyVersion = version;
    room.cursor = Math.max(room.cursor, cursor);
    room.messages = updated;
    room.resync = null;
    showStatus(room, updated.size || room.outgoing ? '' : '还没有消息，欢迎聊聊。');
    renderFeed(room, saved.anchor);
    rememberRead(room);
}

function schedulePoll(room, delay = pollDelays[room.pollLevel]) {
    room.scope.clearTimeout(room.pollTimer);
    if (room.scope.isActive() && !document.hidden && room.ready) {
        room.pollTimer = room.scope.setTimeout(() => poll(room), delay);
    }
}

async function poll(room, { refresh = false } = {}) {
    if (!room.scope.isActive() || document.hidden || !room.ready) return;
    if (room.polling || room.loadingOlder) {
        room.refreshQueued ||= refresh;
        return;
    }
    room.polling = true;
    const controller = new AbortController();
    room.pollController = controller;
    room.scope.clearTimeout(room.pollTimer);
    try {
        if (room.resync || refresh) await reloadHistory(room, room.historyVersion, controller.signal);
        let added = 0;
        let more;
        do {
            const data = await requestChat(room, pageQuery(room, { after_id: room.cursor }), { signal: controller.signal });
            const policyChanged = updateRoomPolicy(room, data);
            if (data.resync_required || data.history_version !== room.historyVersion) {
                await reloadHistory(room, data.history_version, controller.signal);
                more = true;
                continue;
            }
            const anchor = captureAnchor(room);
            const batch = data.messages || [];
            for (const message of batch) {
                if (!room.messages.has(message.id)) {
                    added++;
                    if (!anchor.bottom && !message.is_own && message.status === 'normal') room.newIds.add(message.id);
                }
                room.messages.set(message.id, message);
            }
            const next = data.next_after_id ?? room.cursor;
            more = data.has_more && next > room.cursor;
            room.cursor = Math.max(room.cursor, next);
            if (batch.length || policyChanged) renderFeed(room, anchor);
            rememberRead(room);
        } while (more && !document.hidden);
        showStatus(room, room.messages.size || room.outgoing ? '' : '还没有消息，欢迎聊聊。');
        room.pollLevel = added ? 0 : Math.min(room.pollLevel + 1, pollDelays.length - 1);
        if (added) live(room, `${added} 条新消息`);
        if (refresh) live(room, '聊天记录已刷新');
    } catch (error) {
        if (error.name !== 'AbortError') showStatus(room, error.message || '无法读取消息，请重试。', true);
    } finally {
        room.pollController = null;
        room.polling = false;
        if (room.scope.isActive()) {
            const queued = room.refreshQueued;
            room.refreshQueued = false;
            if (room.olderQueued && room.hasOlder && !room.resync) {
                room.olderQueued = false;
                room.refreshQueued = queued;
                loadOlder(room);
            } else if (queued) poll(room, { refresh: true });
            else schedulePoll(room);
        }
    }
}

async function loadOlder(room) {
    if (!room.hasOlder || room.loadingOlder || room.resync) return;
    if (room.polling) {
        room.olderQueued = true;
        return;
    }
    const before = Math.min(...room.messages.keys());
    if (!Number.isFinite(before)) return;
    room.loadingOlder = true;
    room.older.disabled = true;
    room.older.textContent = '正在读取更早消息…';
    try {
        const data = await requestChat(room, pageQuery(room, { before_id: before }));
        updateRoomPolicy(room, data);
        if (data.resync_required || data.history_version !== room.historyVersion) {
            await reloadHistory(room, data.history_version);
            return;
        }
        const anchor = captureAnchor(room);
        for (const message of data.messages || []) room.messages.set(message.id, message);
        room.hasOlder = data.has_older;
        showStatus(room, '');
        renderFeed(room, anchor);
    } catch (error) {
        if (error.name !== 'AbortError') live(room, error.message || '无法读取更早消息，请重试。');
    } finally {
        if (room.scope.isActive()) {
            room.loadingOlder = false;
            room.older.disabled = !room.hasOlder;
            room.older.textContent = room.hasOlder ? '加载更早消息' : '已到最早消息';
            if (room.refreshQueued) {
                room.refreshQueued = false;
                poll(room, { refresh: true });
            } else {
                schedulePoll(room);
            }
        }
    }
}

async function bootstrap(room) {
    if (room.booting || !room.scope.isActive()) return;
    room.booting = true;
    showStatus(room, '正在读取消息…');
    try {
        const data = await requestChat(room, 'bootstrap');
        room.context = data.context;
        room.cursor = data.next_after_id ?? data.latest_id ?? 0;
        room.hasOlder = data.has_older;
        room.historyVersion = data.history_version;
        room.ready = true;
        updateRoomPolicy(room, data);
        for (const message of data.messages || []) room.messages.set(message.id, message);
        showStatus(room, room.messages.size ? '' : '还没有消息，欢迎聊聊。');
        renderFeed(room, { bottom: true });
        rememberRead(room);
        syncViewport(room);
        schedulePoll(room);
    } catch (error) {
        if (error.name !== 'AbortError') showStatus(room, error.message || '无法读取消息，请重试。', true);
    } finally {
        room.booting = false;
    }
}

function newMessageId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const value = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

async function sendMessage(room) {
    if (!canSend(room) || room.send.disabled) return;
    const content = room.input.value;
    const replyId = room.replyId || null;
    if (room.attempt?.content !== content || room.attempt.reply_to_id !== replyId) {
        room.attempt = { content, reply_to_id: replyId, client_msg_id: newMessageId() };
    }
    room.outgoing = room.attempt;
    room.sending = true;
    room.sendStatus.textContent = '正在发送…';
    syncDraft(room);
    showStatus(room, '');
    renderFeed(room);
    try {
        const data = await requestChat(room, 'messages', { method: 'POST', body: room.attempt });
        room.input.value = '';
        room.replyId = null;
        room.attempt = null;
        room.outgoing = null;
        room.messages.set(data.message.id, data.message);
        renderFeed(room, { bottom: true });
        showStatus(room, '');
        room.sendStatus.textContent = '';
        live(room, '消息已发送');
        room.pollLevel = 0;
        schedulePoll(room, 0);
    } catch (error) {
        if (error.name === 'AbortError') return;
        room.sendStatus.textContent = error.message || '发送失败，草稿已保留。';
        if (error.code === 'CHAT_MUTED') updateRoomPolicy(room, { mute: error.data?.mute });
        if (error.code === 'CHAT_READONLY') updateRoomPolicy(room, { settings: { readonly: true } });
        if (['CHAT_READONLY', 'CHAT_MUTED', 'RATE_LIMITED'].includes(error.code)) schedulePoll(room, 0);
    } finally {
        if (room.scope.isActive()) {
            room.sending = false;
            syncDraft(room);
            if (room.outgoing) renderFeed(room);
        }
    }
}

function updateOwnDisplay(room, data) {
    room.historyFloor = Math.max(room.historyFloor, data.history_version);
    room.viewer.show_student_id = data.show_student_id;
    room.viewer.display_name = data.display_name;
    for (const message of room.messages.values()) {
        if (message.status === 'normal' && message.is_own && message.author) {
            message.author.display_name = data.display_name;
        }
        if (message.reply_to?.is_own && message.reply_to.status === 'normal') {
            message.reply_to.display_name = data.display_name;
        }
    }
    renderFeed(room);
    syncControls(room);
}

function showPrivacy(room) {
    const preview = byId('chat-privacy-preview');
    preview.textContent = `当前对外显示为 ${room.viewer.display_name || '匿名同学'}`;
    byId('chat-privacy-choice').checked = Boolean(room.viewer.show_student_id);
    byId('chat-privacy-status').textContent = '';
    openUiModal(byId('chat-privacy-dialog'), { initialFocusSelector: '#chat-privacy-choice' });
}

async function savePrivacy(room) {
    const control = byId('chat-privacy-save');
    if (control.disabled) return;
    control.disabled = true;
    const choice = byId('chat-privacy-choice');
    choice.disabled = true;
    try {
        const data = await requestChat(room, 'settings/privacy', {
            method: 'PUT', body: { show_student_id: choice.checked },
        });
        updateOwnDisplay(room, data);
        closeUiModal(byId('chat-privacy-dialog'));
        showUiToast('发言设置已保存', 'success');
        schedulePoll(room, 0);
    } catch (error) {
        if (error.name !== 'AbortError') byId('chat-privacy-status').textContent = error.message;
    } finally {
        control.disabled = false;
        choice.disabled = false;
    }
}

function showReport(room, id) {
    room.reportId = id;
    byId('chat-report-form').reset();
    byId('chat-report-status').textContent = '';
    openUiModal(byId('chat-report-dialog'), { initialFocusSelector: '#chat-report-reason' });
}

async function submitReport(room) {
    const control = byId('chat-report-submit');
    if (control.disabled || !room.reportId) return;
    control.disabled = true;
    const reason = byId('chat-report-reason').value;
    const detail = byId('chat-report-detail').value;
    try {
        await requestChat(room, `messages/${room.reportId}/report`, { method: 'POST', body: { reason, detail } });
        closeUiModal(byId('chat-report-dialog'));
        showUiToast('举报已提交', 'success');
    } catch (error) {
        if (error.name !== 'AbortError') byId('chat-report-status').textContent = error.message;
    } finally {
        control.disabled = false;
    }
}

async function recall(room, message) {
    const accepted = await requestUiConfirmation({
        title: '撤回消息', message: '撤回后，群聊和引用中将显示撤回提示。', confirmText: '撤回消息', danger: true,
    });
    if (!accepted || !room.scope.isActive()) return;
    try {
        const data = await requestChat(room, `messages/${message.id}/recall`, { method: 'POST', body: {} });
        room.historyFloor = Math.max(room.historyFloor, data.history_version);
        for (const existing of room.messages.values()) {
            if (existing.reply_to?.id === message.id) existing.reply_to = { id: message.id, status: 'recalled' };
        }
        room.messages.set(message.id, data.message);
        renderFeed(room);
        showUiToast('消息已撤回', 'success');
        schedulePoll(room, 0);
    } catch (error) {
        if (error.name !== 'AbortError') showUiToast(error.message, 'error');
    }
}

function closeMessageMenus(room, except = null) {
    room.list.querySelectorAll('details[open]').forEach(menu => {
        if (menu !== except) menu.open = false;
    });
}

async function handleMessageAction(room, event) {
    const control = event.target.closest('[data-chat-action]');
    if (!control) return;
    const action = control.dataset.chatAction;
    if (action === 'retry') {
        focusUiElement(room.input);
        await sendMessage(room);
        return;
    }
    const row = control.closest('[data-message-id]');
    const message = room.messages.get(Number(row?.dataset.messageId));
    if (!message) return;
    if (action === 'jump') {
        const target = room.list.querySelector(`[data-message-id="${control.dataset.target}"]`);
        if (!target) return;
        const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        target.scrollIntoView({ block: 'nearest', behavior: reduce ? 'instant' : 'smooth' });
        target.classList.add('is-highlighted');
        room.scope.setTimeout(() => target.classList.remove('is-highlighted'), 1600);
        return;
    }
    const menu = control.closest('details');
    if (menu) {
        menu.open = false;
        focusUiElement(menu.querySelector('summary'));
    }
    if (action === 'reply' && canSend(room)) {
        room.replyId = message.id;
        resetOutgoingPreview(room);
        syncReply(room);
        focusUiElement(room.input);
    } else if (action === 'copy') {
        try {
            await navigator.clipboard.writeText(message.content);
            if (room.scope.isActive()) showUiToast('已复制消息', 'success');
        } catch {
            if (room.scope.isActive()) showUiToast('复制失败，请选中文本后复制。', 'error');
        }
    } else if (action === 'report') {
        showReport(room, message.id);
    } else if (action === 'recall') {
        recall(room, message);
    }
}

function resetOutgoingPreview(room) {
    if (!room.outgoing || room.sending) return;
    room.outgoing = null;
    room.sendStatus.textContent = '';
    if (!room.messages.size && room.status.hidden) showStatus(room, '还没有消息，欢迎聊聊。');
    renderFeed(room);
}

function syncViewport(room) {
    const viewport = window.visualViewport;
    const nav = byId('mobile-bottom-nav');
    if (!viewport || !nav || !window.matchMedia?.('(max-width: 768px)').matches) {
        room.host.style.removeProperty('--chat-viewport-height');
        room.host.style.removeProperty('--chat-viewport-top');
        room.page.classList.remove('is-keyboard-open');
        return;
    }
    const follow = atBottom(room.feed);
    const top = viewport.offsetTop;
    const navTop = nav.getBoundingClientRect().top;
    const visibleBottom = top + viewport.height;
    const bottom = navTop > top && navTop < visibleBottom ? navTop : visibleBottom;
    room.page.classList.toggle('is-keyboard-open', viewport.height < window.innerHeight - 120);
    room.host.style.setProperty('--chat-viewport-height', `${Math.max(0, bottom - top)}px`);
    room.host.style.setProperty('--chat-viewport-top', `${top}px`);
    if (follow) room.feed.scrollTop = room.feed.scrollHeight;
}

function bindChat(room) {
    const { scope, feed, list, input } = room;
    const on = (id, type, callback) => scope.listen(byId(id), type, callback);
    on('chat-refresh', 'click', () => poll(room, { refresh: true }));
    on('chat-retry', 'click', () => room.ready ? poll(room, { refresh: true }) : bootstrap(room));
    on('chat-older', 'click', () => loadOlder(room));
    on('chat-new', 'click', () => {
        feed.scrollTop = feed.scrollHeight;
        rememberRead(room);
        focusUiElement(feed);
    });
    scope.listen(feed, 'scroll', () => {
        rememberRead(room);
        if (feed.scrollHeight > feed.clientHeight && feed.scrollTop < 20) loadOlder(room);
    }, { passive: true });
    scope.listen(list, 'click', event => handleMessageAction(room, event));
    scope.listen(document, 'click', event => closeMessageMenus(room, event.target.closest?.('.chat-message-actions')));
    scope.listen(list, 'keydown', event => {
        if (event.key !== 'Escape') return;
        const menu = event.target.closest('details[open]');
        if (!menu) return;
        menu.open = false;
        focusUiElement(menu.querySelector('summary'));
    });
    on('chat-rules', 'click', () => {
        room.noticeVisible = !room.noticeVisible;
        if (room.noticeVisible) room.noticeExpanded = false;
        syncControls(room);
    });
    on('chat-notice-toggle', 'click', () => {
        room.noticeExpanded = !room.noticeExpanded;
        syncControls(room);
    });
    on('chat-notice-hide', 'click', () => {
        room.noticeVisible = false;
        syncControls(room);
        focusUiElement(room.rules);
    });
    on('chat-privacy-open', 'click', () => showPrivacy(room));
    on('chat-privacy-form', 'submit', event => { event.preventDefault(); savePrivacy(room); });
    on('chat-report-form', 'submit', event => { event.preventDefault(); submitReport(room); });
    for (const name of ['privacy', 'report']) {
        for (const action of ['close', 'cancel']) {
            on(`chat-${name}-${action}`, 'click', () => closeUiModal(byId(`chat-${name}-dialog`)));
        }
    }
    on('chat-reply-cancel', 'click', () => {
        room.replyId = null;
        resetOutgoingPreview(room);
        syncReply(room);
        focusUiElement(input);
    });
    on('chat-composer', 'submit', event => { event.preventDefault(); sendMessage(room); });
    scope.listen(input, 'input', () => {
        resetOutgoingPreview(room);
        syncDraft(room);
    });
    scope.listen(input, 'keydown', event => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229
            || window.matchMedia?.('(max-width: 768px), (pointer: coarse)').matches) return;
        event.preventDefault();
        sendMessage(room);
    });
    scope.listen(document, 'visibilitychange', () => {
        if (document.hidden) {
            room.pollController?.abort();
            scope.clearTimeout(room.pollTimer);
        } else {
            poll(room);
        }
    });
    const queueViewport = () => {
        scope.cancelAnimationFrame(room.viewportFrame);
        room.viewportFrame = scope.requestAnimationFrame(() => syncViewport(room));
    };
    scope.listen(window.visualViewport, 'resize', queueViewport);
    scope.listen(window.visualViewport, 'scroll', queueViewport);
    scope.listen(window, 'resize', queueViewport);
    scope.addCleanup(() => room.pollController?.abort());
}

export function mountChat(page) {
    if (!page) return;
    if (!enabled) {
        byId('chat-status').hidden = false;
        byId('chat-status-text').textContent = '公共聊天室暂未开放';
        return;
    }
    const room = mounted = {
        page, host: page.closest('.main-content'), scope: resources.capture(), context: '', settings: {}, viewer: null, mute: null,
        clockOffset: 0, settingsVersion: 0, historyVersion: 0, historyFloor: 0, cursor: 0, hasOlder: false,
        messages: new Map(), newIds: new Set(), pollLevel: 0, noticeVisible: true, noticeExpanded: false,
        feed: byId('chat-feed'), list: byId('chat-messages'), history: byId('chat-history'), older: byId('chat-older'),
        status: byId('chat-status'), statusText: byId('chat-status-text'), retry: byId('chat-retry'),
        tools: byId('chat-tools'), rules: byId('chat-rules'), notice: byId('chat-notice'), noticeText: byId('chat-notice-text'),
        noticeToggle: byId('chat-notice-toggle'), noticeHide: byId('chat-notice-hide'), privacyOpen: byId('chat-privacy-open'),
        input: byId('chat-content'), send: byId('chat-send'), sendStatus: byId('chat-send-status'),
        count: byId('chat-count'), reply: byId('chat-reply'), replyName: byId('chat-reply-name'), replySummary: byId('chat-reply-summary'),
        composer: byId('chat-composer'), muteStatus: byId('chat-mute'), live: byId('chat-live'), newButton: byId('chat-new'),
    };
    bindChat(room);
    syncViewport(room);
    return bootstrap(room);
}

export function unmountChat() {
    const room = mounted;
    if (!room) return;
    mounted = null;
    resources.dispose();
    room.messages.clear();
    room.newIds.clear();
    room.attempt = null;
    room.outgoing = null;
    room.context = '';
    room.viewer = null;
    room.list.replaceChildren();
    room.scope.clearTimeout(room.pollTimer);
    room.input.value = '';
    room.input.readOnly = false;
    room.sendStatus.textContent = '';
    room.muteStatus.textContent = '';
    room.noticeText.textContent = '';
    room.replyName.textContent = '';
    room.replySummary.textContent = '';
    room.live.textContent = '';
    byId('chat-privacy-preview').textContent = '';
    byId('chat-privacy-status').textContent = '';
    byId('chat-report-status').textContent = '';
    byId('chat-report-form').reset();
    for (const element of [room.tools, room.notice, room.history, room.composer, room.muteStatus, room.newButton,
        room.count, room.reply, room.status]) element.hidden = true;
    const modal = state.uiModalState.activeModal;
    if (modal?.id === 'ui-confirm-modal') resolveUiConfirmation(false);
    else if (modal?.id.startsWith('chat-')) closeUiModal(modal, { restoreFocus: false, animate: false });
    room.host.style.removeProperty('--chat-viewport-height');
    room.host.style.removeProperty('--chat-viewport-top');
    room.page.classList.remove('is-keyboard-open');
}
