from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ShortcutApiTemplateTests(unittest.TestCase):
    def test_member_page_contains_shortcut_api_card_controls(self):
        html = (ROOT / 'templates' / 'index.html').read_text(encoding='utf-8')

        self.assertIn('id="shortcut-api-card"', html)
        self.assertIn('id="shortcut-api-status"', html)
        self.assertIn('generateShortcutApiKey()', html)
        self.assertIn('copyShortcutApiKey()', html)
        self.assertIn('id="shortcut-api-endpoint"', html)

    def test_main_script_loads_status_and_uses_member_api_key_endpoints(self):
        script = (ROOT / 'static' / 'js' / 'main.js').read_text(encoding='utf-8')

        self.assertIn('function loadShortcutApiKey()', script)
        self.assertIn('/api/member/api-key', script)
        self.assertIn('function generateShortcutApiKey()', script)
        self.assertIn('function copyShortcutApiKey()', script)


if __name__ == '__main__':
    unittest.main()
