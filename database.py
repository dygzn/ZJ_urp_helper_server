"""
数据库初始化与连接管理。

默认使用本机 SQLite；在后台配置 MySQL/MariaDB 后，所有业务数据会写入同一个远程数据库，
用于多台服务器共享用户、会员、订单、返佣等数据。
"""
import os
import re
import sqlite3
from contextlib import contextmanager
from constants import DB_FILE
from services.config_service import get_config


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
    except Exception:
        pass


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
        CREATE TABLE IF NOT EXISTS surveys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            url TEXT NOT NULL,
            create_time TEXT NOT NULL,
            is_active INTEGER DEFAULT 1
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
        CREATE TABLE IF NOT EXISTS memberships (
            username TEXT PRIMARY KEY,
            member_type TEXT NOT NULL,
            expire_time TEXT NOT NULL,
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
        CREATE TABLE IF NOT EXISTS surveys (
            id INT AUTO_INCREMENT PRIMARY KEY,
            title VARCHAR(255) NOT NULL,
            url TEXT NOT NULL,
            create_time VARCHAR(32) NOT NULL,
            is_active TINYINT DEFAULT 1
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
        CREATE TABLE IF NOT EXISTS memberships (
            username VARCHAR(64) PRIMARY KEY,
            member_type VARCHAR(32) NOT NULL,
            expire_time VARCHAR(32) NOT NULL,
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


def _create_indexes(conn):
    indexes = [
        'CREATE INDEX idx_username ON users(username)',
        'CREATE INDEX idx_device_id ON pending_requests(device_id)',
        'CREATE INDEX idx_announcement_active ON announcements(is_active)',
        'CREATE INDEX idx_user_read ON user_read_announcements(device_id)',
        'CREATE INDEX idx_survey_active ON surveys(is_active)',
        'CREATE INDEX idx_feedback_device ON feedbacks(device_id)',
        'CREATE INDEX idx_feedback_visibility ON feedbacks(visibility)',
        'CREATE INDEX idx_feedback_reply_fid ON feedback_replies(feedback_id)',
        'CREATE INDEX idx_log_time ON request_logs(request_time)',
        'CREATE INDEX idx_log_device ON request_logs(device_id)',
        'CREATE INDEX idx_log_endpoint ON request_logs(endpoint)',
        'CREATE INDEX idx_inviter ON invitations(inviter_username)',
        'CREATE INDEX idx_invitee ON invitations(invitee_username)',
        'CREATE INDEX idx_orders_username_status ON orders(username, status)',
        'CREATE INDEX idx_orders_status_pay_time ON orders(status, pay_time)',
        'CREATE INDEX idx_earnings_username ON invitation_earnings(username)',
        'CREATE UNIQUE INDEX idx_earnings_user_order ON invitation_earnings(username, order_no)',
        'CREATE INDEX idx_earnings_order_no ON invitation_earnings(order_no)',
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
        ]
    else:
        migrations = [
            'ALTER TABLE pending_requests ADD COLUMN notified INTEGER DEFAULT 0',
            'ALTER TABLE users ADD COLUMN last_auto_update TEXT',
            "ALTER TABLE feedback_replies ADD COLUMN device_id TEXT NOT NULL DEFAULT 'admin'",
            "ALTER TABLE feedback_replies ADD COLUMN username TEXT NOT NULL DEFAULT '管理员'",
            'ALTER TABLE orders ADD COLUMN notify_url TEXT',
            'ALTER TABLE orders ADD COLUMN pay_url TEXT',
        ]
    for sql in migrations:
        _exec_ignore(conn, sql)


def init_db(config_override=None):
    """初始化当前配置指向的数据库表结构。"""
    db_config = get_database_config(config_override)
    with get_db(config_override) as conn:
        if db_config['type'] == 'mysql':
            _create_schema_mysql(conn)
        else:
            _create_schema_sqlite(conn)
        _run_migrations(conn, db_config['type'])
        _create_indexes(conn)


def test_database_config(database_config):
    """测试并初始化一个数据库配置。成功返回 (True, message)，失败返回 (False, message)。"""
    config = {'database': database_config}
    try:
        init_db(config)
        return True, '数据库连接成功，表结构已初始化'
    except Exception as exc:
        return False, str(exc)
MIGRATION_TABLES = {
    'users': ['device_id', 'username', 'password', 'bind_time', 'last_auto_update'],
    'pending_requests': ['request_id', 'device_id', 'old_username', 'new_username', 'reason', 'request_time', 'status', 'notified'],
    'announcements': ['id', 'title', 'content', 'create_time', 'is_active'],
    'user_read_announcements': ['device_id', 'announcement_id', 'read_time', 'never_show'],
    'surveys': ['id', 'title', 'url', 'create_time', 'is_active'],
    'feedbacks': ['id', 'device_id', 'username', 'content', 'visibility', 'create_time'],
    'feedback_replies': ['id', 'feedback_id', 'device_id', 'username', 'content', 'create_time'],
    'request_logs': ['id', 'device_id', 'username', 'endpoint', 'method', 'status_code', 'request_time'],
    'memberships': ['username', 'member_type', 'expire_time', 'create_time'],
    'invitations': ['id', 'inviter_username', 'invitee_username', 'create_time'],
    'invitation_earnings': ['id', 'username', 'order_no', 'invitee_username', 'amount', 'rate', 'create_time'],
    'withdrawals': ['id', 'username', 'real_name', 'alipay_account', 'amount', 'status', 'create_time', 'review_time'],
    'orders': ['order_no', 'device_id', 'username', 'member_type', 'amount', 'pay_type', 'status', 'create_time', 'pay_time', 'notify_url', 'pay_url'],
}


def _source_columns(source_conn, table):
    rows = source_conn.execute(f'PRAGMA table_info({table})').fetchall()
    return {row['name'] for row in rows}


def migrate_sqlite_to_current_database(sqlite_path=None):
    """把本机 SQLite 数据导入当前配置的数据库，主要用于切换到 MySQL 后迁移历史数据。"""
    db_config = get_database_config()
    if db_config['type'] != 'mysql':
        return False, '当前数据库不是 MySQL/MariaDB，无需迁移', {}

    sqlite_path = sqlite_path or db_config.get('sqlite_path') or DB_FILE
    if not os.path.exists(sqlite_path):
        return False, f'SQLite 文件不存在: {sqlite_path}', {}

    init_db()
    result = {}
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
                    rows = source.execute(select_sql).fetchall()
                    if not rows:
                        result[table] = 0
                        continue
                    placeholders = ', '.join(['?'] * len(usable_columns))
                    insert_sql = f"REPLACE INTO {table} ({', '.join(usable_columns)}) VALUES ({placeholders})"
                    values = [tuple(row[col] for col in usable_columns) for row in rows]
                    target.executemany(insert_sql, values)
                    result[table] = len(values)
                except Exception as exc:
                    result[table] = f'失败: {exc}'
    finally:
        source.close()

    return True, 'SQLite 数据导入完成', result