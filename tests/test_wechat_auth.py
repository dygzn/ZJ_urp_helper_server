import hashlib
import importlib
import os
import tempfile
import unittest
from datetime import datetime, timedelta
from unittest import mock

import database


class WechatAuthServiceTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch(
            "requests.sessions.Session.request",
            side_effect=AssertionError("禁止真实网络请求"),
        ))
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_config = {
            'type': 'sqlite',
            'sqlite_path': os.path.join(self.temp_dir.name, 'wechat.db'),
            'mysql': {},
        }
        self.init_config = {'database': self.db_config}
        self.config_patch = mock.patch(
            'database.get_database_config',
            return_value=self.db_config,
        )
        self.config_patch.start()
        database.init_db(self.init_config)

    def tearDown(self):
        self.config_patch.stop()
        self.temp_dir.cleanup()

    def load_service(self):
        try:
            return importlib.import_module('services.wechat_auth_service')
        except ImportError as exc:
            self.fail(f'微信认证服务尚未提供: {exc}')

    def test_code_to_session_returns_openid_and_unionid_without_session_key(self):
        service = self.load_service()
        with (
            mock.patch.dict(
                os.environ,
                {
                    'WECHAT_MINIPROGRAM_APPID': 'wx-test-app',
                    'WECHAT_MINIPROGRAM_SECRET': 'server-only-secret',
                },
                clear=False,
            ),
            mock.patch.object(service.requests, 'get') as get_request,
        ):
            get_request.return_value.json.return_value = {
                'openid': 'openid-test-1',
                'session_key': 'server-only-session-key',
                'unionid': 'unionid-test-1',
            }

            result = service.code_to_session('code-1')

        self.assertEqual(
            result,
            {'openid': 'openid-test-1', 'unionid': 'unionid-test-1'},
        )
        self.assertNotIn('session_key', result)
        get_request.assert_called_once()
        self.assertEqual(
            get_request.call_args.kwargs['params']['grant_type'],
            'authorization_code',
        )

    def test_code_to_session_rejects_wechat_error(self):
        service = self.load_service()
        with (
            mock.patch.dict(
                os.environ,
                {
                    'WECHAT_MINIPROGRAM_APPID': 'wx-test-app',
                    'WECHAT_MINIPROGRAM_SECRET': 'server-only-secret',
                },
                clear=False,
            ),
            mock.patch.object(service.requests, 'get') as get_request,
        ):
            get_request.return_value.json.return_value = {
                'errcode': 40029,
                'errmsg': 'invalid code',
            }

            with self.assertRaises(service.WechatAuthError):
                service.code_to_session('invalid-code')

    def test_session_token_is_hashed_and_valid_session_resolves(self):
        service = self.load_service()
        token = service.create_session('openid-test-1', 'unionid-test-1')

        self.assertNotEqual(token, 'openid-test-1')
        self.assertNotEqual(token, 'server-only-session-key')
        with database.get_db() as conn:
            row = conn.execute(
                'SELECT token_hash, openid FROM wechat_sessions'
            ).fetchone()

        self.assertEqual(
            row['token_hash'],
            hashlib.sha256(token.encode('utf-8')).hexdigest(),
        )
        self.assertEqual(row['openid'], 'openid-test-1')
        self.assertEqual(service.resolve_session_token(token)['openid'], 'openid-test-1')

    def test_expired_session_does_not_resolve(self):
        service = self.load_service()
        token = service.create_session('openid-test-2')
        expired = (datetime.now() - timedelta(minutes=1)).isoformat()
        with database.get_db() as conn:
            conn.execute(
                'UPDATE wechat_sessions SET expires_at = ?',
                (expired,),
            )

        self.assertIsNone(service.resolve_session_token(token))

    def test_binding_lookup_is_empty_before_association(self):
        service = self.load_service()

        self.assertIsNone(service.get_binding('openid-never-bound'))

    def test_database_initialization_is_idempotent_for_wechat_tables(self):
        database.init_db(self.init_config)
        with database.get_db() as conn:
            names = {
                row['name']
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
            }

        self.assertIn('wechat_bindings', names)
        self.assertIn('wechat_sessions', names)


if __name__ == '__main__':
    unittest.main()
