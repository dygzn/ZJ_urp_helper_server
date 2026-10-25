"""用户增长快照：北京时间、历史账号去重及只读刷新。"""
from contextlib import contextmanager
from datetime import datetime, timezone
import os
import sqlite3
import unittest
from unittest.mock import patch

from flask import Flask

from routes.admin_routes import admin_bp


class UserGrowthTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(':memory:')
        self.conn.row_factory = sqlite3.Row
        self.addCleanup(self.conn.close)
        self.conn.executescript('''
            CREATE TABLE users (device_id TEXT, username TEXT, bind_time TEXT);
            CREATE TABLE user_account (username TEXT, registered_at TEXT);
            CREATE TABLE user_accounts (username TEXT, registered_at TEXT);
            CREATE TABLE user_account_archive (username TEXT, bind_time TEXT);
            INSERT INTO user_account VALUES ('old', '2026-10-10T09:00:00');
            INSERT INTO users VALUES ('new-device', 'old', '2026-10-25T01:00:00');
            INSERT INTO user_account_archive VALUES ('old', '2026-10-01T09:00:00');
            INSERT INTO user_accounts VALUES ('old', '2026-10-05T09:00:00');
            INSERT INTO user_account VALUES ('today', '2026-10-24T17:00:00+00:00');
            INSERT INTO user_account VALUES ('blank-binding', '2026-10-25T00:30:00');
            INSERT INTO users VALUES ('blank-device', 'blank-binding', '');
        ''')
        self.statements = []
        self.conn.set_trace_callback(self.statements.append)

        @contextmanager
        def db():
            yield self.conn

        self.enterContext(patch('routes.admin_routes.get_db', db))
        self.enterContext(patch.dict(os.environ, {'ADMIN_KEY': 'offline-growth-admin'}))
        self.app = Flask(__name__)
        self.app.register_blueprint(admin_bp)
        self.client = self.app.test_client()

    def refresh(self):
        return self.client.get('/api/admin/users', headers={'X-Admin-Key': 'offline-growth-admin'})

    def test_snapshot_uses_beijing_dates_and_earliest_known_registration(self):
        class Clock(datetime):
            @classmethod
            def now(cls, tz=None):
                return datetime(2026, 10, 24, 17, 30, tzinfo=timezone.utc).astimezone(tz)

        with patch('routes.admin_routes.datetime', Clock):
            response = self.refresh()
        payload = response.get_json()
        self.assertEqual(payload['total'], 3)
        self.assertEqual(payload.get('date'), '2026-10-25')
        self.assertEqual(payload.get('generated_at'), '2026-10-25T01:30:00+08:00')
        self.assertEqual(payload['daily'], [
            {'date': '2026-10-01', 'count': 1, 'total': 1},
            {'date': '2026-10-25', 'count': 2, 'total': 3},
        ])

    def test_refresh_is_not_cached_performs_no_writes_and_only_discovers_schema_once(self):
        self.statements.clear()
        first = self.refresh()
        self.assertIn('no-store', first.headers.get('Cache-Control', ''))
        selects = [sql for sql in self.statements if sql.lstrip().upper().startswith('SELECT')]
        self.assertEqual(len(selects), 2, selects)
        self.assertFalse(any(sql.lstrip().upper().startswith(('INSERT', 'UPDATE', 'DELETE')) for sql in self.statements))
        self.conn.execute("INSERT INTO user_account VALUES ('new', '2026-10-25T02:00:00')")
        self.assertEqual(self.refresh().get_json()['total'], 4)


if __name__ == '__main__':
    unittest.main()
