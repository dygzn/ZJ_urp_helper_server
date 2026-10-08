"""
数据库初始化与连接管理。

默认使用本机 SQLite；在后台配置 MySQL/MariaDB 后，所有业务数据会写入同一个远程数据库，
用于多台服务器共享用户、会员、订单、返佣等数据。
"""
import json
import os
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from constants import DB_FILE
from services.config_service import get_config
from services.credential_service import CredentialCipher


MYSQL_DUPLICATE_CODES = {1060, 1061, 1091}


def _default_database_config():
    return {
        'type': 'sqlite',
        'sqlite_path': DB_FILE,
        'mysql': {
            'host': '',
            'port': 3306,
            'database': 'urp_helper',
            'user': '',
            'password': '',
        }
    }


def get_database_config(config_override=None):
    config = config_override or get_config()
    db_config = dict(_default_database_config())
    saved = config.get('database') or {}
    db_config.update({k: v for k, v in saved.items() if k != 'mysql'})
    mysql = dict(db_config['mysql'])
    mysql.update(saved.get('mysql') or {})
    mysql['port'] = int(mysql.get('port') or 3306)
    db_config['mysql'] = mysql
    db_config['type'] = (db_config.get('type') or 'sqlite').lower()
    if db_config['type'] not in ('sqlite', 'mysql'):
        db_config['type'] = 'sqlite'
    return db_config


def _mysql_identifier(name):
    name = str(name or '').strip()
    if not re.match(r'^[A-Za-z0-9_]+$', name):
        raise ValueError('数据库名称只能包含字母、数字和下划线')
    return f'`{name}`'


def _replace_qmark_params(sql):
    return sql.replace('?', '%s')


def _normalize_mysql_sql(sql):
    sql = re.sub(r'INSERT\s+OR\s+REPLACE\s+INTO', 'REPLACE INTO', sql, flags=re.IGNORECASE)
    sql = re.sub(r'INSERT\s+OR\s+IGNORE\s+INTO', 'INSERT IGNORE INTO', sql, flags=re.IGNORECASE)
    return _replace_qmark_params(sql)


class MySQLConnectionAdapter:
    def __init__(self, conn):
        self.conn = conn

    def execute(self, sql, params=None):
        cursor = self.conn.cursor()
        normalized_sql = _normalize_mysql_sql(sql)
        try:
            cursor.execute(normalized_sql, params or ())
            return cursor
        except Exception as exc:
            code = exc.args[0] if getattr(exc, 'args', None) else None
            first_word = normalized_sql.lstrip().split(' ', 1)[0].upper() if normalized_sql.strip() else ''
            if code in MYSQL_DUPLICATE_CODES and first_word in ('CREATE', 'ALTER', 'DROP'):
                return cursor
            raise

    def executemany(self, sql, seq_of_params):
        cursor = self.conn.cursor()
        cursor.executemany(_normalize_mysql_sql(sql), seq_of_params)
        return cursor

    def commit(self):
        self.conn.commit()

    def rollback(self):
        self.conn.rollback()

    def close(self):
        self.conn.close()


def _connect_sqlite(db_config):
    path = db_config.get('sqlite_path') or DB_FILE
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def _connect_mysql(db_config, ensure_database=True):
    try:
        import pymysql
    except ImportError as exc:
        raise RuntimeError('当前环境缺少 PyMySQL，请先执行 pip install PyMySQL') from exc

    mysql = db_config.get('mysql') or {}
    host = (mysql.get('host') or '').strip()
    user = (mysql.get('user') or '').strip()
    password = mysql.get('password') or ''
    database = (mysql.get('database') or '').strip()
    port = int(mysql.get('port') or 3306)

    if not host or not user or not database:
        raise RuntimeError('请完整填写 MySQL 主机、数据库名和用户名')

    base_kwargs = {
        'host': host,
        'port': port,
        'user': user,
        'password': password,
        'charset': 'utf8mb4',
        'connect_timeout': 8,
        'read_timeout': 15,
        'write_timeout': 15,
        'cursorclass': pymysql.cursors.DictCursor,
        'autocommit': False,
    }

    if ensure_database:
        try:
            bootstrap = pymysql.connect(**base_kwargs)
            try:
                with bootstrap.cursor() as cursor:
                    cursor.execute(
                        f'CREATE DATABASE IF NOT EXISTS {_mysql_identifier(database)} '
                        'DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
                    )
                bootstrap.commit()
            finally:
                bootstrap.close()
        except Exception:
            # 账号可能没有 CREATE DATABASE 权限；如果目标库已经存在且可连接，也允许继续。
            probe = pymysql.connect(database=database, **base_kwargs)
            probe.close()

    return MySQLConnectionAdapter(pymysql.connect(database=database, **base_kwargs))


@contextmanager
def get_db(config_override=None):
    """获取数据库连接。调用方仍可使用 conn.execute(sql, params) 的旧写法。"""
    db_config = get_database_config(config_override)
    conn = _connect_mysql(db_config) if db_config['type'] == 'mysql' else _connect_sqlite(db_config)
    try:
        yield conn
        conn.commit()
    except Exception as e:
        conn.rollback()
        raise e
    finally:
        conn.close()


def _exec_ignore(conn, sql):
    try:
        conn.execute(sql)
    except Exception as exc:
        # 迁移需要可重复执行，但权限不足、表损坏或目标表不存在都不应
        # 被伪装成成功，否则应用会在运行请求时才以更难定位的方式失败。
        message = str(exc).lower()
        ignorable = (
            'already exists',
            'duplicate column',
            'duplicate key name',
            'duplicate key',
        )
        if not any(marker in message for marker in ignorable):
            raise


def _create_api_keys_table(conn, db_type):
    if db_type == 'mysql':
        conn.execute('''
            CREATE TABLE IF NOT EXISTS api_keys (
                username VARCHAR(64) PRIMARY KEY,
                key_hash VARCHAR(64) NOT NULL,
                key_prefix VARCHAR(24) NOT NULL,
                create_time VARCHAR(32) NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        ''')
        return

    conn.execute('''
        CREATE TABLE IF NOT EXISTS api_keys (
            username TEXT PRIMARY KEY,
            key_hash TEXT NOT NULL,
            key_prefix TEXT NOT NULL,
            create_time TEXT NOT NULL
        )
    ''')


def _create_schema_sqlite(conn):
    conn.execute('''
        CREATE TABLE IF NOT EXISTS users (
            device_id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            password TEXT NOT NULL,
            bind_time TEXT NOT NULL,
            last_auto_update TEXT
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS wechat_bindings (
            openid TEXT PRIMARY KEY,
            device_id TEXT NOT NULL UNIQUE,
            unionid TEXT,
            bind_time TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS wechat_sessions (
            token_hash TEXT PRIMARY KEY,
            openid TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS pending_requests (
            request_id TEXT PRIMARY KEY,
            device_id TEXT NOT NULL,
            old_username TEXT NOT NULL,
            new_username TEXT NOT NULL,
            reason TEXT NOT NULL,
            request_time TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            notified INTEGER DEFAULT 0
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS announcements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            create_time TEXT NOT NULL,
            is_active INTEGER DEFAULT 1
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS user_read_announcements (
            device_id TEXT NOT NULL,
            announcement_id INTEGER NOT NULL,
            read_time TEXT NOT NULL,
            never_show INTEGER DEFAULT 0,
            PRIMARY KEY (device_id, announcement_id)
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS feedbacks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT NOT NULL,
            username TEXT NOT NULL,
            content TEXT NOT NULL,
            visibility TEXT DEFAULT 'self',
            create_time TEXT NOT NULL
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS feedback_replies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            feedback_id INTEGER NOT NULL,
            device_id TEXT NOT NULL DEFAULT 'admin',
            username TEXT NOT NULL DEFAULT '管理员',
            content TEXT NOT NULL,
            create_time TEXT NOT NULL
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS request_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT,
            username TEXT,
            endpoint TEXT NOT NULL,
            method TEXT NOT NULL,
            status_code INTEGER,
            request_time TEXT NOT NULL
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS ad_click_stats (
            ad_key TEXT NOT NULL,
            click_date TEXT NOT NULL,
            impression_count INTEGER NOT NULL DEFAULT 0,
            click_count INTEGER NOT NULL DEFAULT 0,
            copy_count INTEGER NOT NULL DEFAULT 0,
            dismiss_count INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (ad_key, click_date)
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS ad_copy_users (
            ad_key TEXT NOT NULL,
            username TEXT NOT NULL,
            PRIMARY KEY (ad_key, username)
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS memberships (
            username TEXT PRIMARY KEY,
            member_type TEXT NOT NULL,
            expire_time TEXT NOT NULL,
            create_time TEXT NOT NULL
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS invitation_links (
            username TEXT PRIMARY KEY,
            token TEXT NOT NULL UNIQUE,
            create_time TEXT NOT NULL
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS invitations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inviter_username TEXT NOT NULL,
            invitee_username TEXT NOT NULL UNIQUE,
            create_time TEXT NOT NULL
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS invitation_earnings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            order_no TEXT NOT NULL,
            invitee_username TEXT NOT NULL,
            amount TEXT NOT NULL,
            rate TEXT NOT NULL,
            create_time TEXT NOT NULL
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS invitation_reward_claims (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            invitee_username TEXT NOT NULL,
            order_no TEXT NOT NULL,
            amount TEXT NOT NULL,
            rate TEXT NOT NULL,
            create_time TEXT NOT NULL,
            UNIQUE (username, invitee_username)
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS invitation_milestone_rewards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            milestone_id TEXT NOT NULL,
            amount TEXT NOT NULL,
            create_time TEXT NOT NULL,
            UNIQUE (username, milestone_id)
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS withdrawals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            real_name TEXT NOT NULL,
            alipay_account TEXT NOT NULL,
            amount TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            create_time TEXT NOT NULL,
            review_time TEXT
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS orders (
            order_no TEXT PRIMARY KEY,
            device_id TEXT NOT NULL,
            username TEXT NOT NULL,
            member_type TEXT NOT NULL,
            amount TEXT NOT NULL,
            pay_type TEXT,
            status TEXT DEFAULT 'pending',
            create_time TEXT NOT NULL,
            pay_time TEXT,
            notify_url TEXT,
            pay_url TEXT
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS admin_service_status (
            id INTEGER PRIMARY KEY,
            status_text TEXT NOT NULL,
            accepting_orders INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        )
    ''')


def _create_schema_mysql(conn):
    conn.execute('''
        CREATE TABLE IF NOT EXISTS users (
            device_id VARCHAR(128) PRIMARY KEY,
            username VARCHAR(64) NOT NULL,
            password TEXT NOT NULL,
            bind_time VARCHAR(32) NOT NULL,
            last_auto_update VARCHAR(32)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS wechat_bindings (
            openid VARCHAR(128) PRIMARY KEY,
            device_id VARCHAR(128) NOT NULL UNIQUE,
            unionid VARCHAR(128),
            bind_time VARCHAR(32) NOT NULL,
            updated_at VARCHAR(32) NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS wechat_sessions (
            token_hash VARCHAR(64) PRIMARY KEY,
            openid VARCHAR(128) NOT NULL,
            expires_at VARCHAR(32) NOT NULL,
            created_at VARCHAR(32) NOT NULL,
            last_seen_at VARCHAR(32) NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS pending_requests (
            request_id VARCHAR(128) PRIMARY KEY,
            device_id VARCHAR(128) NOT NULL,
            old_username VARCHAR(64) NOT NULL,
            new_username VARCHAR(64) NOT NULL,
            reason TEXT NOT NULL,
            request_time VARCHAR(32) NOT NULL,
            status VARCHAR(32) DEFAULT 'pending',
            notified TINYINT DEFAULT 0
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS announcements (
            id INT AUTO_INCREMENT PRIMARY KEY,
            title VARCHAR(255) NOT NULL,
            content TEXT NOT NULL,
            create_time VARCHAR(32) NOT NULL,
            is_active TINYINT DEFAULT 1
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS user_read_announcements (
            device_id VARCHAR(128) NOT NULL,
            announcement_id INT NOT NULL,
            read_time VARCHAR(32) NOT NULL,
            never_show TINYINT DEFAULT 0,
            PRIMARY KEY (device_id, announcement_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS feedbacks (
            id INT AUTO_INCREMENT PRIMARY KEY,
            device_id VARCHAR(128) NOT NULL,
            username VARCHAR(64) NOT NULL,
            content TEXT NOT NULL,
            visibility VARCHAR(32) DEFAULT 'self',
            create_time VARCHAR(32) NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS feedback_replies (
            id INT AUTO_INCREMENT PRIMARY KEY,
            feedback_id INT NOT NULL,
            device_id VARCHAR(128) NOT NULL DEFAULT 'admin',
            username VARCHAR(64) NOT NULL DEFAULT '管理员',
            content TEXT NOT NULL,
            create_time VARCHAR(32) NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS request_logs (
            id INT AUTO_INCREMENT PRIMARY KEY,
            device_id VARCHAR(128),
            username VARCHAR(64),
            endpoint VARCHAR(255) NOT NULL,
            method VARCHAR(16) NOT NULL,
            status_code INT,
            request_time VARCHAR(32) NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS ad_click_stats (
            ad_key VARCHAR(64) NOT NULL,
            click_date VARCHAR(10) NOT NULL,
            impression_count INT NOT NULL DEFAULT 0,
            click_count INT NOT NULL DEFAULT 0,
            copy_count INT NOT NULL DEFAULT 0,
            dismiss_count INT NOT NULL DEFAULT 0,
            updated_at VARCHAR(32) NOT NULL,
            PRIMARY KEY (ad_key, click_date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS ad_copy_users (
            ad_key VARCHAR(64) NOT NULL,
            username VARCHAR(64) NOT NULL,
            PRIMARY KEY (ad_key, username)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS memberships (
            username VARCHAR(64) PRIMARY KEY,
            member_type VARCHAR(32) NOT NULL,
            expire_time VARCHAR(32) NOT NULL,
            create_time VARCHAR(32) NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS invitation_links (
            username VARCHAR(64) PRIMARY KEY,
            token VARCHAR(128) NOT NULL UNIQUE,
            create_time VARCHAR(32) NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS invitations (
            id INT AUTO_INCREMENT PRIMARY KEY,
            inviter_username VARCHAR(64) NOT NULL,
            invitee_username VARCHAR(64) NOT NULL UNIQUE,
            create_time VARCHAR(32) NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS invitation_earnings (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(64) NOT NULL,
            order_no VARCHAR(64) NOT NULL,
            invitee_username VARCHAR(64) NOT NULL,
            amount VARCHAR(32) NOT NULL,
            rate VARCHAR(16) NOT NULL,
            create_time VARCHAR(32) NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS invitation_reward_claims (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(64) NOT NULL,
            invitee_username VARCHAR(64) NOT NULL,
            order_no VARCHAR(64) NOT NULL,
            amount VARCHAR(32) NOT NULL,
            rate VARCHAR(16) NOT NULL,
            create_time VARCHAR(32) NOT NULL,
            UNIQUE KEY uq_invitation_reward_claim (username, invitee_username)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS invitation_milestone_rewards (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(64) NOT NULL,
            milestone_id VARCHAR(128) NOT NULL,
            amount VARCHAR(32) NOT NULL,
            create_time VARCHAR(32) NOT NULL,
            UNIQUE KEY uq_invitation_milestone (username, milestone_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS withdrawals (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(64) NOT NULL,
            real_name VARCHAR(64) NOT NULL,
            alipay_account VARCHAR(128) NOT NULL,
            amount VARCHAR(32) NOT NULL,
            status VARCHAR(32) DEFAULT 'pending',
            create_time VARCHAR(32) NOT NULL,
            review_time VARCHAR(32)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS orders (
            order_no VARCHAR(64) PRIMARY KEY,
            device_id VARCHAR(128) NOT NULL,
            username VARCHAR(64) NOT NULL,
            member_type VARCHAR(32) NOT NULL,
            amount VARCHAR(32) NOT NULL,
            pay_type VARCHAR(32),
            status VARCHAR(32) DEFAULT 'pending',
            create_time VARCHAR(32) NOT NULL,
            pay_time VARCHAR(32),
            notify_url TEXT,
            pay_url TEXT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS admin_service_status (
            id INT PRIMARY KEY,
            status_text VARCHAR(40) NOT NULL,
            accepting_orders TINYINT NOT NULL DEFAULT 0,
            updated_at VARCHAR(32) NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ''')


def _create_indexes(conn):
    indexes = [
        'CREATE INDEX idx_username ON users(username)',
        'CREATE INDEX idx_wechat_binding_device ON wechat_bindings(device_id)',
        'CREATE INDEX idx_wechat_session_openid ON wechat_sessions(openid)',
        'CREATE INDEX idx_wechat_session_expire ON wechat_sessions(expires_at)',
        'CREATE INDEX idx_device_id ON pending_requests(device_id)',
        'CREATE INDEX idx_announcement_active ON announcements(is_active)',
        'CREATE INDEX idx_user_read ON user_read_announcements(device_id)',
        'CREATE INDEX idx_feedback_device ON feedbacks(device_id)',
        'CREATE INDEX idx_feedback_visibility ON feedbacks(visibility)',
        'CREATE INDEX idx_feedback_reply_fid ON feedback_replies(feedback_id)',
        'CREATE INDEX idx_log_time ON request_logs(request_time)',
        'CREATE INDEX idx_log_device ON request_logs(device_id)',
        'CREATE INDEX idx_log_endpoint ON request_logs(endpoint)',
        'CREATE INDEX idx_ad_click_stats_date ON ad_click_stats(click_date)',
        'CREATE INDEX idx_inviter ON invitations(inviter_username)',
        'CREATE INDEX idx_invitee ON invitations(invitee_username)',
        'CREATE UNIQUE INDEX idx_invitation_links_token ON invitation_links(token)',
        'CREATE INDEX idx_orders_username_status ON orders(username, status)',
        'CREATE INDEX idx_orders_status_pay_time ON orders(status, pay_time)',
        'CREATE UNIQUE INDEX idx_api_keys_hash ON api_keys(key_hash)',
        'CREATE INDEX idx_earnings_username ON invitation_earnings(username)',
        'CREATE UNIQUE INDEX idx_earnings_user_order ON invitation_earnings(username, order_no)',
        'CREATE INDEX idx_earnings_order_no ON invitation_earnings(order_no)',
        'CREATE INDEX idx_reward_claims_username ON invitation_reward_claims(username)',
        'CREATE INDEX idx_milestone_rewards_username ON invitation_milestone_rewards(username)',
        'CREATE INDEX idx_withdrawals_username ON withdrawals(username)',
        'CREATE INDEX idx_withdrawals_status ON withdrawals(status)',
    ]
    for sql in indexes:
        _exec_ignore(conn, sql)


def _run_migrations(conn, db_type):
    if db_type == 'mysql':
        migrations = [
            'ALTER TABLE pending_requests ADD COLUMN notified TINYINT DEFAULT 0',
            'ALTER TABLE users ADD COLUMN last_auto_update VARCHAR(32)',
            "ALTER TABLE feedback_replies ADD COLUMN device_id VARCHAR(128) NOT NULL DEFAULT 'admin'",
            "ALTER TABLE feedback_replies ADD COLUMN username VARCHAR(64) NOT NULL DEFAULT '管理员'",
            'ALTER TABLE orders ADD COLUMN notify_url TEXT',
            'ALTER TABLE orders ADD COLUMN pay_url TEXT',
            'ALTER TABLE ad_click_stats ADD COLUMN impression_count INT NOT NULL DEFAULT 0',
            'ALTER TABLE ad_click_stats ADD COLUMN copy_count INT NOT NULL DEFAULT 0',
            'ALTER TABLE ad_click_stats ADD COLUMN dismiss_count INT NOT NULL DEFAULT 0',
        ]
    else:
        migrations = [
            'ALTER TABLE pending_requests ADD COLUMN notified INTEGER DEFAULT 0',
            'ALTER TABLE users ADD COLUMN last_auto_update TEXT',
            "ALTER TABLE feedback_replies ADD COLUMN device_id TEXT NOT NULL DEFAULT 'admin'",
            "ALTER TABLE feedback_replies ADD COLUMN username TEXT NOT NULL DEFAULT '管理员'",
            'ALTER TABLE orders ADD COLUMN notify_url TEXT',
            'ALTER TABLE orders ADD COLUMN pay_url TEXT',
            'ALTER TABLE ad_click_stats ADD COLUMN impression_count INTEGER NOT NULL DEFAULT 0',
            'ALTER TABLE ad_click_stats ADD COLUMN copy_count INTEGER NOT NULL DEFAULT 0',
            'ALTER TABLE ad_click_stats ADD COLUMN dismiss_count INTEGER NOT NULL DEFAULT 0',
        ]
    for sql in migrations:
        _exec_ignore(conn, sql)
    # 旧版只记录进入次数。用历史点击数作为最低展示分母，避免迁移后出现超过 100% 的点击率。
    _exec_ignore(
        conn,
        'UPDATE ad_click_stats SET impression_count = click_count '
        'WHERE impression_count < click_count',
    )


def _drop_removed_tables(conn):
    conn.execute('DROP TABLE IF EXISTS surveys')


def ensure_api_keys_table(config_override=None):
    """单独、幂等地初始化快捷指令 API 密钥表及其唯一索引。"""
    db_config = get_database_config(config_override)
    with get_db(config_override) as conn:
        _create_api_keys_table(conn, db_config['type'])
        _exec_ignore(conn, 'CREATE UNIQUE INDEX idx_api_keys_hash ON api_keys(key_hash)')


def _create_binding_archive_tables(conn, db_type):
    text_type = 'LONGTEXT' if db_type == 'mysql' else 'TEXT'
    suffix = ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' if db_type == 'mysql' else ''
    conn.execute(f'''CREATE TABLE IF NOT EXISTS user_account (
        username VARCHAR(64) PRIMARY KEY,
        password {text_type} NOT NULL,
        registered_at VARCHAR(32) NOT NULL,
        last_bind_time VARCHAR(32) NOT NULL,
        archived_at VARCHAR(32) NOT NULL
    ){suffix}''')
    conn.execute(f'''CREATE TABLE IF NOT EXISTS binding_archive_batches (
        batch_id VARCHAR(36) PRIMARY KEY,
        archived_at VARCHAR(32) NOT NULL,
        result_json {text_type} NOT NULL
    ){suffix}''')
    conn.execute(f'''CREATE TABLE IF NOT EXISTS temporary_sessions (
        device_id VARCHAR(255) PRIMARY KEY,
        session_id VARCHAR(32) NOT NULL,
        username VARCHAR(64) NOT NULL,
        expires_at BIGINT NOT NULL
    ){suffix}''')


def _migrate_temporary_sessions(conn, db_type):
    """旧临时会话表曾保存明文密码，升级时移除这一列。"""
    try:
        conn.execute('SELECT password FROM temporary_sessions WHERE 1 = 0')
    except Exception as exc:
        message = str(exc).lower()
        if 'no such column' in message or 'unknown column' in message:
            _exec_ignore(conn, 'CREATE INDEX idx_temporary_sessions_expires ON temporary_sessions(expires_at)')
            return
        raise

    if db_type == 'mysql':
        conn.execute("UPDATE temporary_sessions SET password = ''")
        conn.execute('ALTER TABLE temporary_sessions DROP COLUMN password')
    else:
        # 通过重建表兼容不支持 DROP COLUMN 的旧版 SQLite。
        conn.execute('''CREATE TABLE temporary_sessions_without_password (
            device_id VARCHAR(255) PRIMARY KEY,
            session_id VARCHAR(32) NOT NULL,
            username VARCHAR(64) NOT NULL,
            expires_at BIGINT NOT NULL
        )''')
        conn.execute('''INSERT INTO temporary_sessions_without_password
            (device_id, session_id, username, expires_at)
            SELECT device_id, session_id, username, expires_at FROM temporary_sessions''')
        conn.execute('DROP TABLE temporary_sessions')
        conn.execute('ALTER TABLE temporary_sessions_without_password RENAME TO temporary_sessions')
    _exec_ignore(conn, 'CREATE INDEX idx_temporary_sessions_expires ON temporary_sessions(expires_at)')


def _migrate_plural_user_accounts(conn):
    """把早期版本的 user_accounts（复数）合并到新的唯一账号主表。"""
    try:
        rows = conn.execute('''SELECT legacy.username, legacy.password, legacy.registered_at,
                                      legacy.last_bind_time, legacy.archived_at
            FROM user_accounts AS legacy
            LEFT JOIN user_account AS account ON account.username = legacy.username
            WHERE account.username IS NULL''').fetchall()
    except Exception as exc:
        message = str(exc).lower()
        if 'no such table' in message or "doesn't exist" in message or 'does not exist' in message:
            return
        raise
    if rows:
        # 复制前加密，INSERT IGNORE 保证并发新增账号也不会被旧资料覆盖。
        cipher = CredentialCipher()
        values = [tuple(cipher.ensure_encrypted(row[field]) if field == 'password' else row[field]
                        for field in ACCOUNT_FIELDS) for row in rows]
        conn.executemany('''INSERT OR IGNORE INTO user_account
            (username, password, registered_at, last_bind_time, archived_at)
            VALUES (?, ?, ?, ?, ?)''', values)


def init_db(config_override=None):
    """初始化当前配置指向的数据库表结构。"""
    db_config = get_database_config(config_override)
    with get_db(config_override) as conn:
        # 先创建快捷指令密钥表，避免其它历史表初始化失败时遗漏新表。
        _create_api_keys_table(conn, db_config['type'])
        _create_binding_archive_tables(conn, db_config['type'])
        _migrate_temporary_sessions(conn, db_config['type'])
        if db_config['type'] == 'mysql':
            _create_schema_mysql(conn)
        else:
            _create_schema_sqlite(conn)
        _run_migrations(conn, db_config['type'])
        _drop_removed_tables(conn)
        _create_indexes(conn)
        _create_wechat_account_bindings(conn, db_config['type'])
        _create_lab_credentials(conn, db_config['type'])
        from services.personal_schedule_service import create_personal_tables
        create_personal_tables(conn, db_config['type'])
        _exec_ignore(conn, 'CREATE INDEX idx_temporary_sessions_session_id ON temporary_sessions(session_id)')
        # MySQL DDL 会隐式提交，凭据加密和账号提升必须放在所有 DDL 后。
        _migrate_urp_credentials(conn, db_config['type'])
        _migrate_plural_user_accounts(conn)
        _migrate_legacy_wechat_bindings(conn)


def _table_columns(conn, table, db_type):
    """仅用于下面固定白名单中的表；不存在的历史表返回空集合。"""
    if db_type == 'sqlite':
        return {row['name'] for row in conn.execute(f'PRAGMA table_info({table})').fetchall()}
    return {row['name'] for row in conn.execute(
        'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS '
        'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', (table,)
    ).fetchall()}


def migrate_account_password(conn, username, password):
    """读取时补迁移，条件更新避免覆盖另一个设备刚提交的新密码。"""
    cipher = CredentialCipher()
    if not password or cipher.is_encrypted(password) or not cipher.configured():
        return password
    encrypted = cipher.encrypt(password)
    equality = 'password = ?' if isinstance(conn, sqlite3.Connection) else 'BINARY password = BINARY ?'
    updated = conn.execute(f'UPDATE user_account SET password = ? WHERE username = ? AND {equality}',
                           (encrypted, username, password))
    if updated.rowcount == 0:
        # MySQL RR 普通 SELECT 仍可能读到旧快照；锁定读取获取最新版本。
        locking = '' if isinstance(conn, sqlite3.Connection) else ' FOR UPDATE'
        current = conn.execute('SELECT password FROM user_account WHERE username = ?' + locking,
                               (username,)).fetchone()
        if current:
            return current['password']
    return encrypted


def _migrate_urp_credentials(conn, db_type):
    """有密钥时在同一事务内加密主表与历史副本；没有密钥仍兼容旧库读取。"""
    cipher = CredentialCipher()
    if not cipher.configured():
        return
    tables = {
        'user_account': ('username',),
        'user_accounts': ('username',),
        'users': ('device_id',),
        'user_account_archive': ('batch_id', 'device_id'),
    }
    equality = 'password = ?' if db_type == 'sqlite' else 'BINARY password = BINARY ?'
    for table, keys in tables.items():
        columns = _table_columns(conn, table, db_type)
        if not {'password', *keys} <= columns:
            continue
        for row in conn.execute(f'SELECT {", ".join(keys)}, password FROM {table} '
                                "WHERE password IS NOT NULL AND password != ''").fetchall():
            encrypted = cipher.ensure_encrypted(row['password'])
            if encrypted == row['password']:
                continue
            where = ' AND '.join(f'{key} = ?' for key in keys)
            conn.execute(f'UPDATE {table} SET password = ? WHERE {where} AND {equality}',
                         (encrypted, *(row[key] for key in keys), row['password']))

    # 早期归档还可能把完整设备记录序列化到 JSON，不能遗留第二份明文。
    table = 'binding_record_archive'
    keys = ('batch_id', 'source_table', 'record_key')
    columns = _table_columns(conn, table, db_type)
    if not {*keys, 'record_json'} <= columns:
        return
    for row in conn.execute(f'SELECT {", ".join(keys)}, record_json FROM {table}').fetchall():
        record = json.loads(row['record_json'])
        if not isinstance(record, dict) or not isinstance(record.get('password'), str):
            continue
        encrypted = cipher.ensure_encrypted(record['password'])
        if encrypted == record['password']:
            continue
        record['password'] = encrypted
        where = ' AND '.join(f'{key} = ?' for key in keys)
        equality = 'record_json = ?' if db_type == 'sqlite' else 'BINARY record_json = BINARY ?'
        conn.execute(f'UPDATE {table} SET record_json = ? WHERE {where} AND {equality}',
                     (json.dumps(record, ensure_ascii=False), *(row[key] for key in keys), row['record_json']))


def _create_lab_credentials(conn, db_type):
    suffix = ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' if db_type == 'mysql' else ''
    conn.execute(f'''CREATE TABLE IF NOT EXISTS lab_credentials (
        username VARCHAR(64) PRIMARY KEY,
        password_ciphertext TEXT NOT NULL,
        updated_at VARCHAR(32) NOT NULL
    ){suffix}''')


def _create_wechat_account_bindings(conn, db_type):
    suffix = ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' if db_type == 'mysql' else ''
    conn.execute(f'''CREATE TABLE IF NOT EXISTS wechat_account_bindings (
        openid VARCHAR(128) PRIMARY KEY,
        username VARCHAR(64) UNIQUE,
        bind_time VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32) NOT NULL
    ){suffix}''')


def _migrate_legacy_wechat_bindings(conn):
    # 保留解绑后的空关系作为迁移标记，避免旧设备关系在下次启动时复活。
    # 旧表没有 username 唯一约束，同一学号可能对应多个历史微信。逐行按
    # 更新时间倒序导入，才能让新表稳定地保留最近关系，而不是依赖数据库
    # 未承诺的 SELECT 返回顺序；INSERT OR IGNORE 仍会保留已有的解绑标记。
    legacy_rows = conn.execute('''SELECT w.openid, u.username, w.bind_time, w.updated_at
        FROM wechat_bindings w JOIN users u ON u.device_id = w.device_id
        JOIN user_account a ON a.username = u.username
        ORDER BY w.updated_at DESC, w.openid ASC''').fetchall()
    for row in legacy_rows:
        conn.execute('''INSERT OR IGNORE INTO wechat_account_bindings
            (openid, username, bind_time, updated_at) VALUES (?, ?, ?, ?)''',
            (row['openid'], row['username'], row['bind_time'], row['updated_at']))


def test_database_config(database_config):
    """测试并初始化一个数据库配置。成功返回 (True, message)，失败返回 (False, message)。"""
    config = {'database': database_config}
    try:
        init_db(config)
        return True, '数据库连接成功，表结构已初始化'
    except Exception as exc:
        return False, str(exc)
MIGRATION_TABLES = {
    'personal_schedule_state': ['owner_key', 'semester_key', 'revision'],
    'personal_schedule_items': ['id', 'owner_key', 'semester_key', 'kind', 'source_id', 'series_id', 'original_week', 'event_json', 'version', 'updated_at'],
    'wechat_account_bindings': ['openid', 'username', 'bind_time', 'updated_at'],
    'user_account': ['username', 'password', 'registered_at', 'last_bind_time', 'archived_at'],
    # 旧 users 是设备绑定记录；先从它提取最新绑定凭据，再导入
    # 旧复数账号表。这样“旧复数表 + 更晚 users 绑定”的数据库不会
    # 因 INSERT OR IGNORE 先占用主键而丢失最新密码。
    'users': ['device_id', 'username', 'password', 'bind_time', 'last_auto_update'],
    # 仅作为旧 SQLite 导入源，当前目标表是 user_account。它必须排在
    # users 后面：只补齐 users 没有的账号，不覆盖设备表中的较新绑定。
    'user_accounts': ['username', 'password', 'registered_at', 'last_bind_time', 'archived_at'],
    'binding_archive_batches': ['batch_id', 'archived_at', 'result_json'],
    'wechat_bindings': ['openid', 'device_id', 'unionid', 'bind_time', 'updated_at'],
    'wechat_sessions': ['token_hash', 'openid', 'expires_at', 'created_at', 'last_seen_at'],
    'pending_requests': ['request_id', 'device_id', 'old_username', 'new_username', 'reason', 'request_time', 'status', 'notified'],
    'announcements': ['id', 'title', 'content', 'create_time', 'is_active'],
    'user_read_announcements': ['device_id', 'announcement_id', 'read_time', 'never_show'],
    'feedbacks': ['id', 'device_id', 'username', 'content', 'visibility', 'create_time'],
    'feedback_replies': ['id', 'feedback_id', 'device_id', 'username', 'content', 'create_time'],
    'request_logs': ['id', 'device_id', 'username', 'endpoint', 'method', 'status_code', 'request_time'],
    'ad_click_stats': ['ad_key', 'click_date', 'impression_count', 'click_count', 'copy_count', 'dismiss_count', 'updated_at'],
    'ad_copy_users': ['ad_key', 'username'],
    'memberships': ['username', 'member_type', 'expire_time', 'create_time'],
    'invitation_links': ['username', 'token', 'create_time'],
    'api_keys': ['username', 'key_hash', 'key_prefix', 'create_time'],
    'invitations': ['id', 'inviter_username', 'invitee_username', 'create_time'],
    'invitation_earnings': ['id', 'username', 'order_no', 'invitee_username', 'amount', 'rate', 'create_time'],
    'invitation_reward_claims': ['id', 'username', 'invitee_username', 'order_no', 'amount', 'rate', 'create_time'],
    'invitation_milestone_rewards': ['id', 'username', 'milestone_id', 'amount', 'create_time'],
    'withdrawals': ['id', 'username', 'real_name', 'alipay_account', 'amount', 'status', 'create_time', 'review_time'],
    'orders': ['order_no', 'device_id', 'username', 'member_type', 'amount', 'pay_type', 'status', 'create_time', 'pay_time', 'notify_url', 'pay_url'],
    'admin_service_status': ['id', 'status_text', 'accepting_orders', 'updated_at'],
}
ACCOUNT_FIELDS = ('username', 'password', 'registered_at', 'last_bind_time', 'archived_at')


def _source_columns(source_conn, table):
    rows = source_conn.execute(f'PRAGMA table_info({table})').fetchall()
    return {row['name'] for row in rows}


def _account_rows_from_legacy_users(rows, archived_at=None):
    """从旧版 users 设备记录生成一条一学号账号资料。"""
    archived_at = archived_at or datetime.now().isoformat()
    accounts = {}
    for row in rows:
        username = str(row['username'] or '').strip()
        bind_time = str(row['bind_time'] or '').strip()
        if not username or not bind_time:
            raise ValueError('旧 users 表存在缺少学号或绑定时间的记录，已停止导入')
        password = row['password'] or ''
        current = accounts.get(username)
        if current is None:
            accounts[username] = {
                'username': username,
                'password': password,
                'registered_at': bind_time,
                'last_bind_time': bind_time,
                'archived_at': archived_at,
            }
            continue

        if bind_time < current['registered_at']:
            current['registered_at'] = bind_time
        if bind_time >= current['last_bind_time']:
            # 旧版本可能已经把设备表密码清空；空值不能覆盖有效凭据。
            if password:
                current['password'] = password
            current['last_bind_time'] = bind_time
    return list(accounts.values())


def migrate_sqlite_to_current_database(sqlite_path=None):
    """把本机 SQLite 数据导入当前配置的数据库，主要用于切换到 MySQL 后迁移历史数据。"""
    db_config = get_database_config()
    if db_config['type'] != 'mysql':
        return False, '当前数据库不是 MySQL/MariaDB，无需迁移', {}

    sqlite_path = sqlite_path or db_config.get('sqlite_path') or DB_FILE
    if not os.path.exists(sqlite_path):
        return False, f'SQLite 文件不存在: {sqlite_path}', {}

    result = {}
    try:
        init_db()
        source = sqlite3.connect(sqlite_path)
        source.row_factory = sqlite3.Row
        try:
            with get_db() as target:
                for table, columns in MIGRATION_TABLES.items():
                    try:
                        existing_columns = _source_columns(source, table)
                        usable_columns = [col for col in columns if col in existing_columns]
                        if not usable_columns:
                            result[table] = 0
                            continue
                        select_sql = f"SELECT {', '.join(usable_columns)} FROM {table}"
                        if table in ('personal_schedule_state', 'personal_schedule_items'):
                            select_sql += " WHERE owner_key LIKE 'account:%'"
                        if table == 'users' and {'username', 'bind_time', 'device_id'} <= set(usable_columns):
                            # 同一学号、同一绑定时间存在多条设备记录时，
                            # 固定设备顺序，保证迁移结果可重复。
                            select_sql += ' ORDER BY username, bind_time, device_id'
                        rows = source.execute(select_sql).fetchall()
                        if not rows:
                            result[table] = 0
                            if table == 'users':
                                result['user_account_from_users'] = 0
                            continue
                        placeholders = ', '.join(['?'] * len(usable_columns))
                        target_table = 'user_account' if table == 'user_accounts' else table
                        operation = 'INSERT OR IGNORE' if table == 'user_accounts' else 'REPLACE'
                        insert_sql = f"{operation} INTO {target_table} ({', '.join(usable_columns)}) VALUES ({placeholders})"
                        values = [tuple(row[col] for col in usable_columns) for row in rows]
                        if target_table == 'user_account' and 'password' in usable_columns:
                            password_index = usable_columns.index('password')
                            values = [tuple(CredentialCipher().ensure_encrypted(value)
                                            if index == password_index else value
                                            for index, value in enumerate(row_values))
                                      for row_values in values]
                        account_rows = None
                        if table == 'users':
                            # 先从旧设备记录提取账号资料，再把兼容表中的密码
                            # 清空，确保新库的凭据只存在于 user_account。
                            account_rows = _account_rows_from_legacy_users(rows)
                            if 'password' in usable_columns:
                                password_index = usable_columns.index('password')
                                values = [
                                    tuple('' if index == password_index else value
                                          for index, value in enumerate(row_values))
                                    for row_values in values
                                ]
                        target.executemany(insert_sql, values)
                        result[table] = len(values)
                        if account_rows is not None:
                            if account_rows:
                                target.executemany(
                                    '''INSERT OR IGNORE INTO user_account
                                       (username, password, registered_at, last_bind_time, archived_at)
                                       VALUES (?, ?, ?, ?, ?)''',
                                    [tuple(CredentialCipher().ensure_encrypted(account[field])
                                           if field == 'password' else account[field] for field in ACCOUNT_FIELDS)
                                     for account in account_rows],
                                )
                            result['user_account_from_users'] = len(account_rows)
                    except Exception as table_error:
                        result[table] = f'失败: {table_error}'
                        raise
                # init_db() 在复制源表之前运行；旧 SQLite 只有 wechat_bindings
                # 时，必须在 users/user_account 已复制完成后再提升一次旧关系，
                # 否则目标库只会有兼容表而新接口仍看不到绑定。
                _migrate_legacy_wechat_bindings(target)
        finally:
            source.close()
    except Exception as exc:
        # 任何一张表失败都让 get_db 回滚整个导入，避免前面已经提交的
        # 表造成“部分迁移却显示成功”的误导。
        return False, f'SQLite 数据导入失败，已回滚: {exc}', result

    return True, 'SQLite 数据导入完成', result
