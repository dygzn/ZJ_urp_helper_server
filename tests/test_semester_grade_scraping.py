"""按学期成绩解析离线回归；仅替换 HTTP 传输及路由登录验证。"""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from flask import Flask
import requests

from routes.data_routes import data_bp
from urp.query import URP_query


SEMESTER = '2026-2027学年第一学期'
NEXT_SEMESTER = '2025-2026学年第二学期'
COURSE = {'课程名': '高等数学', '学分': '4.0', '成绩': '91'}
HEADER = '<tr><th>序号</th><th>代码</th><th>课程名</th><th>性质</th><th>学分</th><th>学时</th><th>方式</th><th>成绩</th></tr>'
ROW = '<tr><td>1</td><td>math</td><td>高等数学</td><td>必修</td><td>4.0</td><td>64</td><td>考试</td><td>91</td></tr>'
OTHER_ROW = '<tr><td>2</td><td>english</td><td>大学英语</td><td>必修</td><td>2</td><td>32</td><td>考试</td><td>78</td></tr>'


def table(rows=ROW, header=HEADER):
    return '<table class="displayTag striped" id="user"><thead>' + header + '</thead><tbody>' + rows + '</tbody></table>'


def anchor(semester=SEMESTER):
    return '<a name="' + semester + '"></a>'


def response(html):
    result = requests.Response()
    result.status_code = 200
    result.url = 'https://urp.example/gradeLnAllAction.do'
    result.encoding = 'utf-8'
    result._content = html.encode('utf-8')
    return result


class SemesterGradeScrapingTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        previous_cwd = os.getcwd()
        os.chdir(self.directory.name)
        self.addCleanup(os.chdir, previous_cwd)
        cookie = Path('user_data/student/cookie.json')
        cookie.parent.mkdir(parents=True)
        cookie.write_text(json.dumps({}), encoding='utf-8')
        self.query = URP_query('https://urp.example/', 'student')
        self.addCleanup(self.query.x.close)

    def parse(self, html, semester=SEMESTER):
        with patch('requests.sessions.Session.request', return_value=response(html)):
            return self.query.score_by_semester(semester)

    def test_table_directly_after_semester_anchor_is_not_empty(self):
        self.assertEqual(self.parse(anchor() + table()), [COURSE])

    def test_existing_wrapped_table_and_all_data_rows_are_preserved(self):
        html = anchor() + '<div>' + table(ROW + OTHER_ROW) + '</div>'
        self.assertEqual(self.parse(html), [COURSE, {'课程名': '大学英语', '学分': '2', '成绩': '78'}])

    def test_anchor_inside_heading_can_find_the_following_table(self):
        html = '<h3>' + anchor() + SEMESTER + '</h3>' + table()
        self.assertEqual(self.parse(html), [COURSE])

    def test_missing_table_does_not_borrow_from_next_wrapped_semester(self):
        html = anchor() + '<p>暂无记录</p><section>' + anchor(NEXT_SEMESTER) + table(OTHER_ROW) + '</section>'
        self.assertEqual(self.parse(html), [])

    def test_selected_semester_does_not_include_other_semesters(self):
        html = anchor(NEXT_SEMESTER) + table(OTHER_ROW) + anchor() + table()
        self.assertEqual(self.parse(html), [COURSE])

    def test_layout_wrapper_row_is_not_a_duplicate_course(self):
        rows = '<tr><td colspan="8">' + table() + '</td></tr>' + ROW
        self.assertEqual(self.parse(anchor() + '<div>' + table(rows) + '</div>'), [COURSE])

    def test_nested_note_table_is_not_a_course(self):
        rows = ROW + '<tr><td colspan="8">备注' + table(OTHER_ROW) + '</td></tr>'
        self.assertEqual(self.parse(anchor() + '<div>' + table(rows) + '</div>'), [COURSE])

    def test_empty_matching_table_stays_empty_before_next_semester(self):
        html = anchor() + table('') + anchor(NEXT_SEMESTER) + table(OTHER_ROW)
        self.assertEqual(self.parse(html), [])

    def test_missing_anchor_stays_empty(self):
        self.assertEqual(self.parse(anchor(NEXT_SEMESTER) + table()), [])

    def test_unrelated_table_is_skipped(self):
        html = anchor() + '<table>' + OTHER_ROW + '</table>' + table()
        self.assertEqual(self.parse(html), [COURSE])

    def test_blank_header_short_row_and_zero_score(self):
        zero = ROW.replace('>91<', '>0<')
        blank = ROW.replace('高等数学', '')
        header = ROW.replace('高等数学', '课程名称')
        rows = header + blank + '<tr><td>无课程的备注</td></tr>' + zero
        self.assertEqual(self.parse(anchor() + '<div>' + table(rows) + '</div>'),
                         [{'课程名': '高等数学', '学分': '4.0', '成绩': '0'}])

    def test_routes_return_real_parsed_grades_and_latest_summary(self):
        html = anchor() + table() + anchor(NEXT_SEMESTER) + table(OTHER_ROW)

        def transport(session, method, url, **kwargs):
            if 'gradeLnAllAction.do?type=ln&oper=qbinfo&' in url:
                return response(html)
            if kwargs.get('params', {}).get('oper') == 'bjg':
                return response('<html><body>无不及格记录</body></html>')
            raise AssertionError('不应发出其他请求: ' + url)

        app = Flask(__name__)
        app.register_blueprint(data_bp)
        client = app.test_client()
        with patch('requests.sessions.Session.request', autospec=True, side_effect=transport), \
             patch('auth.get_user_by_device', return_value={'username': 'student', 'password': 'test-only'}), \
             patch('auth.get_config', return_value={'grades_require_member': False}), \
             patch('auth.check_login_status', return_value=(True, {})), \
             patch('services.urp_service.get_current_urp_url', return_value='https://urp.example/'):
            by_semester = client.get('/api/grades/by_semester', query_string={'semester': SEMESTER},
                                     headers={'X-Device-ID': 'offline-device'}).get_json()
            summary = client.get('/api/grades/latest_summary', headers={'X-Device-ID': 'offline-device'}).get_json()
        self.assertEqual(by_semester, {'success': True, 'semester': SEMESTER,
                                      'grades': [{'course': '高等数学', 'score': '91'}]})
        self.assertEqual(summary, {'success': True, 'semester': SEMESTER,
                                  'passed': [{'course': '高等数学', 'credit': '4.0', 'score': '91'}],
                                  'failed': {'current': [], 'past': []}})


if __name__ == '__main__':
    unittest.main()
