"""URL 隔离合并必须保留临时目录及凭据使用边界，全部使用合成数据。"""
import tempfile
import os
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import requests
from flask import Flask, g, jsonify

from database import init_db
from routes.auth_routes import auth_bp
from services import urp_service
from services import temporary_session_service as temporary_service
from urp import session_store
from urp.login import URP_login

URL1 = 'http://first.example/urp/'
URL2 = 'http://second.example/urp/'


class UrlMergeBoundaryTests(unittest.TestCase):
    def test_temporary_url_cookies_never_write_permanent_account_or_mix_urls(self):
        app = Flask(__name__)
        with tempfile.TemporaryDirectory() as directory, patch.object(
            temporary_service, 'TEMPORARY_DATA_ROOT', str(Path(directory) / 'temporary'),
        ), patch.object(session_store, 'USER_DATA_DIR', Path(directory) / 'permanent'):
            with app.test_request_context('/'):
                g.temporary_session = {'session_id': 'a' * 32, 'username': 'student'}
                first = session_store.save_user_cookies('student', URL1, {'JSESSIONID': 'first'})
                second = session_store.save_user_cookies('student', URL2, {'JSESSIONID': 'second'})
                self.assertTrue(first.is_relative_to(Path(directory) / 'temporary'))
                self.assertTrue(second.is_relative_to(Path(directory) / 'temporary'))
                self.assertEqual(session_store.load_user_cookies('student', URL1)[0], {'JSESSIONID': 'first'})
                self.assertEqual(session_store.load_user_cookies('student', URL2)[0], {'JSESSIONID': 'second'})
            self.assertFalse((Path(directory) / 'permanent').exists())

    def test_temporary_login_cookie_is_only_available_to_its_original_url(self):
        from services.user_service import get_user_by_device
        from urp.query import URP_query
        app = Flask(__name__)
        app.register_blueprint(auth_bp)

        @app.get('/inspect-cookie')
        def inspect_cookie():
            get_user_by_device('temporary-device')
            first = URP_query(URL1, 'student')
            second = URP_query(URL2, 'student')
            return jsonify(first=first.x.cookies.get('JSESSIONID'), second=second.x.cookies.get('JSESSIONID'))

        with tempfile.TemporaryDirectory() as directory:
            previous = os.getcwd()
            os.chdir(directory)
            self.addCleanup(os.chdir, previous)
            config = {'database': {'type': 'sqlite', 'sqlite_path': str(Path(directory) / 'test.db')},
                      'urp_urls': [URL1, URL2], 'current_url_index': 0}
            with patch('database.get_config', return_value=config), patch(
                'services.config_service.get_config', return_value=config,
            ):
                init_db(config)
                client = app.test_client()
                with patch('routes.auth_routes.urp_login', return_value=(True, '登录成功', {'JSESSIONID': 'origin-only'})):
                    reply = client.post('/api/login', headers={'X-Device-ID': 'temporary-device'},
                        json={'username': 'student', 'password': 'synthetic', 'bind_account': False})
                self.assertTrue(reply.json['success'])
                self.assertEqual(client.get('/inspect-cookie').json, {'first': 'origin-only', 'second': None})
                self.assertFalse(Path('user_data/student').exists())
            os.chdir(previous)

    def test_historical_temporary_cookie_without_origin_requires_relogin(self):
        app = Flask(__name__)
        with tempfile.TemporaryDirectory() as directory, patch.object(
            temporary_service, 'TEMPORARY_DATA_ROOT', directory,
        ):
            with app.test_request_context('/'):
                g.temporary_session = {'session_id': 'a' * 32, 'username': 'student'}
                cookie = Path(temporary_service.user_data_file('student', 'cookie.json'))
                cookie.parent.mkdir(parents=True)
                cookie.write_text('{"JSESSIONID": "unknown-origin"}', encoding='utf-8')
                self.assertEqual(session_store.load_user_cookies('student', URL1)[0], {})
                self.assertEqual(session_store.load_user_cookies('student', URL2)[0], {})
                session_store.save_user_cookies('student', URL1, {'JSESSIONID': 'known-origin'})
                self.assertEqual(session_store.load_user_cookies('student', URL1)[0], {'JSESSIONID': 'known-origin'})
                self.assertEqual(session_store.load_user_cookies('student', URL2)[0], {})

    def test_temporary_status_never_reuses_persistent_cache_or_replays_password(self):
        app = Flask(__name__)
        helper = Mock()
        helper.is_logined.return_value = False
        key = urp_service._login_key('student', URL1)
        try:
            urp_service._login_cache[key] = time.time()
            with app.test_request_context('/'):
                g.temporary_session = {'session_id': 'a' * 32, 'username': 'student'}
                with patch('urp.URP_login', return_value=helper), patch.object(
                    urp_service, 'user_cookie_exists', return_value=True,
                ):
                    logged_in, _ = urp_service.check_login_status('student', None, {}, url=URL1)
                self.assertFalse(logged_in)
                helper.login.assert_not_called()
                self.assertIn(key, urp_service._login_cache)
        finally:
            urp_service._login_cache.pop(key, None)

    def test_http_error_account_echo_cannot_validate_cookie(self):
        with tempfile.TemporaryDirectory() as directory:
            cookie = Path(directory) / 'cookie.json'
            cookie.write_text('{"JSESSIONID": "synthetic"}', encoding='utf-8')
            helper = URP_login(URL1, 'student', None, cookie_path=str(cookie))
            response = requests.Response()
            response.status_code = 503
            response.url = URL1 + 'menu/top.jsp'
            response._content = b'student'
            helper.x.get = Mock(return_value=response)
            self.assertFalse(helper.is_logined())
            helper.x.close()

    def test_explicit_cookie_file_is_still_supported_without_decrypting_password(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'isolated.json'
            path.write_text('{"JSESSIONID": "synthetic"}', encoding='utf-8')
            helper = URP_login(URL1, 'student', 'fernet:v1:synthetic', cookie_path=str(path), stored_password=True)
            response = requests.Response()
            response.status_code = 200
            response.url = URL1 + 'menu/top.jsp'
            response._content = b'student'
            helper.x.get = Mock(return_value=response)
            with patch('services.credential_service.CredentialCipher.decrypt', side_effect=AssertionError('must not decrypt')):
                self.assertTrue(helper.is_logined())
            helper.x.close()


if __name__ == '__main__':
    unittest.main()
