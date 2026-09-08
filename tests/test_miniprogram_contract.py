import json
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
MINIPROGRAM_ROOT = PROJECT_ROOT / 'miniprogram'


class MiniProgramContractTests(unittest.TestCase):
    def test_required_scaffold_files_exist(self):
        required = [
            MINIPROGRAM_ROOT / 'app.js',
            MINIPROGRAM_ROOT / 'app.json',
            MINIPROGRAM_ROOT / 'app.wxss',
            MINIPROGRAM_ROOT / 'project.config.json',
            MINIPROGRAM_ROOT / 'utils' / 'request.js',
            MINIPROGRAM_ROOT / 'utils' / 'auth.js',
            MINIPROGRAM_ROOT / 'utils' / 'format.js',
        ]
        for path in required:
            self.assertTrue(path.is_file(), f'缺少小程序文件: {path}')

    def test_app_declares_six_pages_and_five_tabs(self):
        app_json_path = MINIPROGRAM_ROOT / 'app.json'
        self.assertTrue(app_json_path.is_file(), f'缺少小程序配置: {app_json_path}')
        config = json.loads(app_json_path.read_text(encoding='utf-8'))
        expected_pages = {
            'pages/home/index',
            'pages/schedule/index',
            'pages/grades/index',
            'pages/exams/index',
            'pages/account/index',
            'pages/bind/index',
        }
        self.assertEqual(set(config.get('pages', [])), expected_pages)
        tab_pages = [item['pagePath'] for item in config.get('tabBar', {}).get('list', [])]
        self.assertEqual(
            tab_pages,
            [
                'pages/home/index',
                'pages/schedule/index',
                'pages/grades/index',
                'pages/exams/index',
                'pages/account/index',
            ],
        )


if __name__ == '__main__':
    unittest.main()
