import unittest
from unittest import mock

from urp.query import URP_query


class HistoricalScheduleLatestTests(unittest.TestCase):
    def test_empty_semester_fetches_latest_semester_after_reading_options(self):
        query = object.__new__(URP_query)
        first = {
            'semester': '',
            'semesters': [
                {'value': '2024-2025-2-1', 'label': '2024-2025学年春(两学期)'},
                {'value': '2025-2026-1-1', 'label': '2025-2026学年秋(两学期)'},
                {'value': '2025-2026-2-1', 'label': '2025-2026学年春(两学期)'},
            ],
            'courses': [],
        }
        latest = dict(first, semester='2025-2026-2-1', courses=[{'课程名': '最新课程'}])
        with mock.patch.object(
            query,
            '_fetch_historical_schedule',
            side_effect=[first, latest],
        ) as fetch:
            result = query.historical_schedule_cx()

        self.assertEqual(result['semester'], '2025-2026-2-1')
        self.assertEqual(result['courses'], [{'课程名': '最新课程'}])
        self.assertEqual(
            fetch.call_args_list,
            [mock.call(''), mock.call('2025-2026-2-1')],
        )

    def test_explicit_semester_does_not_make_probe_request(self):
        query = object.__new__(URP_query)
        expected = {'semester': '2024-2025-2-1', 'semesters': [], 'courses': []}
        with mock.patch.object(
            query,
            '_fetch_historical_schedule',
            return_value=expected,
        ) as fetch:
            result = query.historical_schedule_cx('2024-2025-2-1')

        self.assertEqual(result, expected)
        fetch.assert_called_once_with('2024-2025-2-1')


if __name__ == '__main__':
    unittest.main()
