"""考试抓取离线回归：真实解析及文件缓存，仅替换外部 HTTP 传输。"""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import requests
from flask import Flask, g

from routes.data_routes import api_update_exams
from services.urp_service import get_exams
from urp.query import URP_query


HEADERS = ('考试名', '校区', '教学楼', '教室', '课程', '考试周次',
           '考试星期', '考试时间', '座位号', '备注')


def exam_row(course, week='2', css_class='odd'):
    # 合成夹具依据现有解析器的十列契约，不包含真实账号或学校页面。
    attribute = f' class="{css_class}"' if css_class is not None else ''
    cells = ('期末考试', '东校区', '一教', '201', course, week,
             '5', '08:30-10:30', '12', '')
    return '<tr' + attribute + '>' + ''.join(f'<td>{cell}</td>' for cell in cells) + '</tr>'


def exam_page(*rows):
    return ('<html><table><tr><td>导航</td></tr></table>'
            '<table class="displayTag" id="user"><thead><tr>'
            + ''.join(f'<th>{header}</th>' for header in HEADERS)
            + '</tr></thead><tbody>' + ''.join(rows) + '</tbody></table></html>')


def response_for(html, status=200):
    response = requests.Response()
    response.status_code = status
    response.url = 'https://urp.example.invalid/ksApCxAction.do'
    response.encoding = 'utf-8'
    response.headers['Content-Type'] = 'text/html; charset=utf-8'
    response._content = html.encode('utf-8')
    return response


class ExamScrapingTests(unittest.TestCase):
    def setUp(self):
        previous = os.getcwd()
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        os.chdir(self.directory.name)
        self.addCleanup(os.chdir, previous)
        self.account = Path('user_data/student')
        self.account.mkdir(parents=True)
        (self.account / 'cookie.json').write_text('{}', encoding='utf-8')
        self.cache = self.account / 'exams.json'
        self.old_cache = b'{"old": []}\n'
        self.cache.write_bytes(self.old_cache)
        self.helper = URP_query('https://urp.example.invalid/', 'student')
        self.addCleanup(self.helper.x.close)
        self.app = Flask(__name__)

    def scrape(self, html, status=200):
        with patch.object(requests.Session, 'request', return_value=response_for(html, status)):
            return self.helper.exam_cx()

    def test_alternating_rows_reach_cache_and_cached_exam_api_model(self):
        result = self.scrape(exam_page(
            exam_row('高等数学', css_class='odd'),
            exam_row('大学英语', css_class='even'),
            exam_row('程序设计', week='3', css_class='odd'),
        ))
        self.assertEqual([exam['课程'] for exam in result['2']], ['高等数学', '大学英语'])
        self.assertEqual([exam['课程'] for exam in result['3']], ['程序设计'])
        self.assertEqual(json.loads(self.cache.read_text(encoding='utf-8')), result)
        cached = get_exams('student')
        self.assertEqual([exam['course'] for exam in cached], ['高等数学', '大学英语', '程序设计'])
        self.assertEqual(cached[1], {
            'exam_name': '期末考试', 'course': '大学英语', 'time': '08:30-10:30',
            'week': '2', 'day': '5', 'location': '东校区一教201',
            'campus': '东校区', 'building': '一教', 'room': '201', 'seat': '12',
        })

    def test_layout_table_does_not_become_an_exam_record(self):
        html = ('<table class="layout"><tr><td>'
                + exam_page(exam_row('高等数学'), exam_row('大学英语', css_class='even'))
                + '</td></tr></table>')
        result = self.scrape(html)
        self.assertEqual(list(result), ['2'])
        self.assertEqual([exam['课程'] for exam in result['2']], ['高等数学', '大学英语'])
        self.assertEqual([exam['course'] for exam in get_exams('student')], ['高等数学', '大学英语'])

    def test_nested_note_table_is_not_parsed_as_another_exam(self):
        nested = '<table>' + exam_row('备注中的展示内容', week='9', css_class=None) + '</table>'
        row = exam_row('高等数学').replace('<td></td></tr>', '<td>' + nested + '</td></tr>')
        result = self.scrape(exam_page(row))
        self.assertEqual(list(result), ['2'])
        self.assertEqual([exam['课程'] for exam in result['2']], ['高等数学'])

    def test_even_only_table_is_not_misreported_as_empty(self):
        result = self.scrape(exam_page(exam_row('大学英语', css_class='even')))
        self.assertEqual([exam['课程'] for exam in result.get('2', [])], ['大学英语'])

    def test_row_css_does_not_determine_whether_an_exam_exists(self):
        for css_class in (None, 'selected', 'even selected'):
            with self.subTest(css_class=css_class):
                result = self.scrape(exam_page(exam_row('大学英语', css_class=css_class)))
                self.assertEqual([exam['课程'] for exam in result.get('2', [])], ['大学英语'])

    def test_headers_and_short_notice_rows_are_not_exams(self):
        result = self.scrape(exam_page(
            '<tr><td colspan="10">以下是考试安排</td></tr>',
            exam_row('高等数学'),
            '<tr class="even"><td>不完整记录</td></tr>',
        ))
        self.assertEqual(list(result), ['2'])
        self.assertEqual([exam['课程'] for exam in result['2']], ['高等数学'])

    def test_successful_empty_table_replaces_old_cache(self):
        self.assertEqual(self.scrape(exam_page('<tr><td colspan="10">暂无考试安排</td></tr>')), {})
        self.assertEqual(json.loads(self.cache.read_text(encoding='utf-8')), {})

    def test_login_or_unrecognized_page_preserves_old_cache(self):
        for html in ('<form name="loginForm"></form>', '<html>维护中</html>'):
            with self.subTest(html=html):
                with self.assertRaisesRegex(Exception, '未找到考试安排表格'):
                    self.scrape(html)
                self.assertEqual(self.cache.read_bytes(), self.old_cache)

    def test_http_error_with_table_preserves_old_cache(self):
        for status in (403, 500, 503):
            with self.subTest(status=status):
                with self.assertRaises(requests.HTTPError):
                    self.scrape(exam_page(exam_row('错误响应中的残留表格')), status)
                self.assertEqual(self.cache.read_bytes(), self.old_cache)

    def test_transport_error_preserves_old_cache(self):
        with patch.object(requests.Session, 'request', side_effect=requests.Timeout):
            with self.assertRaises(requests.Timeout):
                self.helper.exam_cx()
        self.assertEqual(self.cache.read_bytes(), self.old_cache)

    def update_api(self, html, status=200):
        with self.app.test_request_context('/api/update_exams', method='POST'), \
                patch('routes.data_routes.get_current_urp_url', return_value='https://urp.example.invalid/'), \
                patch.object(requests.Session, 'request', return_value=response_for(html, status)):
            return api_update_exams.__wrapped__({'username': 'student', 'password': ''}).get_json()

    def test_update_api_returns_every_exam(self):
        result = self.update_api(exam_page(exam_row('高等数学'), exam_row('大学英语', css_class='even')))
        self.assertTrue(result['success'])
        self.assertEqual([exam['课程'] for exam in result['data']['2']], ['高等数学', '大学英语'])

    def test_update_api_reports_http_failure_without_erasing_cache(self):
        result = self.update_api(exam_page(), status=503)
        self.assertFalse(result['success'])
        self.assertIn('更新失败', result['message'])
        self.assertEqual(self.cache.read_bytes(), self.old_cache)

    def test_temporary_exam_cache_remains_separate_from_persistent_account(self):
        session_id = 'a' * 32
        temporary = Path('user_data/.temporary') / session_id
        temporary.mkdir(parents=True)
        (temporary / 'cookie.json').write_text('{}', encoding='utf-8')
        with self.app.test_request_context('/'):
            g.temporary_session = {'session_id': session_id, 'username': 'student'}
            helper = URP_query('https://urp.example.invalid/', 'student')
            self.addCleanup(helper.x.close)
            with patch.object(requests.Session, 'request', return_value=response_for(
                exam_page(exam_row('临时账号考试', css_class='even')),
            )):
                helper.exam_cx()
            self.assertEqual([exam['course'] for exam in get_exams('student')], ['临时账号考试'])
        self.assertEqual(self.cache.read_bytes(), self.old_cache)
        self.assertIn('临时账号考试', (temporary / 'exams.json').read_text(encoding='utf-8'))


if __name__ == '__main__':
    unittest.main()
