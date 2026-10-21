import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import requests

import urp.login as login_module
import urp.query as query_module


def make_response(
    text,
    url='https://223.112.21.198:6443/7b68f983/',
    status=200,
):
    response = requests.Response()
    response.status_code = status
    response.url = url
    response._content = text.encode('utf-8')
    response.encoding = 'utf-8'
    response.headers['Content-Type'] = 'text/html; charset=utf-8'
    return response


class SequenceSession:
    def __init__(self, responses):
        self.responses = list(responses)
        self.cookies = requests.cookies.RequestsCookieJar()
        self.requests = []

    def get(self, url, **kwargs):
        self.requests.append(('GET', url, kwargs))
        return self.responses.pop(0)

    def request(self, method, url, **kwargs):
        self.requests.append((method.upper(), url, kwargs))
        return self.responses.pop(0)


class SharedCookieTests(unittest.TestCase):
    def test_loading_legacy_file_excludes_user_session_cookies(self):
        payload = {
            'cookies': {
                'VSG_SESSIONID': 'vpn',
                'VSG_LANGUAGE': 'zh_CN',
                'JSESSIONID': 'student',
                'mapid': 'mapping',
                'route': 'backend',
            }
        }
        with tempfile.TemporaryDirectory() as directory:
            cookie_file = Path(directory) / 'vpn_cookie.json'
            cookie_file.write_text(json.dumps(payload), encoding='utf-8')
            with patch.object(login_module, 'VPN_COOKIE_FILE', str(cookie_file)):
                cookies = login_module.load_shared_vpn_cookies()

        self.assertEqual(
            cookies,
            {'VSG_SESSIONID': 'vpn', 'VSG_LANGUAGE': 'zh_CN'},
        )

    def test_saving_shared_file_excludes_user_session_cookies(self):
        with tempfile.TemporaryDirectory() as directory:
            cookie_file = Path(directory) / 'vpn_cookie.json'
            with patch.object(login_module, 'VPN_COOKIE_FILE', str(cookie_file)):
                login_module.save_shared_vpn_cookies({
                    'VSG_SESSIONID': 'vpn',
                    'JSESSIONID': 'student',
                    'mapid': 'mapping',
                    'route': 'backend',
                })
                payload = json.loads(cookie_file.read_text(encoding='utf-8'))

        self.assertEqual(payload['cookies'], {'VSG_SESSIONID': 'vpn'})

    def test_shared_cookie_save_replaces_complete_file_atomically(self):
        old_payload = {
            'cookies': {'VSG_SESSIONID': 'old'},
            'updated_at': 1,
        }
        dump_started = threading.Event()
        release_dump = threading.Event()
        errors = []
        original_dump = login_module.json.dump

        def blocked_dump(payload, stream, **kwargs):
            dump_started.set()
            if not release_dump.wait(2):
                raise AssertionError('test did not release JSON dump')
            return original_dump(payload, stream, **kwargs)

        with tempfile.TemporaryDirectory() as directory:
            cookie_file = Path(directory) / 'vpn_cookie.json'
            old_bytes = json.dumps(old_payload).encode('utf-8')
            cookie_file.write_bytes(old_bytes)

            def save():
                try:
                    login_module.save_shared_vpn_cookies({
                        'VSG_SESSIONID': 'fresh',
                    })
                except Exception as exc:
                    errors.append(exc)

            with patch.object(
                login_module, 'VPN_COOKIE_FILE', str(cookie_file),
            ), patch.object(
                login_module.json, 'dump', side_effect=blocked_dump,
            ):
                thread = threading.Thread(target=save)
                thread.start()
                self.assertTrue(dump_started.wait(2))
                try:
                    self.assertEqual(cookie_file.read_bytes(), old_bytes)
                finally:
                    release_dump.set()
                    thread.join(2)

            payload = json.loads(cookie_file.read_text(encoding='utf-8'))
            remaining_files = [path.name for path in Path(directory).iterdir()]

        self.assertEqual(errors, [])
        self.assertEqual(payload['cookies'], {'VSG_SESSIONID': 'fresh'})
        self.assertEqual(remaining_files, ['vpn_cookie.json'])


class ResponseClassificationTests(unittest.TestCase):
    def test_http_200_vpn_timeout_page_is_not_alive(self):
        response = make_response(
            '<script>var errcode="0x10000001";'
            'var errmsg="session expired";</script>'
            '<script>sslvpn({pageName: "error"});</script>'
        )
        session = SequenceSession([response])

        self.assertFalse(login_module.vpn_session_alive(session))

    def test_http_200_maintenance_page_is_not_alive(self):
        response = make_response(
            '<html><title>\u7f51\u7ad9\u7ef4\u62a4</title>'
            '<body>\u7f51\u7ad9\u6b63\u5728\u7ef4\u62a4\u4e2d</body></html>'
        )
        session = SequenceSession([response])

        self.assertFalse(login_module.vpn_session_alive(session))

    def test_urp_login_page_proves_vpn_channel_is_alive(self):
        response = make_response(
            '<form name="loginForm" '
            'action="/7b68f983/loginAction.do"></form>'
        )
        session = SequenceSession([response])

        self.assertTrue(login_module.vpn_session_alive(session))

    def test_urp_frameset_is_logged_in_and_alive(self):
        response = make_response(
            '<frameset><frame src="/7b68f983/menu/top.jsp">'
            '<frame src="/7b68f983/menu/mainFrame.jsp"></frameset>'
        )
        session = SequenceSession([response])

        self.assertTrue(login_module.vpn_session_alive(session))
        self.assertTrue(login_module._looks_logged_in(response))


class VPNRecoveryTests(unittest.TestCase):
    def test_recovery_reauthenticates_and_returns_fresh_vpn_cookies(self):
        stale = make_response(
            '<script>var errmsg="session expired";'
            'sslvpn({pageName: "error"});</script>'
        )
        login_page = make_response(
            '<form name="loginForm" '
            'action="/7b68f983/loginAction.do"></form>'
        )
        session = SequenceSession([stale, login_page])
        session.cookies.set('JSESSIONID', 'student-session')

        with patch.object(
            login_module,
            'load_shared_vpn_cookies',
            side_effect=[
                {'VSG_SESSIONID': 'stale'},
                {'VSG_SESSIONID': 'fresh'},
            ],
        ), patch.object(
            login_module.URP_login,
            '_vpn_password_auth',
            return_value=(True, 'VPN auth success'),
        ):
            cookies = login_module.recover_vpn_session(
                session,
                'https://223.112.21.198:6443/7b68f983/',
            )

        self.assertEqual(cookies, {'VSG_SESSIONID': 'fresh'})
        self.assertEqual(
            session.cookies.get('JSESSIONID'),
            'student-session',
        )

    def test_recovery_raises_clear_error_when_vpn_auth_fails(self):
        stale = make_response(
            '<script>var errmsg="session expired";'
            'sslvpn({pageName: "error"});</script>'
        )
        session = SequenceSession([stale])

        with patch.object(
            login_module,
            'load_shared_vpn_cookies',
            return_value={'VSG_SESSIONID': 'stale'},
        ), patch.object(
            login_module.URP_login,
            '_vpn_password_auth',
            return_value=(False, 'VPN auth failed'),
        ):
            with self.assertRaisesRegex(
                login_module.VPNUnavailableError,
                '\u5df2\u81ea\u52a8\u91cd\u8fde\u4f46\u672a\u6210\u529f',
            ):
                login_module.recover_vpn_session(
                    session,
                    'https://223.112.21.198:6443/7b68f983/',
                )

    def test_recovery_reuses_session_refreshed_by_another_request(self):
        login_page = make_response(
            '<form name="loginForm" '
            'action="/7b68f983/loginAction.do"></form>'
        )
        session = SequenceSession([login_page])

        with patch.object(
            login_module,
            'load_shared_vpn_cookies',
            return_value={'VSG_SESSIONID': 'fresh'},
        ), patch.object(
            login_module.URP_login,
            '_vpn_password_auth',
        ) as password_auth:
            cookies = login_module.recover_vpn_session(
                session,
                'https://223.112.21.198:6443/7b68f983/',
            )

        self.assertEqual(cookies, {'VSG_SESSIONID': 'fresh'})
        password_auth.assert_not_called()

    def test_ensure_vpn_session_reuses_global_login_without_password_auth(self):
        login = login_module.URP_login(
            'https://223.112.21.198:6443/7b68f983/',
            'student',
            'password',
        )
        with patch.object(
            login_module,
            'load_shared_vpn_cookies',
            return_value={'VSG_SESSIONID': 'alive'},
        ), patch.object(
            login_module,
            'vpn_session_alive',
            return_value=True,
        ), patch.object(
            login_module.URP_login,
            '_vpn_password_auth',
        ) as password_auth:
            success, _ = login._ensure_vpn_session()

        self.assertTrue(success)
        password_auth.assert_not_called()

    def test_concurrent_failed_recovery_is_single_flight(self):
        class ObservedLock:
            def __init__(self):
                self._lock = threading.Lock()
                self._guard = threading.Lock()
                self.acquire_count = 0
                self.second_acquire_started = threading.Event()

            def __enter__(self):
                with self._guard:
                    self.acquire_count += 1
                    if self.acquire_count == 2:
                        self.second_acquire_started.set()
                self._lock.acquire()
                return self

            def __exit__(self, exc_type, exc_value, traceback):
                self._lock.release()

        observed_lock = ObservedLock()
        workers_ready = threading.Barrier(3)
        auth_started = threading.Event()
        release_auth = threading.Event()
        errors = []

        def fail_auth():
            auth_started.set()
            if not release_auth.wait(2):
                raise AssertionError('test did not release VPN auth')
            return False, 'VPN auth failed once'

        def recover():
            workers_ready.wait()
            try:
                login_module.recover_vpn_session(
                    requests.Session(),
                    'https://223.112.21.198:6443/7b68f983/',
                )
            except login_module.VPNUnavailableError as exc:
                errors.append(str(exc))

        with patch.object(
            login_module, '_VPN_LOCK', observed_lock,
        ), patch.object(
            login_module,
            'load_shared_vpn_cookies',
            return_value={'VSG_SESSIONID': 'stale'},
        ), patch.object(
            login_module, 'vpn_session_alive', return_value=False,
        ), patch.object(
            login_module, 'clear_shared_vpn_cookies',
        ), patch.object(
            login_module.URP_login,
            '_vpn_password_auth',
            side_effect=fail_auth,
        ) as password_auth:
            threads = [threading.Thread(target=recover) for _ in range(2)]
            for thread in threads:
                thread.start()
            workers_ready.wait()
            self.assertTrue(auth_started.wait(2))
            self.assertTrue(observed_lock.second_acquire_started.wait(2))
            release_auth.set()
            for thread in threads:
                thread.join(2)

            self.assertEqual(len(errors), 2)
            self.assertEqual(errors[0], errors[1])
            self.assertIn('VPN auth failed once', errors[0])
            self.assertEqual(password_auth.call_count, 1)

            with self.assertRaisesRegex(
                login_module.VPNUnavailableError,
                'VPN auth failed once',
            ):
                login_module.recover_vpn_session(
                    requests.Session(),
                    'https://223.112.21.198:6443/7b68f983/',
                )

        self.assertEqual(password_auth.call_count, 2)

    def test_stale_keepalive_cannot_erase_recovered_global_cookie(self):
        class ObservedLock:
            def __init__(self):
                self._lock = threading.Lock()
                self._guard = threading.Lock()
                self.acquire_count = 0
                self.second_acquire_started = threading.Event()

            def __enter__(self):
                with self._guard:
                    self.acquire_count += 1
                    if self.acquire_count == 2:
                        self.second_acquire_started.set()
                self._lock.acquire()
                return self

            def __exit__(self, exc_type, exc_value, traceback):
                self._lock.release()

        keepalive_once = getattr(login_module, '_vpn_keepalive_once', None)
        self.assertIsNotNone(keepalive_once)

        observed_lock = ObservedLock()
        stale_check_started = threading.Event()
        release_stale_check = threading.Event()
        keepalive_errors = []
        recovery_errors = []
        recovered = []

        def is_alive(session, url=login_module.VPN_KEEPALIVE_URL):
            cookie = session.cookies.get('VSG_SESSIONID')
            if cookie == 'stale':
                stale_check_started.set()
                if not release_stale_check.wait(2):
                    raise AssertionError('test did not release keepalive')
                return False
            return cookie == 'fresh'

        def authenticate():
            login_module.save_shared_vpn_cookies({
                'VSG_SESSIONID': 'fresh',
            })
            return True, 'VPN auth success'

        def run_keepalive():
            try:
                keepalive_once()
            except Exception as exc:
                keepalive_errors.append(exc)

        def run_recovery():
            try:
                recovered.append(login_module.recover_vpn_session(
                    requests.Session(),
                    'https://223.112.21.198:6443/7b68f983/',
                ))
            except Exception as exc:
                recovery_errors.append(exc)

        with tempfile.TemporaryDirectory() as directory, patch.object(
            login_module,
            'VPN_COOKIE_FILE',
            str(Path(directory) / 'vpn_cookie.json'),
        ), patch.object(
            login_module, '_VPN_LOCK', observed_lock,
        ), patch.object(
            login_module, 'vpn_session_alive', side_effect=is_alive,
        ), patch.object(
            login_module.URP_login,
            '_vpn_password_auth',
            side_effect=authenticate,
        ):
            login_module.save_shared_vpn_cookies({
                'VSG_SESSIONID': 'stale',
            })
            keepalive_thread = threading.Thread(target=run_keepalive)
            keepalive_thread.start()
            self.assertTrue(stale_check_started.wait(2))
            recovery_thread = threading.Thread(target=run_recovery)
            recovery_thread.start()
            self.assertTrue(observed_lock.second_acquire_started.wait(2))
            release_stale_check.set()
            keepalive_thread.join(2)
            recovery_thread.join(2)
            final_cookies = login_module.load_shared_vpn_cookies()

        self.assertEqual(keepalive_errors, [])
        self.assertEqual(recovery_errors, [])
        self.assertEqual(recovered, [{'VSG_SESSIONID': 'fresh'}])
        self.assertEqual(final_cookies, {'VSG_SESSIONID': 'fresh'})


class QueryRetryTests(unittest.TestCase):
    def make_query(self, url, responses):
        query = object.__new__(query_module.URP_query)
        query.url = url
        query.account = 'student'
        query.x = SequenceSession(responses)
        query.x.cookies.set('JSESSIONID', 'student-session')
        return query

    def test_vpn_error_recovers_and_retries_original_request_once(self):
        timeout = make_response(
            '<script>var errmsg="session expired";'
            'sslvpn({pageName: "error"});</script>'
        )
        grades = make_response(
            '<table id="user"><tr><td>Calculus</td></tr></table>'
        )
        query = self.make_query(
            'https://223.112.21.198:6443/7b68f983/',
            [timeout, grades],
        )

        with patch.object(
            query_module,
            'recover_vpn_session',
            create=True,
            return_value={'VSG_SESSIONID': 'fresh'},
        ):
            response = query._request(
                'GET',
                query.url + 'gradeLnAllAction.do',
                timeout=10,
            )

        self.assertIn('Calculus', response.text)
        self.assertEqual(len(query.x.requests), 2)
        self.assertEqual(
            query.x.cookies.get('JSESSIONID'),
            'student-session',
        )
        self.assertEqual(
            query.x.cookies.get('VSG_SESSIONID'),
            'fresh',
        )

    def test_second_vpn_error_raises_instead_of_becoming_empty_data(self):
        first = make_response(
            '<script>var errmsg="session expired";'
            'sslvpn({pageName: "error"});</script>'
        )
        second = make_response(
            '<html><title>\u7f51\u7ad9\u7ef4\u62a4</title>'
            '<body>\u7f51\u7ad9\u6b63\u5728\u7ef4\u62a4\u4e2d</body></html>'
        )
        query = self.make_query(
            'https://223.112.21.198:6443/7b68f983/',
            [first, second],
        )

        with patch.object(
            query_module,
            'recover_vpn_session',
            create=True,
            return_value={'VSG_SESSIONID': 'fresh'},
        ):
            with self.assertRaisesRegex(
                login_module.VPNUnavailableError,
                '\u5df2\u81ea\u52a8\u91cd\u8fde\u4f46\u672a\u6210\u529f',
            ):
                query._request(
                    'GET',
                    query.url + 'gradeLnAllAction.do',
                    timeout=10,
                )

        self.assertEqual(len(query.x.requests), 2)

    def test_non_vpn_request_does_not_recover_or_retry(self):
        response = make_response(
            '<script>var errmsg="session expired";'
            'sslvpn({pageName: "error"});</script>',
            url='http://192.168.16.207:9001/',
        )
        query = self.make_query(
            'http://192.168.16.207:9001/',
            [response],
        )

        with patch.object(
            query_module,
            'recover_vpn_session',
            create=True,
        ) as recover:
            returned = query._request('GET', query.url, timeout=10)

        self.assertIs(returned, response)
        self.assertEqual(len(query.x.requests), 1)
        recover.assert_not_called()


if __name__ == '__main__':
    unittest.main()
