"""
用户绑定管理服务
"""
import hashlib
from datetime import datetime
from flask import request
from database import get_db


def get_device_id():
    """获取设备唯一标识"""
    device_id = request.headers.get('X-Device-ID')
    if device_id:
        return device_id.strip()

    authorization = request.headers.get('Authorization', '')
    if authorization.strip():
        # 延迟导入，避免微信认证服务与用户服务之间形成模块循环依赖。
        from services.wechat_auth_service import (
            get_unbound_device_id,
            get_wechat_request_session,
        )

        session = get_wechat_request_session()
        if session:
            if session.get('device_id'):
                return session['device_id']
            return get_unbound_device_id(session['openid'])

        # Bearer 已明确表明请求来自小程序。无效 token 不应退回
        # User-Agent/IP 这种弱身份，否则可能意外命中其它用户的旧绑定。
        token_digest = hashlib.sha256(authorization.encode('utf-8')).hexdigest()[:32]
        return f'wx_invalid_{token_digest}'

    user_agent = request.headers.get('User-Agent', '')
    ip = request.remote_addr
    device_string = f"{user_agent}_{ip}"
    return hashlib.md5(device_string.encode()).hexdigest()


def get_user_by_device(device_id):
    """根据设备ID获取绑定的用户信息"""
    with get_db() as conn:
        row = conn.execute(
            'SELECT * FROM users WHERE device_id = ?',
            (device_id,)
        ).fetchone()
        if row:
            return {
                'device_id': row['device_id'],
                'username': row['username'],
                'password': row['password'],
                'bind_time': row['bind_time']
            }
        return None


def get_user_by_username(username):
    """根据学号获取最新的绑定记录。"""
    with get_db() as conn:
        row = conn.execute(
            'SELECT * FROM users WHERE username = ? '
            'ORDER BY bind_time DESC LIMIT 1',
            (username,)
        ).fetchone()
        if row:
            return {
                'device_id': row['device_id'],
                'username': row['username'],
                'password': row['password'],
                'bind_time': row['bind_time']
            }
        return None


def bind_user(device_id, username, password, invitation_token=None):
    """绑定用户到设备，并在首次绑定时原子化处理邀请归因。"""
    with get_db() as conn:
        conn.execute('''
            INSERT OR REPLACE INTO users (device_id, username, password, bind_time)
            VALUES (?, ?, ?, ?)
        ''', (device_id, username, password, datetime.now().isoformat()))
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


def unbind_user(device_id):
    """解绑用户；解绑设备不影响学号名下的 API 密钥。"""
    with get_db() as conn:
        cursor = conn.execute(
            'DELETE FROM users WHERE device_id = ?',
            (device_id,)
        )
        return cursor.rowcount > 0
