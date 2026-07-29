import unittest

from bs4 import BeautifulSoup

import app as app_module


class ScheduleTemplateContractTests(unittest.TestCase):
    def test_rendered_schedule_marks_weekend_headers_and_loads_layout_script_first(self):
        client = app_module.app.test_client()

        response = client.get('/')

        self.assertEqual(response.status_code, 200)
        soup = BeautifulSoup(response.get_data(as_text=True), 'html.parser')
        weekend_headers = soup.select(
            '.schedule-header .schedule-header-day.schedule-header-weekend'
        )
        self.assertEqual(
            [header.get_text(strip=True) for header in weekend_headers],
            ['周六', '周日'],
        )

        script_sources = [
            script.get('src')
            for script in soup.select('script[src]')
        ]
        self.assertLess(
            script_sources.index('/static/js/schedule-layout.js'),
            script_sources.index('/static/js/main.js'),
        )


if __name__ == '__main__':
    unittest.main()
