"""课表导出使用与页面作息时间一致的年级信息。"""

import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from services.urp_service import get_schedule, get_urgent_event, is_calendar_cache_stale


class CalendarScheduleTests(unittest.TestCase):
    def test_homepage_ignores_old_calendar_caches_after_admin_changes_semester(self):
        previous = os.getcwd()
        with tempfile.TemporaryDirectory() as directory:
            try:
                os.chdir(directory)
                user_dir = Path('user_data/student')
                user_dir.mkdir(parents=True)
                (user_dir / 'schedule.json').write_text(json.dumps({'1': [{
                    '课程名': '上学期课程', '星期': '1', '节次': '1', '节数': '2', '位置': '一教',
                }]}), encoding='utf-8')
                (user_dir / 'exams.json').write_text(json.dumps({'1': [{
                    '课程': '上学期考试', '考试星期': '1', '考试时间': '08:30-10:30',
                    '位置': '一教', '座位号': '1',
                }]}), encoding='utf-8')
                marker = max(path.stat().st_mtime_ns for path in user_dir.iterdir()) + 1_000_000
                today = datetime.now().date()
                next_monday = today + timedelta(days=(7 - today.weekday()))
                with patch('services.urp_service.get_config', return_value={
                    'semester_start': next_monday.isoformat(),
                    'semester_cache_reset_at_ns': marker,
                }):
                    event = get_urgent_event('student')
                self.assertTrue(event['schedule_cache_stale'])
                self.assertTrue(event['exams_cache_stale'])
                self.assertIsNone(event['next'])
                self.assertEqual(event['upcoming'], [])
            finally:
                os.chdir(previous)

    def test_admin_semester_change_marks_old_cache_stale_until_rewritten(self):
        previous = os.getcwd()
        with tempfile.TemporaryDirectory() as directory:
            try:
                os.chdir(directory)
                path = Path('user_data/student/schedule.json')
                path.parent.mkdir(parents=True)
                path.write_text('{}', encoding='utf-8')
                changed_at = path.stat().st_mtime_ns + 1_000_000
                config = {'semester_cache_reset_at_ns': changed_at}
                self.assertTrue(is_calendar_cache_stale('student', 'schedule', config))
                os.utime(path, ns=(changed_at + 1_000_000, changed_at + 1_000_000))
                self.assertFalse(is_calendar_cache_stale('student', 'schedule', config))
            finally:
                os.chdir(previous)

    def test_homepage_survives_invalid_semester_start_and_requests_correction(self):
        previous = os.getcwd()
        with tempfile.TemporaryDirectory() as directory:
            try:
                os.chdir(directory)
                with patch('services.urp_service.get_config', return_value={
                    'semester_start': 'not-a-date',
                }):
                    event = get_urgent_event('student')
                self.assertTrue(event['semester_start_invalid'])
                self.assertIsNone(event['next'])
                self.assertEqual(event['upcoming'], [])
            finally:
                os.chdir(previous)

    def test_schedule_includes_freshman_clock_indicator(self):
        previous = os.getcwd()
        with tempfile.TemporaryDirectory() as directory:
            try:
                os.chdir(directory)
                path = Path('user_data/2612345678/schedule.json')
                path.parent.mkdir(parents=True)
                path.write_text(json.dumps({'1': [{
                    '课程名': '高等数学', '星期': '1', '节次': '1', '节数': '2',
                }]}, ensure_ascii=False), encoding='utf-8')

                with patch('services.urp_service._get_freshman_year', return_value=2026):
                    schedule = get_schedule('2612345678')
                self.assertTrue(schedule['is_freshman'])
            finally:
                os.chdir(previous)


if __name__ == '__main__':
    unittest.main()
