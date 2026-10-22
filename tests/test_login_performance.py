"""登录热路径回归：全部使用模拟上游。"""
import requests
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock, patch
from flask import Flask, g
from services import urp_service as service

VPN = 'https://223.112.21.198:6443/7b68f983/'


class LoginPerformanceTests(unittest.TestCase):
    def setUp(self):
        service._login_cache.clear()
        if hasattr(service, '_login_failures'):
            service._login_failures.clear()
        self.helper = Mock()
        self.helper.is_logined.return_value = True
        self.helper.x.cookies = requests.cookies.RequestsCookieJar()
        self.helper.login_check_uncertain = False
        self.addCleanup(patch.stopall)
        patch('urp.URP_login', return_value=self.helper).start()
        patch.object(service, 'user_cookie_exists', return_value=True).start()
        patch.object(service, 'delete_user_cookies').start()

    def test_vpn_burst_uses_one_check(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: service.check_login_status('perf', None, url=VPN)[0], range(8)))
        self.assertTrue(all(results))
        self.assertEqual(self.helper.is_logined.call_count, 1)

    def test_uncertain_check_preserves_cookie_and_does_not_login(self):
        self.helper.is_logined.return_value = False
        self.helper.login_check_uncertain = True
        valid, details = service.check_login_status('perf', None, url=VPN)
        self.assertFalse(valid)
        self.assertTrue(details['retryable'])
        service.delete_user_cookies.assert_not_called()
        self.helper.login.assert_not_called()

    def test_failed_login_is_cooled_down_and_invalidation_allows_retry(self):
        self.helper.is_logined.return_value = False
        self.helper.login.return_value = (False, '暂不可用', None)
        for _ in range(4):
            self.assertFalse(service.check_login_status('perf', None, url=VPN)[0])
        self.assertEqual(self.helper.login.call_count, 1)
        service.invalidate_login_cache('perf')
        service.check_login_status('perf', None, url=VPN)
        self.assertEqual(self.helper.login.call_count, 2)

    def test_temporary_cache_isolated_by_session(self):
        app = Flask(__name__)
        for session_id in ('a', 'b'):
            with app.test_request_context('/'):
                g.temporary_session = {'session_id': session_id, 'username': 'perf'}
                for _ in range(2):
                    self.assertTrue(service.check_login_status('perf', None, url=VPN)[0])
        self.assertEqual(self.helper.is_logined.call_count, 2)

    def test_login_locks_released_after_use(self):
        service.check_login_status('perf', None, url=VPN)
        self.assertEqual(len(service._login_locks), 0)

    def test_vpn_success_cache_expires(self):
        with patch.object(service.time, 'time', return_value=100):
            service.check_login_status('perf', None, url=VPN)
        with patch.object(service.time, 'time', return_value=131):
            service.check_login_status('perf', None, url=VPN)
        self.assertEqual(self.helper.is_logined.call_count, 2)
