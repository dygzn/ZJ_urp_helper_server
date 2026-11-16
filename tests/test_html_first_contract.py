"""旧清理分支合并回归：保留当前接口、模板、广告配置与资源版本行为。"""
import os
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]


class HtmlMergeContractTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        previous = os.getcwd()
        os.chdir(self.directory.name)
        self.addCleanup(os.chdir, previous)
        self.config = {'urp_urls': ['https://urp.example/'], 'current_url_index': 0,
                       'semester_start': '2026-09-07', 'advertisement': {'enabled': False}}
        values = {
            'FLASK_DEBUG': '0', 'SECRET_KEY': 'offline-html-session-secret',
            'ADMIN_KEY': 'offline-html-admin-secret', 'MERCHANT_NUM': 'offline-merchant',
            'PAY_SECRET_KEY': 'offline-html-payment-secret',
        }
        for override in (
            patch.dict(os.environ, values),
            patch('database.init_db'),
            patch('services.temporary_session_service.start_temporary_session_cleanup'),
            patch('services.config_service.get_config', return_value=self.config),
            patch('services.ad_config_service.get_config', return_value=self.config),
            patch('constants.MERCHANT_NUM', 'offline-merchant'),
            patch('constants.PAY_SECRET_KEY', 'offline-html-payment-secret'),
        ):
            override.start()
            self.addCleanup(override.stop)
        self.app = runpy.run_path(str(ROOT / 'app.py'), run_name='html_merge_test')['app']
        self.app.template_folder = str(ROOT / 'templates')
        self.app.static_folder = str(ROOT / 'static')
        self.app.testing = True
        self.client = self.app.test_client()

    def test_current_public_and_authenticated_api_routes_are_retained(self):
        routes = {str(rule) for rule in self.app.url_map.iter_rules()}
        expected = {
            '/api/login', '/api/request_rebind', '/api/schedule/other_majors',
            '/api/schedule/other_major', '/api/grades/by_semester',
            '/api/member/pay_notify',
            '/api/admin/activity/today', '/api/admin/announcements',
            '/api/admin/feedback', '/api/admin/members', '/api/admin/config',
            '/api/wechat/account', '/api/wechat/bind', '/api/wechat/binding',
        }
        self.assertFalse(expected - routes, expected - routes)
        self.assertNotIn('/api/admin/approve_rebind', routes)
        self.assertNotIn('/api/sign/start', routes)

    def test_current_templates_render_versioned_local_assets(self):
        for url, status in (('/', 200), ('/admin', 200), ('/ad-detail', 404)):
            with self.subTest(url=url):
                result = self.client.get(url)
                self.assertEqual(result.status_code, status)
                soup = BeautifulSoup(result.get_data(as_text=True), 'html.parser')
                assets = [tag.get('src') or tag.get('href') for tag in soup.select('script[src],link[rel="stylesheet"]')]
                assets = [asset for asset in assets if asset.startswith('/static/')]
                self.assertTrue(assets)
                for asset in assets:
                    self.assertTrue(parse_qs(urlsplit(asset).query).get('v'), asset)
                    served = self.client.get(asset)
                    self.addCleanup(served.close)
                    self.assertEqual(served.status_code, 200, asset)

    def test_advertisement_keeps_configured_content_and_escapes_text(self):
        self.config['advertisement'] = {
            'enabled': True, 'title': '离线配置活动', 'summary': '活动简介',
            'body': '<img src=x onerror=alert(1)>', 'contact': 'offline-contact',
        }
        result = self.client.get('/ad-detail')
        self.assertEqual(result.status_code, 200)
        soup = BeautifulSoup(result.get_data(as_text=True), 'html.parser')
        self.assertIn('离线配置活动', soup.get_text())
        self.assertIn('offline-contact', soup.get_text())
        self.assertIn('<img src=x onerror=alert(1)>', soup.get_text())
        self.assertIsNone(soup.select_one('img[src="x"]'))


if __name__ == '__main__':
    unittest.main()
