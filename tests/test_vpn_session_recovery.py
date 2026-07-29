import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import requests

import urp.login as login_module


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


if __name__ == '__main__':
    unittest.main()
