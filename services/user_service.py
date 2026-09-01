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
        return device_id
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


def bind_user(device_id, username, password):
    """绑定用户到设备"""
    with get_db() as conn:
        previous = conn.execute(
            'SELECT username FROM users WHERE device_id = ?',
            (device_id,)
        ).fetchone()
        if previous and previous['username'] != username:
            conn.execute(
                'DELETE FROM api_keys WHERE username = ?',
                (previous['username'],)
            )
        conn.execute('''
            INSERT OR REPLACE INTO users (device_id, username, password, bind_time)
            VALUES (?, ?, ?, ?)
        ''', (device_id, username, password, datetime.now().isoformat()))


def unbind_user(device_id):
    """解绑用户"""
    with get_db() as conn:
        previous = conn.execute(
            'SELECT username FROM users WHERE device_id = ?',
            (device_id,)
        ).fetchone()
        cursor = conn.execute(
            'DELETE FROM users WHERE device_id = ?',
            (device_id,)
        )
        if previous:
            conn.execute(
                'DELETE FROM api_keys WHERE username = ?',
                (previous['username'],)
            )
        return cursor.rowcount > 0
