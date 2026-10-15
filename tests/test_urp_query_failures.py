"""教务请求故障回归：真实 Session/响应、Flask 和临时 SQLite，禁止外网。"""
import json
import math
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime, timedelta

import requests
from flask import Flask

from database import get_db, init_db
from routes.data_routes import data_bp
from services.user_service import bind_user
from urp.login import VPN_BASE_URL, VPNUnavailableError
from urp.query import URP_query

BASE_URL = 'https://urp.example/'
COURSE_HTML = '''<table><tr><td>1</td><td>课程</td><td>老师</td><td>否</td>
<td><img name="survey#@teacher#@王老师#@unused#@高等数学#@content"></td></tr></table>'''


class OfflineAdapter(requests.adapters.BaseAdapter):
    """只替换网络传输，保留请求参数处理、Cookie、响应解码与 HTTP 异常。"""
    def __init__(self, outcomes):
        self.outcomes = iter(outcomes)
        self.calls = []

    def send(self, request, **kwargs):
        self.calls.append((request, kwargs))
        outcome = next(self.outcomes)
        if isinstance(outcome, Exception):
            raise outcome
        status, html = outcome
        response = requests.Response()
        response.status_code = status
        response._content = html.encode('utf-8')
        response.encoding = 'utf-8'
        response.headers['Content-Type'] = 'text/html; charset=utf-8'
        response.url = request.url
        response.request = request
        return response

    def close(self):
        pass


def offline_query(directory, outcomes):
    cookie_file = Path(directory) / 'cookie.json'
    cookie_file.write_text(json.dumps({}), encoding='utf-8')
    with patch('urp.query.user_data_file', return_value=str(cookie_file)):
        query = URP_query(BASE_URL, 'student')
    query.x.trust_env = False
    adapter = OfflineAdapter(outcomes)
    query.x.mount('https://', adapter)
    return query, adapter


class QueryTransportTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = directory.name

    def query(self, outcomes):
        query, adapter = offline_query(self.directory, outcomes)
        self.addCleanup(query.x.close)
        return query, adapter

    def assert_finite_timeout(self, adapter):
        for _, kwargs in adapter.calls:
            timeout = kwargs['timeout']
            values = timeout if isinstance(timeout, tuple) else (timeout,)
            self.assertTrue(all(isinstance(t, (int, float)) and t > 0 and math.isfinite(t)
                                for t in values), f'无限等待参数: {timeout!r}')

    def test_get_and_post_without_timeout_have_finite_transport_limits(self):
        for method in ('GET', 'POST'):
            with self.subTest(method=method):
                query, adapter = self.query([(200, 'ok')])
                self.assertEqual(query._request(method, BASE_URL).text, 'ok')
                self.assert_finite_timeout(adapter)

    def test_none_timeout_does_not_disable_default_limit(self):
        query, adapter = self.query([(200, 'ok')])
        query._request('GET', BASE_URL, timeout=None)
        self.assert_finite_timeout(adapter)

    def test_explicit_short_deadlines_and_connect_read_pairs_are_preserved(self):
        for timeout in (0.2, (0.1, 0.3)):
            with self.subTest(timeout=timeout):
                query, adapter = self.query([(200, 'ok')])
                query._request('GET', BASE_URL, timeout=timeout)
                self.assertEqual(adapter.calls[0][1]['timeout'], timeout)

    def test_upstream_http_errors_are_not_parsed_as_empty_gpa(self):
        for status in (401, 403, 500, 503):
            with self.subTest(status=status):
                query, adapter = self.query([(status, '<html>upstream unavailable</html>')])
                with self.assertRaises(requests.HTTPError):
                    query.score_gpa()
                self.assertEqual(len(adapter.calls), 1)

    def test_timeout_is_propagated_without_replaying_a_submission(self):
        query, adapter = self.query([requests.ReadTimeout('offline timeout')])
        with self.assertRaises(requests.ReadTimeout):
            query._request('POST', BASE_URL, data={'answer': 'value'})
        self.assertEqual(len(adapter.calls), 1)
        self.assert_finite_timeout(adapter)

    def test_vpn_error_recovers_before_http_validation_with_bounded_retry(self):
        query, adapter = self.query([(403, 'vsg_login'), (200, 'recovered')])
        query.url = VPN_BASE_URL + '/urp/'
        with patch('urp.query.recover_vpn_session', return_value={'VSG_TEST': 'fake'}):
            result = query._request('GET', query.url)
        self.assertEqual(result.text, 'recovered')
        self.assertEqual(len(adapter.calls), 2)
        self.assert_finite_timeout(adapter)

    def test_vpn_retry_preserves_explicit_deadline_and_rejects_http_error(self):
        query, adapter = self.query([(200, 'vsg_login'), (503, 'unavailable')])
        query.url = VPN_BASE_URL + '/urp/'
        with patch('urp.query.recover_vpn_session', return_value={}):
            with self.assertRaises(requests.HTTPError):
                query._request('POST', query.url, timeout=0.3)
        self.assertEqual([kwargs['timeout'] for _, kwargs in adapter.calls], [0.3, 0.3])

    def test_vpn_failure_after_recovery_stops_after_two_requests(self):
        query, adapter = self.query([(200, 'vsg_login'), (403, 'vsg_login')])
        query.url = VPN_BASE_URL + '/urp/'
        with patch('urp.query.recover_vpn_session', return_value={}):
            with self.assertRaises(VPNUnavailableError):
                query._request('GET', query.url)
        self.assertEqual(len(adapter.calls), 2)
        self.assert_finite_timeout(adapter)


class EvaluationFailureTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = directory.name
        config = {'database': {'type': 'sqlite', 'sqlite_path': str(Path(directory.name) / 'test.db')}}
        self.start_patch(patch('database.get_config', return_value=config))
        self.start_patch(patch.dict('os.environ', {
            'URP_CREDENTIAL_KEY': 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
        }))
        init_db(config)
        bind_user('offline-device', 'student', 'fake-password')
        with get_db() as conn:
            conn.execute('INSERT INTO memberships (username, member_type, expire_time, create_time) VALUES (?, ?, ?, ?)',
                         ('student', 'basic', (datetime.now() + timedelta(days=1)).isoformat(), datetime.now().isoformat()))
        app = Flask(__name__)
        app.register_blueprint(data_bp)
        self.client = app.test_client()
        self.start_patch(patch('services.urp_service.get_current_urp_url', return_value=BASE_URL))

    def start_patch(self, patcher):
        result = patcher.start()
        self.addCleanup(patcher.stop)
        return result

    def query_courses(self, outcomes):
        query, adapter = offline_query(self.directory, outcomes)
        self.addCleanup(query.x.close)
        self.start_patch(patch('urp.URP_query', return_value=query))
        result = self.client.get('/api/unevaluated_courses', headers={'X-Device-ID': 'offline-device'})
        self.assertEqual(result.status_code, 200)
        return result.get_json(), adapter

    def test_timeout_is_failure_instead_of_successful_empty_list(self):
        result, _ = self.query_courses([requests.ReadTimeout('offline timeout')])
        self.assertFalse(result['success'])
        self.assertNotIn('has_courses', result)

    def test_http_failure_is_not_reported_as_no_pending_courses(self):
        result, _ = self.query_courses([(503, '<html>maintenance</html>')])
        self.assertFalse(result['success'])
        self.assertNotIn('has_courses', result)

    def test_closed_evaluation_period_remains_successfully_empty(self):
        result, _ = self.query_courses([(200, '非教学评估时期')])
        self.assertTrue(result['success'])
        self.assertFalse(result['has_courses'])
        self.assertEqual(result['courses'], [])

    def test_pending_course_fields_and_membership_requirement_are_preserved(self):
        result, _ = self.query_courses([(200, COURSE_HTML)])
        self.assertTrue(result['success'])
        self.assertTrue(result['has_courses'])
        self.assertEqual(result['courses'], [{'未评课程': '高等数学', '教师': '王老师',
            'wjbm': 'survey', 'bpr': 'teacher', 'pgnr': 'content', 'oper': 'wjShow'}])
        with get_db() as conn:
            conn.execute('DELETE FROM memberships WHERE username = ?', ('student',))
        denied = self.client.get('/api/unevaluated_courses', headers={'X-Device-ID': 'offline-device'}).get_json()
        self.assertFalse(denied['success'])
        self.assertEqual(denied['require_member'], 'basic')


if __name__ == '__main__':
    unittest.main()
