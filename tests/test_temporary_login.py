"""未保存账号时，临时登录可用并在到期后删除自己的数据。"""

import os
import json
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

from flask import Flask, jsonify
from cryptography.fernet import Fernet

from auth import require_binding
from database import get_db, init_db
from routes.auth_routes import auth_bp
from routes.data_routes import data_bp
from services.temporary_session_service import cleanup_expired_sessions
from services.user_service import get_user_by_device
from services.urp_service import check_login_status
from services.activity_service import DailyActivityTracker
from urp.login import URP_login


class TemporaryLoginTests(unittest.TestCase):
    def setUp(self):
        credential_key = patch.dict(os.environ, {'URP_CREDENTIAL_KEY': Fernet.generate_key().decode()})
        credential_key.start()
        self.addCleanup(credential_key.stop)
        self.directory = tempfile.TemporaryDirectory()
        self.previous_cwd = os.getcwd()
        os.chdir(self.directory.name)
        self.config = {
            'database': {
                'type': 'sqlite',
                'sqlite_path': os.path.join(self.directory.name, 'test.db'),
            },
        }
        self.config_patch = patch('database.get_config', return_value=self.config)
        self.config_patch.start()
        init_db(self.config)
        self.app = Flask(__name__)
        self.app.register_blueprint(auth_bp)
        self.app.register_blueprint(data_bp)

        @self.app.get('/protected')
        @require_binding
        def protected(user):
            from services.temporary_session_service import user_data_file
            return jsonify({
                'username': user['username'],
                'temporary': user.get('temporary', False),
                'cookie_path': user_data_file(user['username'], 'cookie.json'),
            })

        @self.app.get('/query-cookie')
        @require_binding
        def query_cookie(user):
            from urp.query import URP_query
            query = URP_query('http://urp.example/', user['username'])
            return jsonify({'cookie': query.x.cookies.get('JSESSIONID')})

        self.client = self.app.test_client()
        self.headers = {'X-Device-ID': 'temporary-device'}

    def tearDown(self):
        self.config_patch.stop()
        os.chdir(self.previous_cwd)
        self.directory.cleanup()

    def _login(self, save=False):
        with patch('routes.auth_routes.get_current_urp_url', return_value='http://urp.example/'), patch('routes.auth_routes.urp_login', return_value=(
            True, '登录成功', {'JSESSIONID': 'temporary-cookie'},
        )):
            return self.client.post('/api/login', headers=self.headers, json={
                'username': 'student',
                'password': 'secret',
                'bind_account': save,
            }).get_json()

    def test_both_login_modes_count_activity_without_a_followup_request(self):
        for save in (True, False):
            with self.subTest(save=save):
                tracker = DailyActivityTracker()
                with patch('routes.auth_routes.daily_activity', tracker):
                    self.assertTrue(self._login(save=save)['success'])
                self.assertEqual(tracker.snapshot()['active_users'], 1)

    def test_failed_login_does_not_count_activity(self):
        tracker = DailyActivityTracker()
        with patch('routes.auth_routes.daily_activity', tracker), \
                patch('routes.auth_routes.urp_login', return_value=(False, '登录失败', {})):
            result = self.client.post('/api/login', headers=self.headers, json={
                'username': 'student', 'password': 'secret', 'bind_account': False,
            }).get_json()
        self.assertFalse(result['success'])
        self.assertEqual(tracker.snapshot()['active_users'], 0)

    def test_unchecked_login_can_access_protected_route_and_uses_separate_cache(self):
        result = self._login()
        self.assertTrue(result['success'])
        self.assertTrue(result['temporary'])
        self.assertFalse(result['bound'])
        self.assertEqual(result['message'], '已登录，本次输入的密码不会保存。登录失效后请重新输入。')
        self.assertLessEqual(result['expires_at'] - time.time(), 600)
        self.assertGreater(result['expires_at'] - time.time(), 590)

        status = self.client.get('/api/check_bind', headers=self.headers).get_json()
        self.assertTrue(status['bound'])
        self.assertTrue(status['temporary'])
        self.assertEqual(status['username'], 'student')

        protected = self.client.get('/protected', headers=self.headers).get_json()
        self.assertTrue(protected['temporary'])
        self.assertIn(os.path.join('user_data', '.temporary'), protected['cookie_path'])
        self.assertTrue(os.path.isfile(protected['cookie_path']))
        self.assertEqual(self.client.get('/query-cookie', headers=self.headers).get_json()['cookie'], 'temporary-cookie')
        schedule_path = os.path.join(os.path.dirname(protected['cookie_path']), 'schedule.json')
        with open(schedule_path, 'w', encoding='utf-8') as stream:
            json.dump({'1': [{'课程名': '高等数学'}]}, stream, ensure_ascii=False)
        schedule = self.client.get('/api/schedule', headers=self.headers).get_json()
        self.assertTrue(schedule['success'])
        self.assertEqual(schedule['data']['schedule']['1'][0]['课程名'], '高等数学')
        self.assertFalse(os.path.exists(os.path.join('user_data', 'student')))
        with get_db() as conn:
            self.assertIsNone(conn.execute(
                'SELECT username FROM user_account WHERE username = ?', ('student',)
            ).fetchone())
            columns = {row['name'] for row in conn.execute('PRAGMA table_info(temporary_sessions)')}
            self.assertNotIn('password', columns)
        with self.app.test_request_context('/protected', headers=self.headers):
            self.assertIsNone(get_user_by_device('temporary-device')['password'])

    def test_cookie_failure_never_reuses_a_saved_password(self):
        self._login()
        with self.app.test_request_context('/protected', headers=self.headers):
            user = get_user_by_device('temporary-device')
            with patch('services.urp_service.get_current_urp_url', return_value='http://urp.example/'), \
                    patch('urp.login.URP_login.is_logined', return_value=False), \
                    patch('urp.login.URP_login.login') as login:
                valid, _ = check_login_status(user['username'], user['password'], {})
            self.assertFalse(valid)
            login.assert_not_called()

    def test_status_endpoint_requests_password_again_when_cookie_is_invalid(self):
        self._login()
        with patch('routes.auth_routes.get_current_urp_url', return_value='http://urp.example/'), \
                patch('urp.login.URP_login.is_logined', return_value=False), \
                patch('urp.login.URP_login.login') as login:
            result = self.client.get('/api/check_login_status', headers=self.headers).get_json()
        self.assertFalse(result['logged_in'])
        self.assertTrue(result['requires_relogin'])
        login.assert_not_called()

    def test_urp_login_without_password_never_attempts_relogin(self):
        cookie_path = os.path.join(self.directory.name, 'cookie.json')
        with open(cookie_path, 'w', encoding='utf-8') as stream:
            json.dump({'JSESSIONID': 'old-cookie'}, stream)
        helper = URP_login('http://urp.example/', 'student', None, cookie_path=cookie_path)
        helper.x.get = Mock(return_value=Mock(text='<html>登录失效</html>'))
        helper.login = Mock()
        self.assertFalse(helper.is_logined())
        helper.login.assert_not_called()

    def test_existing_temporary_password_column_is_removed_on_upgrade(self):
        with get_db() as conn:
            conn.execute('DROP TABLE temporary_sessions')
            conn.execute('''CREATE TABLE temporary_sessions (
                device_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
                username TEXT NOT NULL, password TEXT NOT NULL,
                expires_at BIGINT NOT NULL)''')
            conn.execute('''INSERT INTO temporary_sessions
                (device_id, session_id, username, password, expires_at)
                VALUES (?, ?, ?, ?, ?)''',
                ('old-device', 'a' * 32, 'student', 'old-secret', int(time.time()) + 600))
        init_db(self.config)
        with get_db() as conn:
            columns = {row['name'] for row in conn.execute('PRAGMA table_info(temporary_sessions)')}
            self.assertNotIn('password', columns)
            self.assertEqual(conn.execute(
                'SELECT username FROM temporary_sessions WHERE device_id = ?', ('old-device',)
            ).fetchone()['username'], 'student')

    def test_expiry_removes_session_files_without_touching_saved_user_data(self):
        self._login()
        protected = self.client.get('/protected', headers=self.headers).get_json()
        cookie_path = protected['cookie_path']
        os.makedirs(os.path.join('user_data', 'student'), exist_ok=True)
        saved_file = os.path.join('user_data', 'student', 'schedule.json')
        with open(saved_file, 'w', encoding='utf-8') as stream:
            stream.write('{}')
        with get_db() as conn:
            conn.execute('UPDATE temporary_sessions SET expires_at = 0')

        status = self.client.get('/api/check_bind', headers=self.headers).get_json()
        self.assertFalse(status['bound'])
        self.assertEqual(self.client.get('/protected', headers=self.headers).get_json()['success'], False)
        self.assertFalse(os.path.exists(cookie_path))
        self.assertTrue(os.path.exists(saved_file))
        with get_db() as conn:
            self.assertIsNone(conn.execute(
                'SELECT device_id FROM temporary_sessions WHERE device_id = ?',
                ('temporary-device',),
            ).fetchone())

    def test_background_cleanup_removes_expired_session_without_a_request(self):
        self._login()
        cookie_path = self.client.get('/protected', headers=self.headers).get_json()['cookie_path']
        with get_db() as conn:
            conn.execute('UPDATE temporary_sessions SET expires_at = 0')
        self.assertEqual(cleanup_expired_sessions(), 1)
        self.assertFalse(os.path.exists(cookie_path))

    def test_temporary_urp_login_does_not_write_permanent_cookie(self):
        helper = URP_login('http://urp.example/', 'student', 'secret', persist_cookies=False)
        helper.x.cookies.set('JSESSIONID', 'temporary-cookie')
        helper._save_cookies()
        self.assertFalse(os.path.exists(os.path.join('user_data', 'student', 'cookie.json')))

    def test_temporary_login_requires_explicit_device_id(self):
        with patch('routes.auth_routes.urp_login') as login:
            response = self.client.post('/api/login', json={
                'username': 'student', 'password': 'secret', 'bind_account': False,
            })
        self.assertEqual(response.status_code, 400)
        login.assert_not_called()

    def test_saved_login_replaces_temporary_session(self):
        self._login()
        cookie_path = self.client.get('/protected', headers=self.headers).get_json()['cookie_path']
        result = self._login(save=True)
        self.assertTrue(result['bound'])
        self.assertFalse(result.get('temporary', False))
        self.assertFalse(os.path.exists(cookie_path))
        self.assertFalse(self.client.get('/api/check_bind', headers=self.headers).get_json().get('temporary', False))

    def test_unsaved_login_on_previously_bound_device_expires_to_guest(self):
        self._login(save=True)
        self._login()
        with get_db() as conn:
            conn.execute('UPDATE temporary_sessions SET expires_at = 0')

        status = self.client.get('/api/check_bind', headers=self.headers).get_json()
        self.assertFalse(status['bound'])


if __name__ == '__main__':
    unittest.main()
