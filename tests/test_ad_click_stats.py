import os
import sqlite3
import tempfile
from contextlib import closing
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

import app as app_module
import database

try:
    from services import ad_service
except ImportError:
    ad_service = None


ROOT = Path(__file__).resolve().parents[1]


class AdClickStatsServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_config = {
            'database': {
                'type': 'sqlite',
                'sqlite_path': os.path.join(self.temp_dir.name, 'ad-stats.db'),
            }
        }
        self.now = datetime(2026, 9, 2, 12, 30, 0)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_same_day_entries_increment_a_persistent_daily_counter(self):
        self.assertIsNotNone(ad_service, '广告统计服务尚未实现')
        database.init_db(self.database_config)

        ad_service.record_ad_click(self.database_config, now=self.now)
        ad_service.record_ad_click(self.database_config, now=self.now)
        ad_service.record_ad_click(
            self.database_config,
            now=datetime(2026, 9, 1, 18, 0, 0),
        )

        stats = ad_service.get_ad_click_stats(
            self.database_config,
            now=self.now,
        )

        self.assertEqual(stats['total_clicks'], 3)
        self.assertEqual(stats['today_clicks'], 2)
        self.assertEqual(stats['last_7_days_clicks'], 3)
        self.assertEqual(
            next(item for item in stats['daily'] if item['date'] == '2026-09-02')['count'],
            2,
        )
        self.assertEqual(
            next(item for item in stats['daily'] if item['date'] == '2026-09-01')['count'],
            1,
        )

        with database.get_db(self.database_config) as conn:
            columns = {
                row['name']
                for row in conn.execute('PRAGMA table_info(ad_click_stats)').fetchall()
            }
            row_count = conn.execute('SELECT COUNT(*) AS count FROM ad_click_stats').fetchone()['count']

        self.assertEqual(row_count, 2)
        self.assertNotIn('device_id', columns)
        self.assertNotIn('username', columns)

    def test_funnel_events_are_aggregated_and_return_conversion_rates(self):
        self.assertIsNotNone(ad_service, '广告统计服务尚未实现')
        database.init_db(self.database_config)

        for _ in range(4):
            ad_service.record_ad_event('impression', self.database_config, now=self.now)
        for _ in range(2):
            ad_service.record_ad_event('click', self.database_config, now=self.now)
        ad_service.record_ad_event('copy', self.database_config, now=self.now)
        ad_service.record_ad_event('dismiss', self.database_config, now=self.now)

        stats = ad_service.get_ad_click_stats(self.database_config, now=self.now)

        self.assertEqual(stats['total_impressions'], 4)
        self.assertEqual(stats['total_clicks'], 2)
        self.assertEqual(stats['total_copies'], 1)
        self.assertEqual(stats['total_dismissals'], 1)
        self.assertEqual(stats['click_through_rate'], 50.0)
        self.assertEqual(stats['detail_conversion_rate'], 50.0)
        self.assertEqual(stats['overall_conversion_rate'], 25.0)
        today = next(item for item in stats['daily'] if item['date'] == '2026-09-02')
        self.assertEqual(
            today,
            {
                'date': '2026-09-02',
                'count': 2,
                'impressions': 4,
                'clicks': 2,
                'copies': 1,
                'dismissals': 1,
            },
        )

        with database.get_db(self.database_config) as conn:
            columns = {
                row['name']
                for row in conn.execute('PRAGMA table_info(ad_click_stats)').fetchall()
            }
        self.assertTrue(
            {'impression_count', 'copy_count', 'dismiss_count'}.issubset(columns)
        )

    def test_unknown_funnel_event_is_rejected(self):
        database.init_db(self.database_config)

        with self.assertRaises(ValueError):
            ad_service.record_ad_event('made-up', self.database_config, now=self.now)

    def test_legacy_click_rows_receive_a_minimum_impression_denominator(self):
        database_path = self.database_config['database']['sqlite_path']
        with closing(sqlite3.connect(database_path)) as conn:
            conn.execute(
                'CREATE TABLE ad_click_stats ('
                'ad_key TEXT NOT NULL, click_date TEXT NOT NULL, '
                'click_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, '
                'PRIMARY KEY (ad_key, click_date))'
            )
            conn.execute(
                'INSERT INTO ad_click_stats '
                '(ad_key, click_date, click_count, updated_at) VALUES (?, ?, ?, ?)',
                ('student-discount', '2026-09-02', 7, '2026-09-02T10:00:00'),
            )
            conn.commit()

        database.init_db(self.database_config)
        stats = ad_service.get_ad_click_stats(self.database_config, now=self.now)

        self.assertEqual(stats['total_clicks'], 7)
        self.assertEqual(stats['total_impressions'], 7)
        self.assertEqual(stats['click_through_rate'], 100.0)


class AdDetailClickRecordingTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_config = {
            'database': {
                'type': 'sqlite',
                'sqlite_path': os.path.join(self.temp_dir.name, 'ad-detail.db'),
            }
        }
        database.init_db(self.database_config)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_opening_detail_page_records_one_entry_without_blocking_render(self):
        self.assertIsNotNone(ad_service, '广告统计服务尚未实现')

        def record_in_test_database(event_type):
            ad_service.record_ad_event(
                event_type,
                self.database_config,
                now=datetime(2026, 9, 2, 13, 0, 0),
            )

        with mock.patch.object(
            app_module,
            'record_ad_event',
            side_effect=record_in_test_database,
            create=True,
        ):
            response = app_module.app.test_client().get('/ad-detail?source=header')

        self.assertEqual(response.status_code, 200)
        with database.get_db(self.database_config) as conn:
            count = conn.execute(
                'SELECT COALESCE(SUM(click_count), 0) AS count FROM ad_click_stats'
            ).fetchone()['count']
        self.assertEqual(count, 1)

    def test_statistics_failure_does_not_break_detail_page(self):
        with (
            mock.patch.object(
                app_module,
                'record_ad_event',
                side_effect=RuntimeError('database unavailable'),
                create=True,
            ),
            mock.patch.object(app_module.app.logger, 'exception'),
        ):
            response = app_module.app.test_client().get('/ad-detail?source=header')

        self.assertEqual(response.status_code, 200)


class AdEventRouteTests(unittest.TestCase):
    def test_public_event_endpoint_accepts_known_event(self):
        with mock.patch.object(app_module, 'record_ad_event') as recorder:
            response = app_module.app.test_client().post(
                '/api/ad/event',
                json={'event': 'impression'},
            )

        self.assertEqual(response.status_code, 204)
        recorder.assert_called_once_with('impression')

    def test_public_event_endpoint_rejects_unknown_event(self):
        with mock.patch.object(app_module, 'record_ad_event') as recorder:
            response = app_module.app.test_client().post(
                '/api/ad/event',
                json={'event': 'made-up'},
            )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()['success'], False)
        recorder.assert_not_called()


class AdminAdStatsRouteTests(unittest.TestCase):
    def test_ad_stats_endpoint_requires_admin_key(self):
        response = app_module.app.test_client().get('/api/admin/ad_stats')

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.get_json()['success'], False)

    def test_ad_stats_endpoint_returns_aggregated_data(self):
        import routes.admin_routes as admin_routes

        expected = {
            'total_clicks': 12,
            'today_clicks': 3,
            'last_7_days_clicks': 8,
            'daily': [{'date': '2026-09-02', 'count': 3}],
        }
        with (
            mock.patch('auth.get_admin_key', return_value='test-admin-key'),
            mock.patch.object(
                admin_routes,
                'get_ad_click_stats',
                return_value=expected,
                create=True,
            ),
        ):
            response = app_module.app.test_client().get(
                '/api/admin/ad_stats',
                headers={'Admin-Key': 'test-admin-key'},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {'success': True, 'data': expected})


class AdminAdStatsUiTests(unittest.TestCase):
    def setUp(self):
        self.html = (ROOT / 'templates' / 'admin.html').read_text(encoding='utf-8')
        self.js = (ROOT / 'static' / 'js' / 'admin.js').read_text(encoding='utf-8')

    def test_admin_page_exposes_ad_stats_tab_and_loader(self):
        self.assertIn("switchTab('ad-stats')", self.html)
        self.assertIn('id="tab-ad-stats"', self.html)
        self.assertIn('id="ad-stats"', self.html)
        self.assertIn('function loadAdStats()', self.js)
        self.assertIn("/api/admin/ad_stats", self.js)
        self.assertIn("tabName === 'ad-stats'", self.js)

    def test_admin_page_shows_the_full_conversion_funnel(self):
        self.assertIn('广告展示', self.js)
        self.assertIn('详情点击', self.js)
        self.assertIn('微信复制', self.js)
        self.assertIn('横幅点击率', self.js)
        self.assertIn('完整转化率', self.js)


if __name__ == '__main__':
    unittest.main()
