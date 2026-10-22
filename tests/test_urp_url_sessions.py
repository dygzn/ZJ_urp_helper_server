import json
import tempfile
import threading
import time
import unittest
from collections import UserDict
from pathlib import Path
from unittest.mock import Mock, patch

import requests
from flask import Flask
import routes.auth_routes as auth_routes
import services.config_service as config_service
import services.urp_service as urp_service

import urp.login as login_module
import urp.query as query_module
import urp.session_store as session_store


URL1 = 'http://url1.test/urp/'
URL2 = 'https://url2.test/vpn/urp/'
VPN_URL = 'https://223.112.21.198:6443/7b68f983/'


class UserCookieStoreTests(unittest.TestCase):
    def test_same_user_uses_distinct_files_for_distinct_urls(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ):
            first = session_store.save_user_cookies(
                'student',
                URL1,
                {'JSESSIONID': 'url1'},
            )
            second = session_store.save_user_cookies(
                'student',
                URL2,
                {'JSESSIONID': 'url2'},
            )
            first_cookies, first_source = session_store.load_user_cookies(
                'student',
                URL1,
            )
            second_cookies, second_source = session_store.load_user_cookies(
                'student',
                URL2,
            )

        self.assertNotEqual(first, second)
        self.assertEqual(first_cookies, {'JSESSIONID': 'url1'})
        self.assertEqual(second_cookies, {'JSESSIONID': 'url2'})
        self.assertEqual((first_source, second_source), ('scoped', 'scoped'))

    def test_url_reordering_does_not_change_cookie_path(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ):
            first = session_store.user_cookie_path('student', URL1)
            second = session_store.user_cookie_path(
                'student',
                URL1.rstrip('/'),
            )

        self.assertEqual(first, second)

    def test_user_cookie_file_excludes_vpn_cookies(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ):
            path = session_store.save_user_cookies(
                'student',
                URL2,
                {
                    'JSESSIONID': 'student-session',
                    'route': 'backend',
                    'VSG_SESSIONID': 'vpn-session',
                },
            )
            payload = json.loads(path.read_text(encoding='utf-8'))

        self.assertEqual(
            payload,
            {'JSESSIONID': 'student-session', 'route': 'backend'},
        )

    def test_userdict_cookies_are_saved_and_vpn_cookies_filtered(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ):
            path = session_store.save_user_cookies(
                'student',
                URL1,
                UserDict({
                    'JSESSIONID': 'student-session',
                    'VSG_SESSIONID': 'vpn-session',
                }),
            )
            payload = json.loads(path.read_text(encoding='utf-8'))

        self.assertEqual(payload, {'JSESSIONID': 'student-session'})

    def test_legacy_cookie_is_candidate_only_when_scoped_file_missing(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ):
            account_dir = Path(directory) / 'student'
            account_dir.mkdir(parents=True)
            (account_dir / 'cookie.json').write_text(
                json.dumps({
                    'JSESSIONID': 'legacy',
                    'VSG_SESSIONID': 'old-vpn',
                }),
                encoding='utf-8',
            )
            legacy, source = session_store.load_user_cookies('student', URL1)
            session_store.save_user_cookies(
                'student',
                URL1,
                {'JSESSIONID': 'scoped'},
            )
            scoped, scoped_source = session_store.load_user_cookies(
                'student',
                URL1,
            )

        self.assertEqual(legacy, {'JSESSIONID': 'legacy'})
        self.assertEqual(source, 'legacy')
        self.assertEqual(scoped, {'JSESSIONID': 'scoped'})
        self.assertEqual(scoped_source, 'scoped')


class CookieConsumerTests(unittest.TestCase):
    def test_login_saves_only_current_url_user_cookies(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ), patch.object(login_module.requests, 'session') as make_session:
            fake_session = Mock()
            fake_session.cookies = requests.cookies.RequestsCookieJar()
            fake_session.headers = {}
            fake_session.cookies.set('JSESSIONID', 'student')
            fake_session.cookies.set('VSG_SESSIONID', 'vpn')
            make_session.return_value = fake_session

            login = login_module.URP_login(URL2, 'student', 'password')
            login._save_cookies()
            cookies, source = session_store.load_user_cookies('student', URL2)

        self.assertEqual(cookies, {'JSESSIONID': 'student'})
        self.assertEqual(source, 'scoped')

    def test_query_loads_cookie_for_its_own_url(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ), patch.object(query_module.requests, 'session') as make_session:
            session_store.save_user_cookies(
                'student',
                URL1,
                {'JSESSIONID': 'url1'},
            )
            session_store.save_user_cookies(
                'student',
                URL2,
                {'JSESSIONID': 'url2'},
            )
            first_session = requests.Session()
            second_session = requests.Session()
            make_session.side_effect = [first_session, second_session]

            first = query_module.URP_query(URL1, 'student')
            second = query_module.URP_query(URL2, 'student')

        self.assertEqual(first.x.cookies.get('JSESSIONID'), 'url1')
        self.assertEqual(second.x.cookies.get('JSESSIONID'), 'url2')

    def test_valid_legacy_cookie_is_promoted_after_real_validation(self):
        response = Mock()
        response.url = URL1
        response.text = 'student'
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ):
            account_dir = Path(directory) / 'student'
            account_dir.mkdir(parents=True)
            (account_dir / 'cookie.json').write_text(
                json.dumps({'JSESSIONID': 'legacy'}),
                encoding='utf-8',
            )
            login = login_module.URP_login(URL1, 'student', 'password')
            login.x.get = Mock(return_value=response)

            self.assertTrue(login.is_logined())
            promoted, source = session_store.load_user_cookies(
                'student',
                URL1,
                allow_legacy=False,
            )

        self.assertEqual(promoted, {'JSESSIONID': 'legacy'})
        self.assertEqual(source, 'scoped')

    def test_legacy_cookie_is_not_promoted_when_login_page_echoes_account(self):
        response = Mock()
        response.url = URL1
        response.text = (
            '<form name="loginForm" action="loginAction.do">'
            'student'
            '</form>'
        )
        self.assertTrue(login_module._looks_like_urp_login_page(response))

        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ):
            account_dir = Path(directory) / 'student'
            account_dir.mkdir(parents=True)
            (account_dir / 'cookie.json').write_text(
                json.dumps({'JSESSIONID': 'expired-legacy'}),
                encoding='utf-8',
            )
            login = login_module.URP_login(URL1, 'student', 'password')
            login.x.get = Mock(return_value=response)

            self.assertFalse(login.is_logined())
            promoted, source = session_store.load_user_cookies(
                'student',
                URL1,
                allow_legacy=False,
            )

        self.assertEqual(promoted, {})
        self.assertEqual(source, 'missing')

    def test_invalid_cookie_validation_does_not_call_login_recursively(self):
        response = Mock()
        response.url = URL1
        response.text = '<form name="loginForm"></form>'
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ):
            session_store.save_user_cookies(
                'student',
                URL1,
                {'JSESSIONID': 'expired'},
            )
            login = login_module.URP_login(URL1, 'student', 'password')
            login.x.get = Mock(return_value=response)
            login.login = Mock()

            self.assertFalse(login.is_logined())
            login.login.assert_not_called()


class LoginStateTests(unittest.TestCase):
    def setUp(self):
        urp_service._login_cache.clear()
        urp_service._login_failures.clear()
        login_module._VPN_HEALTH.clear()
        login_module._VPN_FAILURES.clear()
        urp_service._login_locks.clear()

    def tearDown(self):
        urp_service._login_cache.clear()
        urp_service._login_failures.clear()
        login_module._VPN_HEALTH.clear()
        login_module._VPN_FAILURES.clear()
        urp_service._login_locks.clear()

    def test_four_status_requests_share_one_real_login(self):
        login_count = 0
        count_lock = threading.Lock()

        class FakeLogin:
            def __init__(self, url, account, password, **kwargs):
                self.url = url
                self.account = account
                self.x = requests.Session()

            def is_logined(self):
                return False

            def login(self):
                nonlocal login_count
                with count_lock:
                    login_count += 1
                time.sleep(0.05)
                session_store.save_user_cookies(
                    self.account,
                    self.url,
                    {'JSESSIONID': 'fresh'},
                )
                return True, '登录成功', {'JSESSIONID': 'fresh'}

        app = Flask(__name__)
        app.register_blueprint(auth_routes.auth_bp)
        user = {
            'username': 'student',
            'password': 'password',
        }
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ), patch.object(
            auth_routes,
            'get_user_by_device',
            return_value=user,
        ), patch.object(
            auth_routes,
            'get_current_urp_url',
            return_value=URL1,
        ), patch.object(
            __import__('urp'),
            'URP_login',
            FakeLogin,
        ), patch(
            'urp.URP_login',
            FakeLogin,
        ):
            responses = []

            def request_status():
                response = app.test_client().get(
                    '/api/check_login_status',
                    headers={'X-Device-ID': 'device'},
                )
                responses.append(response.get_json())

            threads = [
                threading.Thread(target=request_status)
                for _ in range(4)
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(2)

        self.assertEqual(len(responses), 4)
        self.assertEqual(login_count, 1)
        for payload in responses:
            self.assertTrue(payload['success'])
            self.assertTrue(payload['logged_in'])
            self.assertEqual(payload['username'], 'student')
            self.assertIn(
                payload['message'],
                {'登录状态正常', '重新登录成功'},
            )

    def test_status_route_reports_existing_valid_login_as_normal(self):
        class ValidLogin:
            def __init__(self, url, account, password, **kwargs):
                self.x = requests.Session()
                self.x.cookies.set('JSESSIONID', 'existing')

            def is_logined(self):
                return True

            def login(self):
                raise AssertionError('valid login must not relogin')

        app = Flask(__name__)
        app.register_blueprint(auth_routes.auth_bp)
        user = {'username': 'student', 'password': 'password'}
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ), patch.object(
            auth_routes,
            'get_user_by_device',
            return_value=user,
        ), patch.object(
            auth_routes,
            'get_current_urp_url',
            return_value=URL1,
        ), patch.object(
            __import__('urp'),
            'URP_login',
            ValidLogin,
        ), patch(
            'urp.URP_login',
            ValidLogin,
        ):
            payload = app.test_client().get(
                '/api/check_login_status',
                headers={'X-Device-ID': 'device'},
            ).get_json()

        self.assertEqual(payload['success'], True)
        self.assertEqual(payload['logged_in'], True)
        self.assertEqual(payload['username'], 'student')
        self.assertEqual(payload['message'], '登录状态正常')

    def test_invalid_legacy_cookie_does_not_contaminate_relogin(self):
        login_page = Mock()
        login_page.url = URL1
        login_page.text = (
            '<form name="loginForm" action="loginAction.do"></form>'
        )

        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ):
            account_dir = Path(directory) / 'student'
            account_dir.mkdir(parents=True)
            (account_dir / 'cookie.json').write_text(
                json.dumps({
                    'JSESSIONID': 'expired-legacy',
                    'STALE': 'must-not-survive',
                }),
                encoding='utf-8',
            )
            login = login_module.URP_login(URL1, 'student', 'password')
            login.x.get = Mock(return_value=login_page)

            def successful_relogin():
                login.x.cookies.set('JSESSIONID', 'fresh')
                login._save_cookies()
                return True, '登录成功', {'JSESSIONID': 'fresh'}

            login.login = Mock(side_effect=successful_relogin)
            with patch.object(
                __import__('urp'), 'URP_login', return_value=login,
            ):
                success, details = urp_service.check_login_status(
                    'student', 'password', url=URL1,
                )

            scoped, source = session_store.load_user_cookies(
                'student', URL1, allow_legacy=False,
            )

        self.assertTrue(success)
        self.assertTrue(details.relogged)
        self.assertEqual(source, 'scoped')
        self.assertEqual(scoped, {'JSESSIONID': 'fresh'})
        self.assertNotIn('STALE', login.x.cookies.get_dict())

    def test_url1_cache_does_not_skip_url2_validation(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ), patch('urp.URP_login') as login_class:
            session_store.save_user_cookies(
                'student',
                URL1,
                {'JSESSIONID': 'url1'},
            )
            session_store.save_user_cookies(
                'student',
                URL2,
                {'JSESSIONID': 'url2'},
            )
            first = login_class.return_value
            first.is_logined.return_value = True
            first.x.cookies.get_dict.return_value = {'JSESSIONID': 'url1'}

            self.assertTrue(
                urp_service.check_login_status(
                    'student',
                    'password',
                    url=URL1,
                )[0]
            )
            self.assertTrue(
                urp_service.check_login_status(
                    'student',
                    'password',
                    url=URL2,
                )[0]
            )

        self.assertEqual(login_class.call_count, 2)

    def test_concurrent_requests_perform_one_real_login(self):
        login_count = 0
        count_lock = threading.Lock()

        class FakeLogin:
            def __init__(self, url, account, password, **kwargs):
                self.url = url
                self.account = account
                self.x = requests.Session()

            def is_logined(self):
                return session_store.user_cookie_exists(
                    self.account,
                    self.url,
                )

            def login(self):
                nonlocal login_count
                with count_lock:
                    login_count += 1
                time.sleep(0.05)
                session_store.save_user_cookies(
                    self.account,
                    self.url,
                    {'JSESSIONID': 'fresh'},
                )
                return True, '登录成功', {'JSESSIONID': 'fresh'}

        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ), patch('urp.URP_login', FakeLogin):
            results = []
            threads = [
                threading.Thread(
                    target=lambda: results.append(
                        urp_service.check_login_status(
                            'student',
                            'password',
                            url=URL2,
                        )[0]
                    )
                )
                for _ in range(4)
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(2)

        self.assertEqual(results, [True, True, True, True])
        self.assertEqual(login_count, 1)

    def test_vpn_url_reuses_short_ttl_cache(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ), patch('urp.URP_login') as login_class:
            session_store.save_user_cookies(
                'student',
                VPN_URL,
                {'JSESSIONID': 'vpn-user'},
            )
            login = login_class.return_value
            login.is_logined.return_value = True
            login.x.cookies.get_dict.return_value = {
                'JSESSIONID': 'vpn-user',
            }

            for _ in range(2):
                self.assertTrue(
                    urp_service.check_login_status(
                        'student',
                        'password',
                        url=VPN_URL,
                    )[0]
                )

        self.assertEqual(login_class.call_count, 1)

    def test_invalidate_one_url_keeps_other_url_cache(self):
        first_key = (
            'student',
            config_service.urp_url_fingerprint(URL1),
        )
        second_key = (
            'student',
            config_service.urp_url_fingerprint(URL2),
        )
        urp_service._login_cache[first_key] = time.time()
        urp_service._login_cache[second_key] = time.time()

        urp_service.invalidate_login_cache('student', URL2)

        self.assertIn(first_key, urp_service._login_cache)
        self.assertNotIn(second_key, urp_service._login_cache)

    def test_failed_login_preserves_vpn_unavailable_message(self):
        class FailedLogin:
            def __init__(self, url, account, password, **kwargs):
                self.x = requests.Session()

            def is_logined(self):
                return False

            def login(self):
                return False, 'VPN 通道暂不可用，请稍后重试', None

        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ), patch('urp.URP_login', FailedLogin):
            success, details = urp_service.check_login_status(
                'student',
                'password',
                url=URL2,
            )

        self.assertFalse(success)
        self.assertEqual(
            details['message'],
            'VPN 通道暂不可用，请稍后重试',
        )

    def test_failed_vpn_recovery_is_cooled_down_across_status_requests(self):
        expected_message = '教务连接暂不可用，请稍后重试。'
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ), patch.object(
            login_module,
            'load_shared_vpn_cookies',
            return_value={'VSG_SESSIONID': 'stale'},
        ), patch.object(
            login_module,
            'vpn_session_alive',
            return_value=False,
        ), patch.object(
            login_module,
            'clear_shared_vpn_cookies',
        ), patch.object(
            login_module.URP_login,
            '_vpn_password_auth',
            return_value=(False, 'VPN auth failed'),
        ) as password_auth:
            session_store.save_user_cookies(
                'student',
                VPN_URL,
                {'JSESSIONID': 'expired'},
            )
            first_success, first_details = (
                urp_service.check_login_status(
                    'student',
                    'password',
                    url=VPN_URL,
                )
            )

            self.assertFalse(first_success)
            self.assertEqual(
                first_details['message'],
                expected_message,
            )
            self.assertEqual(password_auth.call_count, 1)

            session_store.save_user_cookies(
                'student',
                VPN_URL,
                {'JSESSIONID': 'expired-again'},
            )
            second_success, second_details = (
                urp_service.check_login_status(
                    'student',
                    'password',
                    url=VPN_URL,
                )
            )

        self.assertFalse(second_success)
        self.assertEqual(
            second_details['message'],
            expected_message,
        )
        self.assertEqual(password_auth.call_count, 1)

    def test_vpn_auth_exception_is_wrapped_once_without_exposing_detail(self):
        expected_message = '教务连接暂不可用，请稍后重试。'
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ), patch.object(
            login_module,
            'load_shared_vpn_cookies',
            return_value={'VSG_SESSIONID': 'stale'},
        ), patch.object(
            login_module,
            'vpn_session_alive',
            return_value=False,
        ), patch.object(
            login_module,
            'clear_shared_vpn_cookies',
        ), patch.object(
            login_module.URP_login,
            '_vpn_password_auth',
            side_effect=TimeoutError('timed out'),
        ) as password_auth:
            session_store.save_user_cookies(
                'student',
                VPN_URL,
                {'JSESSIONID': 'expired'},
            )
            success, details = urp_service.check_login_status(
                'student',
                'password',
                url=VPN_URL,
            )

        self.assertFalse(success)
        self.assertEqual(details['message'], expected_message)
        self.assertEqual(password_auth.call_count, 1)


if __name__ == '__main__':
    unittest.main()
