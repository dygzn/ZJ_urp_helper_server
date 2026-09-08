import importlib
import os
import tempfile
import unittest
from unittest import mock

import database
from services.user_service import bind_user
from services.wechat_auth_service import (
    bind_openid_to_device,
    create_session,
)


class WechatRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from app import app

        cls.app = app

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_config = {
            'type': 'sqlite',
            'sqlite_path': os.path.join(self.temp_dir.name, 'wechat-routes.db'),
            'mysql': {},
        }
        self.init_config = {'database': self.db_config}
        self.config_patch = mock.patch(
            'database.get_database_config',
            return_value=self.db_config,
        )
        self.config_patch.start()
        database.init_db(self.init_config)
        self.client = self.app.test_client()

    def tearDown(self):
        self.config_patch.stop()
        self.temp_dir.cleanup()

    def load_routes(self):
        try:
            return importlib.import_module('routes.wechat_routes')
        except ImportError as exc:
            self.fail(f'微信路由尚未提供: {exc}')

    def test_missing_code_returns_json_error(self):
        response = self.client.post('/api/wechat/session', json={})

        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.get_json()['success'])

    def test_session_endpoint_returns_unbound_token(self):
        routes = self.load_routes()
        with mock.patch.object(
            routes,
            'code_to_session',
            return_value={'openid': 'openid-route-1', 'unionid': None},
        ):
            response = self.client.post(
                '/api/wechat/session',
                json={'code': 'code-1'},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.get_json(),
            {
                'success': True,
                'token': mock.ANY,
                'bound': False,
            },
        )

    def test_bind_requires_a_bearer_session(self):
        self.load_routes()
        response = self.client.post(
            '/api/wechat/bind',
            json={'username': '2024123456', 'password': 'password'},
        )

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.get_json()['code'], 'WECHAT_SESSION_REQUIRED')

    def test_bind_reuses_existing_web_user_device_id(self):
        routes = self.load_routes()
        bind_user('existing-web-device', '2024123456', 'old-password')

        with mock.patch.object(
            routes,
            'code_to_session',
            return_value={'openid': 'openid-route-2', 'unionid': 'unionid-route-2'},
        ):
            session_response = self.client.post(
                '/api/wechat/session',
                json={'code': 'code-2'},
            )

        token = session_response.get_json()['token']
        with mock.patch.object(
            routes,
            'urp_login',
            return_value=(True, '登录成功', None),
        ):
            response = self.client.post(
                '/api/wechat/bind',
                headers={'Authorization': f'Bearer {token}'},
                json={'username': '2024123456', 'password': 'new-password'},
            )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()['success'])
        with database.get_db() as conn:
            row = conn.execute(
                'SELECT device_id FROM wechat_bindings WHERE openid = ?',
                ('openid-route-2',),
            ).fetchone()
        self.assertEqual(row['device_id'], 'existing-web-device')

    def test_existing_check_bind_route_accepts_bearer_token(self):
        self.load_routes()
        bind_user('bearer-device', '2024987654', 'password')
        bind_openid_to_device('openid-route-3', 'bearer-device')
        token = create_session('openid-route-3')

        response = self.client.get(
            '/api/check_bind',
            headers={'Authorization': f'Bearer {token}'},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.get_json(),
            {
                'success': True,
                'bound': True,
                'username': '2024987654',
            },
        )


if __name__ == '__main__':
    unittest.main()
