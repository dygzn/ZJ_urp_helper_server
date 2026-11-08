"""首页提醒兼容教务系统尚未确定时间的考试，不影响其他有效安排。"""
import json
import os
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from flask import Flask

from routes.data_routes import api_urgent_event
from services.personal_schedule_service import CHINA
from services.urp_service import get_exams


class UrgentEventExamTests(unittest.TestCase):
    def setUp(self):
        previous = os.getcwd()
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        os.chdir(directory.name)
        self.addCleanup(os.chdir, previous)
        self.account = Path('user_data/student')
        self.account.mkdir(parents=True)
        config = {'semester_start': '2026-09-07', 'database': {
            'type': 'sqlite', 'sqlite_path': str(Path(directory.name) / 'test.db'),
        }}
        for target in ('services.urp_service.get_config', 'database.get_config'):
            patcher = patch(target, return_value=config)
            patcher.start()
            self.addCleanup(patcher.stop)
        clock = patch('services.urp_service.datetime', wraps=datetime)
        clock.start().now.return_value = datetime(2026, 9, 7, 7, 0, tzinfo=CHINA)
        self.addCleanup(clock.stop)
        self.exam = {'课程': '高等数学', '考试周次': '1', '考试星期': '1',
                     '考试时间': '08:30-10:30', '位置': '一教201', '座位号': '12'}
        self.app = Flask(__name__)

    def query(self, exams, schedule=None):
        (self.account / 'exams.json').write_text(json.dumps(exams), encoding='utf-8')
        (self.account / 'schedule.json').write_text(json.dumps(schedule or {}), encoding='utf-8')
        with self.app.test_request_context('/api/urgent_event'):
            result = api_urgent_event.__wrapped__({'username': 'student'}).get_json()
        self.assertTrue(result['success'], result.get('message'))
        return result['event']

    def test_undetermined_week_does_not_hide_valid_exams_or_remove_cached_records(self):
        for week in ('', ' ', '待定', '0', '-1'):
            with self.subTest(week=week):
                event = self.query({week: [{**self.exam, '考试周次': week}], '1': [self.exam]})
                self.assertEqual(event['next']['title'], '高等数学')
                self.assertEqual(event['next']['time'], '2026-09-07 08:30-10:30')
                self.assertEqual(event['next']['countdown'], 90)
                self.assertEqual(len(get_exams('student')), 2)

    def test_invalid_day_does_not_hide_the_next_valid_exam(self):
        for day in ('', None, '待定', '0', '8'):
            with self.subTest(day=day):
                pending = {**self.exam, '课程': '日期待定考试', '考试星期': day}
                self.assertIsNone(self.query({'1': [pending]})['next'])
                event = self.query({'1': [pending, self.exam]})
                self.assertEqual(event['next']['title'], '高等数学')

    def test_invalid_time_does_not_hide_the_next_valid_exam(self):
        for time_range in ('', None, '待定', '08:', '24:00-26:00', '08:60-10:00'):
            with self.subTest(time=time_range):
                event = self.query({'1': [{**self.exam, '考试时间': time_range}, self.exam]})
                self.assertEqual(event['next']['countdown'], 90)

    def test_incomplete_exam_rows_and_buckets_do_not_abort_reminders(self):
        event = self.query({'2': None, '3': {}, '1': [None, '待定', {}, self.exam]})
        self.assertEqual(event['next']['seat'], '12')

    def test_undetermined_exams_do_not_hide_courses(self):
        event = self.query({'': [{**self.exam, '考试周次': ''}]}, {'1': [{
            '课程名': '程序设计', '星期': '1', '节次': '1', '节数': '2', '位置': '实验楼',
        }]})
        self.assertEqual(event['next']['type'], 'class')
        self.assertEqual(event['upcoming'][0]['title'], '程序设计')

    def test_earliest_future_exam_wins_across_unsorted_weeks_and_rows(self):
        event = self.query({'2': [self.exam], '1': [
            {**self.exam, '课程': '下午考试', '考试时间': '14:00-16:00'},
            {**self.exam, '课程': '已结束考试', '考试时间': '06:00-06:30'},
            self.exam,
        ]})
        self.assertEqual(event['next']['title'], '高等数学')
        self.assertEqual(event['next']['location'], '一教201')

    def test_missing_optional_location_and_seat_still_allows_exam_reminder(self):
        exam = {key: value for key, value in self.exam.items() if key not in ('位置', '座位号')}
        event = self.query({'1': [exam]})
        self.assertEqual(event['next']['title'], '高等数学')
        self.assertEqual(event['next']['location'], '')
        self.assertEqual(event['next']['seat'], '')


if __name__ == '__main__':
    unittest.main()
