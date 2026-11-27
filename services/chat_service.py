"""Database-backed discussion room. Public serializers only expose display identities."""

import hashlib
import hmac
import json
import math
import re
import sqlite3
import time
import unicodedata
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone

from flask import current_app

from database import get_db
from services.temporary_session_service import current_temporary_session

ROOM = 'general'
MAX_LINES = 12
REPORT_REASONS = {'spam', 'abuse', 'privacy', 'other'}
MUTE_SECONDS = {'1h': 3600, '24h': 86400, '7d': 604800, 'permanent': None}
ACCOUNT = re.compile(r'[A-Za-z0-9_-]{1,64}')
YEAR = re.compile(r'[0-9]{7,}')


class ChatError(Exception):
    def __init__(self, code, message, status=400, data=None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.data = data


def _now():
    return time.time_ns() // 1_000_000


def _iso(value):
    if value is None:
        return None
    return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def _mac(purpose, *parts):
    key = current_app.secret_key
    if isinstance(key, str):
        key = key.encode('utf-8')
    payload = json.dumps([purpose, *parts], ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    return hmac.new(key, payload, hashlib.sha256).hexdigest()


def _auth_expired():
    return ChatError('AUTH_EXPIRED', '登录已失效，请重新登录。', 401)


def _context(user):
    if user.get('temporary'):
        session = current_temporary_session(user['username'])
        if not session or session['expires_at'] * 1000 <= _now():
            raise _auth_expired()
        generation = session['session_id']
    else:
        generation = user['bind_time']
    return _mac('chat-context', user['device_id'], user['username'], bool(user.get('temporary')), generation)


def _check_context(user, context):
    if not isinstance(context, str) or len(context) != 64 or not context.isascii():
        raise _auth_expired()
    if not hmac.compare_digest(context, _context(user)):
        raise _auth_expired()


def _check_current_binding(conn, user, locking):
    temporary = user.get('temporary')
    binding = None
    if not temporary:
        # Follow the same row-lock order as switching a device to temporary login.
        binding = conn.execute('SELECT username, bind_time FROM users WHERE device_id = ?' + locking,
                               (user['device_id'],)).fetchone()
    session = conn.execute(
        'SELECT username, session_id, expires_at FROM temporary_sessions WHERE device_id = ?' + locking,
        (user['device_id'],),
    ).fetchone()
    if session and session['expires_at'] * 1000 > _now():
        original = current_temporary_session(user['username'])
        if (temporary and original and session['session_id'] == original['session_id']
                and session['username'] == user['username']):
            return
        raise _auth_expired()
    if temporary or not binding or (binding['username'], binding['bind_time']) != (user['username'], user['bind_time']):
        raise _auth_expired()


def _settings(conn, suffix=''):
    row = conn.execute('SELECT * FROM chat_settings WHERE id = 1' + suffix).fetchone()
    if row is None:
        raise ChatError('CHAT_UNAVAILABLE', '聊天室暂时不可用，请稍后重试。', 503)
    return row


def _assert_enabled(settings):
    if not settings['enabled']:
        raise ChatError('CHAT_DISABLED', '公共聊天室暂未开放。', 403, {'enabled': False})


def is_enabled():
    with get_db() as conn:
        return bool(_settings(conn)['enabled'])


@contextmanager
def _read_room(user=None, context=None):
    with get_db() as conn:
        if isinstance(conn, sqlite3.Connection):
            conn.execute('BEGIN')
        else:
            conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
            conn.execute('START TRANSACTION WITH CONSISTENT SNAPSHOT')
        settings = _settings(conn)
        if user is not None:
            _assert_enabled(settings)
            if context is not None:
                _check_context(user, context)
            _check_current_binding(conn, user, '')
        yield conn, settings


@contextmanager
def _write_room(user=None, context=None):
    with get_db() as conn:
        locking = ' FOR UPDATE'
        if isinstance(conn, sqlite3.Connection):
            conn.execute('BEGIN IMMEDIATE')
            locking = ''
        settings = _settings(conn, locking)
        if user is not None:
            _assert_enabled(settings)
            _check_context(user, context)
            _check_current_binding(conn, user, locking)
        yield conn, settings, _now()


def _public_settings(row):
    return {
        'enabled': bool(row['enabled']), 'readonly': bool(row['readonly']),
        'pinned_notice': row['pinned_notice'], 'max_length': row['max_length'],
        'cooldown_seconds': row['cooldown_seconds'], 'recall_seconds': row['recall_seconds'],
        'max_lines': MAX_LINES,
    }


def _private_settings(row):
    return {
        **_public_settings(row), 'settings_version': row['settings_version'],
        'sensitive_words': json.loads(row['sensitive_words']), 'updated_at': _iso(row['updated_at']),
    }


def _view_key(user):
    return _mac('chat-browser-cursor', user['device_id'], user['username'])[:32]


def _identity(conn, username):
    return conn.execute('SELECT show_student_id, anon_code FROM chat_user_settings WHERE username = ?',
                        (username,)).fetchone()


def _allocate_identity(conn, username, now):
    identity = _identity(conn, username)
    if identity is not None:
        return identity
    for attempt in range(32):
        digest = _mac('chat-anonymous-name', username, attempt).upper()
        for length in range(4, 17, 2):
            code = digest[:length]
            if not conn.execute('SELECT 1 FROM chat_user_settings WHERE anon_code = ?', (code,)).fetchone():
                conn.execute('INSERT INTO chat_user_settings (username, anon_code, updated_at) VALUES (?, ?, ?)',
                             (username, code, now))
                return {'show_student_id': 0, 'anon_code': code}
    raise ChatError('CHAT_UNAVAILABLE', '暂时无法生成发言代号，请稍后重试。', 503)


def _display(username, show_student_id, anon_code):
    if show_student_id:
        return username
    grade = f'{username[:2]}级 ' if YEAR.fullmatch(username) else ''
    # Rows written by the room always have a persisted identity.
    code = anon_code or _mac('chat-anonymous-name', username, 0)[:4].upper()
    return f'{grade}同学#{code}'


def _mute(conn, username, now):
    row = conn.execute('SELECT muted_until, reason FROM chat_mutes WHERE username = ?', (username,)).fetchone()
    if not row or (row['muted_until'] is not None and row['muted_until'] <= now):
        return {'active': False}
    return {'active': True, 'reason': row['reason'], 'until': _iso(row['muted_until'])}


def _author(role, username, visible, code):
    return {'role': role, 'display_name': '管理员' if role == 'admin' else _display(username, visible, code)}


PUBLIC_MESSAGES = """
    SELECT m.id, m.username, m.sender_role, m.content, m.status, m.create_time,
           u.show_student_id, u.anon_code,
           q.id AS quote_id, q.username AS quote_username, q.sender_role AS quote_role,
           q.content AS quote_content, q.status AS quote_status,
           qu.show_student_id AS quote_visible, qu.anon_code AS quote_code
    FROM chat_messages m
    LEFT JOIN chat_user_settings u ON u.username = m.username
    LEFT JOIN chat_messages q ON q.id = m.reply_to_id AND q.room_id = m.room_id
    LEFT JOIN chat_user_settings qu ON qu.username = q.username
"""


def _public_message(row, viewer):
    normal = row['status'] == 'normal'
    quote = None
    if normal and row['quote_id'] is not None:
        quote_normal = row['quote_status'] == 'normal'
        quote = {
            'id': row['quote_id'], 'status': row['quote_status'],
            'is_own': viewer == row['quote_username'] and row['quote_role'] == 'user',
            'display_name': _author(row['quote_role'], row['quote_username'], row['quote_visible'],
                                    row['quote_code'])['display_name'] if quote_normal else None,
            'excerpt': ' '.join(row['quote_content'].split())[:100] if quote_normal else None,
        }
    return {
        'id': row['id'], 'status': row['status'], 'is_own': row['sender_role'] == 'user' and viewer == row['username'],
        'author': _author(row['sender_role'], row['username'], row['show_student_id'], row['anon_code']) if normal else None,
        'content': row['content'] if normal else None, 'create_time': _iso(row['create_time']), 'reply_to': quote,
    }


def _public_message_by_id(conn, msg_id, viewer):
    row = conn.execute(PUBLIC_MESSAGES + ' WHERE m.room_id = ? AND m.id = ?', (ROOM, msg_id)).fetchone()
    return _public_message(row, viewer)


def _latest(conn, normal_only=False):
    condition = " AND status = 'normal'" if normal_only else ''
    return conn.execute('SELECT MAX(id) AS latest_id FROM chat_messages WHERE room_id = ?' + condition,
                        (ROOM,)).fetchone()['latest_id'] or 0


def _message_page(conn, username, before, after, limit):
    conditions = ['m.room_id = ?']
    params = [ROOM]
    if before is not None:
        conditions.append('m.id < ?')
        params.append(before)
    if after is not None:
        conditions.append('m.id > ?')
        params.append(after)
    ordering = 'ASC' if after is not None else 'DESC'
    rows = conn.execute(PUBLIC_MESSAGES + f" WHERE {' AND '.join(conditions)} ORDER BY m.id {ordering} LIMIT ?",
                        (*params, limit + 1)).fetchall()
    more = len(rows) > limit
    # PyMySQL DictCursor returns an empty tuple () when 0 rows match; convert before reversing.
    rows = list(rows[:limit])
    if after is None:
        rows.reverse()
    return {
        'messages': [_public_message(row, username) for row in rows],
        'next_before_id': rows[0]['id'] if rows else before,
        'next_after_id': rows[-1]['id'] if rows else (after or 0),
        'has_older': more if after is None else bool(after),
        'has_more': more if after is not None else False,
    }


def _room_state(settings, now):
    return {
        'settings_version': settings['settings_version'], 'history_version': settings['history_version'],
        'server_time': _iso(now),
    }


def bootstrap(user):
    context = _context(user)
    username = user['username']
    # Only first entry needs to allocate a durable alias. Regular reads stay read-only.
    with _read_room(user, context) as (conn, _):
        has_identity = _identity(conn, username) is not None
    if not has_identity:
        with _write_room(user, context) as (conn, _, now):
            _allocate_identity(conn, username, now)
    with _read_room(user, context) as (conn, settings):
        now = _now()
        identity = _identity(conn, username)
        return {
            **_room_state(settings, now), **_message_page(conn, username, None, None, 30),
            'latest_id': _latest(conn), 'settings': _public_settings(settings), 'context': context,
            'viewer': {
                'show_student_id': bool(identity['show_student_id']),
                'display_name': _display(username, identity['show_student_id'], identity['anon_code']),
                'viewer_key': _view_key(user), 'mute': _mute(conn, username, now),
                'temporary_expires_at': _iso(user['expires_at'] * 1000) if user.get('temporary') else None,
            },
        }


def messages(user, context, before, after, limit, settings_version, history_version):
    with _read_room(user, context) as (conn, settings):
        now = _now()
        identity = _identity(conn, user['username'])
        result = {
            **_room_state(settings, now), 'mute': _mute(conn, user['username'], now),
            'latest_id': _latest(conn),
        }
        if settings_version != settings['settings_version']:
            result['settings'] = _public_settings(settings)
        if history_version is not None and history_version != settings['history_version']:
            result.update(resync_required=True, messages=[], next_before_id=before,
                          next_after_id=after or 0, has_older=False, has_more=False)
        else:
            result.update(_message_page(conn, user['username'], before, after, limit))
        if identity is not None:
            result['privacy'] = {
                'show_student_id': bool(identity['show_student_id']),
                'display_name': _display(user['username'], identity['show_student_id'], identity['anon_code']),
            }
        return result


def unread(user):
    with _read_room(user) as (conn, _):
        return {'enabled': True, 'latest_id': _latest(conn, normal_only=True), 'viewer_key': _view_key(user)}


def _bump_history(conn):
    conn.execute('UPDATE chat_settings SET history_version = history_version + 1 WHERE id = 1')


def set_privacy(user, context, payload):
    visible = payload.get('show_student_id')
    if type(visible) is not bool:
        raise ChatError('INVALID_INPUT', '请选择是否公开学号。')
    with _write_room(user, context) as (conn, settings, now):
        username = user['username']
        identity = _allocate_identity(conn, username, now)
        changed = bool(identity['show_student_id']) != visible
        if changed:
            conn.execute('UPDATE chat_user_settings SET show_student_id = ?, updated_at = ? WHERE username = ?',
                         (int(visible), now, username))
            _bump_history(conn)
        return {
            'show_student_id': visible, 'display_name': _display(username, visible, identity['anon_code']),
            'history_version': settings['history_version'] + int(changed),
        }


def _clean_text(value):
    if not isinstance(value, str):
        raise ChatError('INVALID_INPUT', '请输入纯文本。')
    value = re.sub(r'\r\n|[\r\u2028\u2029]', '\n', value)
    text = ''.join(
        ' ' if char == '\t' else char
        for index, char in enumerate(value)
        if char in '\n\t' or unicodedata.category(char) not in {'Cc', 'Cf', 'Cs'}
        or (char == '\u200d' and _emoji_joiner(value, index))
    )
    return '\n'.join(re.sub(r'[^\S\n]{4,}', '   ', line).rstrip() for line in text.split('\n')).strip()


def _emoji_joiner(text, index):
    left = index - 1
    while left >= 0 and (text[left] == '\ufe0f' or 0x1F3FB <= ord(text[left]) <= 0x1F3FF):
        left -= 1
    return (left >= 0 and index + 1 < len(text)
            and all(unicodedata.category(char) == 'So' or ord(char) >= 0x1F000
                    for char in (text[left], text[index + 1])))


def _match_text(text):
    normalized = unicodedata.normalize('NFKC', text).casefold()
    return ''.join(char for char in normalized
                   if not char.isspace() and unicodedata.category(char) not in {'Cc', 'Cf', 'Mn'})


def _validate_content(content, settings):
    if not content or len(content) > settings['max_length']:
        raise ChatError('INVALID_INPUT', f"消息需要 1–{settings['max_length']} 字。")
    if content.count('\n') >= MAX_LINES or '\n\n\n\n' in content:
        raise ChatError('INVALID_INPUT', f'消息最多 {MAX_LINES} 行，连续空行最多 2 行。')
    compare = _match_text(content)
    if not compare:
        raise ChatError('INVALID_INPUT', '请输入消息内容。')
    words = json.loads(settings['sensitive_words'])
    if any(_match_text(word) in compare for word in words):
        raise ChatError('CONTENT_BLOCKED', '消息含有受限内容，请修改后重试。', 422)


def _client_id(value):
    try:
        parsed = uuid.UUID(value)
    except (ValueError, TypeError, AttributeError):
        raise ChatError('INVALID_INPUT', '消息发送标识无效。') from None
    return str(parsed)


def _lookup_message(conn, msg_id):
    row = None
    if 0 < msg_id < 2**53:
        row = conn.execute('SELECT * FROM chat_messages WHERE room_id = ? AND id = ?', (ROOM, msg_id)).fetchone()
    if not row:
        raise ChatError('MESSAGE_NOT_FOUND', '这条消息已找不到。', 404)
    return row


def _check_rate(conn, username, content, now, cooldown):
    window = max(cooldown, 60) * 1000
    rows = conn.execute("""SELECT content, create_time FROM chat_messages
        WHERE username = ? AND create_time > ? ORDER BY create_time DESC LIMIT 10""",
        (username, now - window)).fetchall()
    recent = [row for row in rows if row['create_time'] > now - 60_000]
    allowed_at = max(
        rows[0]['create_time'] + cooldown * 1000 if rows else 0,
        recent[-1]['create_time'] + 60_000 if len(recent) == 10 else 0,
        *(row['create_time'] + 15_000 for row in recent if row['content'] == content),
    )
    if allowed_at > now:
        wait = math.ceil((allowed_at - now) / 1000)
        raise ChatError('RATE_LIMITED', f'发言太频繁，请 {wait} 秒后重试。', 429, {'retry_after': wait})


def send_message(payload, user=None, context=None):
    content = _clean_text(payload.get('content', ''))
    client_id = _client_id(payload.get('client_msg_id'))
    reply_id = payload.get('reply_to_id')
    if reply_id is not None and (type(reply_id) is not int or not 0 < reply_id < 2**53):
        raise ChatError('INVALID_INPUT', '引用的消息无效。')
    role = 'user' if user is not None else 'admin'
    username = user['username'] if user is not None else None
    device_id = user['device_id'] if user is not None else None
    with _write_room(user, context) as (conn, settings, now):
        _assert_enabled(settings)
        existing = conn.execute('SELECT * FROM chat_messages WHERE client_msg_id = ?', (client_id,)).fetchone()
        if existing:
            if (existing['sender_role'], existing['username'], existing['content'], existing['reply_to_id']) != (
                    role, username, content, reply_id):
                raise ChatError('IDEMPOTENCY_CONFLICT', '发送请求已变化，请重新发送。', 409)
            msg_id = existing['id']
        else:
            if user is not None:
                if settings['readonly']:
                    raise ChatError('CHAT_READONLY', '当前聊天室已开启全员禁言，仅可浏览消息。', 403)
                mute = _mute(conn, username, now)
                if mute['active']:
                    raise ChatError('CHAT_MUTED', '你当前处于禁言期间。', 403, {'mute': mute})
                _check_rate(conn, username, content, now, settings['cooldown_seconds'])
                _allocate_identity(conn, username, now)
            _validate_content(content, settings)
            if reply_id is not None:
                _lookup_message(conn, reply_id)
            cursor = conn.execute("""INSERT INTO chat_messages
                (room_id, username, device_id, sender_role, content, reply_to_id, client_msg_id, create_time, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (ROOM, username, device_id, role, content, reply_id, client_id, now, now))
            msg_id = cursor.lastrowid
        message = (_public_message_by_id(conn, msg_id, username) if user is not None
                   else _admin_message_by_id(conn, msg_id))
        return {'message': message, 'history_version': settings['history_version']}, 200 if existing else 201


def recall(user, context, msg_id):
    with _write_room(user, context) as (conn, settings, now):
        message = _lookup_message(conn, msg_id)
        if message['sender_role'] != 'user' or message['username'] != user['username']:
            raise ChatError('FORBIDDEN', '只能撤回自己的消息。', 403)
        changed = message['status'] != 'recalled'
        if changed:
            if message['status'] != 'normal' or now - message['create_time'] >= settings['recall_seconds'] * 1000:
                raise ChatError('RECALL_EXPIRED', '这条消息已无法撤回。', 409)
            conn.execute("UPDATE chat_messages SET status = 'recalled', deleted_by = 'user', updated_at = ? WHERE id = ?",
                         (now, msg_id))
            _bump_history(conn)
        return {
            'message': _public_message_by_id(conn, msg_id, user['username']),
            'history_version': settings['history_version'] + int(changed),
        }


def _short_text(value, length):
    text = _clean_text(value)
    if len(text) > length:
        raise ChatError('INVALID_INPUT', f'说明最多 {length} 字。')
    return text


def report(user, context, msg_id, payload):
    reason = payload.get('reason')
    if not isinstance(reason, str) or reason not in REPORT_REASONS:
        raise ChatError('INVALID_INPUT', '请选择举报理由。')
    detail = _short_text(payload.get('detail', ''), 200)
    with _write_room(user, context) as (conn, _, now):
        message = _lookup_message(conn, msg_id)
        if message['sender_role'] != 'user' or message['status'] != 'normal' or message['username'] == user['username']:
            raise ChatError('FORBIDDEN', '这条消息无法举报。', 403)
        if conn.execute('SELECT 1 FROM chat_reports WHERE message_id = ? AND reporter_username = ?',
                        (msg_id, user['username'])).fetchone():
            raise ChatError('ALREADY_REPORTED', '你已举报过这条消息。', 409)
        conn.execute("""INSERT INTO chat_reports (message_id, reporter_username, reason, detail, create_time)
            VALUES (?, ?, ?, ?, ?)""", (msg_id, user['username'], reason, detail, now))
        return {'reported': True}


def admin_settings():
    with _read_room() as (_, settings):
        return _private_settings(settings)


def save_admin_settings(payload):
    fields = ('max_length', 'cooldown_seconds', 'recall_seconds')
    numeric = tuple(payload.get(field) for field in fields)
    if any(type(value) is not int or not 1 <= value <= cap for value, cap in zip(numeric, (500, 60, 120))):
        raise ChatError('INVALID_INPUT', '请检查字数、发言冷却和撤回时限。')
    enabled, readonly = payload.get('enabled'), payload.get('readonly')
    version = payload.get('if_settings_version')
    if type(enabled) is not bool or type(readonly) is not bool or type(version) is not int:
        raise ChatError('INVALID_INPUT', '聊天室配置无效。')
    notice = _short_text(payload.get('pinned_notice', ''), 2000)
    words = payload.get('sensitive_words')
    if not isinstance(words, list) or len(words) > 200:
        raise ChatError('INVALID_INPUT', '词库最多 200 项。')
    words = list(dict.fromkeys(_short_text(word, 40) for word in words)) if words else []
    words = [word for word in words if _match_text(word)]
    with _write_room() as (conn, settings, now):
        if version != settings['settings_version']:
            raise ChatError('SETTINGS_CONFLICT', '配置已被修改，请刷新后再保存。', 409)
        conn.execute("""UPDATE chat_settings SET enabled = ?, readonly = ?, pinned_notice = ?,
            max_length = ?, cooldown_seconds = ?, recall_seconds = ?, sensitive_words = ?,
            updated_at = ?, settings_version = settings_version + 1 WHERE id = 1""",
            (int(enabled), int(readonly), notice, *numeric, json.dumps(words, ensure_ascii=False), now))
        return _private_settings(_settings(conn))


ADMIN_MESSAGES = """
    SELECT m.id, m.username, m.sender_role, m.content, m.status, m.create_time, u.show_student_id, u.anon_code,
           (SELECT COUNT(*) FROM chat_reports r WHERE r.message_id = m.id) AS report_count
    FROM chat_messages m LEFT JOIN chat_user_settings u ON u.username = m.username
"""


def _admin_message(row):
    return {
        'id': row['id'], 'username': row['username'], 'sender_role': row['sender_role'], 'content': row['content'],
        'status': row['status'], 'create_time': _iso(row['create_time']), 'report_count': row['report_count'],
        'show_student_id': bool(row['show_student_id']),
        'display_name': _author(row['sender_role'], row['username'], row['show_student_id'], row['anon_code'])['display_name'],
    }


def _admin_message_by_id(conn, msg_id):
    row = conn.execute(ADMIN_MESSAGES + ' WHERE m.room_id = ? AND m.id = ?', (ROOM, msg_id)).fetchone()
    return _admin_message(row)


def _admin_page(rows, limit, mapper, key='id'):
    page = rows[:limit]
    more = len(rows) > limit
    return {'items': [mapper(row) for row in page], 'has_more': more,
            'next_cursor': page[-1][key] if more else None}


def admin_messages(username, query, status, before, limit):
    conditions, params = ['m.room_id = ?'], [ROOM]
    if username:
        conditions.append('m.username = ?')
        params.append(username)
    if query:
        conditions.append("LOWER(m.content) LIKE LOWER(?) ESCAPE '!'")
        pattern = query.replace('!', '!!').replace('%', '!%').replace('_', '!_')
        params.append(f'%{pattern}%')
    if status == 'reported':
        conditions.append("EXISTS (SELECT 1 FROM chat_reports r WHERE r.message_id = m.id AND r.status = 'pending')")
    elif status in {'normal', 'recalled', 'deleted'}:
        conditions.append('m.status = ?')
        params.append(status)
    elif status not in {'all', ''}:
        raise ChatError('INVALID_INPUT', '请选择有效的消息状态。')
    if before is not None:
        conditions.append('m.id < ?')
        params.append(before)
    with _read_room() as (conn, _):
        rows = conn.execute(ADMIN_MESSAGES + f" WHERE {' AND '.join(conditions)} ORDER BY m.id DESC LIMIT ?",
                            (*params, limit + 1)).fetchall()
        return _admin_page(rows, limit, _admin_message)


def _delete_message(conn, msg_id, now):
    message = _lookup_message(conn, msg_id)
    if message['status'] != 'deleted':
        conn.execute("UPDATE chat_messages SET status = 'deleted', deleted_by = 'admin', updated_at = ? WHERE id = ?",
                     (now, msg_id))
        _bump_history(conn)
    reports = conn.execute("""UPDATE chat_reports SET status = 'resolved', handled_at = ?
                               WHERE message_id = ? AND status = 'pending'""", (now, msg_id))
    return {'id': msg_id, 'status': 'deleted', 'resolved_report_count': reports.rowcount}


def delete_message(msg_id):
    with _write_room() as (conn, _, now):
        return _delete_message(conn, msg_id, now)


def admin_reports(status, before, limit):
    conditions, params = ['m.room_id = ?'], [ROOM]
    if status in {'pending', 'resolved', 'ignored'}:
        conditions.append('r.status = ?')
        params.append(status)
    elif status != 'all':
        raise ChatError('INVALID_INPUT', '请选择有效的举报状态。')
    if before is not None:
        conditions.append('r.id < ?')
        params.append(before)
    with _read_room() as (conn, _):
        rows = conn.execute(f"""SELECT r.*, m.username, m.content, m.status AS message_status
            FROM chat_reports r JOIN chat_messages m ON m.id = r.message_id WHERE {' AND '.join(conditions)}
            ORDER BY r.id DESC LIMIT ?""", (*params, limit + 1)).fetchall()
        return _admin_page(rows, limit, _admin_report)


def _admin_report(row):
    result = dict(row)
    result['create_time'] = _iso(row['create_time'])
    result['handled_at'] = _iso(row['handled_at'])
    return result


def _admin_mute(row):
    return {'username': row['username'], 'reason': row['reason'], 'muted_until': _iso(row['muted_until'])}


def _save_mute(conn, username, duration, reason, now):
    if not isinstance(username, str) or not ACCOUNT.fullmatch(username):
        raise ChatError('INVALID_INPUT', '请输入有效学号。')
    if not isinstance(duration, str) or duration not in MUTE_SECONDS:
        raise ChatError('INVALID_INPUT', '请选择禁言时长。')
    reason = _short_text(reason, 200)
    if not reason:
        raise ChatError('INVALID_INPUT', '请填写禁言原因。')
    seconds = MUTE_SECONDS[duration]
    until = None if seconds is None else now + seconds * 1000
    existing = conn.execute('SELECT create_time FROM chat_mutes WHERE username = ?', (username,)).fetchone()
    if existing:
        conn.execute('UPDATE chat_mutes SET muted_until = ?, reason = ?, updated_at = ? WHERE username = ?',
                     (until, reason, now, username))
    else:
        conn.execute(
            'INSERT INTO chat_mutes (username, muted_until, reason, create_time, updated_at) VALUES (?, ?, ?, ?, ?)',
            (username, until, reason, now, now),
        )
    return _admin_mute({'username': username, 'reason': reason, 'muted_until': until})


def admin_mutes(after, limit):
    with _read_room() as (conn, _):
        rows = conn.execute("""SELECT username, muted_until, reason FROM chat_mutes
            WHERE username > ? AND (muted_until IS NULL OR muted_until > ?) ORDER BY username LIMIT ?""",
            (after, _now(), limit + 1)).fetchall()
        return _admin_page(rows, limit, _admin_mute, 'username')


def save_mute(payload):
    with _write_room() as (conn, _, now):
        return _save_mute(conn, payload.get('username'), payload.get('duration'), payload.get('reason', ''), now)


def remove_mute(username):
    if not ACCOUNT.fullmatch(username):
        raise ChatError('INVALID_INPUT', '请输入有效学号。')
    with _write_room() as (conn, _, _now_ms):
        conn.execute('DELETE FROM chat_mutes WHERE username = ?', (username,))
        return {'removed': True}


def handle_report(report_id, payload):
    action = payload.get('action')
    if action not in ('ignore', 'delete_message', 'mute_author'):
        raise ChatError('INVALID_INPUT', '请选择举报处理方式。')
    with _write_room() as (conn, _, now):
        row = None
        if 0 < report_id < 2**53:
            row = conn.execute('SELECT * FROM chat_reports WHERE id = ?', (report_id,)).fetchone()
        if not row:
            raise ChatError('REPORT_NOT_FOUND', '这条举报已找不到。', 404)
        if row['status'] != 'pending':
            raise ChatError('REPORT_HANDLED', '这条举报已处理，请刷新。', 409)
        result = {'id': report_id, 'status': 'ignored' if action == 'ignore' else 'resolved'}
        if action == 'delete_message':
            result['message'] = _delete_message(conn, row['message_id'], now)
        else:
            if action == 'mute_author':
                original = _lookup_message(conn, row['message_id'])
                result['mute'] = _save_mute(conn, original['username'], payload.get('duration'),
                                            payload.get('reason', ''), now)
            conn.execute('UPDATE chat_reports SET status = ?, handled_at = ? WHERE id = ?',
                         (result['status'], now, report_id))
        return result
