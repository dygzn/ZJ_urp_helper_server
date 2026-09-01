"""
Apple 快捷指令 API 的密钥管理服务。
"""
import hashlib
import secrets
from datetime import datetime

from database import get_db


API_KEY_PREFIX = 'urp_'
API_KEY_PREFIX_LENGTH = 12


def hash_api_key(raw_key):
    """返回 API 密钥的 SHA-256 十六进制哈希。"""
    return hashlib.sha256(raw_key.encode('utf-8')).hexdigest()


def issue_api_key(username, now=None):
    """为学号创建或轮换唯一密钥，并只在本次调用中返回明文。"""
    if not isinstance(username, str) or not username.strip():
        raise ValueError('学号不能为空')

    username = username.strip()
    raw_key = f'{API_KEY_PREFIX}{secrets.token_urlsafe(32)}'
    key_hash = hash_api_key(raw_key)
    create_time = (now or datetime.now()).isoformat()
    key_prefix = raw_key[:API_KEY_PREFIX_LENGTH]

    with get_db() as conn:
        exists = conn.execute(
            'SELECT username FROM api_keys WHERE username = ?',
            (username,),
        ).fetchone()
        if exists:
            conn.execute(
                'UPDATE api_keys SET key_hash = ?, key_prefix = ?, create_time = ? '
                'WHERE username = ?',
                (key_hash, key_prefix, create_time, username),
            )
        else:
            conn.execute(
                'INSERT INTO api_keys (username, key_hash, key_prefix, create_time) '
                'VALUES (?, ?, ?, ?)',
                (username, key_hash, key_prefix, create_time),
            )

    return {
        'key': raw_key,
        'key_hash': key_hash,
        'key_prefix': key_prefix,
        'create_time': create_time,
    }


def get_api_key_status(username):
    """返回学号的密钥状态，不返回密钥明文或完整哈希。"""
    with get_db() as conn:
        row = conn.execute(
            'SELECT key_prefix, create_time FROM api_keys WHERE username = ?',
            (username,),
        ).fetchone()

    if not row:
        return {
            'has_key': False,
            'key_prefix': None,
            'create_time': None,
        }

    return {
        'has_key': True,
        'key_prefix': row['key_prefix'],
        'create_time': row['create_time'],
    }


def resolve_api_key(raw_key):
    """将明文密钥解析为学号；密钥不存在时返回 None。"""
    if not isinstance(raw_key, str) or not raw_key.strip():
        return None

    with get_db() as conn:
        row = conn.execute(
            'SELECT username FROM api_keys WHERE key_hash = ?',
            (hash_api_key(raw_key.strip()),),
        ).fetchone()
    return row['username'] if row else None
