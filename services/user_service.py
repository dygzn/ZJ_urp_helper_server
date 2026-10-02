"""
用户绑定管理服务
"""
from datetime import datetime
from flask import g, has_request_context, request
from database import get_db
from services.temporary_session_service import get_temporary_session


def get_device_id():
    """只接受显式设备标识；微信身份由 /api/wechat 专用接口校验。"""
    device_id = (request.headers.get('X-Device-ID') or '').strip()
    if not device_id or len(device_id) > 128:
        return None
    return device_id


def get_user_by_device(device_id):
    """根据设备绑定获取账号主表资料。

    ``users`` 只负责证明设备绑定关系；账号密码始终来自 ``user_account``。
    """
    if not device_id:
        if has_request_context():
            g.temporary_session = None
        return None
    temporary = get_temporary_session(device_id)
    if temporary:
        if has_request_context():
            g.temporary_session = temporary
        return {
            'device_id': device_id,
            'username': temporary['username'],
            'password': None,
            'temporary': True,
            'expires_at': temporary['expires_at'],
        }
    if has_request_context():
        g.temporary_session = None
    with get_db() as conn:
        row = conn.execute(
            '''SELECT b.device_id, b.username, b.bind_time,
                      a.password, a.registered_at, a.last_bind_time
               FROM users AS b
               INNER JOIN user_account AS a ON a.username = b.username
               WHERE b.device_id = ?''',
            (device_id,)
        ).fetchone()
        if row:
            return {
                'device_id': row['device_id'],
                'username': row['username'],
                'password': row['password'],
                'bind_time': row['bind_time'],
                'registered_at': row['registered_at'],
                'last_bind_time': row['last_bind_time'],
            }
        return None


def get_user_by_username(username):
    """根据学号获取账号主表资料，并附带当前设备绑定（如果存在）。"""
    with get_db() as conn:
        row = conn.execute(
            '''SELECT a.username, a.password, a.registered_at, a.last_bind_time,
                      b.device_id, b.bind_time
               FROM user_account AS a
               LEFT JOIN users AS b ON b.username = a.username
               WHERE a.username = ?
               ORDER BY b.bind_time DESC LIMIT 1''',
            (username,)
        ).fetchone()
        if row:
            return {
                'username': row['username'],
                'password': row['password'],
                'device_id': row['device_id'],
                'bind_time': row['bind_time'] or row['last_bind_time'],
                'registered_at': row['registered_at'],
                'last_bind_time': row['last_bind_time'],
            }
        return None


def bind_user(device_id, username, password, invitation_token=None):
    """更新账号主表并绑定设备；账号主表是唯一凭据来源。"""
    with get_db() as conn:
        now = datetime.now().isoformat()
        # 先幂等占位，再更新最新凭据；相比“先 SELECT 再 INSERT”，
        # 两台设备同时绑定同一学号时不会因主键竞争丢失其中一次绑定。
        conn.execute('''INSERT OR IGNORE INTO user_account
            (username, password, registered_at, last_bind_time, archived_at)
            VALUES (?, ?, ?, ?, ?)''',
            (username, password, now, now, now))
        conn.execute('''UPDATE user_account
            SET password = ?,
                registered_at = CASE
                    WHEN registered_at IS NULL OR registered_at = '' OR registered_at > ? THEN ?
                    ELSE registered_at
                END,
                last_bind_time = ?, archived_at = ?
            WHERE username = ?''',
            (password, now, now, now, now, username))
        conn.execute('''
            INSERT OR REPLACE INTO users (device_id, username, password, bind_time)
            VALUES (?, ?, ?, ?)
        ''', (device_id, username, '', now))
        invitation_bound = False
        if invitation_token:
            from services.invitation_service import bind_invitation_by_token
            invitation_bound = bind_invitation_by_token(
                conn, username, invitation_token
            )
            if invitation_bound:
                from services.member_service import ensure_invitation_earnings
                ensure_invitation_earnings(conn, invitee_username=username)
        return invitation_bound


def unbind_user(device_id, conn=None):
    """解绑用户；解绑设备不影响学号名下的 API 密钥。

    管理员审批已经持有事务时可传入同一个连接，避免解绑和审批状态
    分别提交造成半完成状态。
    """
    if conn is not None:
        cursor = conn.execute(
            'DELETE FROM users WHERE device_id = ?',
            (device_id,)
        )
        return cursor.rowcount > 0

    with get_db() as owned_conn:
        cursor = owned_conn.execute(
            'DELETE FROM users WHERE device_id = ?',
            (device_id,)
        )
        return cursor.rowcount > 0
