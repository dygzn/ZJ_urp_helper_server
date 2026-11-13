"""每日考试更新使用本地成功日期，兼容临时登录且失败不影响已有缓存。"""
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from unittest.mock import patch
from flask import Flask, g
from services import urp_service as service
from services.personal_schedule_service import CHINA


class DailyExamUpdateTests(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        previous = os.getcwd()
        os.chdir(directory)
        self.addCleanup(os.chdir, previous)
        self.enterContext(Flask(__name__).test_request_context('/api/check_bind'))
        self.clock = self.enterContext(patch.object(service, 'datetime', wraps=datetime))
        self.clock.now.return_value = datetime(2026, 11, 13, 8, tzinfo=CHINA)
        self.enterContext(patch.object(service, 'get_current_urp_url', return_value='http://urp.test/'))
        self.enterContext(patch.object(service, 'get_config', return_value={}))
        self.login = self.enterContext(patch.object(service, 'check_login_status', return_value=(True, {})))
        self.query = self.enterContext(patch('urp.URP_query')).return_value
        self.user = {'username': 'student', 'password': 'secret'}

    def test_once_a_day_and_again_after_china_midnight(self):
        service.update_daily_exams(self.user)
        service.update_daily_exams(self.user)
        self.assertEqual(self.query.exam_cx.call_count, 1)
        self.query.schedule_cx.assert_not_called()
        self.clock.now.return_value = datetime(2026, 11, 14, 0, tzinfo=CHINA)
        service.update_daily_exams(self.user)
        self.assertEqual(self.query.exam_cx.call_count, 2)

    def test_failure_keeps_cache_and_allows_retry_after_cooldown(self):
        cache = Path('user_data/student/exams.json')
        cache.parent.mkdir(parents=True)
        cache.write_text('{"1": []}')
        self.query.exam_cx.side_effect = RuntimeError('offline')
        service.update_daily_exams(self.user)
        service.update_daily_exams(self.user)
        self.assertEqual(self.query.exam_cx.call_count, 1)
        self.assertEqual(cache.read_text(), '{"1": []}')
        self.clock.now.return_value = datetime(2026, 11, 13, 8, 2, tzinfo=CHINA)
        self.query.exam_cx.side_effect = None
        service.update_daily_exams(self.user)
        self.assertEqual(self.query.exam_cx.call_count, 2)

    def test_temporary_session_uses_isolated_directory_and_no_stored_password(self):
        g.temporary_session = {'username': 'student', 'session_id': 'a'*32}
        service.update_daily_exams({**self.user, 'password': None, 'temporary': True})
        service.update_daily_exams({**self.user, 'password': None, 'temporary': True})
        self.query.exam_cx.assert_called_once()
        self.assertTrue(Path('user_data/.temporary/'+'a'*32+'/daily_exams.json').exists())
        self.assertFalse(Path('user_data/student/daily_exams.json').exists())
        self.assertIsNone(self.login.call_args.args[1])

    def test_parallel_logins_share_one_update(self):
        with ThreadPoolExecutor(max_workers=4) as executor:
            list(executor.map(service.update_daily_exams, [self.user] * 8))
        self.query.exam_cx.assert_called_once()

    def test_semester_change_can_update_again_on_the_same_day(self):
        service.update_daily_exams(self.user)
        with patch.object(service, 'get_config', return_value={'semester_start': '2027-03-01'}):
            service.update_daily_exams(self.user)
        self.assertEqual(self.query.exam_cx.call_count, 2)

    def test_failed_login_does_not_query_exams(self):
        self.login.return_value = (False, {})
        service.update_daily_exams(self.user)
        self.query.exam_cx.assert_not_called()


class DailyExamLoginRouteTests(unittest.TestCase):
    def setUp(self):
        from routes import auth_routes
        self.routes = auth_routes
        app = Flask(__name__)
        app.register_blueprint(auth_routes.auth_bp)
        self.client = app.test_client()
        self.user = {'username': 'student', 'password': 'secret'}
        self.identity = self.enterContext(patch.object(auth_routes, 'get_user_by_device', return_value=self.user))
        self.update = self.enterContext(patch.object(auth_routes, 'update_daily_exams'))
        self.enterContext(patch.object(auth_routes, 'get_device_id', return_value='device'))
        self.enterContext(patch.object(auth_routes, 'record_daily_activity'))

    def test_restoring_login_updates_before_returning_identity(self):
        response = self.client.get('/api/check_bind').get_json()
        self.assertTrue(response['bound'])
        self.update.assert_called_once_with(self.user)

    def test_guest_does_not_update(self):
        self.identity.return_value = None
        self.assertFalse(self.client.get('/api/check_bind').get_json()['bound'])
        self.update.assert_not_called()

    def test_new_bound_login_updates_exams(self):
        with patch.object(self.routes, 'CredentialCipher'), \
                patch.object(self.routes, 'begin_login_attempt', create=True) as attempt, \
                patch.object(self.routes, 'urp_login', return_value=(True, '', {})), \
                patch.object(self.routes, 'bind_user'), \
                patch.object(self.routes, 'delete_temporary_session'):
            attempt.return_value.retry_after = 0
            response = self.client.post('/api/login', json=self.user).get_json()
        self.assertTrue(response['success'])
        self.update.assert_called_once_with(self.user)

    def test_new_temporary_login_resolves_isolated_identity_before_update(self):
        self.identity.return_value = {**self.user, 'password': None, 'temporary': True, 'expires_at': 123}
        with patch.object(self.routes, 'begin_login_attempt', create=True) as attempt, \
                patch.object(self.routes, 'urp_login', return_value=(True, '', {})), \
                patch.object(self.routes, 'save_temporary_session', return_value=123), \
                patch.object(self.routes, 'get_current_urp_url', return_value='http://urp.test/'):
            attempt.return_value.retry_after = 0
            response = self.client.post('/api/login', json={**self.user, 'bind_account': False}).get_json()
        self.assertTrue(response['temporary'])
        self.update.assert_called_once_with(self.identity.return_value)


if __name__ == '__main__':
    unittest.main()
