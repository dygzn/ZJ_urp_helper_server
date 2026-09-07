import re
import unittest
from pathlib import Path

from bs4 import BeautifulSoup

import app as app_module


PROJECT_ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = {
    'index.html': 'user-ui-copy',
    'admin.html': 'admin-ui-copy',
    'ad_detail.html': 'ad-ui-copy',
}
REMOVED_ROUTES = {
    '/api/grades',
    '/api/schedule/other_majors',
    '/api/schedule/other_major',
    '/api/rebind_notified',
    '/api/admin/invitation_debug',
    '/api/admin/pending_requests',
    '/api/admin/approve_rebind',
    '/api/sign/login',
    '/api/sign/login_link',
    '/api/sign/status',
    '/api/sign/start',
    '/api/sign/stop',
    '/api/sign/stream',
}
RETAINED_ROUTES = {
    '/api/login',
    '/api/request_rebind',
    '/api/member/pay_notify',
    '/api/member/pay_return',
    '/api/member/api-key',
    '/api/shortcut/query',
    '/api/admin/users',
    '/api/admin/ad_stats',
    '/api/admin/monitor/online',
    '/api/admin/announcements',
    '/api/admin/service-status',
    '/api/admin/feedback',
    '/api/admin/members',
    '/api/admin/withdrawals',
    '/api/admin/config',
}
FRONTEND_SCRIPTS = (
    'static/js/main.js',
    'static/js/admin.js',
    'static/js/ad-detail.js',
    'static/js/ui-ux.js',
    'static/js/service-status-ui.js',
)


def javascript_string_literals(source):
    """Yield quoted JavaScript strings while ignoring line and block comments."""
    index = 0
    length = len(source)
    while index < length:
        if source.startswith('//', index):
            newline = source.find('\n', index + 2)
            index = length if newline == -1 else newline + 1
            continue
        if source.startswith('/*', index):
            end = source.find('*/', index + 2)
            index = length if end == -1 else end + 2
            continue
        if source[index] not in ('"', "'", '`'):
            index += 1
            continue

        quote = source[index]
        index += 1
        value = []
        escaped = False
        while index < length:
            char = source[index]
            index += 1
            if escaped:
                value.append(char)
                escaped = False
            elif char == '\\':
                value.append(char)
                escaped = True
            elif char == quote:
                break
            else:
                value.append(char)
        yield ''.join(value)


class HtmlFirstApplicationContractTests(unittest.TestCase):
    def setUp(self):
        self.client = app_module.app.test_client()

    def test_templates_reload_and_ui_responses_are_not_cached(self):
        self.assertTrue(app_module.app.config.get('TEMPLATES_AUTO_RELOAD'))
        self.assertTrue(app_module.app.jinja_env.auto_reload)

        for path in ('/', '/admin', '/ad-detail', '/static/js/main.js'):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 200)
                self.assertIn('no-store', response.headers.get('Cache-Control', ''))
                self.assertEqual(response.headers.get('Pragma'), 'no-cache')
                self.assertEqual(response.headers.get('Expires'), '0')

    def test_route_boundary_keeps_public_contracts_and_removes_dead_routes(self):
        routes = {str(rule) for rule in app_module.app.url_map.iter_rules()}
        for route in REMOVED_ROUTES:
            with self.subTest(removed_route=route):
                self.assertNotIn(route, routes)
        for route in RETAINED_ROUTES:
            with self.subTest(retained_route=route):
                self.assertIn(route, routes)

    def test_templates_expose_html_owned_copy_roots_without_fixed_versions(self):
        for template_name, root_id in TEMPLATES.items():
            with self.subTest(template=template_name):
                source = (PROJECT_ROOT / 'templates' / template_name).read_text(
                    encoding='utf-8'
                )
                soup = BeautifulSoup(source, 'html.parser')
                self.assertIsNotNone(soup.select_one(f'#{root_id}'))
                self.assertIsNotNone(soup.select_one('[data-ui-copy]'))
                self.assertIsNotNone(soup.select_one('[data-ui-template]'))
                self.assertNotRegex(source, r'(?:src|href)="[^"]+\?v=\d+"')

    def test_frontend_scripts_have_no_fixed_chinese_strings_or_removed_api_calls(self):
        removed_text = tuple(REMOVED_ROUTES) + (
            'routes.sign_routes',
            'sign_bp',
            'get_grades',
            'other_major',
            'currentRequestId',
        )
        for relative_path in FRONTEND_SCRIPTS:
            source = (PROJECT_ROOT / relative_path).read_text(encoding='utf-8')
            with self.subTest(script=relative_path):
                chinese_literals = [
                    literal
                    for literal in javascript_string_literals(source)
                    if re.search(r'[\u4e00-\u9fff]', literal)
                ]
                self.assertEqual(chinese_literals, [])
                for removed in removed_text:
                    self.assertNotIn(removed, source)


if __name__ == '__main__':
    unittest.main()
