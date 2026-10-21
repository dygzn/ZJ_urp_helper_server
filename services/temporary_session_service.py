"""未保存设备绑定时使用的十分钟隔离会话。"""

import json
import logging
import os
import shutil
import threading
import time
import uuid

from flask import g, has_request_context

from database import get_db


TEMPORARY_SESSION_SECONDS = 600
TEMPORARY_DATA_ROOT = os.path.join('user_data', '.temporary')
_cleanup_lock = threading.Lock()
_cleanup_pid = None
_logger = logging.getLogger(__name__)


def _session_directory(session_id):
    return os.path.join(TEMPORARY_DATA_ROOT, session_id)


def _remove_session_directory(session_id):
    # session_id 只由服务端 uuid4 生成，删除范围始终限制在临时目录内。
    if session_id and len(session_id) == 32 and all(c in '0123456789abcdef' for c in session_id):
        from services.personal_schedule_service import clear_temporary_personal_schedule
        clear_temporary_personal_schedule([session_id])
        shutil.rmtree(_session_directory(session_id), ignore_errors=True)


def _forget_runtime_state(device_id, username):
    try:
        from services.online_service import online_tracker
        from services.lab_service import forget_temporary_lab_session

        online_tracker.forget(device_id)
        forget_temporary_lab_session(username, device_id)
    except Exception:
        _logger.exception('清理临时登录的进程内状态失败')


def save_temporary_session(device_id, username, cookies, url=None):
    """只保存会话标识、学号、到期时间和教务 Cookie。"""
    from services.config_service import get_current_urp_url, urp_url_fingerprint
    from urp.session_store import _filter_user_cookies

    origin = urp_url_fingerprint(url or get_current_urp_url())
    session_id = uuid.uuid4().hex
    directory = _session_directory(session_id)
    os.makedirs(directory, mode=0o700, exist_ok=False)
    try:
        cookie_fd = os.open(os.path.join(directory, 'cookie.json'), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(cookie_fd, 'w', encoding='utf-8') as stream:
            json.dump({'url_fingerprint': origin, 'cookies': _filter_user_cookies(cookies)},
                      stream, ensure_ascii=False)
        expires_at = int(time.time()) + TEMPORARY_SESSION_SECONDS
        with get_db() as conn:
            old = conn.execute(
                'SELECT session_id, username FROM temporary_sessions WHERE device_id = ?',
                (device_id,),
            ).fetchone()
            # 用户选择不保存时，此设备之前的持久绑定也不能在到期后重新生效。
            conn.execute('DELETE FROM users WHERE device_id = ?', (device_id,))
            conn.execute('''INSERT OR REPLACE INTO temporary_sessions
                (device_id, session_id, username, expires_at)
                VALUES (?, ?, ?, ?)''',
                (device_id, session_id, username, expires_at),
            )
        if old:
            _remove_session_directory(old['session_id'])
            _forget_runtime_state(device_id, old['username'])
        return expires_at
    except Exception:
        _remove_session_directory(session_id)
        raise


def delete_temporary_session(device_id):
    with get_db() as conn:
        row = conn.execute(
            'SELECT session_id, username FROM temporary_sessions WHERE device_id = ?',
            (device_id,),
        ).fetchone()
        if row:
            deleted = conn.execute(
                'DELETE FROM temporary_sessions WHERE device_id = ? AND session_id = ?',
                (device_id, row['session_id']),
            ).rowcount > 0
        else:
            deleted = False
    if deleted:
        _remove_session_directory(row['session_id'])
        _forget_runtime_state(device_id, row['username'])
    if has_request_context():
        g.temporary_session = None


def cleanup_expired_sessions(now=None):
    """删除过期记录及其独立文件；可由定时线程和请求入口重复调用。"""
    now = int(time.time()) if now is None else int(now)
    with get_db() as conn:
        rows = conn.execute(
            'SELECT device_id, session_id, username FROM temporary_sessions WHERE expires_at <= ?',
            (now,),
        ).fetchall()
        removed = [row for row in rows if conn.execute(
            'DELETE FROM temporary_sessions WHERE device_id = ? AND session_id = ? AND expires_at <= ?',
            (row['device_id'], row['session_id'], now),
        ).rowcount > 0]
        active_ids = {
            row['session_id'] for row in conn.execute(
                'SELECT session_id FROM temporary_sessions'
            ).fetchall()
        }
    for row in removed:
        _remove_session_directory(row['session_id'])
        _forget_runtime_state(row['device_id'], row['username'])
    if os.path.isdir(TEMPORARY_DATA_ROOT):
        for session_id in os.listdir(TEMPORARY_DATA_ROOT):
            directory = _session_directory(session_id)
            if session_id in active_ids or not os.path.isdir(directory):
                continue
            try:
                # 给尚未写入数据库的新会话留出创建时间。
                if time.time() - os.path.getmtime(directory) > 60:
                    _remove_session_directory(session_id)
            except OSError:
                pass
    return len(removed)


def get_temporary_session(device_id):
    with get_db() as conn:
        row = conn.execute('''SELECT device_id, session_id, username, expires_at
            FROM temporary_sessions WHERE device_id = ?''', (device_id,)).fetchone()
    if not row:
        return None
    session = dict(row)
    if session['expires_at'] <= int(time.time()):
        cleanup_expired_sessions()
        return None
    return session


def current_temporary_session(username=None):
    if not has_request_context():
        return None
    session = getattr(g, 'temporary_session', None)
    if session and (username is None or session['username'] == username):
        return session
    return None


def user_data_file(username, filename):
    """当前请求的临时账号读写隔离目录；普通账号保持原有路径。"""
    session = current_temporary_session(username)
    if session:
        return os.path.join(_session_directory(session['session_id']), filename)
    return os.path.join('user_data', username, filename)


def start_temporary_session_cleanup():
    """每个服务进程启动一个守护线程，空闲时也会清理到期数据。"""
    global _cleanup_pid
    with _cleanup_lock:
        pid = os.getpid()
        if _cleanup_pid == pid:
            return
        _cleanup_pid = pid

        def worker():
            while True:
                try:
                    cleanup_expired_sessions()
                except Exception:
                    # 临时数据库故障时，下轮继续；鉴权入口仍会检查到期时间。
                    pass
                time.sleep(15)

        threading.Thread(target=worker, name='temporary-session-cleanup', daemon=True).start()
