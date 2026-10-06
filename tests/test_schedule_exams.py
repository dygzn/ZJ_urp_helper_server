"""课程页一次读取课程和考试，保持周次过滤与缓存隔离。"""
import unittest
import os
import json
import tempfile
from pathlib import Path
from unittest.mock import patch

from flask import Flask
from routes.data_routes import api_schedule


class ScheduleExamTests(unittest.TestCase):
    def setUp(self):
        self.previous_cwd = os.getcwd()
        self.directory = tempfile.TemporaryDirectory()
        os.chdir(self.directory.name)
        self.user_dir = Path('user_data/student')
        self.user_dir.mkdir(parents=True)
        (self.user_dir / 'schedule.json').write_text(json.dumps({'1': [{
            '课程名': '软件工程导论', '星期': '3', '节次': '1', '节数': '2',
        }]}), encoding='utf-8')
        (self.user_dir / 'exams.json').write_text(json.dumps({'1': [{
            '考试名': '秋学期补考', '课程': '高等数学A（Ⅱ）-66', '考试周次': '1',
            '考试星期': '6', '考试时间': '08:00-10:00', '座位号': '50',
            '位置': '仙林校区教B-106', '校区': '仙林校区', '教学楼': '教B', '教室': '-106',
        }]}), encoding='utf-8')

    def tearDown(self):
        os.chdir(self.previous_cwd)
        self.directory.cleanup()

    def query(self, query='', config=None):
        app = Flask(__name__)
        with app.test_request_context('/api/schedule' + query), patch(
            'routes.data_routes.get_config', return_value=config or {'semester_start': '2026-09-07'}
        ):
            return api_schedule.__wrapped__({'username': 'student'}).get_json()

    def test_sample_courses_and_exam_share_one_response(self):
        result = self.query()
        self.assertTrue(result['success'])
        self.assertIn('软件工程导论', [course['课程名'] for course in result['data']['schedule']['1']])
        exam = result['data']['exams'][0]
        self.assertEqual(exam['course'], '高等数学A（Ⅱ）-66')
        self.assertEqual(exam['time'], '08:00-10:00')
        self.assertEqual(exam['seat'], '50')

    def test_week_filter_also_filters_exams(self):
        self.assertEqual(self.query('?week=2')['data']['exams'], [])
        self.assertEqual(self.query('?week=1')['data']['exams'][0]['day'], '6')

    def test_stale_exams_are_flagged_independently(self):
        with patch('routes.data_routes.is_calendar_cache_stale', side_effect=lambda user, kind, config: kind == 'exams'):
            result = self.query()
        self.assertFalse(result['data']['cache_stale'])
        self.assertTrue(result['data']['exams_cache_stale'])

    def test_exam_only_response_retains_semester_start(self):
        (self.user_dir / 'schedule.json').unlink()
        result = self.query()
        self.assertTrue(result['success'])
        self.assertEqual(result['data']['schedule'], {})
        self.assertEqual(result['data']['semester_start'], '2026-09-07')
        self.assertEqual(result['data']['exams'][0]['seat'], '50')


if __name__ == '__main__':
    unittest.main()
