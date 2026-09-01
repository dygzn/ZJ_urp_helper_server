from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ShortcutApiTemplateTests(unittest.TestCase):
    def test_shortcut_api_has_a_dedicated_page(self):
        html = (ROOT / 'templates' / 'index.html').read_text(encoding='utf-8')

        self.assertIn('data-page="shortcut-api"', html)
        self.assertIn('id="page-shortcut-api"', html)
        self.assertIn('id="shortcut-api-card"', html)
        self.assertIn('id="shortcut-api-status"', html)
        self.assertIn('generateShortcutApiKey()', html)
        self.assertIn('copyShortcutApiKey()', html)
        self.assertIn('id="shortcut-api-endpoint"', html)

        member_start = html.index('id="page-member"')
        shortcut_start = html.index('id="page-shortcut-api"')
        self.assertLess(shortcut_start, member_start)

    def test_shortcut_api_page_has_its_own_member_status_card(self):
        html = (ROOT / 'templates' / 'index.html').read_text(encoding='utf-8')

        page_start = html.index('id="page-shortcut-api"')
        page_end = html.index('id="page-member"')
        page = html[page_start:page_end]
        self.assertIn('id="shortcut-api-member-status"', page)

    def test_main_script_loads_status_and_uses_member_api_key_endpoints(self):
        script = (ROOT / 'static' / 'js' / 'main.js').read_text(encoding='utf-8')

        self.assertIn('function loadShortcutApiPage()', script)
        self.assertIn('function loadShortcutApiKey()', script)
        self.assertIn('/api/member/api-key', script)
        self.assertIn('function generateShortcutApiKey()', script)
        self.assertIn('function copyShortcutApiKey()', script)

        self.assertIn("case 'shortcut-api':", script)
        self.assertIn("loadMemberStatus('shortcut-api-member-status')", script)

        member_loader = re.search(
            r'async function loadMemberPage\(\) \{(?P<body>.*?)\n\}',
            script,
            re.DOTALL,
        )
        self.assertIsNotNone(member_loader)
        self.assertNotIn('loadShortcutApiKey()', member_loader.group('body'))


if __name__ == '__main__':
    unittest.main()
