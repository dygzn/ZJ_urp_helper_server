"""Run with the backend environment and PYTHONPATH pointing to ../web."""
import sys
import types
import unittest
from unittest.mock import patch

from flask import Flask
from routes import wechat_routes as routes


class WechatScheduleExamTests(unittest.TestCase):
    def query(self, query='', stale=False, update=False):
        app = Flask(__name__)
        config = {'semester_start': '2026-09-07'}
        exams = [{'week': '1', 'day': '6', 'course': '数学', 'time': '08:00-10:00', 'seat': '50'},
                 {'week': '2', 'day': '1', 'course': '英语'}]
        schedule = {'schedule': {}, 'semester_start': '2026-09-07', 'is_freshman': True}
        fake_urp = types.ModuleType('urp')
        fake_urp.URP_query = lambda *args: types.SimpleNamespace(schedule_cx=lambda: None)
        with app.test_request_context('/api/wechat/schedule' + query), \
                patch.object(routes.urp, 'get_config', return_value=config), \
                patch.object(routes.urp, 'get_schedule', return_value=schedule), \
                patch.object(routes.urp, 'get_exams', return_value=exams), \
                patch.object(routes.urp, 'is_calendar_cache_stale', side_effect=lambda username, kind, cfg: stale and kind == 'exams'), \
                patch.object(routes, 'get_current_urp_url', return_value='https://example.invalid'), \
                patch.dict(sys.modules, {'urp': fake_urp}):
            result = (routes.update_schedule if update else routes.schedule).__wrapped__({'username': 'student'})
            if isinstance(result, tuple):
                return result[0].get_json(), result[1]
            return result.get_json(), 200

    def test_exam_only_schedule_includes_seat_and_freshman_clock(self):
        response, status = self.query()
        self.assertEqual(status, 200)
        self.assertEqual(response['data']['schedule'], {})
        self.assertEqual(response['data']['exams'][0]['seat'], '50')
        self.assertEqual(response['data']['semester_start'], '2026-09-07')
        self.assertTrue(response['data']['is_freshman'])

    def test_week_filter_applies_to_exams(self):
        response, _ = self.query('?week=2')
        self.assertEqual([exam['course'] for exam in response['data']['exams']], ['英语'])

    def test_invalid_week_is_rejected(self):
        for query in ['?week=0', '?week=61', '?week=no']:
            self.assertEqual(self.query(query)[1], 400)

    def test_exam_staleness_is_reported_independently(self):
        response, _ = self.query(stale=True)
        self.assertTrue(response['data']['exams_cache_stale'])
        self.assertFalse(response['data']['cache_stale'])

    def test_schedule_update_also_returns_cached_exams_and_staleness(self):
        response, _ = self.query(update=True, stale=True)
        self.assertEqual(response['data']['exams'][0]['seat'], '50')
        self.assertTrue(response['data']['exams_cache_stale'])


if __name__ == '__main__':
    unittest.main()
