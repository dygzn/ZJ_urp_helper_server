import unittest
from unittest.mock import patch

from pathlib import Path
import services.config_service as config_service




def offline_app(case):
    import os
    import runpy
    from contextlib import ExitStack
    root = Path(__file__).resolve().parents[1]
    fixture_config = {'urp_urls': ['http://url1.test/urp/'], 'current_url_index': 0}
    for target in ('services.config_service.get_config', 'database.get_config',
                   'routes.data_routes.get_config', 'services.ad_config_service.get_config'):
        case.enterContext(patch(target, return_value=fixture_config))
    environment = {
        'FLASK_DEBUG': '0', 'SECRET_KEY': 'synthetic-session-key',
        'ADMIN_KEY': 'synthetic-admin-key', 'MERCHANT_NUM': 'synthetic-merchant',
        'PAY_SECRET_KEY': 'synthetic-payment-key',
    }
    with ExitStack() as stack:
        stack.enter_context(patch.dict(os.environ, environment))
        stack.enter_context(patch('database.init_db'))
        stack.enter_context(patch('database.ensure_api_keys_table'))
        stack.enter_context(patch('constants.MERCHANT_NUM', environment['MERCHANT_NUM']))
        stack.enter_context(patch('constants.PAY_SECRET_KEY', environment['PAY_SECRET_KEY']))
        loaded = runpy.run_path(str(root / 'app.py'), run_name='offline_url_app')
    return loaded


class AppErrorHandlingTests(unittest.TestCase):
    def setUp(self):
        loaded = offline_app(self)
        self.app = loaded['app']
        self.handler = loaded['handle_api_exception']
        cleanup = patch('services.temporary_session_service.start_temporary_session_cleanup')
        cleanup.start()
        self.addCleanup(cleanup.stop)
        self.client = self.app.test_client()

    def get_without_exception(self, path):
        try:
            return self.client.get(path)
        except Exception as exc:
            self.fail(f'GET {path} raised {type(exc).__name__}: {exc}')

    def test_favicon_returns_no_content(self):
        response = self.get_without_exception('/favicon.ico')

        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.data, b'')

    def test_missing_web_page_remains_not_found(self):
        response = self.get_without_exception('/definitely-missing-page')

        self.assertEqual(response.status_code, 404)
        self.assertFalse(response.is_json)

    def test_missing_api_returns_json_not_found(self):
        response = self.get_without_exception('/api/definitely-missing')

        self.assertEqual(response.status_code, 404)
        self.assertTrue(response.is_json)
        self.assertEqual(response.get_json()['success'], False)

    def test_api_runtime_error_keeps_existing_json_500_contract(self):
        with self.app.test_request_context('/api/test-error'):
            response, status = self.handler(
                RuntimeError('boom')
            )

        self.assertEqual(status, 500)
        self.assertEqual(
            response.get_json(),
            {
                'success': False,
                'message': '服务器内部错误，请稍后重试',
            },
        )

    def test_home_page_still_loads(self):
        with patch('services.config_service.get_config', return_value={}), patch('services.ad_config_service.get_config', return_value={}):
            response = self.get_without_exception('/')

        self.assertEqual(response.status_code, 200)

    def test_request_url_is_snapshotted_before_view_dispatch(self):
        current = {'url': 'http://url1.test/'}

        def current_config():
            return {
                'urp_urls': [current['url']],
                'current_url_index': 0,
            }

        with patch.object(
            config_service,
            'get_config',
            side_effect=current_config,
        ) as get_config:
            with self.app.test_request_context('/favicon.ico'):
                self.assertIsNone(self.app.preprocess_request())
                current['url'] = 'http://url2.test/'
                first = config_service.get_current_urp_url()

            with self.app.test_request_context('/favicon.ico'):
                self.assertIsNone(self.app.preprocess_request())
                second = config_service.get_current_urp_url()

        self.assertEqual(first, 'http://url1.test/')
        self.assertEqual(second, 'http://url2.test/')
        self.assertEqual(get_config.call_count, 2)


if __name__ == '__main__':
    unittest.main()
