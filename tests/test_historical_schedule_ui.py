from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class HistoricalScheduleUiTests(unittest.TestCase):
    def test_schedule_page_has_historical_schedule_entry_and_modal(self):
        template = (ROOT / 'templates' / 'index.html').read_text(encoding='utf-8')

        self.assertIn('历年课表查询', template)
        self.assertIn('showHistoricalSchedule()', template)
        self.assertIn('id="historical-schedule-modal"', template)
        self.assertIn('id="historical-semester-select"', template)
        self.assertIn('id="historical-schedule-body"', template)

    def test_main_script_loads_and_renders_historical_schedule(self):
        script = (ROOT / 'static' / 'js' / 'main.js').read_text(encoding='utf-8')

        self.assertIn('/api/historical_schedule', script)
        self.assertIn('function showHistoricalSchedule()', script)
        self.assertIn('function loadHistoricalSchedule(', script)
        self.assertIn('function renderHistoricalSchedule(', script)
