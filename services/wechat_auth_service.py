"""微信小程序登录态与 OpenID 绑定服务。"""

import hashlib
import os
import secrets
from datetime import datetime, timedelta

import requests
from flask import request

from database import get_db


WECHAT_CODE2SESSION_URL = 'https://api.weixin.qq.com/sns/jscode2session'
SESSION_TTL = timedelta(days=30)


class WechatAuthError(RuntimeError):
    """微信登录或小程序服务端配置错误。"""


def _now():
    return datetime.now()


def _hash_token(token):
    return hashlib.sha256(token.encode('utf-8')).hexdigest()


def code_to_session(code):
    """用微信临时 code 换取服务端使用的 OpenID/UnionID。"""
    if not isinstance(code, str) or not code.strip():
        raise WechatAuthError('微信登录凭证不能为空')

    app_id = os.environ.get('WECHAT_MINIPROGRAM_APPID', '').strip()
    app_secret = os.environ.get('WECHAT_MINIPROGRAM_SECRET', '').strip()
    if not app_id or not app_secret:
        raise WechatAuthError('微信小程序服务端配置未完成')

    try:
        response = requests.get(
            WECHAT_CODE2SESSION_URL,
            params={
                'appid': app_id,
                'secret': app_secret,
                'js_code': code.strip(),
                'grant_type': 'authorization_code',
            },
            timeout=10,
        )
        data = response.json()
    except requests.RequestException as exc:
        raise WechatAuthError('微信登录服务暂时不可用，请稍后重试') from exc
    except (TypeError, ValueError) as exc:
        raise WechatAuthError('微信登录服务返回了无效结果') from exc

    if not isinstance(data, dict):
        raise WechatAuthError('微信登录服务返回了无效结果')

    errcode = data.get('errcode')
    if errcode not in (None, 0, '0'):
        raise WechatAuthError('微信登录凭证无效，请重新打开小程序')

    openid = str(data.get('openid') or '').strip()
    if not openid:
        raise WechatAuthError('微信登录未返回用户身份')

    unionid = data.get('unionid')
    unionid = str(unionid).strip() if unionid else None
    return {'openid': openid, 'unionid': unionid}


def create_session(openid, unionid=None):
    """创建随机业务 token，数据库只保存 token 哈希。"""
    openid = str(openid or '').strip()
    if not openid:
        raise ValueError('openid 不能为空')

    token = secrets.token_urlsafe(32)
    token_hash = _hash_token(token)
    now = _now()
    now_text = now.isoformat()
    expires_text = (now + SESSION_TTL).isoformat()

    with get_db() as conn:
        conn.execute(
            'DELETE FROM wechat_sessions WHERE openid = ? AND expires_at < ?',
            (openid, now_text),
        )
        conn.execute(
            'INSERT INTO wechat_sessions '
            '(token_hash, openid, expires_at, created_at, last_seen_at) '
            'VALUES (?, ?, ?, ?, ?)',
            (token_hash, openid, expires_text, now_text, now_text),
        )
    return token


def get_binding(openid):
    openid = str(openid or '').strip()
    if not openid:
        return None

    with get_db() as conn:
        row = conn.execute(
            'SELECT openid, device_id, unionid, bind_time, updated_at '
            'FROM wechat_bindings WHERE openid = ?',
            (openid,),
        ).fetchone()
    if not row:
        return None
    return {
        'openid': row['openid'],
        'device_id': row['device_id'],
        'unionid': row['unionid'],
        'bind_time': row['bind_time'],
        'updated_at': row['updated_at'],
    }


def get_binding_by_device_id(device_id):
    device_id = str(device_id or '').strip()
    if not device_id:
        return None

    with get_db() as conn:
        row = conn.execute(
            'SELECT openid, device_id, unionid, bind_time, updated_at '
            'FROM wechat_bindings WHERE device_id = ?',
            (device_id,),
        ).fetchone()
    if not row:
        return None
    return {
        'openid': row['openid'],
        'device_id': row['device_id'],
        'unionid': row['unionid'],
        'bind_time': row['bind_time'],
        'updated_at': row['updated_at'],
    }


def get_unbound_device_id(openid):
    openid = str(openid or '').strip()
    if not openid:
        raise ValueError('openid 不能为空')
    digest = hashlib.sha256(openid.encode('utf-8')).hexdigest()[:32]
    return f'wx_{digest}'


def bind_openid_to_device(openid, device_id, unionid=None):
    openid = str(openid or '').strip()
    device_id = str(device_id or '').strip()
    if not openid or not device_id:
        raise ValueError('微信身份和内部用户身份不能为空')

    now_text = _now().isoformat()
    existing = get_binding(openid)
    with get_db() as conn:
        if existing:
            conn.execute(
                'UPDATE wechat_bindings SET device_id = ?, unionid = ?, '
                'updated_at = ? WHERE openid = ?',
                (device_id, unionid, now_text, openid),
            )
        else:
            conn.execute(
                'INSERT INTO wechat_bindings '
                '(openid, device_id, unionid, bind_time, updated_at) '
                'VALUES (?, ?, ?, ?, ?)',
                (openid, device_id, unionid, now_text, now_text),
            )


def resolve_session_token(token):
    """解析有效业务 token；过期、篡改或不存在时返回 None。"""
    token = str(token or '').strip()
    if not token:
        return None

    token_hash = _hash_token(token)
    now = _now()
    with get_db() as conn:
        row = conn.execute(
            'SELECT token_hash, openid, expires_at, last_seen_at FROM wechat_sessions '
            'WHERE token_hash = ?',
            (token_hash,),
        ).fetchone()
        if not row:
            return None

        try:
            expires_at = datetime.fromisoformat(str(row['expires_at']))
        except (TypeError, ValueError):
            expires_at = now - timedelta(seconds=1)

        if expires_at <= now:
            conn.execute(
                'DELETE FROM wechat_sessions WHERE token_hash = ?',
                (token_hash,),
            )
            return None

        try:
            last_seen = datetime.fromisoformat(str(row['last_seen_at']))
            should_touch = (now - last_seen).total_seconds() >= 300 or now < last_seen
        except (TypeError, ValueError):
            should_touch = True
        if should_touch:
            conn.execute(
                'UPDATE wechat_sessions SET last_seen_at = ? WHERE token_hash = ? AND last_seen_at = ?',
                (now.isoformat(), token_hash, row['last_seen_at']),
            )
        openid = row['openid']

    binding = get_binding(openid)
    return {
        'openid': openid,
        'device_id': binding['device_id'] if binding else None,
    }


def get_bearer_token():
    """读取请求中的标准 Bearer token。"""
    header = request.headers.get('Authorization', '')
    scheme, separator, token = header.partition(' ')
    if scheme.lower() != 'bearer' or not separator or not token.strip():
        return None
    return token.strip()


def get_wechat_request_session():
    token = get_bearer_token()
    if not token:
        return None
    return resolve_session_token(token)
