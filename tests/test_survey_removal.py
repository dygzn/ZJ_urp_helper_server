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
