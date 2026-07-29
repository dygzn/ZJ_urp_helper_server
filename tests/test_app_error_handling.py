import unittest

import app as app_module


class AppErrorHandlingTests(unittest.TestCase):
    def setUp(self):
        self.client = app_module.app.test_client()

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
        with app_module.app.test_request_context('/api/test-error'):
            response, status = app_module.handle_api_exception(
                RuntimeError('boom')
            )

        self.assertEqual(status, 500)
        self.assertEqual(
            response.get_json(),
            {
                'success': False,
                'message': '服务器内部错误: boom',
            },
        )

    def test_home_page_still_loads(self):
        response = self.get_without_exception('/')

        self.assertEqual(response.status_code, 200)


if __name__ == '__main__':
    unittest.main()
