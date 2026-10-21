import tempfile
import time
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import Mock, patch

from flask import Flask

import auth
import routes.admin_routes as admin_routes
import routes.data_routes as data_routes
import services.config_service as config_service
import services.urp_service as urp_service
import urp.login as login_module
import urp.session_store as session_store


URL1 = 'http://url1.test/urp/'




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


class BackgroundUrlTests(unittest.TestCase):
    def test_urgent_event_passes_request_url_to_background_update(self):
        app = Flask(__name__)
        with app.test_request_context('/api/urgent_event'), patch.object(
            data_routes, 'get_current_urp_url', return_value=URL1,
        ), patch.object(
            data_routes, 'start_auto_update', return_value=True,
        ) as start_update, patch.object(
            data_routes, 'get_urgent_event',
            return_value={'current': None, 'next': None},
        ):
            response = data_routes.api_urgent_event.__wrapped__(
                user={'username': 'student', 'password': 'password'},
            )

        self.assertTrue(response.get_json()['success'])
        start_update.assert_called_once_with('student', 'password', url=URL1)

    def test_auto_update_uses_explicit_normalized_url_for_all_live_work(self):
        connection = Mock()
        connection.execute.return_value.fetchone.return_value = (None,)
        database = Mock()
        database.__enter__ = Mock(return_value=connection)
        database.__exit__ = Mock(return_value=False)
        query = Mock()

        with patch.object(
            urp_service, 'get_db', return_value=database,
        ), patch.object(
            urp_service, 'get_current_urp_url',
            side_effect=AssertionError('explicit URL must be used'),
        ), patch.object(
            urp_service, 'check_login_status', return_value=(True, {}),
        ) as login_check, patch(
            'urp.URP_query', return_value=query,
        ) as query_class:
            result = urp_service.check_and_auto_update(
                'student', 'password', url=' http://url1.test/urp ',
            )

        self.assertEqual(result, (True, '自动更新成功'))
        login_check.assert_called_once_with(
            'student', 'password', {}, url=URL1,
        )
        query_class.assert_called_once_with(URL1, 'student')
        query.schedule_cx.assert_called_once_with()
        query.exam_cx.assert_called_once_with()


class LiveUpdateUrlTests(unittest.TestCase):
    def setUp(self):
        self.app = offline_app(self)['app']
        cleanup = patch('services.temporary_session_service.start_temporary_session_cleanup')
        cleanup.start()
        self.addCleanup(cleanup.stop)
        self.client = self.app.test_client()

    def _assert_live_route_uses_snapshot(self, path, query_method):
        user = {'username': 'student', 'password': 'password'}
        query = Mock()
        getattr(query, query_method).return_value = {'fresh': True}
        with patch.object(
            config_service,
            'get_config',
            return_value={
                'urp_urls': [URL1],
                'current_url_index': 0,
            },
        ), patch.object(
            auth, 'get_device_id', return_value='device',
        ), patch.object(
            auth, 'get_user_by_device', return_value=user,
        ), patch.object(
            auth, 'check_login_status', return_value=(True, {}),
        ) as login_check, patch(
            'urp.URP_query', return_value=query,
        ) as query_class:
            response = self.client.post(path)

        self.assertTrue(response.get_json()['success'])
        login_check.assert_called_once_with(
            'student', 'password', {}, url=URL1,
        )
        query_class.assert_called_once_with(URL1, 'student')
        getattr(query, query_method).assert_called_once_with()

    def test_schedule_update_uses_one_request_url_and_one_login_check(self):
        self._assert_live_route_uses_snapshot(
            '/api/update_schedule', 'schedule_cx',
        )

    def test_exam_update_uses_one_request_url_and_one_login_check(self):
        self._assert_live_route_uses_snapshot(
            '/api/update_exams', 'exam_cx',
        )


class EvaluationLoginTests(unittest.TestCase):
    def setUp(self):
        self.app = offline_app(self)['app']
        cleanup = patch('services.temporary_session_service.start_temporary_session_cleanup')
        cleanup.start()
        self.addCleanup(cleanup.stop)
        self.client = self.app.test_client()

    def _assert_login_failure_stops_query(self, method, path, query_name):
        user = {'username': 'student', 'password': 'password'}
        with patch.object(
            auth, 'get_device_id', return_value='device',
        ), patch.object(
            auth, 'get_user_by_device', return_value=user,
        ), patch.object(
            auth, '_check_member_access', return_value=(True, None),
        ) as member_check, patch.object(
            auth, 'check_login_status', return_value=(False, {}),
        ), patch.object(
            data_routes, query_name,
        ) as query:
            response = getattr(self.client, method)(
                path, json={'courses': [{'id': 'course-1'}]},
            )

        self.assertFalse(response.get_json()['success'])
        self.assertIn('登录已失效', response.get_json()['message'])
        member_check.assert_called_once_with('student', 'basic')
        query.assert_not_called()

    def test_unevaluated_courses_stops_before_query_when_login_fails(self):
        self._assert_login_failure_stops_query(
            'get', '/api/unevaluated_courses', 'get_unevaluated_courses',
        )

    def test_evaluation_stops_before_submit_when_login_fails(self):
        self._assert_login_failure_stops_query(
            'post', '/api/evaluation', 'do_evaluation',
        )


class AdminUrlValidationTests(unittest.TestCase):
    def _switch_index(self, url_index, urls):
        app = Flask(__name__)
        writes = []

        def update(mutator):
            config = {
                'urp_urls': list(urls),
                'current_url_index': 0,
            }
            mutator(config)
            writes.append(config.copy())
            return config

        with app.test_request_context(
            '/api/admin/config/url', method='POST',
            json={'url_index': url_index},
        ), patch.object(admin_routes, 'update_config', side_effect=update):
            response = admin_routes.admin_switch_url.__wrapped__()

        return response, writes

    def test_invalid_url_list_is_rejected_without_write(self):
        app = Flask(__name__)
        with app.test_request_context(
            '/api/admin/config/url', method='POST',
            json={'urls': ['http://valid.test/', 'not-a-url']},
        ), patch.object(admin_routes, 'update_config') as update:
            response = admin_routes.admin_switch_url.__wrapped__()

        self.assertFalse(response.get_json()['success'])
        update.assert_not_called()

    def test_out_of_range_url_index_is_rejected_without_write(self):
        response, writes = self._switch_index(
            2,
            ['http://url1.test/', 'http://url2.test/'],
        )

        self.assertFalse(response.get_json()['success'])
        self.assertEqual(writes, [])

    def test_boolean_url_indices_are_rejected_without_write(self):
        for boolean_index in (True, False):
            with self.subTest(url_index=boolean_index):
                response, writes = self._switch_index(
                    boolean_index,
                    ['http://url1.test/', 'http://url2.test/'],
                )

                self.assertFalse(response.get_json()['success'])
                self.assertEqual(writes, [])

    def test_invalid_stored_target_url_is_rejected_without_write(self):
        response, writes = self._switch_index(
            1,
            ['http://url1.test/', 'not-a-url'],
        )

        self.assertFalse(response.get_json()['success'])
        self.assertEqual(writes, [])


class AdminUrlStatePreservationTests(unittest.TestCase):
    def test_successful_switch_preserves_cookies_and_url_login_cache(self):
        app = Flask(__name__)
        url2 = 'http://url2.test/urp/'
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory) / 'user_data',
        ), patch.object(
            login_module,
            'VPN_COOKIE_FILE',
            str(Path(directory) / 'data' / 'vpn_cookie.json'),
        ):
            user_cookie = session_store.save_user_cookies(
                'student', URL1, {'JSESSIONID': 'student-session'},
            )
            login_module.save_shared_vpn_cookies(
                {'VSG_SESSIONID': 'vpn-session'},
            )
            vpn_cookie = Path(login_module.VPN_COOKIE_FILE)
            user_before = user_cookie.read_bytes()
            vpn_before = vpn_cookie.read_bytes()
            cache_key = (
                'student',
                config_service.urp_url_fingerprint(URL1),
            )
            urp_service._login_cache[cache_key] = time.time()

            def update(mutator):
                config = {
                    'urp_urls': [URL1, url2],
                    'current_url_index': 0,
                }
                mutator(config)
                return config

            try:
                with app.test_request_context(
                    '/api/admin/config/url', method='POST',
                    json={'url_index': 1},
                ), patch.object(
                    admin_routes, 'update_config', side_effect=update,
                ):
                    response = admin_routes.admin_switch_url.__wrapped__()

                self.assertTrue(response.get_json()['success'])
                self.assertEqual(user_cookie.read_bytes(), user_before)
                self.assertEqual(vpn_cookie.read_bytes(), vpn_before)
                self.assertIn(cache_key, urp_service._login_cache)
            finally:
                urp_service._login_cache.pop(cache_key, None)


class LocalCacheRouteTests(unittest.TestCase):
    def _assert_local_route_does_not_require_login(
        self, path, query_name, response_value,
    ):
        app = offline_app(self)['app']

        user = {'username': 'student', 'password': 'password'}
        with ExitStack() as stack:
            stack.enter_context(patch.object(auth, 'get_device_id', return_value='device'))
            stack.enter_context(patch.object(auth, 'get_user_by_device', return_value=user))
            stack.enter_context(patch.object(auth, 'check_login_status',
                side_effect=AssertionError('local reads are binding-only')))
            query = stack.enter_context(patch.object(data_routes, query_name, return_value=response_value))
            stack.enter_context(patch.object(data_routes, 'get_config', return_value={}))
            stack.enter_context(patch.object(data_routes, 'is_calendar_cache_stale', return_value=False))
            if query_name != 'get_exams':
                stack.enter_context(patch.object(data_routes, 'get_exams', return_value=[]))
            stack.enter_context(patch('services.temporary_session_service.start_temporary_session_cleanup'))
            response = app.test_client().get(path)

        self.assertTrue(response.get_json()['success'])
        query.assert_called_once()

    def test_cached_schedule_read_remains_binding_only(self):
        self._assert_local_route_does_not_require_login(
            '/api/schedule?week=1', 'get_schedule',
            {'week': 1, 'schedule': {}},
        )

    def test_cached_exam_read_remains_binding_only(self):
        self._assert_local_route_does_not_require_login(
            '/api/exams', 'get_exams', [],
        )


if __name__ == '__main__':
    unittest.main()
