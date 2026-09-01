import os
import tempfile
import unittest
from datetime import datetime
from unittest import mock

import database
import services.shortcut_service as shortcut_service


class ShortcutApiKeyServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_config = {
            'database': {
                'type': 'sqlite',
                'sqlite_path': os.path.join(self.temp_dir.name, 'shortcut.db'),
            }
        }
        database.init_db(self.database_config)
        self.get_db_patcher = mock.patch.object(
            shortcut_service,
            'get_db',
            side_effect=lambda: database.get_db(self.database_config),
        )
        self.get_db_patcher.start()

    def tearDown(self):
        self.get_db_patcher.stop()
        self.temp_dir.cleanup()

    def test_api_keys_table_is_created(self):
        with database.get_db(self.database_config) as conn:
            row = conn.execute(
                "SELECT name FROM sqlite_master "
                "WHERE type = 'table' AND name = 'api_keys'"
            ).fetchone()

        self.assertIsNotNone(row)

    def test_issue_api_key_stores_hash_and_can_be_resolved(self):
        issued = shortcut_service.issue_api_key(
            '2415108133', datetime(2026, 9, 1, 12, 0, 0)
        )

        self.assertTrue(issued['key'].startswith('urp_'))
        self.assertNotEqual(issued['key'], issued['key_hash'])
        self.assertEqual(
            shortcut_service.resolve_api_key(issued['key']),
            '2415108133',
        )

        with database.get_db(self.database_config) as conn:
            row = conn.execute(
                'SELECT key_hash, key_prefix, create_time '
                'FROM api_keys WHERE username = ?',
                ('2415108133',),
            ).fetchone()

        self.assertEqual(row['key_hash'], shortcut_service.hash_api_key(issued['key']))
        self.assertNotEqual(row['key_hash'], issued['key'])
        self.assertEqual(row['key_prefix'], issued['key'][:12])

    def test_reissuing_for_same_username_invalidates_old_key(self):
        first = shortcut_service.issue_api_key(
            '2415108133', datetime(2026, 9, 1, 12, 0, 0)
        )
        second = shortcut_service.issue_api_key(
            '2415108133', datetime(2026, 9, 1, 12, 1, 0)
        )

        self.assertIsNone(shortcut_service.resolve_api_key(first['key']))
        self.assertEqual(
            shortcut_service.resolve_api_key(second['key']),
            '2415108133',
        )
        with database.get_db(self.database_config) as conn:
            count = conn.execute(
                'SELECT COUNT(*) AS count FROM api_keys WHERE username = ?',
                ('2415108133',),
            ).fetchone()['count']
        self.assertEqual(count, 1)

    def test_status_never_returns_plaintext_key(self):
        issued = shortcut_service.issue_api_key('2415108133')
        status = shortcut_service.get_api_key_status('2415108133')

        self.assertTrue(status['has_key'])
        self.assertEqual(status['key_prefix'], issued['key'][:12])
        self.assertNotIn('key', status)

    def test_unknown_username_has_empty_status(self):
        self.assertEqual(
            shortcut_service.get_api_key_status('not-found'),
            {'has_key': False, 'key_prefix': None, 'create_time': None},
        )


if __name__ == '__main__':
    unittest.main()


from flask import Flask

import auth
import services.user_service as user_service
from routes import shortcut_routes
from urp.query import URP_query


class ShortcutApiKeyRouteTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.config['TESTING'] = True
        self.app.register_blueprint(shortcut_routes.shortcut_bp)
        self.client = self.app.test_client()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_config = {
            'database': {
                'type': 'sqlite',
                'sqlite_path': os.path.join(self.temp_dir.name, 'route.db'),
            }
        }
        database.init_db(self.database_config)
        with database.get_db(self.database_config) as conn:
            conn.execute(
                'INSERT INTO memberships '
                '(username, member_type, expire_time, create_time) '
                'VALUES (?, ?, ?, ?)',
                (
                    '2415108133',
                    'basic',
                    '2026-12-31T23:59:59',
                    '2026-09-01T12:00:00',
                ),
            )
        self.bind_patcher = mock.patch.object(
            auth,
            'get_user_by_device',
            return_value={
                'device_id': 'device-1',
                'username': '2415108133',
                'password': 'password',
                'bind_time': '2026-09-01T12:00:00',
            },
        )
        self.auth_db_patcher = mock.patch.object(
            auth,
            'get_db',
            side_effect=lambda: database.get_db(self.database_config),
        )
        self.bind_patcher.start()
        self.auth_db_patcher.start()

    def tearDown(self):
        self.auth_db_patcher.stop()
        self.bind_patcher.stop()
        self.temp_dir.cleanup()

    def test_get_api_key_status_hides_plaintext(self):
        with mock.patch.object(
            shortcut_routes,
            'get_api_key_status',
            return_value={
                'has_key': True,
                'key_prefix': 'urp_abcdef12',
                'create_time': '2026-09-01T12:00:00',
            },
        ):
            response = self.client.get(
                '/api/member/api-key',
                headers={'X-Device-ID': 'device-1'},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {
            'success': True,
            'data': {
                'has_key': True,
                'key_prefix': 'urp_abcdef12',
                'create_time': '2026-09-01T12:00:00',
            },
        })
        self.assertNotIn('key', response.get_json()['data'])

    def test_post_api_key_returns_plaintext_only_when_issued(self):
        issued = {
            'key': 'urp_new-secret',
            'key_prefix': 'urp_new-secr',
            'create_time': '2026-09-01T12:00:00',
        }
        with mock.patch.object(shortcut_routes, 'issue_api_key', return_value=issued):
            response = self.client.post(
                '/api/member/api-key',
                headers={'X-Device-ID': 'device-1'},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {'success': True, 'data': issued})

    def test_non_member_cannot_issue_api_key(self):
        with database.get_db(self.database_config) as conn:
            conn.execute(
                'DELETE FROM memberships WHERE username = ?',
                ('2415108133',),
            )

        with mock.patch.object(shortcut_routes, 'issue_api_key') as issue:
            response = self.client.post(
                '/api/member/api-key',
                headers={'X-Device-ID': 'device-1'},
            )

        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.get_json()['success'])
        issue.assert_not_called()


class UserLookupTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_config = {
            'database': {
                'type': 'sqlite',
                'sqlite_path': os.path.join(self.temp_dir.name, 'lookup.db'),
            }
        }
        database.init_db(self.database_config)
        with database.get_db(self.database_config) as conn:
            conn.executemany(
                'INSERT INTO users '
                '(device_id, username, password, bind_time) VALUES (?, ?, ?, ?)',
                [
                    (
                        'device-old',
                        '2415108133',
                        'old-password',
                        '2026-09-01T12:00:00',
                    ),
                    (
                        'device-new',
                        '2415108133',
                        'new-password',
                        '2026-09-02T12:00:00',
                    ),
                ],
            )
        self.get_db_patcher = mock.patch.object(
            user_service,
            'get_db',
            side_effect=lambda: database.get_db(self.database_config),
        )
        self.get_db_patcher.start()

    def tearDown(self):
        self.get_db_patcher.stop()
        self.temp_dir.cleanup()

    def test_user_lookup_returns_newest_binding(self):
        user = user_service.get_user_by_username('2415108133')

        self.assertEqual(user['device_id'], 'device-new')
        self.assertEqual(user['password'], 'new-password')


class ShortcutDataNormalizationTests(unittest.TestCase):
    def test_historical_schedule_is_shortcut_friendly(self):
        result = shortcut_service.normalize_historical_schedule(
            '2415108133',
            {
                'semester': '2025-2026-2-1',
                'semesters': [{
                    'value': '2025-2026-2-1',
                    'label': '2025-2026学年春(两学期)',
                }],
                'courses': [{
                    '课程名': '软件工程导论', '星期': '3', '节次': '1', '节数': '2',
                    '位置': '仙林校区实C-501', '课序': '01',
                }],
            },
        )

        self.assertEqual(result, {
            'student_id': '2415108133',
            'semester': '2025-2026-2-1',
            'semester_name': '2025-2026学年春(两学期)',
            'course_count': 1,
            'courses': [{
                'course_name': '软件工程导论',
                'weekday': 3,
                'weekday_name': '星期三',
                'start_section': 1,
                'section_count': 2,
                'section_name': '第1-2节',
                'location': '仙林校区实C-501',
                'class_no': '01',
            }],
        })

    def test_grade_summary_is_flat_and_contains_counts(self):
        result = shortcut_service.normalize_grade_summary(
            '2415108133',
            {
                'semester': '2025-2026学年春',
                'passed': [{'course': '软件工程导论', 'score': '92'}],
                'failed': {
                    'current': [],
                    'past': [{
                        'course': '高等数学', 'score': '58', 'credit': '4',
                        'exam_time': '20250101',
                    }],
                },
            },
        )

        self.assertEqual(result, {
            'student_id': '2415108133',
            'semester': '2025-2026学年春',
            'passed_count': 1,
            'failed_current_count': 0,
            'failed_past_count': 1,
            'passed': [{'course_name': '软件工程导论', 'score': '92'}],
            'failed_current': [],
            'failed_past': [{
                'course_name': '高等数学', 'score': '58', 'credit': '4',
                'exam_time': '20250101',
            }],
        })

    def test_historical_schedule_skips_invalid_numeric_courses(self):
        result = shortcut_service.normalize_historical_schedule(
            '2415108133',
            {
                'semester': '2025-2026-2-1',
                'semesters': [],
                'courses': [
                    {
                        '课程名': '有效课程', '星期': '1', '节次': '2', '节数': '1',
                        '位置': '', '课序': '',
                    },
                    {
                        '课程名': '无效星期', '星期': '八', '节次': '2', '节数': '1',
                    },
                    {
                        '课程名': '无效节次', '星期': '2', '节次': 'x', '节数': '1',
                    },
                    {
                        '课程名': '无效节数', '星期': '2', '节次': '3', '节数': 'x',
                    },
                ],
            },
        )

        self.assertEqual(result['course_count'], 1)
        self.assertEqual([course['course_name'] for course in result['courses']], ['有效课程'])

    def test_query_rejects_unsupported_action(self):
        with (
            mock.patch('URP.URP_query') as query_class,
            mock.patch.object(shortcut_service, 'get_latest_semester_grade_summary') as grade_summary,
        ):
            with self.assertRaisesRegex(ValueError, '^invalid_action$'):
                shortcut_service.query_shortcut_data(
                    '2415108133', 'exams', {},
                )

        query_class.assert_not_called()
        grade_summary.assert_not_called()


class ShortcutPublicQueryRouteTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.config['TESTING'] = True
        self.app.register_blueprint(shortcut_routes.shortcut_bp)
        self.client = self.app.test_client()
        self.resolve_patcher = mock.patch.object(
            shortcut_routes, 'resolve_api_key', return_value='2415108133'
        )
        self.user_patcher = mock.patch.object(
            shortcut_routes, 'get_user_by_username', return_value={
                'username': '2415108133', 'password': 'password',
                'device_id': 'device-1', 'bind_time': '2026-09-01T12:00:00',
            }
        )
        self.member_patcher = mock.patch.object(
            shortcut_routes, '_check_member_access', return_value=(True, None)
        )
        self.login_patcher = mock.patch.object(
            shortcut_routes, 'check_login_status', return_value=(True, {})
        )
        self.login_mock = self.login_patcher.start()
        for patcher in (
            self.resolve_patcher, self.user_patcher,
            self.member_patcher,
        ):
            patcher.start()

    def tearDown(self):
        for patcher in (
            self.resolve_patcher, self.user_patcher,
            self.member_patcher,
        ):
            patcher.stop()
        self.login_patcher.stop()

    def test_invalid_request_is_json_and_http_200(self):
        response = self.client.post('/api/shortcut/query', json={'key': 'x'})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {
            'success': False,
            'action': None,
            'error_code': 'invalid_request',
            'message': '缺少 action',
            'data': None,
        })

    def test_invalid_key_is_not_queried(self):
        self.resolve_patcher.stop()
        self.resolve_patcher = mock.patch.object(
            shortcut_routes, 'resolve_api_key', return_value=None
        )
        self.resolve_patcher.start()
        response = self.client.post(
            '/api/shortcut/query',
            json={'key': 'urp_invalid', 'action': 'grades', 'params': {}},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['error_code'], 'invalid_key')
        self.login_mock.assert_not_called()

    def test_expired_member_is_rejected_before_login(self):
        self.member_patcher.stop()
        self.member_patcher = mock.patch.object(
            shortcut_routes, '_check_member_access', return_value=(False, {
                'success': False, 'message': '您的会员已过期', 'require_member': 'basic',
            })
        )
        self.member_patcher.start()
        response = self.client.post(
            '/api/shortcut/query',
            json={'key': 'urp_valid', 'action': 'grades', 'params': {}},
        )

        self.assertEqual(response.get_json()['error_code'], 'member_required')
        self.login_mock.assert_not_called()

    def test_unknown_action_is_rejected(self):
        response = self.client.post(
            '/api/shortcut/query',
            json={'key': 'urp_valid', 'action': 'exams', 'params': {}},
        )

        self.assertEqual(response.get_json(), {
            'success': False,
            'action': 'exams',
            'error_code': 'invalid_action',
            'message': '不支持的查询功能',
            'data': None,
        })

    def test_grades_returns_normalized_data(self):
        expected = {
            'student_id': '2415108133',
            'semester': '2025-2026学年春',
            'passed_count': 1,
            'failed_current_count': 0,
            'failed_past_count': 0,
            'passed': [{'course_name': '软件工程导论', 'score': '92'}],
            'failed_current': [], 'failed_past': [],
        }
        with mock.patch.object(
            shortcut_routes, 'query_shortcut_data', return_value=expected
        ) as query:
            response = self.client.post(
                '/api/shortcut/query',
                json={'key': 'urp_valid', 'action': 'grades', 'params': {}},
            )

        self.assertEqual(response.get_json(), {
            'success': True,
            'action': 'grades',
            'message': '查询成功',
            'data': expected,
        })
        query.assert_called_once_with('2415108133', 'grades', {})

    def test_query_failure_has_stable_error_code(self):
        with mock.patch.object(
            shortcut_routes,
            'query_shortcut_data',
            side_effect=RuntimeError('URP 暂时不可用'),
        ):
            response = self.client.post(
                '/api/shortcut/query',
                json={'key': 'urp_valid', 'action': 'grades', 'params': {}},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['error_code'], 'query_failed')
        self.assertIsNone(response.get_json()['data'])
