"""登录失败反馈回归：只模拟外部教务响应，不使用真实账号或 OCR。"""
from contextlib import ExitStack
import json
import unittest
from unittest.mock import Mock, patch

import requests
from flask import Flask

from routes.auth_routes import auth_bp
from services import urp_service
from urp import login as login_module
from urp.login import URP_login

FORM = '<form name="loginForm" action="/loginAction.do"><input name="token" value="fake"></form>'
HOME = '<html>menu/top.jsp menu/mainFrame.jsp</html>'
SECRET = 'private-upstream-detail'


def response(html, status=200):
    result = requests.Response()
    result.status_code = status
    result.url = 'http://urp.example/loginAction.do?ticket=' + SECRET
    result.headers['Content-Type'] = 'text/html'
    result._content = html.encode('gbk')
    result.encoding = 'gbk'
    return result


class LoginFailureMessageTests(unittest.TestCase):
    def setUp(self):
        self.helper = URP_login('http://urp.example/', 'synthetic-student', 'synthetic-password', persist_cookies=False)
        self.addCleanup(self.helper.x.close)
        self.stack = self.enterContext(ExitStack())
        self.stack.enter_context(patch.object(login_module, 'MAX_CAPTCHA_ATTEMPTS', 2))
        self.stack.enter_context(patch('urp.login.time.sleep'))
        self.stack.enter_context(patch('ddddocr.DdddOcr', return_value=object()))
        self.helper.x.get = Mock(return_value=response(FORM))
        self.helper.x.post = Mock()
        self.helper._read_captcha = Mock(return_value='1234')

    def assert_safe_failure(self, result, expected):
        self.assertEqual(result, (False, expected, None))
        for internal in (SECRET, 'URL=', 'Body=', 'Content-Type=', 'HTML_PAGE', '最后页面', 'Traceback', 'synthetic-password'):
            self.assertNotIn(internal, result[1])

    def test_explicit_bad_credentials_have_actionable_message_without_repeating_login(self):
        self.helper.x.post.return_value = response('<table><td class="errorTop">用户名或密码不正确！</td></table>')
        result = self.helper.login()
        self.assert_safe_failure(result, '学号或密码不正确，请核对后重试。')
        self.assertEqual(self.helper.x.post.call_count, 1)

    def test_top_level_alert_can_report_an_explicit_credential_rejection(self):
        self.helper.x.post.return_value = response('<script>window.alert("密码错误！"); window.location="loginAction.do";</script>')
        self.assert_safe_failure(self.helper.login(), '学号或密码不正确，请核对后重试。')

    def test_unused_validation_script_does_not_falsely_blame_the_password(self):
        self.helper.x.post.return_value = response(FORM + '<script>function check(){ alert("密码错误"); }</script>')
        result = self.helper.login()
        self.assertFalse(result[0])
        self.assertNotIn('学号或密码不正确', result[1])
        self.assertNotIn('最后页面', result[1])

    def test_hidden_error_templates_do_not_stop_a_successful_captcha_retry(self):
        hidden_errors = (
            '<div class="error" hidden>密码错误</div>',
            '<div class="error" style="display: none !important">密码错误</div>',
            '<div aria-hidden="true"><div class="error">密码错误</div></div>',
            '<div style="visibility: hidden"><span class="error">密码错误</span></div>',
            '<template><span class="error">密码错误</span></template>',
            '<script type="text/template">alert("密码错误")</script>',
            '<script type="application/json">alert("密码错误")</script>',
            '<script src="login.js">alert("密码错误")</script>',
        )
        for hidden in hidden_errors:
            with self.subTest(hidden=hidden):
                self.helper.x.post.reset_mock()
                self.helper.x.post.side_effect = [response(
                    FORM + hidden + '<td class="errorTop">验证码错误</td>'
                ), response(HOME)]
                self.assertEqual(self.helper.login(), (True, '登录成功', {}))
                self.assertEqual(self.helper.x.post.call_count, 2)

    def test_captcha_rejection_retries_and_reports_automatic_verification_failure(self):
        self.helper.x.post.return_value = response('<td class="errorTop">验证码不正确，请重新输入</td>')
        self.assert_safe_failure(self.helper.login(), '登录验证码校验未通过，请重试。')
        self.assertEqual(self.helper.x.post.call_count, 2)

    def test_captcha_retry_can_still_succeed(self):
        self.helper.x.post.side_effect = [response('<td class="errorTop">验证码错误</td>'), response(HOME)]
        self.assertEqual(self.helper.login(), (True, '登录成功', {}))
        self.assertEqual(self.helper.x.post.call_count, 2)

    def test_explicit_account_lock_is_not_reported_as_a_wrong_password(self):
        self.helper.x.post.return_value = response('<div role="alert">账号已锁定</div>')
        self.assert_safe_failure(self.helper.login(), '教务账号暂时被限制登录，请到学校教务系统确认账号状态。')
        self.assertEqual(self.helper.x.post.call_count, 1)

    def test_http_error_is_not_treated_as_a_homepage_or_bad_password(self):
        self.helper.x.post.return_value = response(HOME + '<td class="errorTop">密码错误</td>', status=503)
        self.assert_safe_failure(self.helper.login(), '学校教务系统暂不可用，请稍后重试。')

    def test_maintenance_page_reports_maintenance(self):
        self.helper.x.post.return_value = response('<html><h1>网站正在维护</h1></html>')
        self.assert_safe_failure(self.helper.login(), '学校教务系统正在维护，请稍后重试。')

    def test_unknown_page_never_leaks_response_body_or_guesses_password_failure(self):
        self.helper.x.post.return_value = response('<html><h1>提示页面</h1>' + SECRET + '</html>')
        result = self.helper.login()
        self.assert_safe_failure(result, '教务登录失败，请稍后重试，或先到学校教务系统确认账号能否登录。')

    def test_submit_timeout_has_a_network_message_without_raw_exception(self):
        self.helper.x.post.side_effect = requests.ReadTimeout(SECRET)
        self.assert_safe_failure(self.helper.login(), '学校教务系统响应超时，请稍后重试。')

    def test_connection_failure_does_not_blame_credentials(self):
        self.helper.x.post.side_effect = requests.ConnectionError(SECRET)
        self.assert_safe_failure(self.helper.login(), '暂时无法连接学校教务系统，请稍后重试。')

    def test_vpn_bootstrap_exception_is_inside_the_failure_boundary(self):
        self.helper._ensure_vpn_session = Mock(side_effect=requests.ReadTimeout(SECRET))
        self.assert_safe_failure(self.helper.login(), '学校教务系统响应超时，请稍后重试。')

    def test_vpn_failure_details_are_not_forwarded_to_the_browser(self):
        self.helper._ensure_vpn_session = Mock(return_value=(False, 'VPN_AUTH_PAGE; Body=' + SECRET))
        self.assert_safe_failure(self.helper.login(), '教务连接暂不可用，请稍后重试。')

    def test_captcha_image_failure_has_a_specific_message(self):
        del self.helper._read_captcha
        self.helper.x.get.side_effect = [response(FORM), response('<html>' + SECRET + '</html>')]
        self.assert_safe_failure(self.helper.login(), '暂时无法获取登录验证码，请稍后重试。')

    def test_login_page_failure_hides_page_titles(self):
        self.helper.x.get.return_value = response('<html><title>' + SECRET + '</title></html>')
        self.assert_safe_failure(self.helper.login(), '暂时无法打开学校教务登录页，请稍后重试。')

    def test_ocr_failure_has_an_actionable_message_without_dependency_details(self):
        self.stack.enter_context(patch('ddddocr.DdddOcr', side_effect=RuntimeError('onnxruntime ' + SECRET)))
        self.assert_safe_failure(self.helper.login(), '登录验证码识别服务暂不可用，请稍后重试或联系管理员。')

    def test_login_api_returns_safe_message_and_does_not_persist_failed_login(self):
        self.helper.x.post.return_value = response('<html>' + SECRET + '</html>')
        app = Flask(__name__)
        app.register_blueprint(auth_bp)
        with patch('urp.URP_login', return_value=self.helper), \
             patch('services.urp_service.get_current_urp_url', return_value='http://urp.example/'), \
             patch('routes.auth_routes.save_temporary_session') as save:
            reply = app.test_client().post('/api/login', headers={'X-Device-ID': 'offline-device'},
                json={'username': 'synthetic-student', 'password': 'synthetic-password', 'bind_account': False})
        self.assertEqual(reply.status_code, 200)
        self.assertFalse(reply.json['success'])
        self.assertNotIn(SECRET, json.dumps(reply.json))
        self.assertNotIn('最后页面', reply.json['message'])
        save.assert_not_called()

    def test_service_exception_boundary_never_exposes_raw_constructor_errors(self):
        with patch('urp.URP_login', side_effect=RuntimeError(SECRET)), \
             patch('services.urp_service.get_current_urp_url', return_value='http://urp.example/'):
            result = urp_service.urp_login('synthetic-student', 'synthetic-password')
        self.assert_safe_failure(result, '登录服务暂时出现异常，请稍后重试或联系管理员。')


if __name__ == '__main__':
    unittest.main()
