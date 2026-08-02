import json
import tempfile
import threading
import time
import unittest
from collections import UserDict
from pathlib import Path
from unittest.mock import Mock, patch

import requests
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
        urp_service._login_locks.clear()

    def tearDown(self):
        urp_service._login_cache.clear()
        urp_service._login_locks.clear()

    def test_url1_cache_does_not_skip_url2_validation(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ), patch.object(urp_service, 'URP_login') as login_class:
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
            def __init__(self, url, account, password):
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
        ), patch.object(urp_service, 'URP_login', FakeLogin):
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

    def test_vpn_url_revalidates_instead_of_using_ttl_cache(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ), patch.object(urp_service, 'URP_login') as login_class:
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

        self.assertEqual(login_class.call_count, 2)

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
            def __init__(self, url, account, password):
                self.x = requests.Session()

            def is_logined(self):
                return False

            def login(self):
                return False, 'VPN 通道暂不可用，请稍后重试', None

        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ), patch.object(urp_service, 'URP_login', FailedLogin):
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


if __name__ == '__main__':
    unittest.main()
