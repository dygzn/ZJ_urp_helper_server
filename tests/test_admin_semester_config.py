import unittest

from bs4 import BeautifulSoup

from app import app


class AdminSemesterConfigPageTests(unittest.TestCase):
    def test_admin_page_renders_first_week_date_form(self):
        response = app.test_client().get('/admin')

        self.assertEqual(response.status_code, 200)
        soup = BeautifulSoup(response.get_data(as_text=True), 'html.parser')
        form = soup.select_one('#semester-form')
        self.assertIsNotNone(form)
        self.assertEqual(form.get('onsubmit'), 'handleUpdateSemester(event)')

        date_input = form.select_one('#semester-start')
        self.assertIsNotNone(date_input)
        self.assertEqual(date_input.get('type'), 'date')
        self.assertIn('第一周星期一', form.get_text(' ', strip=True))


if __name__ == '__main__':
    unittest.main()
