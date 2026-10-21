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

    def test_bind_and_account_pages_expose_auth_controls(self):
        bind_markup = (MINIPROGRAM_ROOT / 'pages' / 'bind' / 'index.wxml')
        account_markup = (MINIPROGRAM_ROOT / 'pages' / 'account' / 'index.wxml')
        app_script = (MINIPROGRAM_ROOT / 'app.js').read_text(encoding='utf-8')

        self.assertTrue(bind_markup.is_file(), f'缺少绑定页: {bind_markup}')
        self.assertTrue(account_markup.is_file(), f'缺少账号页: {account_markup}')
        bind_text = bind_markup.read_text(encoding='utf-8')
        account_text = account_markup.read_text(encoding='utf-8')
        for marker in ('username', 'password', 'bind', 'status'):
            self.assertIn(marker, bind_text)
        self.assertIn('username', account_text)
        self.assertIn('rebind', account_text)
        self.assertIn('ensureSession', app_script)
        self.assertTrue(
            'wx.switchTab' in app_script or 'wx.navigateTo' in app_script
        )

    def test_mvp_pages_declare_pull_refresh_states_and_endpoints(self):
        page_contracts = {
            'home': ('/api/wechat/account', '/api/wechat/urgent_event'),
            'schedule': ('/api/wechat/schedule', '/api/wechat/update_schedule'),
            'grades': ('/api/wechat/grades/latest_summary', '/api/wechat/grades/current'),
            'exams': ('/api/wechat/exams', '/api/wechat/update_exams'),
            'account': ('/api/wechat/binding',),
        }
        for page_name, endpoints in page_contracts.items():
            script_path = MINIPROGRAM_ROOT / 'pages' / page_name / 'index.js'
            markup_path = MINIPROGRAM_ROOT / 'pages' / page_name / 'index.wxml'
            self.assertTrue(script_path.is_file(), f'缺少页面脚本: {script_path}')
            self.assertTrue(markup_path.is_file(), f'缺少页面模板: {markup_path}')
            script = script_path.read_text(encoding='utf-8')
            markup = markup_path.read_text(encoding='utf-8')
            self.assertIn('onPullDownRefresh', script)
            self.assertTrue(
                any(marker in markup for marker in ('loading', 'error', 'empty', 'state')),
                f'页面缺少状态节点: {markup_path}',
            )
            for endpoint in endpoints:
                self.assertIn(endpoint, script)

    def test_schedule_wxml_uses_wxml_safe_course_properties(self):
        markup = (
            MINIPROGRAM_ROOT / 'pages' / 'schedule' / 'index.wxml'
        ).read_text(encoding='utf-8')
        self.assertNotRegex(markup, r'\bcourse\.[\u4e00-\u9fff]')

    def test_tabbar_and_home_quick_actions_have_local_icons(self):
        config = json.loads(
            (MINIPROGRAM_ROOT / 'app.json').read_text(encoding='utf-8')
        )
        icon_names = ('home', 'schedule', 'grades', 'exams', 'account')
        tab_items = config.get('tabBar', {}).get('list', [])
        self.assertEqual(len(tab_items), len(icon_names))
        for item, icon_name in zip(tab_items, icon_names):
            self.assertEqual(item.get('iconPath'), f'assets/icons/{icon_name}.png')
            self.assertEqual(
                item.get('selectedIconPath'),
                f'assets/icons/{icon_name}-selected.png',
            )
            self.assertTrue(
                (MINIPROGRAM_ROOT / item['iconPath']).is_file(),
                f'缺少 Tab 图标: {item["iconPath"]}',
            )
            self.assertTrue(
                (MINIPROGRAM_ROOT / item['selectedIconPath']).is_file(),
                f'缺少选中 Tab 图标: {item["selectedIconPath"]}',
            )

        home_markup = (
            MINIPROGRAM_ROOT / 'pages' / 'home' / 'index.wxml'
        ).read_text(encoding='utf-8')
        self.assertEqual(home_markup.count('quick-icon-image'), 4)
        for icon_name in icon_names[1:]:
            self.assertIn(
                f'/assets/icons/{icon_name}-selected.png',
                home_markup,
            )


if __name__ == '__main__':
    unittest.main()
