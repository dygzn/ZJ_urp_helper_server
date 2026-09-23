"""固定邀请链接和邀请关系归因服务。"""
import secrets
from datetime import datetime
from urllib.parse import urlencode


MAX_INVITATION_TOKEN_LENGTH = 128
TOKEN_BYTES = 24
MAX_CREATE_ATTEMPTS = 10


def get_invitation_link(conn, username):
    row = conn.execute(
        'SELECT username, token, create_time FROM invitation_links WHERE username = ?',
        (username,),
    ).fetchone()
    return dict(row) if row else None


def build_invitation_url(server_url, token):
    base_url = (server_url or 'http://localhost:5050').rstrip('/')
    return f"{base_url}/?{urlencode({'invite': token})}"


def get_or_create_invitation_link(conn, username, server_url):
    existing = get_invitation_link(conn, username)
    if existing:
        return build_invitation_url(server_url, existing['token']), False

    for _ in range(MAX_CREATE_ATTEMPTS):
        token = secrets.token_urlsafe(TOKEN_BYTES)
        cursor = conn.execute(
            'INSERT OR IGNORE INTO invitation_links (username, token, create_time) VALUES (?, ?, ?)',
            (username, token, datetime.now().isoformat()),
        )
        saved = get_invitation_link(conn, username)
        if saved:
            return build_invitation_url(server_url, saved['token']), cursor.rowcount == 1

    raise RuntimeError('生成邀请链接失败，请稍后重试')


def bind_invitation_by_token(conn, invitee_username, invitation_token):
    token = str(invitation_token or '').strip()
    if not token or len(token) > MAX_INVITATION_TOKEN_LENGTH:
        return False

    link = conn.execute(
        'SELECT username FROM invitation_links WHERE token = ?',
        (token,),
    ).fetchone()
    if not link or link['username'] == invitee_username:
        return False

    already = conn.execute(
        'SELECT id FROM invitations WHERE invitee_username = ?',
        (invitee_username,),
    ).fetchone()
    if already:
        return False

    cursor = conn.execute(
        'INSERT OR IGNORE INTO invitations (inviter_username, invitee_username, create_time) VALUES (?, ?, ?)',
        (link['username'], invitee_username, datetime.now().isoformat()),
    )
    return cursor.rowcount == 1
