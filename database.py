"""
数据库初始化与连接管理
"""
import sqlite3
from contextlib import contextmanager
from constants import DB_FILE


@contextmanager
def get_db():
    """获取数据库连接的上下文管理器"""
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception as e:
        conn.rollback()
        raise e
    finally:
        conn.close()


def init_db():
    """初始化数据库表结构"""
    with get_db() as conn:
        # 用户绑定表
        conn.execute('''
            CREATE TABLE IF NOT EXISTS users (
                device_id TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                password TEXT NOT NULL,
                bind_time TEXT NOT NULL,
                last_auto_update TEXT
            )
        ''')

        # 换绑请求表
        conn.execute('''
            CREATE TABLE IF NOT EXISTS pending_requests (
                request_id TEXT PRIMARY KEY,
                device_id TEXT NOT NULL,
                old_username TEXT NOT NULL,
                new_username TEXT NOT NULL,
                reason TEXT NOT NULL,
                request_time TEXT NOT NULL,
                status TEXT DEFAULT 'pending'
            )
        ''')

        # 公告表
        conn.execute('''
            CREATE TABLE IF NOT EXISTS announcements (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                create_time TEXT NOT NULL,
                is_active INTEGER DEFAULT 1
            )
        ''')

        # 用户已读公告表
        conn.execute('''
            CREATE TABLE IF NOT EXISTS user_read_announcements (
                device_id TEXT NOT NULL,
                announcement_id INTEGER NOT NULL,
                read_time TEXT NOT NULL,
                never_show INTEGER DEFAULT 0,
                PRIMARY KEY (device_id, announcement_id)
            )
        ''')

        # 问卷调查表
        conn.execute('''
            CREATE TABLE IF NOT EXISTS surveys (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                url TEXT NOT NULL,
                create_time TEXT NOT NULL,
                is_active INTEGER DEFAULT 1
            )
        ''')

        # 反馈表
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

        # 反馈回复表
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

        # 索引
        conn.execute('CREATE INDEX IF NOT EXISTS idx_username ON users(username)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_device_id ON pending_requests(device_id)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_announcement_active ON announcements(is_active)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_user_read ON user_read_announcements(device_id)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_survey_active ON surveys(is_active)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_feedback_device ON feedbacks(device_id)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_feedback_visibility ON feedbacks(visibility)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_feedback_reply_fid ON feedback_replies(feedback_id)')

        # 请求日志表
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
        conn.execute('CREATE INDEX IF NOT EXISTS idx_log_time ON request_logs(request_time)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_log_device ON request_logs(device_id)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_log_endpoint ON request_logs(endpoint)')

        # 迁移：pending_requests 添加 notified 字段
        try:
            conn.execute('ALTER TABLE pending_requests ADD COLUMN notified INTEGER DEFAULT 0')
        except Exception:
            pass

        # 迁移：users 添加 last_auto_update 字段
        try:
            conn.execute('ALTER TABLE users ADD COLUMN last_auto_update TEXT')
        except Exception:
            pass

        # 迁移：feedback_replies 添加 device_id/username 字段
        try:
            conn.execute("ALTER TABLE feedback_replies ADD COLUMN device_id TEXT NOT NULL DEFAULT 'admin'")
        except Exception:
            pass
        try:
            conn.execute("ALTER TABLE feedback_replies ADD COLUMN username TEXT NOT NULL DEFAULT '管理员'")
        except Exception:
            pass

        # 迁移：orders 添加 notify_url 字段
        try:
            conn.execute('ALTER TABLE orders ADD COLUMN notify_url TEXT')
        except Exception:
            pass

        # 会员信息表
        conn.execute('''
            CREATE TABLE IF NOT EXISTS memberships (
                username TEXT PRIMARY KEY,
                member_type TEXT NOT NULL,
                expire_time TEXT NOT NULL,
                create_time TEXT NOT NULL
            )
        ''')

        # 支付订单表
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
                pay_time TEXT
            )
        ''')
