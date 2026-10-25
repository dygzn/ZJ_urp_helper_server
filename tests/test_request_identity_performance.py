"""身份解析只能在请求内复用；状态改变后必须立即重新读取。"""

import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from cryptography.fernet import Fernet
from flask import Flask, jsonify

import database
from routes.auth_routes import auth_bp
from services.activity_service import DailyActivityTracker, init_activity_tracking
from services.temporary_session_service import (
    current_temporary_session, delete_temporary_session, get_temporary_session,
    save_temporary_session,
)
from services.user_service import bind_user, get_user_by_device, unbind_user


class RequestIdentityPerformanceTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.config = {'database': {'type': 'sqlite', 'sqlite_path': str(Path(directory.name) / 'test.db')}}
        for item in (
            patch('database.get_config', return_value=self.config),
            patch.dict(os.environ, {'URP_CREDENTIAL_KEY': Fernet.generate_key().decode()}),
            patch('services.temporary_session_service.TEMPORARY_DATA_ROOT', str(Path(directory.name) / 'sessions')),
        ):
            item.start()
            self.addCleanup(item.stop)
        database.init_db(self.config)
        bind_user('device', 'student', 'secret')
        self.queries = []
        connect = database._connect_sqlite

        def traced_connect(config):
            conn = connect(config)
            conn.set_trace_callback(self.queries.append)
            return conn

        tracing = patch('database._connect_sqlite', side_effect=traced_connect)
        tracing.start()
        self.addCleanup(tracing.stop)
        self.app = Flask(__name__)
        self.app.register_blueprint(auth_bp)
        self.tracker = DailyActivityTracker()
        init_activity_tracking(self.app, tracker=self.tracker)

        @self.app.get('/api/protected-test')
        def protected():
            first = get_user_by_device('device')
            second = get_user_by_device('device')
            return jsonify(username=second['username'], same=first == second)

    def identity_selects(self):
        return [sql for sql in self.queries if sql.lstrip().upper().startswith('SELECT')
                and ('FROM users AS b' in sql or 'FROM temporary_sessions WHERE device_id' in sql)]

    def temporary_login(self, device='device', username='temporary-student'):
        return save_temporary_session(device, username, {'JSESSIONID': 'test'}, url='http://urp.example/')

    def test_route_and_activity_tracking_resolve_identity_once(self):
        result = self.app.test_client().get('/api/protected-test', headers={'X-Device-ID': 'device'})
        self.assertEqual(result.get_json(), {'username': 'student', 'same': True})
        self.assertEqual(self.tracker.snapshot()['active_users'], 1)
        self.assertEqual(len(self.identity_selects()), 2)

    def test_unknown_device_is_cached_only_within_its_request(self):
        with self.app.test_request_context('/'):
            self.assertIsNone(get_user_by_device('missing'))
            self.assertIsNone(get_user_by_device('missing'))
        self.assertEqual(len(self.identity_selects()), 2)
        with self.app.test_request_context('/'):
            self.assertIsNone(get_user_by_device('missing'))
        self.assertEqual(len(self.identity_selects()), 4)

    def test_bind_and_unbind_invalidate_previous_positive_and_negative_results(self):
        with self.app.test_request_context('/'):
            self.assertEqual(get_user_by_device('device')['username'], 'student')
            unbind_user('device')
            self.assertIsNone(get_user_by_device('device'))
            bind_user('device', 'new-student', 'new-secret')
            self.assertEqual(get_user_by_device('device')['username'], 'new-student')

    def test_credential_change_invalidates_other_device_of_same_account(self):
        bind_user('second-device', 'student', 'secret')
        with self.app.test_request_context('/'):
            self.assertEqual(__import__('services.credential_service', fromlist=['CredentialCipher']).CredentialCipher().decrypt(get_user_by_device('second-device')['password']), 'secret')
            bind_user('device', 'student', 'new-secret')
            self.assertEqual(__import__('services.credential_service', fromlist=['CredentialCipher']).CredentialCipher().decrypt(get_user_by_device('second-device')['password']), 'new-secret')

    def test_route_unbind_does_not_trigger_an_extra_identity_lookup(self):
        response = self.app.test_client().post('/api/request_rebind', headers={'X-Device-ID': 'device'})
        self.assertTrue(response.get_json()['success'])
        self.assertEqual(self.tracker.snapshot()['active_users'], 0)
        self.assertEqual(len(self.identity_selects()), 2)

    def test_temporary_changes_invalidate_identity_and_restore_matching_context(self):
        with self.app.test_request_context('/'):
            self.assertEqual(get_user_by_device('device')['username'], 'student')
            self.temporary_login()
            self.assertEqual(get_user_by_device('device')['username'], 'temporary-student')
            get_user_by_device('missing')
            self.assertIsNone(current_temporary_session())
            get_user_by_device('device')
            self.assertEqual(current_temporary_session()['username'], 'temporary-student')
            delete_temporary_session('device')
            self.assertIsNone(get_user_by_device('device'))
            self.assertIsNone(current_temporary_session())

    def test_temporary_identity_is_not_reused_after_expiry_in_same_request(self):
        expires = self.temporary_login()
        with self.app.test_request_context('/'):
            self.assertTrue(get_user_by_device('device')['temporary'])
            with patch('time.time', return_value=expires + 1):
                self.assertIsNone(get_user_by_device('device'))

    def test_expired_lookup_deletes_only_its_session_without_global_scan(self):
        expires = self.temporary_login()
        self.temporary_login('other-device', 'other-student')
        self.queries.clear()
        with patch('time.time', return_value=expires + 1):
            self.assertIsNone(get_temporary_session('device'))
        with database.get_db() as conn:
            self.assertIsNotNone(conn.execute('SELECT * FROM temporary_sessions WHERE device_id = ?', ('other-device',)).fetchone())
        scans = [sql for sql in self.queries if sql.strip() == 'SELECT session_id FROM temporary_sessions']
        self.assertEqual(scans, [])

    def test_frequent_cleanup_can_skip_full_orphan_scan(self):
        from services.temporary_session_service import cleanup_expired_sessions
        self.temporary_login()
        self.queries.clear()
        cleanup_expired_sessions(scan_orphans=False)
        self.assertFalse(any(sql.strip() == 'SELECT session_id FROM temporary_sessions' for sql in self.queries))


if __name__ == '__main__':
    unittest.main()
