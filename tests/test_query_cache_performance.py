import unittest
from unittest.mock import Mock, patch
import requests
from urp.query import URP_query

class QueryCachePerformanceTests(unittest.TestCase):
    def test_semesters_and_grades_share_one_response_per_query_instance(self):
        q = URP_query.__new__(URP_query)
        q.url = 'http://urp.test/'
        q._request = Mock(return_value=Mock(text='<a name="2026学年第一学期"></a>'))
        q.get_semesters()
        q.score_by_semester('2026学年第一学期')
        self.assertEqual(q._request.call_count, 1)
    def test_login_redirect_invalidates_success_cache_instead_of_returning_empty_data(self):
        q = URP_query.__new__(URP_query)
        q.url, q.account = 'http://urp.test/', 'test'
        response = requests.Response()
        response.status_code = 200
        response.url = q.url + 'loginAction.do'
        response._content = b'<form name="loginForm" action="loginAction.do"></form>'
        q.x = Mock();q.x.request.return_value = response
        with patch('services.urp_service.invalidate_login_cache') as invalidate:
            with self.assertRaises(requests.HTTPError):
                q._request('GET', q.url)
            invalidate.assert_called_once_with('test', q.url)
