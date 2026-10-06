import unittest
from unittest.mock import MagicMock, patch
from flask import Flask

from services import urp_service
from services.urp_service import get_current_semester_grades
from urp.query import URP_query
from routes.data_routes import data_bp


class GradeCreditTests(unittest.TestCase):
    def test_current_semester_parser_keeps_each_course_credit(self):
        query = URP_query.__new__(URP_query)
        query.url = 'http://urp.example/'
        query.account = '202600001'
        response = MagicMock()
        response.text = '''
            <table><tr>
                <td>1</td><td>code</td><td>高等数学</td><td>必修</td>
                <td>3.5</td><td>unused</td><td>unused</td><td>91</td>
            </tr></table>
        '''
        query._request = MagicMock(return_value=response)

        self.assertEqual(query.score_current_semester(), [
            {'课程名': '高等数学', '学分': '3.5', '成绩': '91'},
        ])

    @patch('services.urp_service.get_current_urp_url', return_value='http://urp.example/')
    @patch('urp.URP_query')
    def test_current_semester_service_exposes_credit_to_the_dashboard(self, query_class, _url):
        query_class.return_value.score_current_semester.return_value = [
            {'课程名': '大学英语', '学分': '2', '成绩': '78'},
        ]

        self.assertEqual(get_current_semester_grades('202600001'), [
            {'course': '大学英语', 'credit': '2', 'score': '78'},
        ])

    @patch('services.urp_service.get_current_urp_url', return_value='http://urp.example/')
    @patch('urp.URP_query')
    def test_latest_summary_keeps_credit_for_the_default_result_table(self, query_class, _url):
        query = query_class.return_value
        query.get_semesters.return_value = ['2026-2027-2', '2026-2027-1']
        query.score_by_semester.return_value = [
            {'课程名': '程序设计', '学分': '4.0', '成绩': '88'},
        ]
        query.score_failed.return_value = {'current': [], 'past': []}

        result = urp_service.get_latest_semester_grade_summary('student')

        self.assertEqual(result['semester'], '2026-2027-2')
        self.assertEqual(result['passed'], [
            {'course': '程序设计', 'credit': '4.0', 'score': '88'},
        ])


class LatestMakeupGradeTests(unittest.TestCase):
    def latest_makeup(self, username):
        function = getattr(urp_service, 'get_latest_makeup_grade_summary', None)
        return function(username) if function else {}

    @patch('services.urp_service.get_current_urp_url', return_value='http://urp.example/')
    @patch('urp.URP_query')
    def test_finds_latest_session_and_recent_published_result_by_exam_name(self, query_class, _url):
        query = query_class.return_value
        query.get_exam_sessions.return_value = {
            'semesters': [],
            'exams': [
                {'jxzxjh': 'wrong-old-semester', 'ksbh': 'new', 'name': '2026秋学期补考'},
                {'jxzxjh': '2025-2026-2-1', 'ksbh': 'spring-xianlin', 'name': '2026春学期补考-仙林'},
                {'jxzxjh': '2025-2026-2-1', 'ksbh': 'spring-gaochun', 'name': '2026春学期补考-高淳'},
                {'jxzxjh': '2025-2026-1-1', 'ksbh': 'published', 'name': '2025秋学期补考'},
                {'jxzxjh': '2025-2026-1-1', 'ksbh': 'ordinary', 'name': '2025秋期末考试'},
            ],
        }
        query.score_resit.side_effect = lambda _semester, exam, **_options: {
            'new': [], 'spring-xianlin': [], 'spring-gaochun': [],
            'published': [{'课程名': '中国近现代史纲要', '学分': '3.0', '成绩': '85.0'}],
        }[exam]

        result = self.latest_makeup('student')

        self.assertIn('latest_session', result)
        self.assertIn('latest_published', result)
        self.assertEqual(result['latest_session'], {
            'period': '2026-2027-1',
            'label': '2026-2027学年秋学期',
            'sessions': ['2026秋学期补考'],
            'status': 'no_results',
        })
        self.assertEqual(result['latest_published']['period'], '2025-2026-1')
        self.assertEqual(result['latest_published']['results'], [{
            'course': '中国近现代史纲要',
            'credit': '3.0',
            'score': '85.0',
            'sessions': ['2025秋学期补考'],
        }])

    @patch('services.urp_service.get_current_urp_url', return_value='http://urp.example/')
    @patch('urp.URP_query')
    def test_merges_duplicate_campus_rows_but_keeps_different_attempt_scores(self, query_class, _url):
        query = query_class.return_value
        query.get_exam_sessions.return_value = {'semesters': [], 'exams': [
            {'jxzxjh': '2025-2026-2-1', 'ksbh': 'a', 'name': '2026春学期补考-仙林'},
            {'jxzxjh': '2025-2026-2-1', 'ksbh': 'b', 'name': '2026春学期补考-高淳'},
            {'jxzxjh': '2025-2026-2-1', 'ksbh': 'c', 'name': '2026春学期补考（第二批）'},
        ]}
        query.score_resit.side_effect = lambda _semester, exam, **_options: {
            'a': [{'课程名': '高等数学', '学分': '5.0', '成绩': '62'}],
            'b': [{'课程名': '高等数学', '学分': '5.0', '成绩': '62'}],
            'c': [{'课程名': '高等数学', '学分': '5.0', '成绩': '78'}],
        }[exam]

        result = self.latest_makeup('student')

        self.assertIn('latest_published', result)
        results = result['latest_published']['results']
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0]['sessions'], ['2026春学期补考-仙林', '2026春学期补考-高淳'])
        self.assertEqual([row['score'] for row in results], ['62', '78'])

    def test_resit_parser_discards_blank_and_header_rows(self):
        query = URP_query.__new__(URP_query)
        query.url = 'http://urp.example/'
        query.account = '202600001'
        response = MagicMock()
        response.text = '''
            <table>
              <tr><td></td><td></td><td></td><td></td><td></td><td></td></tr>
              <tr><td>1</td><td>x</td><td>课序号</td><td>x</td><td>学时</td><td>学分</td></tr>
              <tr><td>2</td><td>x</td><td>课程名称</td><td>x</td><td>学分</td><td>考试成绩</td></tr>
              <tr><td>3</td><td>x</td><td>高等数学</td><td>x</td><td>5.0</td><td>78</td></tr>
            </table>
        '''
        query._request = MagicMock(return_value=response)

        self.assertEqual(query.score_resit('semester', 'exam'), [
            {'课程名': '高等数学', '学分': '5.0', '成绩': '78'},
        ])

    @patch('services.urp_service.get_current_urp_url', return_value='http://urp.example/')
    @patch('urp.URP_query')
    def test_one_failed_campus_retains_other_results_and_reports_partial_status(self, query_class, _url):
        query = query_class.return_value
        query.get_exam_sessions.return_value = {'semesters': [], 'exams': [
            {'jxzxjh': '2025-2026-2-1', 'ksbh': 'a', 'name': '2026春学期补考-仙林'},
            {'jxzxjh': '2025-2026-2-1', 'ksbh': 'b', 'name': '2026春学期补考-高淳'},
        ]}
        query.score_resit.side_effect = [RuntimeError('场次暂时不可用'), [
            {'课程名': '高数', '学分': '4', '成绩': '合格'},
            {'课程名': '英语', '学分': '2', '成绩': ''},
        ]]
        result = self.latest_makeup('student')
        self.assertEqual(result['latest_session']['status'], 'partial')
        self.assertEqual(result['latest_published']['results'][0]['score'], '合格')
        self.assertEqual(len(result['errors']), 1)
        self.assertEqual(result['latest_session']['pending_count'], 1)

    @patch('services.urp_service.get_current_urp_url', return_value='http://urp.example/')
    @patch('urp.URP_query')
    def test_empty_lookup_stops_after_six_periods_without_claiming_no_history(self, query_class, _url):
        query = query_class.return_value
        query.get_exam_sessions.return_value = {'exams': [
            {'jxzxjh': f'{year}-{year+1}-1-1', 'ksbh': str(year), 'name': f'{year}秋学期补考'}
            for year in range(2018, 2027)
        ]}
        query.score_resit.return_value = []
        result = self.latest_makeup('student')
        self.assertEqual(result['checked_periods'], 6)
        self.assertEqual(query.score_resit.call_count, 6)
        self.assertTrue(result['truncated'])
        self.assertIsNone(result['latest_published'])

    @patch('services.urp_service.time.monotonic', side_effect=[0, 21])
    @patch('services.urp_service.get_current_urp_url', return_value='http://urp.example/')
    @patch('urp.URP_query')
    def test_elapsed_budget_stops_before_starting_another_session(self, query_class, _url, _clock):
        query = query_class.return_value
        query.get_exam_sessions.return_value = {'exams': [
            {'jxzxjh': '2026-2027-1-1', 'ksbh': 'a', 'name': '2026秋学期补考'},
        ]}
        result = self.latest_makeup('student')
        self.assertTrue(result['truncated'])
        self.assertEqual(result['latest_session']['status'], 'error')
        query.score_resit.assert_not_called()

    @patch('services.urp_service.get_current_urp_url', return_value='http://urp.example/')
    @patch('urp.URP_query')
    def test_null_score_is_pending_and_numeric_zero_is_published(self, query_class, _url):
        query = query_class.return_value
        query.get_exam_sessions.return_value = {'exams': [
            {'jxzxjh': '2026-2027-1-1', 'ksbh': 'a', 'name': '2026秋学期补考'},
        ]}
        query.score_resit.return_value = [
            {'课程名': '英语', '学分': 2, '成绩': None},
            {'课程名': '高数', '学分': 0, '成绩': 0},
        ]
        result = self.latest_makeup('student')
        self.assertEqual(result['latest_session']['pending_count'], 1)
        self.assertEqual(result['latest_session']['pending_results'][0]['course'], '英语')
        self.assertEqual(result['latest_published']['results'][0]['score'], '0')


class MakeupRouteTests(unittest.TestCase):
    def setUp(self):
        app = Flask(__name__)
        app.register_blueprint(data_bp)
        self.client = app.test_client()

    @patch('auth.get_user_by_device', return_value=None)
    @patch('routes.data_routes.get_latest_makeup_grade_summary')
    def test_unbound_user_cannot_query_makeup_results(self, service, _user):
        result = self.client.get('/api/grades/latest_makeup').get_json()
        self.assertFalse(result['success'])
        service.assert_not_called()

    @patch('auth.check_login_status', return_value=(True, {}))
    @patch('auth.get_config', return_value={'grades_require_member': False})
    @patch('auth.get_user_by_device', return_value={'username': 'student', 'password': 'test-only'})
    @patch('routes.data_routes.get_latest_makeup_grade_summary', return_value={
        'latest_session': None, 'latest_published': None, 'checked_periods': 0, 'errors': [], 'truncated': False,
    })
    def test_route_returns_the_makeup_summary_after_grade_authentication(self, service, _user, _config, _login):
        result = self.client.get('/api/grades/latest_makeup', headers={'X-Device-ID': 'test-device'}).get_json()
        self.assertTrue(result['success'])
        self.assertEqual(result['checked_periods'], 0)
        self.assertIsNone(result['latest_session'])
        service.assert_called_once_with('student')


if __name__ == '__main__':
    unittest.main()
