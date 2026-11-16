"""主动登录限流：临时存储、可控时钟和模拟上游，不访问真实教务。"""
from concurrent.futures import ProcessPoolExecutor
import ipaddress
import multiprocessing
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from flask import Flask
from routes.auth_routes import auth_bp
from routes.wechat_routes import wechat_bp
from services.login_rate_limit_service import (
    LoginRateLimiter, client_source, init_login_rate_limiting,
)
from urp.login import LOGIN_CREDENTIALS_ERROR


def reserve_in_worker(path):
    return LoginRateLimiter(path, clock=lambda: 1000).begin('198.51.100.10', 'student').retry_after


class LoginRateLimiterTests(unittest.TestCase):
    def setUp(self):
        self.directory = self.enterContext(tempfile.TemporaryDirectory())
        self.path = Path(self.directory) / 'limits.sqlite3'
        self.now = 1000
        self.limiter = LoginRateLimiter(self.path, clock=lambda: self.now)

    def attempt(self, source='198.51.100.10', username='student', message=None):
        ticket = self.limiter.begin(source, username)
        if not ticket.retry_after and message is not None:
            ticket.finish(False, message)
        return ticket

    def test_seven_wrong_passwords_still_allow_correct_login_and_success_clears_errors(self):
        for _ in range(7):
            self.assertEqual(self.attempt(message=LOGIN_CREDENTIALS_ERROR).retry_after, 0)
            self.now += 10
        ticket = self.attempt()
        self.assertEqual(ticket.retry_after, 0)
        ticket.finish(True, '登录成功')
        for _ in range(7):
            self.now += 10
            self.assertEqual(self.attempt(message=LOGIN_CREDENTIALS_ERROR).retry_after, 0)
        self.assertEqual(self.attempt().retry_after, 0)

    def test_eighth_wrong_password_starts_short_cooldown_and_rejected_clicks_do_not_extend_it(self):
        for _ in range(8):
            self.attempt(message=LOGIN_CREDENTIALS_ERROR)
        self.assertEqual(self.attempt().retry_after, 30)
        self.now += 29
        self.assertEqual(self.attempt().retry_after, 1)
        self.now += 1
        ticket = self.attempt()
        self.assertEqual(ticket.retry_after, 0)
        ticket.finish(True, '登录成功')
        self.assertEqual(self.attempt().retry_after, 0)

    def test_campus_neighbors_and_other_sources_are_not_locked_out(self):
        for _ in range(8):
            self.attempt(message=LOGIN_CREDENTIALS_ERROR)
        for index in range(100):
            self.assertEqual(self.attempt(username=f'student{index}').retry_after, 0)
        self.assertEqual(self.attempt(source='198.51.100.11').retry_after, 0)
        self.assertEqual(self.attempt().retry_after, 30)

    def test_captcha_network_maintenance_and_unknown_failures_do_not_start_cooldown(self):
        for message in (
            '登录验证码校验未通过，请重试。', '学校教务系统响应超时，请稍后重试。',
            '学校教务系统正在维护，请稍后重试。', '登录服务暂时出现异常，请稍后重试或联系管理员。',
        ):
            for _ in range(10):
                self.assertEqual(self.attempt(message=message).retry_after, 0)
                self.now += 6

    def test_burst_uses_sliding_window_and_rejections_do_not_slide_expiry(self):
        for _ in range(12):
            self.assertEqual(self.attempt().retry_after, 0)
            self.now += 1
        self.assertEqual(self.attempt().retry_after, 48)
        self.now = 1059.1
        self.assertEqual(self.attempt().retry_after, 1)
        self.now = 1060
        self.assertEqual(self.attempt().retry_after, 0)
        self.assertEqual(self.attempt().retry_after, 1)

    def test_success_does_not_allow_unlimited_rapid_relogin(self):
        for _ in range(12):
            ticket = self.attempt()
            ticket.finish(True, '登录成功')
        self.assertEqual(self.attempt().retry_after, 60)

    def test_failures_age_out_and_late_failures_cannot_restore_cleared_state(self):
        for _ in range(7):
            self.attempt(message=LOGIN_CREDENTIALS_ERROR)
        old_request = self.attempt()
        self.attempt().finish(True, '登录成功')
        old_request.finish(False, LOGIN_CREDENTIALS_ERROR)
        self.now += 61
        for _ in range(7):
            self.attempt(message=LOGIN_CREDENTIALS_ERROR)
        self.assertEqual(self.attempt().retry_after, 0)
        self.now += 600
        self.assertEqual(self.attempt(message=LOGIN_CREDENTIALS_ERROR).retry_after, 0)
        self.assertEqual(self.attempt().retry_after, 0)

    def test_clock_rollback_does_not_lock_out_users(self):
        for _ in range(8):
            self.attempt(message=LOGIN_CREDENTIALS_ERROR)
        self.now -= 100
        self.assertEqual(self.attempt().retry_after, 0)

    def test_state_is_shared_across_processes_and_admission_is_atomic(self):
        self.attempt(username='warmup')
        with ProcessPoolExecutor(max_workers=4, mp_context=multiprocessing.get_context('spawn')) as pool:
            waits = list(pool.map(reserve_in_worker, [str(self.path)] * 20))
        self.assertEqual(waits.count(0), 12)
        self.assertEqual(waits.count(60), 8)
        self.assertEqual(self.attempt().retry_after, 60)

    def test_expired_records_are_cleaned_and_no_plaintext_identity_is_stored(self):
        self.attempt()
        with sqlite3.connect(self.path) as conn:
            dump = '\n'.join(conn.iterdump())
        self.assertNotIn('198.51.100.10', dump)
        self.assertNotIn('student', dump)
        self.now += 600
        self.attempt(username='another-student')
        with sqlite3.connect(self.path) as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM login_limits').fetchone()[0], 1)

    def test_unavailable_or_corrupt_storage_allows_login(self):
        for path in (Path(self.directory), self.path):
            if path == self.path:
                path.write_text('not a sqlite database')
            limiter = LoginRateLimiter(path)
            self.assertEqual(limiter.begin('198.51.100.10', 'student').retry_after, 0)


class ClientSourceTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.trusted = tuple(map(ipaddress.ip_network, ['127.0.0.1/32', '::1/128', '10.0.0.0/24']))

    def source(self, peer, forwarded='', trusted=None):
        with self.app.test_request_context('/', headers={'X-Forwarded-For': forwarded},
                                           environ_overrides={'REMOTE_ADDR': peer}):
            return client_source(self.trusted if trusted is None else trusted)

    def test_public_client_cannot_choose_its_own_source_using_forwarded_header(self):
        self.assertEqual(self.source('198.51.100.10', '203.0.113.2'), '198.51.100.10')

    def test_trusted_local_nginx_uses_rightmost_untrusted_hop_not_spoofed_leftmost(self):
        self.assertEqual(self.source('127.0.0.1', '203.0.113.2, 198.51.100.10'), '198.51.100.10')
        self.assertEqual(self.source('127.0.0.1', '198.51.100.10, 10.0.0.5'), '198.51.100.10')

    def test_ipv6_is_normalized_and_ipv4_mapped_addresses_share_limits(self):
        self.assertEqual(self.source('::ffff:198.51.100.10'), '198.51.100.10')
        self.assertEqual(self.source('::1', '2001:0db8:0:0:0:0:0:1'), '2001:db8::1')

    def test_missing_or_invalid_forwarded_data_uses_peer_without_trusting_other_headers(self):
        self.assertEqual(self.source('127.0.0.1'), '127.0.0.1')
        self.assertEqual(self.source('127.0.0.1', '203.0.113.1, invalid'), '127.0.0.1')
        self.assertEqual(self.source('127.0.0.1', '198.51.100.10', trusted=()), '127.0.0.1')
        self.assertIsNone(self.source(None))


class LoginRateLimitRouteTests(unittest.TestCase):
    def setUp(self):
        self.directory = self.enterContext(tempfile.TemporaryDirectory())
        self.app = Flask(__name__)
        self.app.testing = True
        self.app.config['LOGIN_RATE_LIMIT_PATH'] = str(Path(self.directory) / 'limits.sqlite3')
        init_login_rate_limiting(self.app)
        self.now = 1000
        self.app.extensions['login_rate_limit'][0].clock = lambda: self.now
        self.app.register_blueprint(auth_bp)
        self.app.register_blueprint(wechat_bp)
        self.client = self.app.test_client()
        self.upstream = self.enterContext(patch('routes.auth_routes.urp_login', return_value=(
            False, '学校教务系统响应超时，请稍后重试。', None,
        )))

    def login(self, username='student', ip='198.51.100.10', device='device', **headers):
        return self.client.post('/api/login', json={
            'username': username, 'password': 'private-password', 'bind_account': False,
        }, headers={'X-Device-ID': device, **headers}, environ_overrides={'REMOTE_ADDR': ip})

    def test_thirteenth_submission_is_rejected_before_expensive_upstream_login(self):
        for _ in range(12):
            self.assertEqual(self.login().status_code, 200)
        response = self.login()
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.json['code'], 'LOGIN_RATE_LIMITED')
        self.assertFalse(response.json['success'])
        self.assertEqual(response.headers['Retry-After'], str(response.json['retry_after']))
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertEqual(self.upstream.call_count, 12)

    def test_changing_device_id_or_forging_forwarded_headers_does_not_bypass_limit(self):
        for index in range(12):
            self.assertEqual(self.login(device=f'device-{index}', **{
                'X-Forwarded-For': f'203.0.113.{index + 1}',
            }).status_code, 200)
        self.assertEqual(self.login(device='new-device', **{'X-Real-IP': '203.0.113.99'}).status_code, 429)

    def test_web_credential_failures_start_cooldown_but_other_accounts_still_work(self):
        self.upstream.return_value = False, LOGIN_CREDENTIALS_ERROR, None
        for _ in range(8):
            self.assertEqual(self.login().status_code, 200)
        self.assertEqual(self.login().status_code, 429)
        self.assertEqual(self.login(username='neighbor').status_code, 200)
        self.assertEqual(self.login(ip='198.51.100.11').status_code, 200)
        self.now += 30
        self.assertEqual(self.login().status_code, 200)

    def test_web_and_authenticated_wechat_bind_share_budget(self):
        for _ in range(12):
            self.login()
        with patch('auth.get_wechat_request_session', return_value={'openid': 'openid'}), \
                patch('routes.wechat_routes.CredentialCipher.validate_configuration'), \
                patch('routes.wechat_routes.get_account', return_value=None), \
                patch('routes.wechat_routes.urp_login') as wechat_upstream:
            response = self.client.post('/api/wechat/bind', json={
                'username': 'student', 'password': 'private-password',
            }, environ_overrides={'REMOTE_ADDR': '198.51.100.10'})
        self.assertEqual(response.status_code, 429)
        wechat_upstream.assert_not_called()

    def test_rate_limit_does_not_affect_binding_checks_or_automatic_relogin(self):
        for _ in range(12):
            self.login()
        user = {'username': 'student', 'password': 'encrypted'}
        with patch('routes.auth_routes.get_user_by_device', return_value=user), \
                patch('routes.auth_routes.check_login_status', return_value=(True, {})), \
                patch('routes.auth_routes.get_current_urp_url', return_value='https://urp.example/'):
            self.assertTrue(self.client.get('/api/check_bind', headers={'X-Device-ID': 'device'}).json['bound'])
            self.assertTrue(self.client.get('/api/check_login_status', headers={'X-Device-ID': 'device'}).json['logged_in'])

    def test_disabled_limiter_preserves_original_login_behavior(self):
        self.app.config['LOGIN_RATE_LIMIT_ENABLED'] = False
        for _ in range(20):
            self.assertEqual(self.login().status_code, 200)

    def test_valid_success_after_cooldown_preserves_temporary_login_contract(self):
        self.upstream.return_value = False, LOGIN_CREDENTIALS_ERROR, None
        for _ in range(8):
            self.login()
        self.assertEqual(self.login().status_code, 429)
        self.now += 30
        self.upstream.return_value = True, '登录成功', {'JSESSIONID': 'cookie'}
        with patch('routes.auth_routes.save_temporary_session', return_value=2000), \
                patch('routes.auth_routes.get_current_urp_url', return_value='https://urp.example/'), \
                patch('routes.auth_routes.record_daily_activity'):
            response = self.login()
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json['success'])
        self.assertTrue(response.json['temporary'])
        self.assertEqual(response.json['expires_at'], 2000)
        self.upstream.return_value = False, LOGIN_CREDENTIALS_ERROR, None
        self.assertEqual(self.login().status_code, 200)


if __name__ == '__main__':
    unittest.main()
