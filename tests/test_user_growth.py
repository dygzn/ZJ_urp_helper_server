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
            CREATE TABLE memberships (username TEXT PRIMARY KEY, member_type TEXT, expire_time TEXT, create_time TEXT);
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
        self.assertEqual(len(selects), 3, selects)
        self.assertFalse(any(sql.lstrip().upper().startswith(('INSERT', 'UPDATE', 'DELETE')) for sql in self.statements))
        self.conn.execute("INSERT INTO user_account VALUES ('new', '2026-10-25T02:00:00')")
        self.assertEqual(self.refresh().get_json()['total'], 4)

    def test_membership_rates_deduplicate_history_and_exclude_expired_and_unregistered(self):
        self.conn.executescript('''
            INSERT INTO user_account VALUES ('2315011001', '2026-10-01');
            INSERT INTO user_account VALUES ('2315011002', '2026-10-01');
            INSERT INTO user_account VALUES ('2415011001', '2026-10-01');
            INSERT INTO user_account_archive VALUES ('2315011001', '2026-09-01');
            INSERT INTO memberships VALUES ('2315011001', 'basic', '2026-10-26T00:00:00', '2026-10-19T00:00:00');
            INSERT INTO memberships VALUES ('2315011002', 'advanced', '2026-10-24T00:00:00', '2026-10-18T00:00:00');
            INSERT INTO memberships VALUES ('2415011001', 'advanced', '2026-10-25T00:00:00+00:00', '2026-10-25T00:00:00');
            INSERT INTO memberships VALUES ('old', 'basic', 'invalid', '2026-10-12T00:00:00');
            INSERT INTO memberships VALUES ('not-registered', 'basic', '2027-01-01', '2026-10-25T00:00:00');
        ''')
        class Clock(datetime):
            @classmethod
            def now(cls, tz=None):
                return datetime(2026, 10, 24, 17, 30, tzinfo=timezone.utc).astimezone(tz)
        with patch('routes.admin_routes.datetime', Clock):
            rates = self.refresh().get_json()['membership_rates']
        self.assertEqual(rates['total'], {'users': 6, 'members': 2})
        self.assertIn({'grade': '2023', 'users': 2, 'members': 1}, rates['grades'])
        self.assertIn({'major': '011', 'users': 3, 'members': 2}, rates['majors'])
        self.assertIn({'grade': '2024', 'major': '011', 'users': 1, 'members': 1}, rates['grade_majors'])
        self.assertIn({'grade': None, 'users': 3, 'members': 0}, rates['grades'])
        with patch('routes.admin_routes.datetime', Clock):
            growth = self.refresh().get_json()['membership_growth']
        self.assertEqual(growth, {'current': 2, 'previous': 2, 'rate': 0.0})

    def test_empty_history_has_no_division_or_unmatched_members(self):
        for table in ('users', 'user_account', 'user_accounts', 'user_account_archive'):
            self.conn.execute('DELETE FROM ' + table)
        self.conn.execute("INSERT INTO memberships VALUES ('other', 'basic', '2099-01-01', '2026-10-25')")
        payload = self.refresh().get_json()
        rates = payload['membership_rates']
        self.assertEqual(rates['total'], {'users': 0, 'members': 0})
        self.assertEqual(rates['grades'], [])
        self.assertEqual(payload['membership_growth'], {'current': 0, 'previous': 0, 'rate': None})

    def test_membership_growth_uses_beijing_days_and_handles_zero_baseline(self):
        from routes.admin_routes import _membership_growth
        now = datetime.fromisoformat('2026-10-25T12:00:00+08:00')
        rows = [{'username': name} for name in ('a', 'b', 'c')]
        members = [
            {'username': 'a', 'create_time': '2026-10-18T16:00:00+00:00'},
            {'username': 'b', 'create_time': '2026-10-25T09:00:00+08:00'},
            {'username': 'c', 'create_time': '2026-10-11T16:00:00+00:00'},
        ]
        self.assertEqual(_membership_growth(rows, members, now), {'current': 2, 'previous': 1, 'rate': 100.0})
        self.assertEqual(_membership_growth(rows, members[:2], now)['rate'], None)


if __name__ == '__main__':
    unittest.main()
