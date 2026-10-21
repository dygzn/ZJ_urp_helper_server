"""微信接口边界回归：独立 Flask 应用、临时数据库、禁止外部网络。"""
import os
import tempfile
import unittest
from datetime import datetime, timedelta
from unittest import mock

from cryptography.fernet import Fernet
from flask import Flask

import database
from routes.auth_routes import auth_bp
from routes.wechat_routes import wechat_bp
from services.credential_service import CredentialCipher
from services.user_service import bind_user, get_user_by_device
from services.wechat_account_service import bind_account, get_account
from services.wechat_auth_service import create_session


class WechatRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = self.enterContext(tempfile.TemporaryDirectory())
        self.db_config = {
            'type': 'sqlite',
            'sqlite_path': os.path.join(self.temp_dir, 'wechat-routes.db'),
            'mysql': {},
        }
        self.enterContext(mock.patch('database.get_database_config', return_value=self.db_config))
        self.enterContext(mock.patch.dict(os.environ, {'URP_CREDENTIAL_KEY': Fernet.generate_key().decode()}))
        self.enterContext(mock.patch('requests.sessions.Session.request', side_effect=AssertionError('禁止真实网络请求')))
        database.init_db({'database': self.db_config})
        app = Flask(__name__)
        app.config['TESTING'] = True
        app.register_blueprint(auth_bp)
        app.register_blueprint(wechat_bp)
        self.client = app.test_client()

    def token(self, openid='synthetic-openid'):
        return {'Authorization': f'Bearer {create_session(openid)}'}

    def account(self, openid='synthetic-openid', username='2024123456'):
        bind_account(openid, username, 'synthetic-password')
        return self.token(openid)

    def test_missing_code_returns_json_error(self):
        response = self.client.post('/api/wechat/session', json={})
        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.get_json()['success'])

    def test_session_endpoint_returns_unbound_token_without_wechat_secrets(self):
        with mock.patch('routes.wechat_routes.code_to_session', return_value={'openid': 'synthetic-openid', 'unionid': None}):
            response = self.client.post('/api/wechat/session', json={'code': 'synthetic-code'})
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload['success'])
        self.assertFalse(payload['bound'])
        self.assertTrue(payload['token'])
        for field in ('openid', 'unionid', 'session_key', 'password'):
            self.assertNotIn(field, payload)

    def test_bind_and_account_require_bearer_even_with_a_bound_web_device(self):
        bind_user('web-device', '2024123456', 'web-password')
        headers = {'X-Device-ID': 'web-device'}
        for method, path, body in [
            ('GET', '/api/wechat/account', None),
            ('POST', '/api/wechat/bind', {'username': '2024123456', 'password': 'synthetic-password'}),
            ('DELETE', '/api/wechat/binding', None),
            ('GET', '/api/wechat/schedule', None),
        ]:
            with self.subTest(path=path):
                response = self.client.open(path, method=method, headers=headers, json=body)
                self.assertEqual(response.status_code, 401)
                self.assertEqual(response.get_json()['code'], 'WECHAT_SESSION_REQUIRED')

    def test_bind_existing_web_account_preserves_web_binding_and_stores_independent_wechat_binding(self):
        bind_user('web-device', '2024123456', 'old-password')
        with mock.patch('routes.wechat_routes.urp_login', return_value=(True, '登录成功', None)):
            response = self.client.post('/api/wechat/bind', headers=self.token(), json={'username': '2024123456', 'password': 'new-password'})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()['success'])
        self.assertEqual(get_user_by_device('web-device')['username'], '2024123456')
        self.assertEqual(get_account('synthetic-openid')['username'], '2024123456')
        with database.get_db() as conn:
            bindings = conn.execute('SELECT device_id FROM users').fetchall()
            password = conn.execute('SELECT password FROM user_account WHERE username = ?', ('2024123456',)).fetchone()['password']
        self.assertEqual([row['device_id'] for row in bindings], ['web-device'])
        self.assertTrue(CredentialCipher.is_encrypted(password))
        self.assertEqual(CredentialCipher().decrypt(password), 'new-password')

    def test_wechat_token_does_not_authenticate_the_web_binding_route(self):
        bind_user('web-device', '2024123456', 'synthetic-password')
        headers = self.account()
        response = self.client.get('/api/check_bind', headers=headers)
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.get_json()['bound'])
        response = self.client.get('/api/check_bind', headers={'X-Device-ID': 'web-device'})
        self.assertTrue(response.get_json()['bound'])

    def test_wechat_unbind_leaves_web_account_bound_and_token_usable(self):
        bind_user('web-device', '2024123456', 'synthetic-password')
        headers = self.account()
        response = self.client.delete('/api/wechat/binding', headers=headers)
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.get_json()['bound'])
        self.assertIsNone(get_account('synthetic-openid'))
        self.assertEqual(get_user_by_device('web-device')['username'], '2024123456')
        status = self.client.get('/api/wechat/account', headers=headers)
        self.assertEqual(status.status_code, 200)
        self.assertFalse(status.get_json()['bound'])

    def test_account_cannot_be_claimed_by_a_second_wechat(self):
        self.account()
        with mock.patch('routes.wechat_routes.urp_login', return_value=(True, '登录成功', None)):
            response = self.client.post('/api/wechat/bind', headers=self.token('other-openid'), json={'username': '2024123456', 'password': 'synthetic-password'})
        self.assertEqual(response.status_code, 409)
        self.assertFalse(response.get_json()['success'])
        self.assertIsNone(get_account('other-openid'))
        self.assertEqual(get_account('synthetic-openid')['username'], '2024123456')

    def test_changing_wechat_account_requires_explicit_unbind(self):
        headers = self.account()
        response = self.client.post('/api/wechat/bind', headers=headers, json={'username': '2024987654', 'password': 'synthetic-password'})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(get_account('synthetic-openid')['username'], '2024123456')

    def test_expired_token_returns_401(self):
        headers = self.token()
        with database.get_db() as conn:
            conn.execute('UPDATE wechat_sessions SET expires_at = ?', ((datetime.now() - timedelta(minutes=1)).isoformat(),))
        response = self.client.get('/api/wechat/account', headers=headers)
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.get_json()['code'], 'WECHAT_SESSION_REQUIRED')

    def test_unbound_session_gets_an_actionable_binding_error(self):
        response = self.client.get('/api/wechat/schedule', headers=self.token())
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()['code'], 'BINDING_REQUIRED')
        self.assertTrue(response.get_json()['message'])

    def test_grades_without_membership_return_readable_403(self):
        with mock.patch('services.wechat_access.config_service.get_config', return_value={'grades_require_member': True}):
            response = self.client.get('/api/wechat/grades/current', headers=self.account())
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.get_json()['code'], 'MEMBER_REQUIRED')
        self.assertIn('网页端', response.get_json()['message'])

    def test_expired_urp_login_returns_readable_409(self):
        with mock.patch('services.wechat_access.urp_service.check_login_status', return_value=(False, {})):
            response = self.client.get('/api/wechat/exams', headers=self.account())
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()['code'], 'URP_LOGIN_REQUIRED')
        self.assertIn('解绑', response.get_json()['message'])

    def test_grade_queries_use_existing_payload_shapes_when_membership_is_disabled(self):
        with (mock.patch('services.wechat_access.config_service.get_config', return_value={'grades_require_member': False}),
              mock.patch('services.wechat_access.urp_service.check_login_status', return_value=(True, {})),
              mock.patch('routes.wechat_routes.urp.get_current_semester_grades', return_value=[{'course': '数学', 'score': '90', 'credit': '3'}])):
            response = self.client.get('/api/wechat/grades/current', headers=self.account())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['grades'], [{'course': '数学', 'score': '90', 'credit': '3'}])


if __name__ == '__main__':
    unittest.main()
