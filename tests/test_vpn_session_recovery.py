import json
import tempfile
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
