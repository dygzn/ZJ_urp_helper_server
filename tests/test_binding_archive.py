"""仅操作临时数据库：python -m unittest discover -s tests -p test_binding_archive.py"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import database


class BindingArchiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.config = {'database': {'type': 'sqlite', 'sqlite_path': str(Path(self.tmp.name) / 'test.db')}}
        database.init_db(self.config)
        with database.get_db(self.config) as conn:
            conn.executemany('INSERT INTO users VALUES (?, ?, ?, ?, ?)', [
                ('d1', 'student', 'old密碼', '2025-01-01', None),
                ('d2', 'student', 'new-password', '2026-01-01', '2026-02-01')])
            conn.execute("INSERT INTO memberships VALUES ('student','basic','2030','2025')")

    def service(self):
        from services import binding_archive_service
        return binding_archive_service

    def test_archive_keeps_one_account_with_latest_password_and_first_registration(self):
        service = self.service()
        with database.get_db(self.config) as conn:
            preview = service.snapshot(conn)
            result = service.archive_snapshot(conn, preview, 'batch-one')
        with database.get_db(self.config) as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM users').fetchone()[0], 0)
            rows = conn.execute('SELECT * FROM user_account').fetchall()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]['password'], 'new-password')
            self.assertEqual(rows[0]['registered_at'], '2025-01-01')
            self.assertEqual(set(rows[0].keys()), {'username', 'password', 'registered_at', 'last_bind_time', 'archived_at'})
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM memberships').fetchone()[0], 1)
            self.assertEqual(result['counts']['users'], 2)
            self.assertEqual(len(service.historical_users(conn)), 1)

    def test_failure_rolls_back_archive_and_deletion(self):
        service = self.service()
        with database.get_db(self.config) as conn:
            conn.execute("CREATE TRIGGER prevent_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'blocked'); END")
        with self.assertRaises(Exception):
            with database.get_db(self.config) as conn:
                service.archive_snapshot(conn, service.snapshot(conn), 'batch-fail')
        with database.get_db(self.config) as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM users').fetchone()[0], 2)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM user_account').fetchone()[0], 0)

    def test_sqlite_execution_is_rejected(self):
        service = self.service()
        with patch.object(service, 'get_database_config', return_value=self.config['database']):
            with self.assertRaises(ValueError):
                service.execute_archive('preview', 'batch')

    def test_stale_preview_does_not_clear_bindings(self):
        service = self.service()
        with database.get_db(self.config) as conn:
            data = service.snapshot(conn)
            fingerprint = service._fingerprint(data, {'database': 'one'})
            conn.execute("UPDATE users SET password='changed' WHERE device_id='d1'")
            with self.assertRaises(ValueError):
                service.archive_checked(conn, service.snapshot(conn), {'database': 'one'}, fingerprint, 'stale')
            with self.assertRaises(ValueError):
                service.archive_checked(conn, data, {'database': 'other'}, fingerprint, 'wrong-target')
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM users').fetchone()[0], 2)

    def test_retry_keeps_new_bindings_and_statistics_deduplicate(self):
        service = self.service()
        with database.get_db(self.config) as conn:
            data = service.snapshot(conn)
            fingerprint = service._fingerprint(data, {})
            first = service.archive_checked(conn, data, {}, fingerprint, 'retry')
        with database.get_db(self.config) as conn:
            conn.execute("INSERT INTO users VALUES ('new-device','student','new','2026-09-18',NULL)")
            repeated = service.archive_checked(conn, service.snapshot(conn), {}, fingerprint, 'retry')
            self.assertEqual(first, repeated)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM users').fetchone()[0], 1)
            history = service.historical_users(conn)
            self.assertEqual(len(history), 1)
            self.assertEqual(history[0]['first_bind_time'], '2025-01-01')

    def test_corrupt_archive_aborts_before_deletion(self):
        service = self.service()
        with database.get_db(self.config) as conn:
            conn.execute("""CREATE TRIGGER corrupt_archive AFTER INSERT ON user_account
                BEGIN UPDATE user_account SET password='corrupt'
                WHERE username=NEW.username; END""")
        with self.assertRaises(RuntimeError):
            with database.get_db(self.config) as conn:
                service.archive_snapshot(conn, service.snapshot(conn), 'corrupt')
        with database.get_db(self.config) as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM users').fetchone()[0], 2)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM user_account').fetchone()[0], 0)

    def test_related_records_are_cleared_without_archiving_and_orders_untouched(self):
        service = self.service()
        with database.get_db(self.config) as conn:
            conn.execute("""INSERT INTO pending_requests
                (request_id,device_id,old_username,new_username,reason,request_time,status,notified)
                VALUES ('req','d1','student','next','换机','2026','pending',0)""")
            conn.execute("INSERT INTO wechat_bindings VALUES ('openid','d1',NULL,'2025','2026')")
            conn.execute("INSERT INTO wechat_sessions VALUES ('token','openid','2030','2025','2026')")
            conn.execute("""INSERT INTO orders (order_no,device_id,username,member_type,amount,create_time)
                VALUES ('order','d1','student','basic','10','2026')""")
            original = service.snapshot(conn)
            service.archive_snapshot(conn, original, 'related')
        with database.get_db(self.config) as conn:
            for table in ('pending_requests', 'wechat_bindings', 'wechat_sessions'):
                self.assertEqual(conn.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0], 0)
            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertNotIn('binding_record_archive', tables)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM orders').fetchone()[0], 1)

    def test_preview_never_returns_credentials(self):
        service = self.service()
        with patch.object(service, 'get_database_config', return_value=self.config['database']):
            preview = service.preview_archive()
        encoded = json.dumps(preview, ensure_ascii=False)
        self.assertNotIn('old密碼', encoded)
        self.assertNotIn('new-password', encoded)
        self.assertEqual(preview['unique_users'], 1)
        self.assertFalse(preview['enabled'])

    def test_admin_endpoint_requires_auth_and_rejects_sqlite(self):
        from flask import Flask
        from routes.admin_routes import admin_bp
        app = Flask(__name__)
        app.register_blueprint(admin_bp)
        client = app.test_client()
        with patch('auth.get_admin_key', return_value='test-only-key'):
            self.assertEqual(client.get('/api/admin/bindings/archive').status_code, 403)
            self.assertEqual(client.post('/api/admin/bindings/archive', json={}).status_code, 403)
            headers = {'Admin-Key': 'test-only-key'}
            self.assertEqual(client.post('/api/admin/bindings/archive', json={}, headers=headers).status_code, 400)
            with patch.object(self.service(), 'get_database_config', return_value=self.config['database']):
                response = client.post('/api/admin/bindings/archive',
                                       json={'prepared': True, 'protocol_version': 2, 'batch_id': 'test'}, headers=headers)
                self.assertEqual(response.status_code, 409)

    def test_statistics_route_keeps_archived_users(self):
        from flask import Flask
        from routes.admin_routes import admin_bp
        with database.get_db(self.config) as conn:
            self.service().archive_snapshot(conn, self.service().snapshot(conn), 'statistics')
        app = Flask(__name__)
        app.register_blueprint(admin_bp)
        with patch('auth.get_admin_key', return_value='test-only-key'), patch(
                'routes.admin_routes.get_db', side_effect=lambda: database.get_db(self.config)):
            response = app.test_client().get('/api/admin/users', headers={'Admin-Key': 'test-only-key'})
        self.assertTrue(response.json['success'])
        self.assertEqual(response.json['total'], 1)
        self.assertEqual(response.json['daily'], [{'date': '2025-01-01', 'count': 1, 'total': 1}])

    def test_legacy_archive_is_compacted_when_no_active_bindings_remain(self):
        service = self.service()
        with database.get_db(self.config) as conn:
            conn.execute('DELETE FROM users')
            conn.execute('''CREATE TABLE user_account_archive (
                batch_id TEXT, device_id TEXT, username TEXT, password TEXT,
                bind_time TEXT, archived_at TEXT, record_json TEXT)''')
            conn.executemany('INSERT INTO user_account_archive VALUES (?,?,?,?,?,?,?)', [
                ('old1', 'device1', 'student', 'first', '2024-01-01', '2026', '{}'),
                ('old2', 'device2', 'student', 'latest', '2025-01-01', '2026', '{}')])
            conn.execute('CREATE TABLE binding_record_archive (batch_id TEXT, source_table TEXT, record_key TEXT, record_json TEXT)')
            conn.execute("INSERT INTO binding_record_archive VALUES ('old','wechat_sessions','token','{}')")
            service.archive_snapshot(conn, service.snapshot(conn), 'compact')
        with database.get_db(self.config) as conn:
            rows = conn.execute('SELECT * FROM user_account').fetchall()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]['registered_at'], '2024-01-01')
            self.assertEqual(rows[0]['password'], 'latest')
            for table in ('user_account_archive', 'binding_record_archive'):
                self.assertEqual(conn.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0], 0)

    def test_later_batches_update_account_instead_of_duplicating(self):
        service = self.service()
        with database.get_db(self.config) as conn:
            service.archive_snapshot(conn, service.snapshot(conn), 'first')
            conn.execute("INSERT INTO users VALUES ('new','student','updated','2026-09-18',NULL)")
            service.archive_snapshot(conn, service.snapshot(conn), 'second')
            rows = conn.execute('SELECT * FROM user_account').fetchall()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]['password'], 'updated')
            self.assertEqual(rows[0]['registered_at'], '2025-01-01')

    def test_older_binding_extends_registration_without_overwriting_newer_password(self):
        service = self.service()
        with database.get_db(self.config) as conn:
            service.archive_snapshot(conn, service.snapshot(conn), 'first')
            conn.execute("INSERT INTO users VALUES ('older','student','stale','2023-01-01',NULL)")
            service.archive_snapshot(conn, service.snapshot(conn), 'older-batch')
            row = conn.execute('SELECT * FROM user_account').fetchone()
            self.assertEqual(row['registered_at'], '2023-01-01')
            self.assertEqual(row['password'], 'new-password')
            self.assertEqual(row['last_bind_time'], '2026-01-01')

    def test_failure_restores_preexisting_compact_account(self):
        service = self.service()
        with database.get_db(self.config) as conn:
            service.archive_snapshot(conn, service.snapshot(conn), 'first')
            original = dict(conn.execute('SELECT * FROM user_account').fetchone())
            conn.execute("INSERT INTO users VALUES ('new','student','replacement','2026-09-18',NULL)")
            conn.execute("CREATE TRIGGER prevent_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'blocked'); END")
        with self.assertRaises(Exception):
            with database.get_db(self.config) as conn:
                service.archive_snapshot(conn, service.snapshot(conn), 'failed')
        with database.get_db(self.config) as conn:
            self.assertEqual(dict(conn.execute('SELECT * FROM user_account').fetchone()), original)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM users').fetchone()[0], 1)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM binding_archive_batches').fetchone()[0], 1)

    def test_legacy_batch_is_not_reported_as_compact_success(self):
        service = self.service()
        with database.get_db(self.config) as conn:
            conn.execute('INSERT INTO binding_archive_batches VALUES (?, ?, ?)',
                         ('old-batch', '2026', json.dumps({'batch_id': 'old-batch', 'counts': {'users': 8130}})))
            with self.assertRaisesRegex(ValueError, '旧版'):
                service.archive_checked(conn, service.snapshot(conn), {}, 'unused', 'old-batch')
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM users').fetchone()[0], 2)

    def test_route_rejects_incompatible_service_before_execution(self):
        from flask import Flask
        from routes.admin_routes import admin_bp
        app = Flask(__name__)
        app.register_blueprint(admin_bp)
        with patch('auth.get_admin_key', return_value='test-only-key'), patch.object(
                self.service(), 'PROTOCOL_VERSION', 1, create=True), patch(
                'routes.admin_routes.execute_archive', side_effect=AssertionError('must not execute')):
            response = app.test_client().post('/api/admin/bindings/archive',
                json={'prepared': True, 'protocol_version': 2}, headers={'Admin-Key': 'test-only-key'})
        self.assertEqual(response.status_code, 409)
        self.assertIn('版本', response.json['message'])


if __name__ == '__main__':
    unittest.main()
