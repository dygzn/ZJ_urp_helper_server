const AdminChat = (() => {
    const element = name => document.getElementById(`admin-chat-${name}`);
    const endpoint = '/api/admin/chat';
    const formatTime = new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Shanghai', hourCycle: 'h23',
    });
    const statuses = { normal: '正常', recalled: '已撤回', deleted: '已删除' };
    const reportStatuses = { pending: '待处理', resolved: '已处理', ignored: '已忽略' };
    const reportReasons = { spam: '广告／刷屏', abuse: '辱骂／骚扰', privacy: '泄露隐私', other: '其他' };
    const sectionNames = ['messages', 'reports', 'mutes'];
    let session = null;
    let initialized = false;

    function time(value) {
        if (!value) return '未知';
        const date = new Date(value);
        return Number.isNaN(date.valueOf()) ? '未知' : formatTime.format(date);
    }

    function status(name, message = '', error = false) {
        const node = element(`${name}-status`);
        node.textContent = message;
        node.classList.toggle('is-error', error);
    }

    async function request(workspace, path, options = {}) {
        const { signal = workspace.abort.signal, method = 'GET', body } = options;
        const headers = { 'X-Admin-Key': adminKey };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const response = await fetch(endpoint + path, {
            method, headers, cache: 'no-store', signal,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const result = await response.json().catch(() => null);
        if (session !== workspace || signal.aborted) throw new DOMException('请求已取消', 'AbortError');
        if (!response.ok || !result?.success) {
            throw Object.assign(new Error(result?.message || '聊天室请求失败，请重试'), { code: result?.code });
        }
        return result.data;
    }

    function errorMessage(error) {
        return error instanceof TypeError ? '网络连接失败，请重试' : error.message;
    }

    function makeButton(label, handler, danger = false) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = danger ? 'btn-danger' : 'btn-secondary';
        button.textContent = label;
        button.addEventListener('click', handler);
        return button;
    }

    function actions(...buttons) {
        const group = document.createElement('div');
        group.className = 'admin-chat-actions';
        group.append(...buttons);
        return group;
    }

    function renderTable(name, headings, items, rowFor) {
        const host = element(`${name}-list`);
        const restoreFocus = host.contains(document.activeElement);
        host.replaceChildren();
        if (items.length) {
            const table = document.createElement('table');
            table.className = `admin-chat-table admin-chat-table-${name}`;
            table.setAttribute('role', 'table');
            table.setAttribute('aria-labelledby', element(`${name}-title`).id);
            const head = table.createTHead();
            head.setAttribute('role', 'rowgroup');
            const header = head.insertRow();
            header.setAttribute('role', 'row');
            headings.forEach(heading => {
                const cell = document.createElement('th');
                cell.scope = 'col';
                cell.setAttribute('role', 'columnheader');
                cell.textContent = heading;
                header.append(cell);
            });
            const body = table.createTBody();
            body.setAttribute('role', 'rowgroup');
            for (const item of items) {
                const row = body.insertRow();
                row.setAttribute('role', 'row');
                rowFor(item).forEach((value, index) => {
                    const cell = row.insertCell();
                    cell.setAttribute('role', 'cell');
                    const label = document.createElement('span');
                    label.textContent = headings[index];
                    label.className = 'admin-chat-field-label';
                    label.setAttribute('aria-hidden', 'true');
                    const contents = document.createElement('div');
                    contents.className = 'admin-chat-field-value';
                    if (value instanceof Node) contents.append(value);
                    else contents.textContent = value ?? '—';
                    cell.append(label, contents);
                });
            }
            host.append(table);
        }
        if (restoreFocus) element(`${name}-title`).focus({ preventScroll: true });
    }

    function moderationAction(title, detail, button, path, method, affected, options = {}) {
        openAction({ title, detail, button, path, method, affected, ...options });
    }

    const tables = {
        messages: {
            headings: ['发送时间', '真实学号', '对外显示', '正文', '状态', '累计举报', '操作'],
            empty: '暂无符合条件的消息', cursor: 'before_id',
            row(item) {
                const buttons = [];
                const path = `/messages/${encodeURIComponent(item.id)}`;
                if (item.status !== 'deleted') {
                    buttons.push(makeButton('删除消息', () => moderationAction(
                        '删除消息', `删除消息 #${item.id} 并处理相关举报？`, '删除消息',
                        path, 'DELETE', ['messages', 'reports'],
                    ), true));
                }
                if (item.sender_role === 'user' && item.username) {
                    buttons.push(makeButton('禁言', () => moderationAction(
                        '禁言学号', `学号 ${item.username}`, '禁言', '/mutes', 'POST', ['mutes'],
                        { mute: true, body: { username: item.username } },
                    )));
                }
                const visibility = item.show_student_id ? '已公开学号' : '已隐藏学号';
                const displayName = item.sender_role === 'admin' ? '管理员' : `${item.display_name || '—'}\n${visibility}`;
                return [time(item.create_time), item.username, displayName, item.content,
                    statuses[item.status] || item.status, item.report_count ?? 0,
                    buttons.length ? actions(...buttons) : null];
            },
        },
        reports: {
            headings: ['举报时间', '消息', '作者学号', '举报人学号', '理由', '操作'],
            empty: '暂无待处理举报', cursor: 'before_id',
            row(item) {
                const path = `/reports/${encodeURIComponent(item.id)}/handle`;
                const reason = reportReasons[item.reason] || item.reason;
                let actionCell;
                if (item.status === 'pending') {
                    const buttons = [
                        makeButton('删除消息并处理', () => moderationAction(
                            '删除消息并处理举报', `删除消息 #${item.message_id} 并处理相关举报？`, '删除消息并处理',
                            path, 'POST', ['messages', 'reports'], { body: { action: 'delete_message' } },
                        ), true),
                        makeButton('忽略举报', event => runMutation({
                            path, method: 'POST', body: { action: 'ignore' },
                            affected: ['reports', 'messages'], statusName: 'reports',
                            success: '已忽略举报', source: event.currentTarget,
                        })),
                    ];
                    if (item.username) {
                        buttons.push(makeButton('禁言原作者', () => moderationAction(
                            '禁言原作者', `学号 ${item.username}`, '禁言', path, 'POST',
                            ['reports', 'messages', 'mutes'], { mute: true, body: { action: 'mute_author' } },
                        )));
                    }
                    actionCell = actions(...buttons);
                } else {
                    const label = reportStatuses[item.status] || item.status;
                    actionCell = item.handled_at ? `${label}\n${time(item.handled_at)}` : label;
                }
                return [time(item.create_time), item.content, item.username, item.reporter_username,
                    item.detail ? `${reason}\n${item.detail}` : reason, actionCell];
            },
        },
        mutes: {
            headings: ['学号', '原因', '到期时间', '操作'],
            empty: '暂无生效中的禁言', cursor: 'after_username',
            row(item) {
                return [item.username, item.reason, item.muted_until === null ? '永久' : time(item.muted_until),
                    makeButton('解除禁言', () => moderationAction(
                        '解除禁言', `学号 ${item.username} 将恢复发言权限。`, '解除禁言',
                        `/mutes/${encodeURIComponent(item.username)}`, 'DELETE', ['mutes'],
                    ))];
            },
        },
    };

    async function readList(name, append = false) {
        const workspace = session;
        if (!workspace) return;
        const current = workspace.lists[name];
        if (append && (current.cursor === null || current.pending)) return;
        current.pending?.abort();
        const pending = new AbortController();
        current.pending = pending;
        const more = element(`${name}-more`);
        const table = tables[name];
        more.disabled = true;
        status(name, '正在加载…');
        const query = new URLSearchParams({ limit: '30' });
        if (name === 'reports') query.set('status', workspace.reportStatus || 'pending');
        if (name === 'messages') {
            for (const [key, value] of Object.entries(workspace.filters)) if (value) query.set(key, value);
        }
        if (append) query.set(table.cursor, current.cursor);
        try {
            const data = await request(workspace, `/${name}?${query}`, { signal: pending.signal });
            current.rows = append ? [...current.rows, ...data.items] : data.items;
            current.cursor = data.has_more ? (data.next_cursor ?? null) : null;
            renderTable(name, table.headings, current.rows, table.row);
            if (current.cursor === null && more === document.activeElement) {
                element(`${name}-title`).focus({ preventScroll: true });
            }
            more.hidden = current.cursor === null;
            const emptyText = name === 'reports' && (workspace.reportStatus || 'pending') !== 'pending'
                ? '暂无符合条件的举报记录' : table.empty;
            status(name, current.rows.length ? '' : emptyText);
        } catch (error) {
            if (error.name !== 'AbortError' && session === workspace) status(name, errorMessage(error), true);
        } finally {
            if (session === workspace && current.pending === pending) {
                current.pending = null;
                more.disabled = false;
            }
        }
    }

    function updateOfficialState(workspace) {
        element('official').querySelector('[type="submit"]').disabled = !workspace.enabled || workspace.sending;
    }

    function applySettings(workspace, data) {
        const fields = element('settings').elements;
        for (const name of ['enabled', 'readonly']) fields[name].checked = data[name] === true || data[name] === 1;
        for (const name of ['pinned_notice', 'max_length', 'cooldown_seconds', 'recall_seconds']) fields[name].value = data[name] ?? '';
        fields.sensitive_words.value = data.sensitive_words.join('\n');
        workspace.version = data.settings_version;
        workspace.enabled = fields.enabled.checked;
        workspace.dirty = false;
        element('reload-settings').hidden = true;
        status('official', workspace.enabled ? '' : '启用聊天室后可以发送官方消息');
        updateOfficialState(workspace);
    }

    async function readSettings(replaceDraft = false) {
        const workspace = session;
        if (!workspace || workspace.settingsBusy || (!replaceDraft && workspace.dirty)) return;
        const fields = element('settings').querySelector('fieldset');
        workspace.settingsBusy = true;
        fields.disabled = true;
        status('settings', '正在读取配置…');
        try {
            applySettings(workspace, await request(workspace, '/settings'));
            status('settings');
        } catch (error) {
            if (error.name !== 'AbortError' && session === workspace) status('settings', errorMessage(error), true);
        } finally {
            if (session === workspace) {
                workspace.settingsBusy = false;
                fields.disabled = workspace.version === null;
            }
        }
    }

    async function saveSettings(event) {
        event.preventDefault();
        const workspace = session;
        if (!workspace || workspace.settingsBusy || workspace.version === null) return;
        const fields = event.currentTarget.elements;
        const body = {
            if_settings_version: workspace.version, enabled: fields.enabled.checked, readonly: fields.readonly.checked,
            pinned_notice: fields.pinned_notice.value, max_length: fields.max_length.valueAsNumber,
            cooldown_seconds: fields.cooldown_seconds.valueAsNumber, recall_seconds: fields.recall_seconds.valueAsNumber,
            sensitive_words: fields.sensitive_words.value.split(/[\n,，]+/).map(word => word.trim()).filter(Boolean),
        };
        const group = event.currentTarget.querySelector('fieldset');
        workspace.settingsBusy = true;
        group.disabled = true;
        status('settings', '正在保存配置…');
        try {
            applySettings(workspace, await request(workspace, '/settings', { method: 'PUT', body }));
            status('settings', '聊天室配置已保存');
        } catch (error) {
            if (error.name !== 'AbortError' && session === workspace) {
                if (error.code === 'SETTINGS_CONFLICT') {
                    workspace.dirty = true;
                    element('reload-settings').hidden = false;
                    status('settings', '配置已被修改。当前输入已保留，可读取最新配置。', true);
                } else {
                    status('settings', errorMessage(error), true);
                }
            }
        } finally {
            if (session === workspace) {
                workspace.settingsBusy = false;
                group.disabled = false;
            }
        }
    }

    function newMessageId() {
        if (crypto.randomUUID) return crypto.randomUUID();
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    async function sendOfficial(event) {
        event.preventDefault();
        const workspace = session;
        if (!workspace?.enabled || workspace.sending) return;
        const input = element('official-content');
        const content = input.value.trim();
        if (!content) {
            status('official', '请输入消息正文', true);
            input.focus();
            return;
        }
        if (workspace.draft?.content !== content) workspace.draft = { content, client_msg_id: newMessageId() };
        workspace.sending = true;
        updateOfficialState(workspace);
        status('official', '正在发送…');
        input.readOnly = true;
        try {
            await request(workspace, '/messages', { method: 'POST', body: workspace.draft });
            workspace.draft = null;
            input.value = '';
            status('official', '官方消息已发送');
            void readList('messages');
        } catch (error) {
            if (error.name !== 'AbortError' && session === workspace) status('official', errorMessage(error), true);
        } finally {
            if (session === workspace) {
                input.readOnly = false;
                workspace.sending = false;
                updateOfficialState(workspace);
            }
        }
    }

    function openAction(action) {
        if (!session || session.mutationPending) return;
        const form = element('action-form');
        form.reset();
        status('action');
        session.action = action;
        element('action-title').textContent = action.title;
        element('action-detail').textContent = action.detail;
        element('mute-fields').hidden = !action.mute;
        element('mute-duration').disabled = !action.mute;
        element('mute-reason').disabled = !action.mute;
        element('mute-reason').required = Boolean(action.mute);
        element('action-submit').textContent = action.button;
        adminOpenModal(element('action-modal'), action.mute ? '#admin-chat-mute-duration' : '#admin-chat-action-cancel');
    }

    async function runMutation(action, fromModal = false) {
        const workspace = session;
        if (!workspace || workspace.mutationPending) return;
        const statusName = fromModal ? 'action' : action.statusName;
        const button = fromModal ? element('action-submit') : action.source;
        const input = element('mute-reason');
        workspace.mutationPending = true;
        if (button instanceof HTMLButtonElement) button.disabled = true;
        status(statusName, '正在提交…');
        if (fromModal) input.readOnly = true;
        try {
            await request(workspace, action.path, { method: action.method, body: action.body });
            if (fromModal) {
                adminCloseModal(element('action-modal'));
                workspace.action = null;
            }
            showAdminToast(action.success || `已${action.button}`, 'success');
            await Promise.all(action.affected.map(name => readList(name)));
        } catch (error) {
            if (error.name !== 'AbortError' && session === workspace) status(statusName, errorMessage(error), true);
        } finally {
            if (session === workspace) {
                workspace.mutationPending = false;
                if (button instanceof HTMLButtonElement) button.disabled = false;
                if (fromModal) input.readOnly = false;
            }
        }
    }

    function submitAction(event) {
        event.preventDefault();
        const action = session?.action;
        if (!action) return;
        let body = action.body;
        if (action.mute) {
            const reason = element('mute-reason').value.trim();
            if (!reason) {
                status('action', '请填写禁言原因', true);
                element('mute-reason').focus();
                return;
            }
            body = { ...body, duration: element('mute-duration').value, reason };
        }
        void runMutation({ ...action, body }, true);
    }

    async function refresh() {
        const workspace = session;
        if (!workspace || workspace.refreshing) return;
        workspace.refreshing = true;
        element('refresh').disabled = true;
        try {
            await Promise.all([readSettings(), ...sectionNames.map(name => readList(name))]);
        } finally {
            if (session === workspace) {
                workspace.refreshing = false;
                element('refresh').disabled = false;
            }
        }
    }

    async function submitDirectMute(event) {
        event.preventDefault();
        const workspace = session;
        if (!workspace || workspace.mutationPending) return;
        const usernameInput = element('direct-mute-username');
        const durationSelect = element('direct-mute-duration');
        const reasonInput = element('direct-mute-reason');
        const submitButton = element('direct-mute-submit');
        const username = usernameInput.value.trim();
        const reason = reasonInput.value.trim();
        if (!username) {
            status('direct-mute', '请输入有效学号', true);
            usernameInput.focus();
            return;
        }
        if (!reason) {
            status('direct-mute', '请填写禁言原因', true);
            reasonInput.focus();
            return;
        }
        workspace.mutationPending = true;
        submitButton.disabled = true;
        status('direct-mute', '正在提交…');
        try {
            await request(workspace, '/mutes', {
                method: 'POST',
                body: { username, duration: durationSelect.value, reason },
            });
            event.currentTarget.reset();
            status('direct-mute', `已禁言学号 ${username}`);
            showAdminToast('已禁言该学号', 'success');
            await readList('mutes');
        } catch (error) {
            if (error.name !== 'AbortError' && session === workspace) status('direct-mute', errorMessage(error), true);
        } finally {
            if (session === workspace) {
                workspace.mutationPending = false;
                submitButton.disabled = false;
            }
        }
    }

    function bind() {
        initialized = true;
        element('refresh').addEventListener('click', refresh);
        element('settings').addEventListener('input', () => { if (session) session.dirty = true; });
        element('settings').addEventListener('submit', saveSettings);
        element('clear-notice').addEventListener('click', () => {
            if (!session) return;
            element('notice').value = '';
            session.dirty = true;
            element('notice').focus();
        });
        element('reload-settings').addEventListener('click', () => readSettings(true));
        element('filters').addEventListener('submit', event => {
            event.preventDefault();
            if (!session) return;
            session.filters = Object.fromEntries([...new FormData(event.currentTarget)].map(([name, value]) => [name, value.trim()]));
            void readList('messages');
        });
        element('report-filters')?.addEventListener('submit', event => {
            event.preventDefault();
            if (!session) return;
            session.reportStatus = element('report-status')?.value || 'pending';
            void readList('reports');
        });
        element('report-status')?.addEventListener('change', event => {
            if (!session) return;
            session.reportStatus = event.currentTarget.value || 'pending';
            void readList('reports');
        });
        element('direct-mute')?.addEventListener('submit', submitDirectMute);
        for (const name of sectionNames) element(`${name}-more`).addEventListener('click', () => readList(name, true));
        element('action-modal').querySelectorAll('[data-chat-dismiss]').forEach(button => {
            button.addEventListener('click', () => adminCloseModal(element('action-modal')));
        });
        element('official').addEventListener('submit', sendOfficial);
        element('action-form').addEventListener('submit', submitAction);
    }

    function mount() {
        if (session) return;
        if (!initialized) bind();
        session = {
            abort: new AbortController(), version: null, filters: {}, reportStatus: 'pending',
            lists: Object.fromEntries(sectionNames.map(name => [name, { cursor: null, rows: [], pending: null }])),
        };
        void refresh();
    }

    function unmount() {
        if (!session) return;
        const workspace = session;
        session = null;
        workspace.abort.abort();
        if (adminModalState.activeModal === element('action-modal')) adminCloseModal(element('action-modal'), false);
        for (const name of sectionNames) {
            workspace.lists[name].pending?.abort();
            element(`${name}-list`).replaceChildren();
            element(`${name}-more`).hidden = true;
            status(name);
        }
        for (const name of ['settings', 'official', 'filters', 'report-filters', 'direct-mute', 'action-form']) element(name)?.reset();
        for (const name of ['settings', 'official', 'direct-mute', 'action']) {
            if (element(`${name}-status`)) status(name);
        }
        element('settings').querySelector('fieldset').disabled = true;
        element('reload-settings').hidden = true;
        element('official').querySelector('[type="submit"]').disabled = true;
        if (element('direct-mute-submit')) element('direct-mute-submit').disabled = false;
        element('official-content').readOnly = false;
        element('action-submit').disabled = false;
        element('mute-reason').readOnly = false;
        element('action-detail').textContent = '';
    }

    return { mount, unmount };
})();
