"""真实登录探测与服务组合，避免 Mock 掩盖 Cookie 失效分支。"""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import requests
from flask import Flask, g
from services import urp_service as service
from urp import login as login_module, session_store

URL = 'http://urp-regression.test/'
FORM = '<form name="loginForm" action="loginAction.do"></form>'


def response(text, status=200, url=URL):
    result = requests.Response()
    result.status_code = status
    result._content = text.encode('utf-8')
    result.encoding = 'utf-8'
    result.url = url
    return result


class CookieRecoveryRegressionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.enterContext(patch.object(session_store, 'USER_DATA_DIR', Path(self.directory.name)))
        service.invalidate_login_cache('student')
        self.addCleanup(lambda: service.invalidate_login_cache('student'))
        session_store.save_user_cookies('student', URL, {'JSESSIONID': 'expired'})
        self.helper = login_module.URP_login(URL, 'student', 'stored', stored_password=True)
        self.addCleanup(self.helper.x.close)
        def relogin():
            session_store.save_user_cookies('student', URL, {'JSESSIONID': 'fresh'})
            self.helper.x.cookies.set('JSESSIONID', 'fresh')
            return True, '登录成功', {'JSESSIONID': 'fresh'}
        self.helper.login = Mock(side_effect=relogin)
        self.enterContext(patch('urp.URP_login', return_value=self.helper))

    def test_expired_cookie_with_top_error_and_root_login_page_relogs_in(self):
        for status in (200, 401, 403, 500, 503):
            with self.subTest(status=status):
                service.invalidate_login_cache('student')
                session_store.save_user_cookies('student', URL, {'JSESSIONID':'expired'})
                self.helper.login.reset_mock()
                self.helper.x.get = Mock(side_effect=[response('session unavailable', status), response(FORM)])
                valid, details = service.check_login_status('student', 'stored', url=URL)
                self.assertTrue(valid)
                self.assertTrue(details.relogged)
                self.helper.login.assert_called_once()

    def test_maintenance_root_preserves_cookie_after_failed_relogin(self):
        self.helper.login.side_effect = None
        self.helper.login.return_value = (False, '学校教务系统暂不可用', None)
        self.helper.x.get = Mock(side_effect=[response('maintenance', 503), response('maintenance', 503)])
        valid, details = service.check_login_status('student', 'stored', url=URL)
        self.assertFalse(valid)
        self.assertTrue(details['retryable'])
        self.helper.login.assert_called_once()
        self.assertTrue(session_store.user_cookie_exists('student', URL))

    def test_transport_timeout_preserves_cookie_when_normal_login_also_fails(self):
        self.helper.login.side_effect = None
        self.helper.login.return_value = (False, '学校教务系统响应超时', None)
        self.helper.x.get = Mock(side_effect=requests.ReadTimeout())
        valid, details = service.check_login_status('student', 'stored', url=URL)
        self.assertFalse(valid)
        self.assertTrue(details['retryable'])
        self.helper.login.assert_called_once()
        self.assertEqual(self.helper.x.get.call_count, 1)
        self.assertTrue(session_store.user_cookie_exists('student', URL))

    def test_temporary_expired_cookie_never_replays_password(self):
        app = Flask(__name__)
        with app.test_request_context('/'):
            g.temporary_session = {'username':'student', 'session_id':'a'*32}
            with patch.object(login_module, 'load_user_cookies', return_value=({'JSESSIONID':'expired'},'scoped')):
                self.helper.x.get = Mock(side_effect=[response('expired', 500), response(FORM)])
                valid, details = service.check_login_status('student', None, url=URL)
        self.assertFalse(valid)
        self.assertFalse(details.get('retryable'))
        self.helper.login.assert_not_called()

    def test_login_form_with_id_is_detected_without_fallback(self):
        self.helper.x.get = Mock(return_value=response('<form id="loginForm" action="loginAction.do"></form>'))
        self.assertFalse(self.helper.is_logined())
        self.assertFalse(self.helper.login_check_uncertain)
        self.assertEqual(self.helper.x.get.call_count,1)

    def test_expired_vpn_health_cache_is_bypassed_during_cookie_probe(self):
        url = login_module.VPN_KEEPALIVE_URL
        helper = login_module.URP_login(url, 'student', 'stored', stored_password=True)
        self.addCleanup(helper.x.close)
        helper._ensure_vpn_session = Mock(return_value=(True, 'cached health'))
        helper.x.get = Mock(side_effect=[
            response('vsg_login', url=login_module.VPN_LOGIN_PAGE),
            response('student', url=url + 'menu/top.jsp'),
        ])
        with patch.object(login_module,'load_user_cookies',return_value=({'JSESSIONID':'user'},'scoped')), patch.object(login_module,'recover_vpn_session',return_value={'VSG_SESSIONID':'fresh'}) as recover:
            self.assertTrue(helper.is_logined())
        recover.assert_called_once_with(helper.x, helper._url(), force=True)
        self.assertFalse(helper.login_check_uncertain)

    def test_status_endpoint_relogs_in_and_subsequent_call_uses_fresh_cookie(self):
        from routes import auth_routes
        app = Flask(__name__)
        app.register_blueprint(auth_routes.auth_bp)
        self.helper.x.get = Mock(side_effect=[response('expired',500),response(FORM)])
        with patch.object(auth_routes,'get_user_by_device',return_value={'username':'student','password':'stored'}), patch.object(auth_routes,'get_current_urp_url',return_value=URL):
            client = app.test_client()
            first = client.get('/api/check_login_status',headers={'X-Device-ID':'test'}).get_json()
            second = client.get('/api/check_login_status',headers={'X-Device-ID':'test'}).get_json()
        self.assertTrue(first['logged_in'])
        self.assertEqual(first['message'],'重新登录成功')
        self.assertTrue(second['logged_in'])
        self.assertEqual(self.helper.x.get.call_count,2)
        self.helper.login.assert_called_once()
        self.assertEqual(session_store.load_user_cookies('student',URL)[0], {'JSESSIONID':'fresh'})
