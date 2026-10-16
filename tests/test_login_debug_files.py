"""调试快照与配置目录隔离，不读取实际配置或登录页面。"""
from pathlib import Path
import os
import tempfile
import unittest
from unittest.mock import patch

from urp import login


class LoginDebugFilesTests(unittest.TestCase):
    def setUp(self):
        temporary = self.enterContext(tempfile.TemporaryDirectory())
        previous = os.getcwd()
        os.chdir(temporary)
        self.addCleanup(os.chdir, previous)
        self.enterContext(patch.object(login, '_debug_file_times', {}))
        self.enterContext(patch.object(login, 'DEBUG_FILE_DIRECTORY', Path('logs/urp-debug'), create=True))

    def test_disabled_debug_never_creates_files_or_directories(self):
        with patch.object(login, 'SAVE_DEBUG_FILES', False):
            self.assertFalse(login._save_debug_file('last_jiaowu_login.html', '<html>synthetic</html>'))
            self.assertFalse(login._save_debug_file('last_jiaowu_captcha.gif', b'GIF89a'))
        self.assertEqual(list(Path('.').iterdir()), [])

    def test_enabled_html_snapshot_stays_out_of_configuration_directory(self):
        Path('data').mkdir()
        Path('data/config.json').write_text('{"fixture": true}', encoding='utf-8')
        with patch.object(login, 'SAVE_DEBUG_FILES', True):
            self.assertTrue(login._save_debug_file('last_jiaowu_login.html', '<html>synthetic</html>'))
        self.assertTrue(Path('logs/urp-debug/last_jiaowu_login.html').is_file())
        self.assertEqual(Path('logs/urp-debug/last_jiaowu_login.html').read_text(), '<html>synthetic</html>')
        self.assertEqual(sorted(p.name for p in Path('data').iterdir()), ['config.json'])
        self.assertEqual(Path('data/config.json').read_text(), '{"fixture": true}')

    def test_enabled_binary_captcha_uses_the_same_debug_directory(self):
        with patch.object(login, 'SAVE_DEBUG_FILES', True):
            self.assertTrue(login._save_debug_file('last_jiaowu_captcha.gif', b'GIF89a-synthetic'))
        self.assertTrue(Path('logs/urp-debug/last_jiaowu_captcha.gif').is_file())
        self.assertEqual(Path('logs/urp-debug/last_jiaowu_captcha.gif').read_bytes(), b'GIF89a-synthetic')
        self.assertFalse(Path('data').exists())

    def test_throttled_snapshot_preserves_previous_file_until_interval_passes(self):
        with patch.object(login, 'SAVE_DEBUG_FILES', True), patch('urp.login.time.monotonic', side_effect=[100, 101, 161]):
            self.assertTrue(login._save_debug_file('last_vpn_portal_response.html', 'first'))
            self.assertFalse(login._save_debug_file('last_vpn_portal_response.html', 'second'))
            self.assertTrue(Path('logs/urp-debug/last_vpn_portal_response.html').is_file())
            self.assertEqual(Path('logs/urp-debug/last_vpn_portal_response.html').read_text(), 'first')
            self.assertTrue(login._save_debug_file('last_vpn_portal_response.html', 'third'))
        self.assertTrue(Path('logs/urp-debug/last_vpn_portal_response.html').is_file())
        self.assertEqual(Path('logs/urp-debug/last_vpn_portal_response.html').read_text(), 'third')

    def test_preexisting_configuration_html_is_not_deleted_or_rewritten(self):
        Path('data').mkdir()
        legacy = Path('data/last_jiaowu_login.html')
        legacy.write_text('legacy-fixture')
        with patch.object(login, 'SAVE_DEBUG_FILES', True):
            self.assertTrue(login._save_debug_file('last_jiaowu_login.html', 'new-fixture'))
        self.assertEqual(legacy.read_text(), 'legacy-fixture')
        self.assertTrue(Path('logs/urp-debug/last_jiaowu_login.html').is_file())
        self.assertEqual(Path('logs/urp-debug/last_jiaowu_login.html').read_text(), 'new-fixture')

    def test_debug_output_failure_does_not_abort_login(self):
        with patch.object(login, 'SAVE_DEBUG_FILES', True), patch('urp.login.os.makedirs', side_effect=PermissionError('offline-fixture')):
            self.assertFalse(login._save_debug_file('last_jiaowu_login.html', 'synthetic'))


if __name__ == '__main__':
    unittest.main()
