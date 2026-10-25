"""今日活跃统计只复用已解析身份，不产生数据库或文件访问。"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import os
import unittest
from unittest.mock import patch

from flask import Flask, jsonify, request

from routes.admin_routes import admin_bp
from services.activity_service import DailyActivityTracker, init_activity_tracking


def timestamp(value):
    return datetime.fromisoformat(value).replace(tzinfo=timezone.utc).timestamp()


class DailyActivityTests(unittest.TestCase):
    def test_counts_accounts_once_without_exposing_individual_records(self):
        tracker = DailyActivityTracker()
        now = timestamp('2026-10-25T04:00:00')
        for username in ('student-a', 'student-a', 'student-b', '', None):
            tracker.record(username, now=now)
        self.assertEqual(tracker.snapshot(now=now), {
            'date': '2026-10-25', 'active_users': 2,
        })

    def test_beijing_midnight_clears_previous_day_on_reads_and_writes(self):
        before = timestamp('2026-10-25T15:59:59')
        after = timestamp('2026-10-25T16:00:00')
        for read_first in (True, False):
            with self.subTest(read_first=read_first):
                tracker = DailyActivityTracker()
                tracker.record('yesterday', now=before)
                if read_first:
                    self.assertEqual(tracker.snapshot(now=after), {
                        'date': '2026-10-26', 'active_users': 0,
                    })
                tracker.record('today', now=after)
                self.assertEqual(tracker.snapshot(now=after)['active_users'], 1)

    def test_concurrent_requests_deduplicate_accounts(self):
        tracker = DailyActivityTracker()
        with ThreadPoolExecutor(max_workers=8) as executor:
            list(executor.map(lambda i: tracker.record(f'user-{i % 100}', now=0), range(1000)))
        self.assertEqual(tracker.snapshot(now=0)['active_users'], 100)


class ActivityRequestTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.register_blueprint(admin_bp)
        self.tracker = DailyActivityTracker()
        init_activity_tracking(self.app, tracker=self.tracker)

        @self.app.get('/api/identified')
        @self.app.get('/api/admin/identified')
        def identified():
            request.environ['urp.identity_cache'] = {
                'device': ({'username': 'student'}, None),
                'another-device': ({'username': 'someone-else'}, None),
            }
            return jsonify(success=True)

        @self.app.get('/api/public')
        def public():
            return jsonify(success=True)

        self.client = self.app.test_client()

    def test_hook_never_resolves_identity_or_opens_database(self):
        with patch('services.user_service.get_db', side_effect=AssertionError('unexpected database read')), \
                patch('database.get_db', side_effect=AssertionError('unexpected database access')), \
                patch('builtins.open', side_effect=AssertionError('unexpected file access')):
            for _ in range(3):
                response = self.client.get('/api/identified', headers={'X-Device-ID': 'device'})
                self.assertTrue(response.get_json()['success'])
                self.client.get('/api/public', headers={'X-Device-ID': 'unknown'})
            self.assertEqual(self.tracker.snapshot()['active_users'], 1)

    def test_public_admin_and_unrelated_identities_do_not_inflate_count(self):
        for path, device in (('/api/public', 'device'), ('/api/admin/identified', 'device'),
                             ('/api/identified', 'missing'), ('/api/identified', 'x' * 129)):
            self.client.get(path, headers={'X-Device-ID': device})
        self.assertEqual(self.tracker.snapshot()['active_users'], 0)

    def test_activity_route_keeps_admin_auth_returns_only_totals_and_does_no_io(self):
        self.tracker.record('student')
        with patch.dict(os.environ, {'ADMIN_KEY': 'test-admin'}), \
                patch('services.activity_service.daily_activity', self.tracker), \
                patch('database.get_db', side_effect=AssertionError('unexpected database access')), \
                patch('services.user_service.get_db', side_effect=AssertionError('unexpected identity lookup')), \
                patch('builtins.open', side_effect=AssertionError('unexpected file access')):
            self.assertEqual(self.client.get('/api/admin/activity/today').status_code, 403)
            for _ in range(3):
                response = self.client.get('/api/admin/activity/today', headers={'X-Admin-Key': 'test-admin'})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.get_json()['data']['active_users'], 1)
                self.assertEqual(set(response.get_json()['data']), {'date', 'active_users'})
            self.assertEqual(self.client.get('/api/admin/monitor/online').status_code, 404)


if __name__ == '__main__':
    unittest.main()
