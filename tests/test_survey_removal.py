import os
import pathlib
import sqlite3
import tempfile
import unittest
from contextlib import closing

from bs4 import BeautifulSoup

import app as app_module
import database


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[1]


class SurveyUiRemovalTests(unittest.TestCase):
    def setUp(self):
        self.client = app_module.app.test_client()

    def test_user_page_has_no_survey_feature(self):
        response = self.client.get('/')
        self.assertEqual(response.status_code, 200)
        soup = BeautifulSoup(response.get_data(as_text=True), 'html.parser')
        self.assertIsNone(soup.select_one('[data-page="surveys"]'))
        self.assertIsNone(soup.select_one('#page-surveys'))

    def test_admin_page_has_no_survey_feature(self):
        response = self.client.get('/admin')
        self.assertEqual(response.status_code, 200)
        soup = BeautifulSoup(response.get_data(as_text=True), 'html.parser')
        self.assertIsNone(soup.select_one('#tab-surveys'))
        self.assertIsNone(soup.select_one('#survey-modal'))
        self.assertNotIn("switchTab('surveys')", response.get_data(as_text=True))

    def test_frontend_scripts_have_no_survey_requests_or_handlers(self):
        main_js = (PROJECT_ROOT / 'static/js/main.js').read_text(encoding='utf-8')
        admin_js = (PROJECT_ROOT / 'static/js/admin.js').read_text(encoding='utf-8')
        for removed_text in ('/api/surveys', 'loadSurveysList', 'displaySurveysList'):
            self.assertNotIn(removed_text, main_js)
        for removed_text in (
            '/api/admin/surveys', 'loadSurveys', 'displaySurveys',
            'showCreateSurveyModal', 'showEditSurveyModal',
            'closeSurveyModal', 'handleSurveySubmit', 'deleteSurvey',
        ):
            self.assertNotIn(removed_text, admin_js)

    def test_admin_checkbox_labels_keep_a_complete_shared_css_rule(self):
        css = (PROJECT_ROOT / 'static/css/admin.css').read_text(encoding='utf-8')
        rules = []
        rule_start = 0
        block_start = None
        depth = 0
        quote = None
        escaped = False

        for index, char in enumerate(css):
            if quote:
                if escaped:
                    escaped = False
                elif char == '\\':
                    escaped = True
                elif char == quote:
                    quote = None
                continue
            if char in ('"', "'"):
                quote = char
            elif char == '{':
                if depth == 0:
                    header = css[rule_start:index].strip()
                    block_start = index + 1
                depth += 1
            elif char == '}':
                depth -= 1
                self.assertGreaterEqual(depth, 0, 'admin.css has an unmatched closing brace')
                if depth == 0:
                    rules.append((header, css[block_start:index]))
                    rule_start = index + 1

        self.assertEqual(depth, 0, 'admin.css has an unclosed rule block')

        expected_selectors = {
            '.config-section label:has(input[type="checkbox"])',
            '.form-group label:has(input[type="checkbox"])',
            '#announcement-form > label',
        }
        matching_bodies = []
        for header, body in rules:
            selectors = {selector.strip() for selector in header.split(',')}
            self.assertNotIn('', selectors, f'dangling selector comma in: {header!r}')
            if expected_selectors.issubset(selectors):
                matching_bodies.append(body)

        self.assertEqual(len(matching_bodies), 1)
        declarations = ''.join(matching_bodies[0].split())
        self.assertIn('display:flex;', declarations)
        self.assertIn('align-items:center;', declarations)


class SurveyApiRemovalTests(unittest.TestCase):
    def setUp(self):
        self.client = app_module.app.test_client()

    def test_survey_api_routes_are_not_registered(self):
        registered_rules = {str(rule) for rule in app_module.app.url_map.iter_rules()}
        self.assertNotIn('/api/surveys', registered_rules)
        self.assertNotIn('/api/admin/surveys', registered_rules)
        self.assertNotIn('/api/admin/surveys/<int:survey_id>', registered_rules)

    def test_removed_survey_api_paths_return_json_404(self):
        requests = (
            ('GET', '/api/surveys'),
            ('GET', '/api/admin/surveys'),
            ('POST', '/api/admin/surveys'),
            ('PUT', '/api/admin/surveys/1'),
            ('DELETE', '/api/admin/surveys/1'),
        )
        for method, path in requests:
            with self.subTest(method=method, path=path):
                response = self.client.open(path, method=method)
                self.assertEqual(response.status_code, 404)
                self.assertTrue(response.is_json)
                self.assertFalse(response.get_json()['success'])

    def test_logging_map_has_no_survey_endpoints(self):
        source = (PROJECT_ROOT / 'services/logging_service.py').read_text(encoding='utf-8')
        self.assertNotIn("'/api/surveys'", source)
        self.assertNotIn("'/api/admin/surveys'", source)


class SurveyDatabaseRemovalTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.sqlite_path = os.path.join(self.temp_dir.name, 'survey-removal.db')
        self.config = {
            'database': {'type': 'sqlite', 'sqlite_path': self.sqlite_path}
        }

    def tearDown(self):
        self.temp_dir.cleanup()

    def survey_table_exists(self):
        with closing(sqlite3.connect(self.sqlite_path)) as conn, conn:
            return conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'surveys'"
            ).fetchone() is not None

    def test_fresh_database_does_not_create_surveys_table(self):
        database.init_db(self.config)
        self.assertFalse(self.survey_table_exists())

    def test_init_db_drops_legacy_surveys_table_and_rows(self):
        with closing(sqlite3.connect(self.sqlite_path)) as conn, conn:
            conn.execute(
                'CREATE TABLE surveys ('
                'id INTEGER PRIMARY KEY, title TEXT, url TEXT, '
                'create_time TEXT, is_active INTEGER)'
            )
            conn.execute(
                'INSERT INTO surveys VALUES (?, ?, ?, ?, ?)',
                (1, '旧问卷', 'https://example.com', '2026-08-13', 1),
            )
        database.init_db(self.config)
        self.assertFalse(self.survey_table_exists())

    def test_schema_source_keeps_only_legacy_drop_statement(self):
        source = (PROJECT_ROOT / 'database.py').read_text(encoding='utf-8')
        self.assertNotIn('CREATE TABLE IF NOT EXISTS surveys', source)
        self.assertNotIn('idx_survey_active', source)
        self.assertNotIn("'surveys': ['id'", source)
        self.assertIn('DROP TABLE IF EXISTS surveys', source)
