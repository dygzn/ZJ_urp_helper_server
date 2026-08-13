import pathlib
import unittest

from bs4 import BeautifulSoup

import app as app_module


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
