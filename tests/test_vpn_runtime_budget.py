"""VPN 热路径与上游状态判断回归；所有网络均使用本地替身。"""
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import requests
from urp import login as login_module
from urp import query as query_module


URL = login_module.VPN_KEEPALIVE_URL


class VPNRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.file_patch = patch.object(login_module, 'VPN_COOKIE_FILE', str(Path(self.directory.name) / 'vpn.json'))
        self.file_patch.start()
        self.addCleanup(self.file_patch.stop)
        login_module.save_shared_vpn_cookies({'VSG_SESSIONID': 'first'})
        self.network = patch.object(login_module, 'vpn_session_alive', return_value=True).start()
        self.addCleanup(patch.stopall)

    def test_healthy_requests_probe_once_and_keep_user_cookies_separate(self):
        for account in ('alice', 'bob'):
            session = requests.Session()
            session.cookies.set('JSESSIONID', account)
            self.assertEqual(login_module.recover_vpn_session(session, URL), {'VSG_SESSIONID': 'first'})
            self.assertEqual(session.cookies.get('JSESSIONID'), account)
        self.assertEqual(self.network.call_count, 1)

    def test_cookie_version_and_channel_each_require_new_probe(self):
        for channel in (URL, URL + 'other/'):
            login_module.recover_vpn_session(requests.Session(), channel)
        login_module.save_shared_vpn_cookies({'VSG_SESSIONID': 'second'})
        login_module.recover_vpn_session(requests.Session(), URL)
        self.assertEqual(self.network.call_count, 3)

    def test_healthy_fast_path_does_not_wait_for_recovery_lock(self):
        login_module.recover_vpn_session(requests.Session(), URL)
        with login_module._VPN_LOCK:
            with ThreadPoolExecutor(max_workers=1) as pool:
                job = pool.submit(login_module.recover_vpn_session, requests.Session(), URL)
                # Release lock even if the old implementation blocks.
                try:
                    self.assertEqual(job.result(timeout=.2), {'VSG_SESSIONID': 'first'})
                finally:
                    login_module._VPN_LOCK.release()
                    job.result(timeout=2)
                    login_module._VPN_LOCK.acquire()

    def test_failed_recovery_is_reused_until_short_cooldown_expires(self):
        self.network.return_value = False
        with patch.object(login_module.URP_login, '_vpn_password_auth', return_value=(False, 'failed')) as auth, \
                patch.object(login_module.time, 'monotonic', return_value=100) as clock:
            for _ in range(2):
                with self.assertRaises(login_module.VPNUnavailableError):
                    login_module.recover_vpn_session(requests.Session(), URL)
            self.assertEqual(auth.call_count, 1)
            clock.return_value = 200
            with self.assertRaises(login_module.VPNUnavailableError):
                login_module.recover_vpn_session(requests.Session(), URL)
            self.assertEqual(auth.call_count, 2)

    def test_business_vpn_failure_bypasses_recent_healthy_probe(self):
        session = requests.Session()
        login_module.recover_vpn_session(session, URL)
        stale = SimpleNamespace(status_code=200, url=login_module.VPN_LOGIN_PAGE,
                                text='VPN auth', raise_for_status=lambda: None)
        healthy = SimpleNamespace(status_code=200, url=URL, text='grades', raise_for_status=lambda: None)
        session.request = Mock(side_effect=[stale, healthy])
        query = object.__new__(query_module.URP_query)
        query.url, query.x = URL, session

        def authenticate():
            login_module.save_shared_vpn_cookies({'VSG_SESSIONID': 'fresh'})
            return True, 'ok'

        with patch.object(login_module.URP_login, '_vpn_password_auth', side_effect=authenticate) as auth:
            self.assertEqual(query._request('GET', URL).text, 'grades')
        self.assertEqual(auth.call_count, 1)
        self.assertEqual(session.cookies.get('VSG_SESSIONID'), 'fresh')

    def test_expired_health_entry_probes_again(self):
        with patch.object(login_module.time, 'monotonic', return_value=100) as clock:
            login_module.recover_vpn_session(requests.Session(), URL)
            clock.return_value = 200
            login_module.recover_vpn_session(requests.Session(), URL)
        self.assertEqual(self.network.call_count, 2)

    def test_keepalive_failure_invalidates_cached_health_even_for_same_cookie(self):
        login_module.recover_vpn_session(requests.Session(), URL)
        self.network.return_value = False
        login_module._vpn_keepalive_once()
        login_module.save_shared_vpn_cookies({'VSG_SESSIONID': 'first'})
        self.network.return_value = True
        login_module.recover_vpn_session(requests.Session(), URL)
        self.assertEqual(self.network.call_count, 3)


class LoginUncertainTests(unittest.TestCase):
    def test_timeout_server_error_and_unknown_page_are_not_explicit_invalidity(self):
        cases = [requests.ReadTimeout(),
                 SimpleNamespace(status_code=503, text='maintenance', url='http://urp.test/'),
                 SimpleNamespace(status_code=200, text='unexpected proxy response', url='http://urp.test/')]
        with patch.object(login_module, 'load_user_cookies', return_value=({'JSESSIONID': 'user'}, 'scoped')):
            for response in cases:
                with self.subTest(response=response):
                    helper = login_module.URP_login('http://urp.test/', 'alice', 'password')
                    helper.x.get = Mock(side_effect=response) if isinstance(response, Exception) else Mock(return_value=response)
                    self.assertFalse(helper.is_logined())
                    self.assertTrue(getattr(helper, 'login_check_uncertain', False))

    def test_explicit_login_page_and_wrong_account_remain_invalid(self):
        cases = ['<form name="loginForm" action="loginAction.do"></form>',
                 '<div>学生个人课表 学号：bob</div>']
        with patch.object(login_module, 'load_user_cookies', return_value=({'JSESSIONID': 'user'}, 'scoped')):
            for text in cases:
                helper = login_module.URP_login('http://urp.test/', 'alice', 'password')
                helper.x.get = Mock(return_value=SimpleNamespace(status_code=200, text=text, url='http://urp.test/'))
                self.assertFalse(helper.is_logined())
                self.assertFalse(getattr(helper, 'login_check_uncertain', False))


if __name__ == '__main__':
    unittest.main()

class LoginDeadlineTests(unittest.TestCase):
    def test_slow_first_stage_exhausts_budget_before_requesting_captcha(self):
        helper = login_module.URP_login('http://urp.test/', 'alice', 'password')
        helper._ensure_vpn_session = Mock(return_value=(True, ''))
        parser = login_module._parse_login_form('<form name="loginForm" action="loginAction.do"></form>')
        clock = [100]
        def slow_page():
            clock[0] = 146
            return 'http://urp.test/', parser
        helper._get_login_page = Mock(side_effect=slow_page)
        helper.x.get = Mock(side_effect=AssertionError('must not start another network request'))
        with patch.object(login_module.time, 'monotonic', side_effect=lambda: clock[0]), patch('ddddocr.DdddOcr', return_value=Mock()):
            success, message, _ = helper.login()
        self.assertFalse(success)
        self.assertIn('超时', message)
        helper.x.get.assert_not_called()
