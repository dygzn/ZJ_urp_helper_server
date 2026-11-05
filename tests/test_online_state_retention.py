"""今日活跃统计不查业务库，同机进程共享去重并在北京时间换日。"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import os
from pathlib import Path
import json
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from flask import Flask, jsonify, request

from routes.admin_routes import admin_bp
from services.activity_service import DailyActivityTracker, init_activity_tracking
from services import activity_service


def timestamp(value):
    return datetime.fromisoformat(value).replace(tzinfo=timezone.utc).timestamp()


class DailyActivityTests(unittest.TestCase):
    def test_counts_accounts_once_without_exposing_individual_records(self):
        tracker = DailyActivityTracker()
        now = timestamp('2026-10-25T04:00:00')
        for username in ('student-a', 'student-a', 'student-b', '', None):
            tracker.record(username, now=now)
        self.assertEqual(tracker.snapshot(now=now), {
            'date': '2026-10-25', 'active_users': 2, 'sources': {'web': 0, 'miniprogram': 0, 'app': 0, 'unknown': 2},
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
                        'date': '2026-10-26', 'active_users': 0, 'sources': {'web': 0, 'miniprogram': 0, 'app': 0, 'unknown': 0},
                    })
                tracker.record('today', now=after)
                self.assertEqual(tracker.snapshot(now=after)['active_users'], 1)

    def test_concurrent_requests_deduplicate_accounts(self):
        tracker = DailyActivityTracker()
        with ThreadPoolExecutor(max_workers=8) as executor:
            list(executor.map(lambda i: tracker.record(f'user-{i % 100}', now=0), range(1000)))
        self.assertEqual(tracker.snapshot(now=0)['active_users'], 100)


@unittest.skipUnless(os.name == 'posix', 'Gunicorn 进程共享使用 Unix 文件锁')
class SharedActivityTests(unittest.TestCase):
    def setUp(self):
        self.directory = self.enterContext(tempfile.TemporaryDirectory())
        self.path = Path(self.directory) / 'today.bin'
        self.now = timestamp('2026-10-25T04:00:00')

    def tracker(self):
        return activity_service.SharedDailyActivityTracker(self.path)

    def test_alternating_workers_always_return_the_same_total(self):
        workers = [self.tracker(), self.tracker()]
        for index in range(10):
            workers[0].record(f'user-{index}', now=self.now)
        for index in range(6):
            workers[1].record(f'user-{index}', now=self.now)
        self.assertEqual([workers[i].snapshot(now=self.now)['active_users']
                          for i in (0, 1, 0, 1)], [10, 10, 10, 10])
        self.assertEqual(self.tracker().snapshot(now=self.now)['active_users'], 10)

    def test_independent_processes_share_deduplication_and_survive_worker_exit(self):
        script = '''
import json, sys
from services.activity_service import SharedDailyActivityTracker
tracker = SharedDailyActivityTracker(sys.argv[1])
for username in json.loads(sys.argv[2]):
    tracker.record(username, now=float(sys.argv[3]))
print(json.dumps(tracker.snapshot(now=float(sys.argv[3]))))
'''
        processes = []
        for worker in range(4):
            names = ['shared'] + [f'worker-{worker}-{index}' for index in range(100)]
            processes.append(subprocess.Popen(
                [sys.executable, '-c', script, str(self.path), json.dumps(names), str(self.now)],
                cwd=str(Path(__file__).resolve().parents[1]), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True,
            ))
        results = [(process, *process.communicate(timeout=20)) for process in processes]
        for process, output, error in results:
            self.assertEqual(process.returncode, 0, error)
            self.assertGreaterEqual(json.loads(output)['active_users'], 101)
        self.assertEqual(self.tracker().snapshot(now=self.now)['active_users'], 401)

    def test_preloaded_tracker_remains_shared_after_fork(self):
        tracker = self.tracker()
        tracker.record('parent', now=self.now)
        child = os.fork()
        if child == 0:
            try:
                tracker.record('child', now=self.now)
            except BaseException:
                os._exit(1)
            os._exit(0)
        _, status = os.waitpid(child, 0)
        self.assertEqual(status, 0)
        tracker.record('child', now=self.now)
        self.assertEqual(tracker.snapshot(now=self.now)['active_users'], 2)

    def test_midnight_clears_shared_state_once_and_late_old_requests_cannot_reset_it(self):
        before = timestamp('2026-10-25T15:59:59')
        after = timestamp('2026-10-25T16:00:00')
        one, two = self.tracker(), self.tracker()
        one.record('one', now=before)
        two.record('two', now=before)
        size = self.path.stat().st_size
        one.record('one', now=after)
        self.assertEqual(two.snapshot(now=after), {'date': '2026-10-26', 'active_users': 1, 'sources': {'web': 0, 'miniprogram': 0, 'app': 0, 'unknown': 1}})
        two.record('two', now=after)
        one.record('late-yesterday', now=before)
        self.assertEqual(one.snapshot(now=after)['active_users'], 2)
        self.assertEqual(self.path.stat().st_size, size)
        self.assertEqual(len(list(Path(self.directory).iterdir())), 1)

    def test_repeat_visits_skip_shared_io_and_new_workers_do_not_rewrite_duplicates(self):
        one = self.tracker()
        one.record('student', now=self.now)
        with patch('services.activity_service.os.open', side_effect=AssertionError('repeat visit opened shared state')):
            for _ in range(100):
                one.record('student', now=self.now)
        with patch('services.activity_service.os.pwrite', side_effect=AssertionError('duplicate rewrote shared state')):
            self.tracker().record('student', now=self.now)
        self.assertEqual(one.snapshot(now=self.now)['active_users'], 1)

    def test_shared_state_contains_no_plaintext_accounts_and_reading_does_not_write(self):
        tracker = self.tracker()
        tracker.record('synthetic-private-student', now=self.now)
        self.assertNotIn(b'synthetic-private-student', self.path.read_bytes())
        with patch('services.activity_service.os.pwrite', side_effect=AssertionError('refresh wrote state')):
            for _ in range(5):
                self.assertEqual(self.tracker().snapshot(now=self.now)['active_users'], 1)

    def test_threads_do_not_double_count_when_adding_the_same_accounts(self):
        tracker = self.tracker()
        with ThreadPoolExecutor(max_workers=8) as executor:
            list(executor.map(lambda i: tracker.record(f'user-{i % 100}', now=self.now), range(1000)))
        self.assertEqual(self.tracker().snapshot(now=self.now)['active_users'], 100)

    def test_partial_append_after_worker_crash_preserves_completed_records(self):
        tracker = self.tracker()
        tracker.record('completed', now=self.now)
        with self.path.open('ab') as stream:
            stream.write(b'partial')
        self.assertEqual(self.tracker().snapshot(now=self.now)['active_users'], 1)
        tracker.record('next', now=self.now)
        self.assertEqual(self.tracker().snapshot(now=self.now)['active_users'], 2)


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
                self.assertIn('no-store', response.headers.get('Cache-Control', ''))
                self.assertEqual(response.get_json()['data']['active_users'], 1)
                self.assertEqual(set(response.get_json()['data']), {'date', 'active_users', 'sources'})
            self.assertEqual(self.client.get('/api/admin/monitor/online').status_code, 404)

    @unittest.skipUnless(os.name == 'posix', '共享状态使用 Unix 文件锁')
    def test_unavailable_shared_state_is_reported_instead_of_a_misleading_zero(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict(os.environ, {'ADMIN_KEY': 'test-admin'}), \
                patch('services.activity_service.daily_activity', activity_service.SharedDailyActivityTracker(directory)):
            response = self.client.get('/api/admin/activity/today', headers={'X-Admin-Key': 'test-admin'})
        self.assertEqual(response.status_code, 503)
        self.assertFalse(response.get_json()['success'])
        self.assertNotIn('data', response.get_json())
        self.assertIn('no-store', response.headers['Cache-Control'])

    def test_unavailable_statistics_cannot_break_user_requests_or_flood_logs(self):
        with patch.object(self.tracker, 'record', side_effect=OSError('fixture unavailable state')), \
                patch('services.activity_service._last_error_at', None), \
                self.assertLogs('services.activity_service', level='WARNING') as logs:
            for _ in range(10):
                response = self.client.get('/api/identified', headers={'X-Device-ID': 'device'})
                self.assertEqual(response.get_json(), {'success': True})
        self.assertEqual(len(logs.records), 1)

    def test_admin_can_authenticate_without_accessing_statistics_or_the_database(self):
        with patch.dict(os.environ, {'ADMIN_KEY': 'test-admin'}), \
                patch('routes.admin_routes.get_today_activity', side_effect=AssertionError('authentication read statistics')), \
                patch('database.get_db', side_effect=AssertionError('authentication read database')), \
                patch('builtins.open', side_effect=AssertionError('authentication opened a file')):
            self.assertEqual(self.client.get('/api/admin/auth').status_code, 403)
            response = self.client.get('/api/admin/auth', headers={'X-Admin-Key': 'test-admin'})
        self.assertEqual(response.get_json(), {'success': True})
        self.assertIn('no-store', response.headers['Cache-Control'])
import tempfile
import unittest
from pathlib import Path
from flask import Flask, jsonify, request
from services.activity_service import DailyActivityTracker, SharedDailyActivityTracker, init_activity_tracking


class ActivitySourcesTests(unittest.TestCase):
    def test_cross_platform_deduplication_and_shared_workers(self):
        with tempfile.TemporaryDirectory() as directory:
            for trackers in ([DailyActivityTracker()], [SharedDailyActivityTracker(Path(directory) / 'state'), SharedDailyActivityTracker(Path(directory) / 'state')]):
                trackers[0].record('one', source='web')
                trackers[-1].record('one', source='app')
                trackers[-1].record('two', source='miniprogram')
                trackers[0].record('two', source='miniprogram')
                result = trackers[0].snapshot()
                self.assertEqual(result['active_users'], 2)
                self.assertEqual(result['sources'], {'web': 1, 'app': 1, 'miniprogram': 1, 'unknown': 0})

    def test_request_sources_and_wechat_identity(self):
        app = Flask(__name__)
        tracker = DailyActivityTracker()
        init_activity_tracking(app, tracker)
        @app.get('/api/example')
        def example():
            request.environ['urp.identity_cache'] = {'device': ({'username': 'one'}, None)}
            return jsonify(success=True)
        @app.get('/api/wechat/example')
        def mini():
            request.environ['urp.wechat_username'] = 'one'
            return jsonify(success=True)
        client = app.test_client()
        client.get('/api/example', headers={'X-Device-ID': 'device', 'User-Agent': 'Mozilla/5.0'})
        client.get('/api/example', headers={'X-Device-ID': 'device', 'User-Agent': 'Dalvik/2.1.0'})
        client.get('/api/wechat/example')
        self.assertEqual(tracker.snapshot()['sources'], {'web': 1, 'app': 1, 'miniprogram': 1, 'unknown': 0})

class ActivityMigrationTests(unittest.TestCase):
    @unittest.skipUnless(os.name == 'posix', '共享状态使用 Unix 文件锁')
    def test_existing_daily_accounts_survive_upgrade_and_deduplicate(self):
        import hashlib
        import struct
        from datetime import date
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state'
            path.write_bytes(struct.pack('!8sI', b'URPACT01', date(2026, 10, 25).toordinal()) + hashlib.sha256(b'one').digest())
            tracker = activity_service.SharedDailyActivityTracker(path)
            now = timestamp('2026-10-25T04:00:00')
            tracker.record('one', now=now, source='web')
            self.assertEqual(tracker.snapshot(now=now)['active_users'], 1)
            self.assertEqual(tracker.snapshot(now=now)['sources']['unknown'], 1)
            self.assertEqual(tracker.snapshot(now=now)['sources']['web'], 1)


if __name__ == '__main__':
    unittest.main()
