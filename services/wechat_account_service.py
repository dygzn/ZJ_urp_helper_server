"""微信直接关联学号；不依赖或修改网页设备关系。"""
from datetime import datetime

from database import get_db, migrate_account_password
from services.credential_service import CredentialCipher


class BindingConflict(ValueError):
    pass


def get_account(openid):
    with get_db() as conn:
        row = conn.execute('''SELECT a.username, a.password, w.bind_time
            FROM wechat_account_bindings w JOIN user_account a ON a.username = w.username
            WHERE w.openid = ?''', (openid,)).fetchone()
        if row:
            account = dict(row)
            account['password'] = migrate_account_password(conn, row['username'], row['password'])
            return account
    return None


def bind_account(openid, username, password):
    password = CredentialCipher().encrypt(password)
    now = datetime.now().isoformat()
    with get_db() as conn:
        conn.execute('''INSERT OR IGNORE INTO wechat_account_bindings
            (openid, username, bind_time, updated_at) VALUES (?, NULL, ?, ?)''', (openid, now, now))
        # 条件 UPDATE 防止两个并发绑定把同一微信覆盖到不同学号。
        try:
            cursor = conn.execute('''UPDATE wechat_account_bindings
                SET username = ?, bind_time = ?, updated_at = ?
                WHERE openid = ? AND (username IS NULL OR username = ?)''',
                (username, now, now, openid, username))
        except Exception as exc:
            if 'unique' in str(exc).lower() or getattr(exc, 'args', [None])[0] == 1062:
                raise BindingConflict('该学号已绑定其他微信，请先解绑') from exc
            raise
        if cursor.rowcount == 0:
            row = conn.execute('SELECT username FROM wechat_account_bindings WHERE openid = ?', (openid,)).fetchone()
            if not row or row['username'] != username:
                raise BindingConflict('请先解绑当前学号，再绑定新学号')
        conn.execute('''INSERT OR IGNORE INTO user_account
            (username, password, registered_at, last_bind_time, archived_at)
            VALUES (?, ?, ?, ?, ?)''', (username, password, now, now, now))
        conn.execute('''UPDATE user_account SET password = ?, last_bind_time = ?, archived_at = ?
            WHERE username = ?''', (password, now, now, username))


def unbind_account(openid):
    with get_db() as conn:
        conn.execute('''INSERT OR IGNORE INTO wechat_account_bindings
            (openid, username, bind_time, updated_at) VALUES (?, NULL, ?, ?)''',
            (openid, datetime.now().isoformat(), datetime.now().isoformat()))
        conn.execute('UPDATE wechat_account_bindings SET username = NULL, updated_at = ? WHERE openid = ?',
                     (datetime.now().isoformat(), openid))
