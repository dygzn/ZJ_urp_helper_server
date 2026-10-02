"""静态资源版本与真实 Jinja 模板渲染，不启动数据库或教务服务。"""

import ast
import os
import re
import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from flask import render_template


ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ('index.html', 'admin.html', 'ad_detail.html')


def load_template_app():
    # 执行入口中的 Flask 初始化和模板注册，隔离数据库、OCR 等无关依赖。
    source = ast.parse((ROOT / 'app.py').read_text(encoding='utf-8'))
    nodes = []
    for node in source.body:
        if isinstance(node, ast.Import) and all(alias.name == 'os' for alias in node.names):
            nodes.append(node)
        elif isinstance(node, ast.ImportFrom) and node.module == 'flask':
            nodes.append(node)
        elif isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == 'app' for target in node.targets
        ):
            nodes.append(node)
        elif isinstance(node, ast.FunctionDef) and node.name == 'static_versioned':
            nodes.append(node)
    namespace = {'__name__': 'static_versioning_test', '__file__': str(ROOT / 'app.py')}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(ROOT / 'app.py'), 'exec'), namespace)
    app = namespace['app']
    app.template_folder = str(ROOT / 'templates')
    return app


class StaticVersioningTests(unittest.TestCase):
    def setUp(self):
        self.app = load_template_app()
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.app.static_folder = self.directory.name
        self.asset = Path(self.directory.name) / 'css' / 'taste-theme.css'
        self.asset.parent.mkdir()
        self.asset.write_text('body { color: black; }', encoding='utf-8')

    def versioned_url(self, filename='css/taste-theme.css'):
        with self.app.test_request_context('/'):
            return self.app.jinja_env.globals['static_versioned'](filename)

    def test_existing_asset_has_stable_version(self):
        url = self.versioned_url()
        self.assertEqual(urlsplit(url).path, '/static/css/taste-theme.css')
        self.assertTrue(parse_qs(urlsplit(url).query)['v'][0])
        self.assertEqual(self.versioned_url(), url)

    def test_mtime_change_updates_version_within_same_second(self):
        timestamp = 1_700_000_000_123_000_000
        os.utime(self.asset, ns=(timestamp, timestamp))
        initial = self.versioned_url()
        stat = self.asset.stat()
        os.utime(self.asset, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
        self.assertNotEqual(self.versioned_url(), initial)

    def test_missing_asset_falls_back_and_recovers_when_created(self):
        self.asset.unlink()
        self.assertEqual(self.versioned_url(), '/static/css/taste-theme.css')
        self.asset.write_text('body {}', encoding='utf-8')
        self.assertIn('?v=', self.versioned_url())

    def test_static_url_respects_application_mount_prefix(self):
        with self.app.test_request_context('/', environ_overrides={'SCRIPT_NAME': '/urp'}):
            url = self.app.jinja_env.globals['static_versioned']('css/taste-theme.css')
        self.assertEqual(urlsplit(url).path, '/urp/static/css/taste-theme.css')

    def test_rendered_templates_share_versions_and_serve_assets(self):
        self.app.static_folder = str(ROOT / 'static')
        shared_urls = []
        for template in TEMPLATES:
            with self.subTest(template=template), self.app.test_request_context('/'):
                html = render_template(template, ad={'enabled': False})
                urls = re.findall(r'(?:src|href)="(/static/[^\"]+)"', html)
                self.assertTrue(urls)
                for url in urls:
                    self.assertIn('v', parse_qs(urlsplit(url).query), url)
                    self.assertTrue((ROOT / urlsplit(url).path.lstrip('/')).is_file(), url)
                shared_urls.append(next(url for url in urls if '/css/taste-theme.css?' in url))
        self.assertEqual(len(set(shared_urls)), 1)
        response = self.app.test_client().get(shared_urls[0])
        self.addCleanup(response.close)
        self.assertEqual(response.status_code, 200)

    def test_templates_use_helper_for_all_css_and_js_references(self):
        for template in TEMPLATES:
            with self.subTest(template=template):
                html = (ROOT / 'templates' / template).read_text(encoding='utf-8')
                self.assertIsNone(re.search(r'(?:src|href)="/static/[^\"]+\.(?:css|js)', html))
                references = re.findall(r"static_versioned\('([^']+)'\)", html)
                self.assertTrue(references)
                for filename in references:
                    self.assertTrue((ROOT / 'static' / filename).is_file(), filename)


if __name__ == '__main__':
    unittest.main()
