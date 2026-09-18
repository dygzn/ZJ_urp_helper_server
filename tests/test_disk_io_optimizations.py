import threading
import time
import unittest
from unittest.mock import patch
from datetime import datetime

from flask import Flask

from services.online_service import OnlineUserTracker
import services.logging_service as logging_service
import services.urp_service as urp_service
import urp.login as login_module


class OnlineUserTrackerTests(unittest.TestCase):
    def test_snapshot_deduplicates_users_and_expires_stale_devices(self):
        tracker = OnlineUserTracker(ttl_seconds=300)

        tracker.touch('device-1', 'student-1', '课表查询', now=1000)
        tracker.touch('device-1', 'student-1', '成绩查询', now=1100)
        tracker.touch('device-2', 'student-2', '考试安排', now=1200)

        snapshot = tracker.snapshot(now=1300)

        self.assertEqual(snapshot['online_count'], 2)
        self.assertEqual(
            snapshot['users'],
            [
                {
                    'device_id': 'device-2',
                    'username': 'student-2',
                    'last_active': datetime.fromtimestamp(1200).strftime('%Y-%m-%d %H:%M:%S'),
                    'last_endpoint': '考试安排',
                },
                {
                    'device_id': 'device-1',
                    'username': 'student-1',
                    'last_active': datetime.fromtimestamp(1100).strftime('%Y-%m-%d %H:%M:%S'),
                    'last_endpoint': '成绩查询',
                },
            ],
        )

        expired_snapshot = tracker.snapshot(now=1501)

        self.assertEqual(expired_snapshot['online_count'], 0)
        self.assertEqual(expired_snapshot['users'], [])


class LoggingHookTests(unittest.TestCase):
    def test_api_request_updates_memory_presence_without_request_log_database(self):
        tracker = OnlineUserTracker(ttl_seconds=300)
        app = Flask(__name__)

        @app.get('/api/ping')
        def ping():
            return {'success': True}

        logging_service.init_logging(
            app,
            tracker=tracker,
            user_lookup=lambda device_id: {
                'username': 'student-1',
            },
        )

        with patch.object(
            logging_service,
            'get_db',
            side_effect=AssertionError('在线统计不应访问请求日志数据库'),
            create=True,
        ) as get_db:
            response = app.test_client().get(
                '/api/ping',
                headers={'X-Device-ID': 'device-1'},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(get_db.call_count, 0)
        self.assertEqual(tracker.snapshot()['online_count'], 1)
        self.assertEqual(tracker.snapshot()['users'][0]['username'], 'student-1')


class AutoUpdateSchedulingTests(unittest.TestCase):
    def test_duplicate_requests_do_not_start_two_workers_for_one_user(self):
        username = 'student-scheduler-test'
        worker_started = threading.Event()
        release_worker = threading.Event()
        worker_finished = threading.Event()

        def blocking_update(current_username, password):
            self.assertEqual(current_username, username)
            self.assertEqual(password, 'password')
            worker_started.set()
            release_worker.wait(timeout=2)
            worker_finished.set()
            return True, '自动更新成功'

        with patch.object(
            urp_service,
            'check_and_auto_update',
            side_effect=blocking_update,
        ):
            self.assertTrue(urp_service.start_auto_update(username, 'password'))
            self.assertTrue(worker_started.wait(timeout=1))
            self.assertFalse(urp_service.start_auto_update(username, 'password'))

            release_worker.set()
            self.assertTrue(worker_finished.wait(timeout=1))

        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            if not urp_service.is_auto_update_running(username):
                break
            time.sleep(0.01)
        self.assertFalse(urp_service.is_auto_update_running(username))


class AutoUpdateDatabaseLifetimeTests(unittest.TestCase):
    def test_remote_update_runs_after_initial_database_connection_is_closed(self):
        connection_states = []
        remote_connection_states = []

        class FakeCursor:
            def fetchone(self):
                return (None,)

        class FakeConnection:
            def execute(self, sql, params=()):
                connection_states.append(('execute', sql, self.active))
                if sql.startswith('SELECT'):
                    return FakeCursor()
                return FakeCursor()

        class FakeDatabaseContext:
            def __init__(self):
                self.connection = FakeConnection()

            def __enter__(self):
                self.connection.active = True
                return self.connection

            def __exit__(self, exc_type, exc_value, traceback):
                self.connection.active = False
                return False

        contexts = []

        def fake_get_db():
            context = FakeDatabaseContext()
            contexts.append(context)
            return context

        class FakeLogin:
            def __init__(self, url, username, password):
                remote_connection_states.append(contexts[-1].connection.active)

            def is_logined(self):
                remote_connection_states.append(contexts[-1].connection.active)
                return True

        class FakeQuery:
            def __init__(self, url, username):
                remote_connection_states.append(contexts[-1].connection.active)

            def schedule_cx(self):
                remote_connection_states.append(contexts[-1].connection.active)

            def exam_cx(self):
                remote_connection_states.append(contexts[-1].connection.active)

        with (
            patch.object(urp_service, 'get_db', side_effect=fake_get_db),
            patch('urp.URP_login', FakeLogin),
            patch('urp.URP_query', FakeQuery),
            patch.object(urp_service, 'get_current_urp_url', return_value='http://urp.test/'),
        ):
            result = urp_service.check_and_auto_update(
                'student-db-lifetime-test',
                'password',
            )

        self.assertEqual(result, (True, '自动更新成功'))
        self.assertEqual(len(contexts), 2)
        self.assertFalse(contexts[0].connection.active)
        self.assertFalse(contexts[1].connection.active)
        self.assertTrue(remote_connection_states)
        self.assertTrue(all(active is False for active in remote_connection_states))


class LoginDebugFileTests(unittest.TestCase):
    def test_disabled_debug_capture_skips_file_writes(self):
        with (
            patch.object(login_module, 'SAVE_DEBUG_FILES', False, create=True),
            patch.object(login_module.Path, 'write_text') as write_text,
            patch.object(login_module.Path, 'write_bytes') as write_bytes,
        ):
            result = login_module._save_debug_file('debug.html', 'response')

        self.assertFalse(result)
        write_text.assert_not_called()
        write_bytes.assert_not_called()

    def test_enabled_debug_capture_is_throttled_per_file(self):
        with (
            patch.object(login_module, 'SAVE_DEBUG_FILES', True, create=True),
            patch.object(login_module, 'DEBUG_FILE_THROTTLE_SECONDS', 60, create=True),
            patch.object(login_module, '_debug_file_times', {}, create=True),
            patch.object(login_module.time, 'monotonic', side_effect=[100, 110, 161]),
            patch.object(login_module.Path, 'write_text') as write_text,
        ):
            first = login_module._save_debug_file('debug.html', 'first')
            skipped = login_module._save_debug_file('debug.html', 'second')
            third = login_module._save_debug_file('debug.html', 'third')

        self.assertTrue(first)
        self.assertFalse(skipped)
        self.assertTrue(third)
        self.assertEqual(write_text.call_count, 2)


if __name__ == '__main__':
    unittest.main()
