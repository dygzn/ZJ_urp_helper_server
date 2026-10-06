"""安全边界离线回归；数据库与启动测试均使用临时目录。"""
import hashlib
import hmac
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from flask import Flask, jsonify

import auth
from database import get_db, init_db
from routes.auth_routes import auth_bp
from routes.member_routes import member_bp
from routes.misc_routes import misc_bp
from routes.wechat_routes import wechat_bp
from services.user_service import bind_user, get_device_id, get_user_by_device

ROOT = Path(__file__).resolve().parents[1]
SAFE_ENV = {
    'FLASK_DEBUG': '0',
    'SECRET_KEY': 'test-session-key-with-sufficient-entropy',
    'ADMIN_KEY': 'test-admin-key-with-sufficient-entropy',
    'MERCHANT_NUM': 'test-merchant-123',
    'PAY_SECRET_KEY': 'test-payment-key-with-sufficient-entropy',
    'URP_CREDENTIAL_KEY': 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
}


def start_app(overrides=None, as_main=True):
    env = dict(os.environ, **SAFE_ENV)
    for key, value in (overrides or {}).items():
        if value is None:
            env.pop(key, None)
        else:
            env[key] = value
    script = '''
import contextlib, io, json, runpy
from unittest.mock import patch
from flask import Flask
output = io.StringIO()
result = {}
try:
    with contextlib.redirect_stdout(output), patch('database.init_db') as db, \
         patch('database.ensure_api_keys_table'), patch.object(Flask, 'run') as run:
        ns = runpy.run_path(APP_PATH, run_name=RUN_NAME)
        result = {'debug': ns['app'].debug, 'secret': ns['app'].secret_key,
                  'run': run.call_args.kwargs if run.called else None,
                  'db_called': db.called}
except Exception as exc:
    result = {'error': type(exc).__name__, 'message': str(exc), 'db_called': db.called}
result['stdout'] = output.getvalue()
print(json.dumps(result))
'''
    script = 'APP_PATH = ' + repr(str(ROOT / 'app.py')) + '\nRUN_NAME = ' + repr('__main__' if as_main else 'wsgi_test') + '\n' + script
    env['PYTHONPATH'] = str(ROOT)
    with tempfile.TemporaryDirectory() as directory:
        result = subprocess.run([sys.executable, '-c', script], cwd=directory,
                                env=env, capture_output=True, text=True, check=True)
    return json.loads(result.stdout), result.stderr


class StartupSecurityTests(unittest.TestCase):
    def test_production_uses_env_secrets_and_host(self):
        result, _ = start_app({'HOST': '10.0.0.1', 'PORT': '5051'})
        self.assertEqual(result['secret'], SAFE_ENV['SECRET_KEY'])
        self.assertFalse(result['debug'])
        self.assertEqual(result['run'], {'debug': False, 'host': '10.0.0.1', 'port': 5051, 'use_reloader': False})
        self.assertNotIn(SAFE_ENV['ADMIN_KEY'], result['stdout'])
        self.assertNotIn('管理员密钥:', result['stdout'])

    def test_debug_truthy_values_always_bind_loopback(self):
        for value in ('1', 'TRUE', 'yes', 'On'):
            with self.subTest(value=value):
                result, _ = start_app({'FLASK_DEBUG': value, 'HOST': '0.0.0.0'})
                self.assertTrue(result['debug'])
                self.assertEqual(result['run']['host'], '127.0.0.1')
                self.assertTrue(result['run']['debug'])
                self.assertTrue(result['run']['use_reloader'])

    def test_unset_or_false_debug_defaults_to_production(self):
        for value in (None, '', 'false', '0', 'off'):
            with self.subTest(value=value):
                result, _ = start_app({'FLASK_DEBUG': value, 'HOST': None})
                self.assertFalse(result['debug'])
                self.assertEqual(result['run']['host'], '0.0.0.0')

    def test_each_missing_or_blank_core_setting_blocks_wsgi_before_db(self):
        for key in ('SECRET_KEY', 'ADMIN_KEY', 'MERCHANT_NUM', 'PAY_SECRET_KEY'):
            for value in (None, '', '   '):
                with self.subTest(key=key, value=value):
                    result, logs = start_app({key: value}, as_main=False)
                    self.assertEqual(result.get('error'), 'RuntimeError')
                    self.assertIn(key, result['message'])
                    self.assertFalse(result['db_called'])
                    for secret in SAFE_ENV.values():
                        if len(secret) > 10:
                            self.assertNotIn(secret, logs + result['message'])

    def test_example_core_values_block_production(self):
        values = {'SECRET_KEY': 'your-secret-key-change-this', 'ADMIN_KEY': 'your-admin-key',
                  'MERCHANT_NUM': 'your-merchant-num', 'PAY_SECRET_KEY': 'your-pay-secret-key'}
        for key, value in values.items():
            with self.subTest(key=key):
                result, _ = start_app({key: value})
                self.assertEqual(result.get('error'), 'RuntimeError')
                self.assertIn(key, result['message'])

    def test_development_has_random_session_fallback(self):
        env = {key: None for key in SAFE_ENV}
        env['FLASK_DEBUG'] = '1'
        first, logs = start_app(env)
        second, _ = start_app(env)
        self.assertTrue(first['debug'])
        self.assertGreaterEqual(len(first['secret']), 32)
        self.assertNotEqual(first['secret'], second['secret'])
        self.assertIn('ADMIN_KEY', logs)
        self.assertNotIn(first['secret'], first['stdout'] + logs)


class RequestSecurityTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        config = {'database': {'type': 'sqlite', 'sqlite_path': str(Path(self.directory.name) / 'test.db')}}
        self.config_patch = patch('database.get_config', return_value=config)
        self.config_patch.start()
        self.addCleanup(self.config_patch.stop)
        init_db(config)
        self.env_patch = patch.dict(os.environ, {
            'ADMIN_KEY': SAFE_ENV['ADMIN_KEY'],
            'URP_CREDENTIAL_KEY': SAFE_ENV['URP_CREDENTIAL_KEY'],
        })
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)
        self.app = Flask(__name__)
        for bp in (auth_bp, member_bp, misc_bp, wechat_bp):
            self.app.register_blueprint(bp)

        @self.app.get('/admin-protected')
        @auth.require_admin
        def admin_protected():
            return jsonify(success=True)

        @self.app.get('/device-protected')
        @auth.require_binding
        def device_protected(user):
            return jsonify(success=True, username=user['username'])

        self.client = self.app.test_client()

    def test_admin_accepts_only_canonical_header(self):
        key = SAFE_ENV['ADMIN_KEY']
        self.assertEqual(self.client.get('/admin-protected', headers={'X-Admin-Key': key}).status_code, 200)
        for headers, url in (({}, '/admin-protected'), ({}, '/admin-protected?admin_key=' + key),
                             ({'Admin-Key': key}, '/admin-protected'), ({'X-Admin-Key': 'wrong'}, '/admin-protected')):
            with self.subTest(headers=headers, url=url):
                self.assertEqual(self.client.get(url, headers=headers).status_code, 403)

    def test_empty_admin_configuration_cannot_authenticate(self):
        with patch.dict(os.environ, {'ADMIN_KEY': ''}):
            self.assertEqual(self.client.get('/admin-protected', headers={'X-Admin-Key': ''}).status_code, 403)

    def test_admin_uses_constant_time_comparison(self):
        with patch('hmac.compare_digest', wraps=hmac.compare_digest) as compare:
            response = self.client.get('/admin-protected', headers={'X-Admin-Key': SAFE_ENV['ADMIN_KEY']})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(compare.called)

    def test_non_ascii_admin_key_is_rejected_without_server_error(self):
        self.assertEqual(self.client.get('/admin-protected', headers={'X-Admin-Key': '错误密钥'}).status_code, 403)

    def test_same_nat_without_device_never_recovers_legacy_binding(self):
        agent = 'same-phone-model'
        legacy = hashlib.md5((agent + '_127.0.0.1').encode()).hexdigest()
        bind_user(legacy, 'legacy-student', 'password')
        for headers in ({'User-Agent': agent}, {'User-Agent': agent, 'Authorization': 'Bearer invalid'}):
            with self.subTest(headers=headers):
                self.assertFalse(self.client.get('/api/check_bind', headers=headers).get_json()['bound'])
                self.assertFalse(self.client.get('/device-protected', headers=headers).get_json()['success'])
                with self.app.test_request_context('/', headers=headers):
                    self.assertIsNone(get_device_id())

    def test_valid_explicit_device_keeps_existing_binding(self):
        bind_user('existing-device', 'student', 'password')
        result = self.client.get('/device-protected', headers={'X-Device-ID': ' existing-device '}).get_json()
        self.assertTrue(result['success'])
        self.assertEqual(result['username'], 'student')

    def test_missing_device_skips_database_lookup(self):
        with self.app.test_request_context('/'), patch('services.user_service.get_db') as db:
            self.assertIsNone(get_user_by_device(None))
        db.assert_not_called()

    def test_saved_and_temporary_login_reject_missing_or_invalid_device(self):
        for bind in (True, False):
            for device in (None, '   ', 'x' * 129):
                headers = {} if device is None else {'X-Device-ID': device}
                with self.subTest(bind=bind, device=device), patch('routes.auth_routes.urp_login', return_value=(False, 'test failure', None)) as login:
                    response = self.client.post('/api/login', headers=headers,
                                                json={'username': 'student', 'password': 'password', 'bind_account': bind})
                    self.assertEqual(response.status_code, 400)
                    login.assert_not_called()

    def test_login_rejects_unsafe_usernames_before_urp_or_storage(self):
        invalid = ('../outside', 'student/child', r'student\child', 'student..id',
                   '.', '..', '%2e%2e%2foutside', 'student id', 'student\nid',
                   '学生', 'student\x00', 'a' * 65, '   ', 123, True,
                   ['student'], {'username': 'student'})
        for bind in (True, False):
            for username in invalid:
                with self.subTest(bind=bind, username=username), patch(
                    'routes.auth_routes.urp_login',
                    side_effect=AssertionError('非法学号不应触发教务登录'),
                ):
                    response = self.client.post('/api/login', headers={'X-Device-ID': 'safe-device'},
                                                json={'username': username, 'password': 'password',
                                                      'bind_account': bind})
                    self.assertEqual(response.status_code, 400)
                    self.assertEqual(response.get_json(), {'success': False, 'message': '请输入有效学号'})
        with get_db() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) AS n FROM users').fetchone()['n'], 0)
            self.assertEqual(conn.execute('SELECT COUNT(*) AS n FROM temporary_sessions').fetchone()['n'], 0)

    def test_login_accepts_whitelist_boundaries_and_normalizes_like_wechat(self):
        for index, username in enumerate(('A', '20260001', 'student_01-A', 'a' * 64, ' student-02 ')):
            device_id = f'valid-device-{index}'
            with self.subTest(username=username), patch(
                'routes.auth_routes.urp_login', return_value=(True, '登录成功', {}),
            ):
                response = self.client.post('/api/login', headers={'X-Device-ID': device_id},
                                            json={'username': username, 'password': 'password'})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json(), {'success': True, 'bound': True,
                                                  'message': '登录成功', 'username': username.strip()})
            with get_db() as conn:
                row = conn.execute('SELECT username FROM users WHERE device_id = ?', (device_id,)).fetchone()
            self.assertEqual(row['username'], username.strip())

    def test_anonymous_announcement_write_requires_device(self):
        response = self.client.post('/api/announcements/1/read', json={})
        self.assertEqual(response.status_code, 401)

    def test_wechat_token_remains_on_dedicated_endpoint(self):
        self.assertEqual(self.client.get('/api/wechat/account', headers={'Authorization': 'Bearer invalid'}).status_code, 401)
        with patch('auth.get_wechat_request_session', return_value={'openid': 'verified-openid'}), \
             patch('routes.wechat_routes.get_account', return_value=None):
            response = self.client.get('/api/wechat/account')
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.get_json()['bound'])

    def test_payment_invalid_signatures_use_constant_time_and_do_not_settle(self):
        with get_db() as conn:
            conn.execute('''INSERT INTO orders
                (order_no, device_id, username, member_type, amount, pay_type, status, create_time)
                VALUES ('test-order', 'test-device', 'student', 'basic', '3.00', 'alipay', 'pending', '2026-10-02')''')
        for method in ('get', 'post'):
            for sign in ('', 'wrong', '错' * 32):
                with self.subTest(method=method, sign=sign), patch('hmac.compare_digest', wraps=hmac.compare_digest) as compare:
                    params = {'orderNo': 'test-order', 'amount': '3.00', 'state': '1', 'sign': sign}
                    response = (self.client.get('/api/member/pay_notify', query_string=params) if method == 'get'
                                else self.client.post('/api/member/pay_notify', data=params))
                    self.assertEqual(response.status_code, 400)
                    self.assertEqual(response.text, 'fail')
                    self.assertTrue(compare.called)
        with get_db() as conn:
            self.assertEqual(conn.execute("SELECT status FROM orders WHERE order_no = 'test-order'").fetchone()['status'], 'pending')

    def test_valid_payment_signature_settles_order_once(self):
        with get_db() as conn:
            conn.execute('''INSERT INTO orders
                (order_no, device_id, username, member_type, amount, pay_type, status, create_time)
                VALUES ('test-order', 'test-device', 'student', 'basic', '3.00', 'alipay', 'pending', '2026-10-02')''')
        # 签名独立按支付协议计算，不调用被测业务 helper。
        sign = hashlib.md5(b'1merchanttest-order3.00payment-key').hexdigest()
        params = {'orderNo': 'test-order', 'amount': '3.00', 'state': '1', 'sign': sign}
        with patch('routes.member_routes.MERCHANT_NUM', 'merchant'), patch('routes.member_routes.PAY_SECRET_KEY', 'payment-key'):
            for _ in range(2):
                response = self.client.post('/api/member/pay_notify', data=params)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.text, 'success')
        with get_db() as conn:
            self.assertEqual(conn.execute("SELECT status FROM orders WHERE order_no = 'test-order'").fetchone()['status'], 'paid')
            self.assertEqual(conn.execute('SELECT COUNT(*) AS n FROM memberships').fetchone()['n'], 1)


class ApiExceptionTests(unittest.TestCase):
    def setUp(self):
        # 加载真实入口及全部 Blueprint，隔离数据库启动和后台清理线程。
        cleanup = patch('services.temporary_session_service.start_temporary_session_cleanup')
        cleanup.start()
        self.addCleanup(cleanup.stop)
        with patch.dict(os.environ, SAFE_ENV), patch('database.init_db'), \
                patch('database.ensure_api_keys_table'), \
                patch('constants.MERCHANT_NUM', SAFE_ENV['MERCHANT_NUM']), \
                patch('constants.PAY_SECRET_KEY', SAFE_ENV['PAY_SECRET_KEY']):
            self.app = runpy.run_path(str(ROOT / 'app.py'), run_name='api_exception_test')['app']

        @self.app.get('/api/test-unhandled-error')
        def unhandled_error():
            raise RuntimeError('private-database-password-and-path')

        @self.app.post('/api/test-json')
        def parse_json():
            from flask import request
            return jsonify(request.get_json())

        self.client = self.app.test_client()

    def test_unhandled_error_is_logged_with_traceback_and_redacted_in_response(self):
        with self.assertLogs(self.app.logger, level='ERROR') as logs:
            response = self.client.get('/api/test-unhandled-error')
            self.assertEqual(response.status_code, 500)
            self.assertEqual(response.get_json(), {'success': False, 'message': '服务器内部错误，请稍后重试'})
        self.assertTrue(logs.records[0].exc_info)
        self.assertIn('Traceback', logs.output[0])
        self.assertIn('private-database-password-and-path', logs.output[0])

    def test_http_error_status_codes_and_json_contract_are_preserved(self):
        responses = (
            (self.client.get('/api/nonexistent-test-route'), 404),
            (self.client.post('/api/test-unhandled-error'), 405),
            (self.client.post('/api/test-json', data='{', content_type='application/json'), 400),
        )
        for response, code in responses:
            with self.subTest(code=code):
                self.assertEqual(response.status_code, code)
                self.assertFalse(response.get_json()['success'])
                self.assertIsInstance(response.get_json()['message'], str)
        response = self.client.get('/nonexistent-test-page')
        self.assertEqual(response.status_code, 404)
        self.assertFalse(response.is_json)


if __name__ == '__main__':
    unittest.main()
