"""Offline regression checks for monitoring and list-query costs."""
import builtins
import sqlite3
import unittest
from contextlib import contextmanager
from datetime import datetime, timedelta
from unittest.mock import patch

from flask import Flask
from routes import misc_routes
from services import online_service, wechat_auth_service


class MonitorQueryCosts(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(':memory:')
        self.conn.row_factory = sqlite3.Row
        self.addCleanup(self.conn.close)
        self.conn.executescript('''
            CREATE TABLE announcements (id INTEGER PRIMARY KEY, title TEXT, content TEXT, create_time TEXT, is_active INTEGER);
            CREATE TABLE user_read_announcements (device_id TEXT, announcement_id INTEGER, never_show INTEGER, UNIQUE(device_id, announcement_id));
            CREATE TABLE feedbacks (id INTEGER PRIMARY KEY, device_id TEXT, username TEXT, content TEXT, visibility TEXT, create_time TEXT);
            CREATE TABLE feedback_replies (id INTEGER PRIMARY KEY, feedback_id INTEGER, device_id TEXT, username TEXT, content TEXT, create_time TEXT);
            CREATE TABLE wechat_sessions (token_hash TEXT PRIMARY KEY, openid TEXT, expires_at TEXT, created_at TEXT, last_seen_at TEXT);
            CREATE TABLE wechat_bindings (openid TEXT PRIMARY KEY, device_id TEXT, unionid TEXT, bind_time TEXT, updated_at TEXT);
        ''')
        self.statements = []
        self.conn.set_trace_callback(self.statements.append)
        @contextmanager
        def db():
            with self.conn:
                yield self.conn
        self.enterContext(patch.object(misc_routes, 'get_db', db))
        self.enterContext(patch.object(wechat_auth_service, 'get_db', db))
        self.app = Flask(__name__)

    def selects(self):
        return [s for s in self.statements if s.lstrip().upper().startswith('SELECT')]

    def test_announcement_read_states_use_one_query_and_keep_order(self):
        for index in range(20):
            self.conn.execute('INSERT INTO announcements VALUES (?, ?, ?, ?, ?)',
                              (index, str(index), 'content', f'2026-10-{index + 1:02}', int(index != 19)))
        self.conn.executemany('INSERT INTO user_read_announcements VALUES (?, ?, ?)',
                              [('device', 1, 1), ('device', 2, 0), ('another', 3, 1)])
        self.statements.clear()
        with self.app.test_request_context(), patch.object(misc_routes, 'get_device_id', return_value='device'):
            payload = misc_routes.get_announcements().get_json()
        self.assertEqual(len(self.selects()), 1)
        rows = payload['announcements']
        self.assertEqual([r['id'] for r in rows], list(reversed(range(19))))
        by_id = {r['id']: r for r in rows}
        self.assertEqual((by_id[1]['is_read'], by_id[1]['never_show']), (True, True))
        self.assertEqual((by_id[2]['is_read'], by_id[2]['never_show']), (True, False))
        self.assertEqual((by_id[3]['is_read'], by_id[3]['never_show']), (False, False))

    def seed_feedback(self):
        for index in range(20):
            self.conn.execute('INSERT INTO feedbacks VALUES (?, ?, ?, ?, ?, ?)',
                              (index, 'device', 'self' if index % 2 == 0 else 'other', 'body',
                               'self' if index % 3 == 0 else 'public', f'{index:02}'))
            for reply in (2, 1):
                self.conn.execute('INSERT INTO feedback_replies VALUES (?, ?, ?, ?, ?, ?)',
                                  (index * 10 + reply, index, 'device', 'writer', 'reply', str(reply)))
        self.statements.clear()

    def test_user_feedback_uses_bounded_queries_and_preserves_privacy_and_reply_order(self):
        self.seed_feedback()
        with self.app.test_request_context('/api/feedback'):
            result = misc_routes.handle_feedback.__wrapped__({'username': 'self'}).get_json()
        self.assertLessEqual(len(self.selects()), 3)
        self.assertEqual([f['id'] for f in result['my_feedbacks']], list(range(18, -1, -2)))
        self.assertEqual([f['id'] for f in result['public_feedbacks']], [19, 17, 13, 11, 7, 5, 1])
        for row in result['my_feedbacks'] + result['public_feedbacks']:
            self.assertEqual([r['create_time'] for r in row['replies']], ['1', '2'])
            self.assertEqual(row['is_own'], row['username'] == 'self')
            self.assertNotIn('device_id', row['replies'][0])

    def test_admin_feedback_uses_two_queries_and_preserves_all_rows(self):
        self.seed_feedback()
        with self.app.test_request_context():
            result = misc_routes.admin_get_feedback.__wrapped__().get_json()
        self.assertEqual(len(self.selects()), 2)
        self.assertEqual([r['id'] for r in result['feedbacks']], list(reversed(range(20))))
        self.assertTrue(all(len(r['replies']) == 2 for r in result['feedbacks']))

    def test_wechat_seen_updates_are_throttled_but_expiry_and_revocation_are_checked(self):
        service = wechat_auth_service
        now = datetime(2026, 10, 22, 12)
        with patch.object(service, '_now', return_value=now):
            token = service.create_session('openid')
        self.statements.clear()
        for seconds in (1, 30, 299, 300, 301):
            with patch.object(service, '_now', return_value=now + timedelta(seconds=seconds)):
                self.assertEqual(service.resolve_session_token(token)['openid'], 'openid')
        writes = [s for s in self.statements if s.startswith('UPDATE wechat_sessions')]
        self.assertEqual(len(writes), 1)
        self.assertEqual(len([s for s in self.selects() if 'FROM wechat_sessions' in s]), 5)
        self.conn.execute('UPDATE wechat_sessions SET expires_at = ?', (now.isoformat(),))
        with patch.object(service, '_now', return_value=now + timedelta(seconds=302)):
            self.assertIsNone(service.resolve_session_token(token))
        self.assertIsNone(service.resolve_session_token(token))

    def test_snapshot_sorts_and_formats_outside_lock_and_returns_detached_data(self):
        tracker = online_service.OnlineUserTracker()
        tracker.touch('one', now=10)
        tracker.touch('two', now=20)
        real_sorted = builtins.sorted
        def checked_sorted(*args, **kwargs):
            self.assertFalse(tracker._lock.locked(), 'sorting must not block request tracking')
            return real_sorted(*args, **kwargs)
        with patch.object(online_service, 'sorted', checked_sorted, create=True):
            result = tracker.snapshot(now=30)
        result['users'][0]['username'] = 'changed'
        self.assertEqual(tracker.snapshot(now=30)['users'][0]['username'], '未绑定')
        self.assertEqual([r['device_id'] for r in result['users']], ['two', 'one'])


if __name__ == '__main__':
    unittest.main()
