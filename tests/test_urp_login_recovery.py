import unittest
from unittest.mock import Mock, patch

import urp.login as login_module
from urp.login import URP_login


class FakeResponse:
    def __init__(self, text, url='http://urp.example/'):
        self.text = text
        self.url = url
        self.status_code = 200
        self.headers = {'Content-Type': 'text/html'}


class LoginPageRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.helper = URP_login('http://urp.example/', 'student', 'password')

    def test_transient_page_without_form_is_refetched(self):
        self.helper.x.get = Mock(side_effect=[
            FakeResponse('<html><title>提示页面</title></html>'),
            FakeResponse('<form name="loginForm" action="/loginAction.do"></form>'),
        ])

        form_url, parser = self.helper._get_login_page()

        self.assertEqual(form_url, 'http://urp.example/')
        self.assertEqual(parser.form_action, '/loginAction.do')
        self.assertEqual(self.helper.x.get.call_count, 2)

    def test_persistent_page_without_form_has_useful_error(self):
        self.helper.x.get = Mock(return_value=FakeResponse(
            '<html><title>提示页面</title></html>'
        ))

        with self.assertRaises(RuntimeError) as raised:
            self.helper._get_login_page()

        self.assertIn('教务登录页', str(raised.exception))
        self.assertNotIn('Could not find loginForm action', str(raised.exception))

    def test_last_captcha_attempt_does_not_fetch_login_page_again(self):
        self.helper._ensure_vpn_session = Mock(return_value=(True, ''))
        self.helper._get_login_page = Mock(return_value=(
            'http://urp.example/',
            login_module._parse_login_form(
                '<form name="loginForm" action="/loginAction.do"></form>'
            ),
        ))
        self.helper._read_captcha = Mock(return_value='1234')
        self.helper._submit_login = Mock(return_value=FakeResponse(
            '<html><title>登录失败</title></html>',
            url='http://urp.example/loginAction.do',
        ))

        with patch.object(login_module, 'MAX_CAPTCHA_ATTEMPTS', 1), \
                patch('ddddocr.DdddOcr', return_value=object()):
            success, message, _ = self.helper.login()

        self.assertFalse(success)
        self.assertIn('登录失败', message)
        self.assertEqual(self.helper._get_login_page.call_count, 1)


if __name__ == '__main__':
    unittest.main()
