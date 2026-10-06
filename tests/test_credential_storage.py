"""教务凭据的落盘、延迟解密和历史迁移离线回归。"""
import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import Mock, patch

from cryptography.fernet import Fernet

from database import (
    get_db, init_db, migrate_sqlite_to_current_database,
    MySQLConnectionAdapter, _migrate_urp_credentials,
    migrate_account_password, _migrate_plural_user_accounts,
)
from services.binding_archive_service import archive_snapshot, snapshot
from services.user_service import bind_user, get_user_by_device, get_user_by_username
from services.wechat_account_service import bind_account, get_account
from services.credential_service import CredentialCipher, CredentialError
from services.urp_service import check_login_status
from urp.login import URP_login, _parse_login_form


class CredentialStorageTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.key = Fernet.generate_key().decode()
        env = patch.dict(os.environ, {'URP_CREDENTIAL_KEY': self.key})
        env.start()
        self.addCleanup(env.stop)
        self.config = {'database': {'type': 'sqlite', 'sqlite_path': str(Path(self.directory.name) / 'target.db')}}
        config_patch = patch('database.get_config', return_value=self.config)
        config_patch.start()
        self.addCleanup(config_patch.stop)
        init_db(self.config)

    def assert_encrypted(self, value, password):
        self.assertTrue(value.startswith('fernet:v1:'))
        self.assertEqual(Fernet(self.key.encode()).decrypt(value[len('fernet:v1:'):].encode()).decode(), password)

    def insert_legacy_account(self, username='student', password='old-password'):
        with get_db() as conn:
            conn.execute('INSERT INTO user_account VALUES (?, ?, ?, ?, ?)',
                         (username, password, '2025-01-01', '2025-01-01', '2025-01-01'))
            conn.execute('INSERT INTO users (device_id, username, password, bind_time) VALUES (?, ?, ?, ?)',
                         ('legacy-device', username, '', '2025-01-01'))

    def test_binding_encrypts_and_updates_only_the_account_credential(self):
        bind_user('device-1', 'student', '初始密码')
        bind_user('device-2', 'student', 'changed-password')
        with get_db() as conn:
            password = conn.execute('SELECT password FROM user_account').fetchone()['password']
            placeholders = [row['password'] for row in conn.execute('SELECT password FROM users')]
        self.assert_encrypted(password, 'changed-password')
        self.assertEqual(placeholders, ['', ''])
        self.assertEqual(get_user_by_device('device-1')['password'], password)
        self.assertEqual(get_user_by_username('student')['password'], password)

    def test_legacy_reads_encrypt_without_breaking_account_lookup(self):
        self.insert_legacy_account()
        user = get_user_by_device('legacy-device')
        self.assert_encrypted(user['password'], 'old-password')
        with get_db() as conn:
            self.assertEqual(conn.execute('SELECT password FROM user_account').fetchone()['password'], user['password'])
        self.assertEqual(get_user_by_username('student')['password'], user['password'])

    def test_username_lookup_also_migrates_plaintext(self):
        self.insert_legacy_account()
        self.assert_encrypted(get_user_by_username('student')['password'], 'old-password')

    def test_wechat_binding_uses_the_same_encrypted_account_storage(self):
        bind_account('openid', 'student', 'wechat-password')
        account = get_account('openid')
        self.assert_encrypted(account['password'], 'wechat-password')
        with get_db() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) AS n FROM users').fetchone()['n'], 0)

    def test_wechat_lookup_migrates_legacy_plaintext(self):
        self.insert_legacy_account()
        with get_db() as conn:
            conn.execute('INSERT INTO wechat_account_bindings VALUES (?, ?, ?, ?)',
                         ('openid', 'student', '2025-01-01', '2025-01-01'))
        self.assert_encrypted(get_account('openid')['password'], 'old-password')

    def test_no_key_allows_legacy_reads_but_refuses_new_persistent_credentials(self):
        self.insert_legacy_account()
        with patch.dict(os.environ, {'URP_CREDENTIAL_KEY': ''}):
            self.assertEqual(get_user_by_username('student')['password'], 'old-password')
            for binder, identity in ((bind_user, 'new-device'), (bind_account, 'new-openid')):
                with self.subTest(binder=binder.__name__), self.assertRaises(RuntimeError):
                    binder(identity, 'new-student', 'new-password')
        with get_db() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) AS n FROM user_account').fetchone()['n'], 1)
            self.assertEqual(conn.execute('SELECT COUNT(*) AS n FROM wechat_account_bindings').fetchone()['n'], 0)

    def test_cookie_checks_do_not_require_decrypting_the_stored_password(self):
        bind_user('device', 'student', 'saved-password')
        cookie_path = Path(self.directory.name) / 'cookie.json'
        cookie_path.write_text('{"JSESSIONID": "valid-cookie"}', encoding='utf-8')
        with patch.dict(os.environ, {'URP_CREDENTIAL_KEY': ''}):
            stored = get_user_by_device('device')['password']
            helper = URP_login('http://urp.example/', 'student', stored,
                               cookie_path=str(cookie_path), stored_password=True)
            helper.x.get = Mock(return_value=Mock(text='student'))
            self.assertTrue(helper.is_logined())

    def test_relogin_decrypts_at_the_network_boundary(self):
        bind_user('device', 'student', '重放密码')
        stored = get_user_by_device('device')['password']
        helpers = []

        def simulated_login(*args, **kwargs):
            helper = URP_login(*args, **kwargs)
            helper.x.post = Mock(return_value=Mock(text='student'))
            # 不启动 OCR，使用真实表单提交方法来检查发送到教务的密码。
            def submit():
                helper._submit_login('http://urp.example/', _parse_login_form(
                    '<form name="loginForm" action="/loginAction.do"></form>'), '1234')
                return True, '登录成功', {}
            helper.login = submit
            helpers.append(helper)
            return helper

        with patch('services.urp_service.get_current_urp_url', return_value='http://urp.example/'), \
                patch('urp.URP_login', side_effect=simulated_login):
            valid, _ = check_login_status('student', stored, {})
        self.assertTrue(valid)
        self.assertEqual(helpers[0].x.post.call_args.kwargs['data']['mm'], '重放密码')
        self.assertEqual(get_user_by_device('device')['password'], stored)

    def test_missing_wrong_or_invalid_key_never_sends_ciphertext_as_password(self):
        stored = CredentialCipher().encrypt('private-password')
        for key in ('', 'invalid-key', Fernet.generate_key().decode()):
            with self.subTest(key_type='missing' if not key else 'invalid-or-wrong'), \
                    patch.dict(os.environ, {'URP_CREDENTIAL_KEY': key}):
                helper = URP_login('http://urp.example/', 'student', stored, stored_password=True)
                helper.x.post = Mock()
                with self.assertRaises(CredentialError):
                    helper._submit_login('http://urp.example/', _parse_login_form(
                        '<form name="loginForm" action="/loginAction.do"></form>'), '1234')
                helper.x.post.assert_not_called()
        with self.assertRaises(CredentialError):
            CredentialCipher().decrypt('fernet:v1:damaged-token')

    def test_new_plaintext_with_reserved_prefix_is_not_mistaken_for_ciphertext(self):
        raw = 'fernet:v1:my-literal-password'
        helper = URP_login('http://urp.example/', 'student', raw)
        self.assertEqual(helper.password, raw)
        bind_user('device', 'student', raw)
        self.assert_encrypted(get_user_by_device('device')['password'], raw)

    def test_lazy_migration_does_not_overwrite_a_concurrent_password_change(self):
        self.insert_legacy_account()
        new_token = CredentialCipher().encrypt('concurrent-password')
        def race_encrypt(password):
            with get_db() as conn:
                conn.execute('UPDATE user_account SET password = ? WHERE username = ?', (new_token, 'student'))
            return 'fernet:v1:' + Fernet(self.key.encode()).encrypt(password.encode()).decode()
        with patch('database.CredentialCipher.encrypt', side_effect=race_encrypt):
            user = get_user_by_device('legacy-device')
        with get_db() as conn:
            self.assertEqual(conn.execute('SELECT password FROM user_account').fetchone()['password'], new_token)
        self.assertEqual(user['password'], new_token)

    def test_mysql_failed_conditional_update_rereads_the_current_password(self):
        new_token = CredentialCipher().encrypt('concurrent-password')
        class SnapshotCursor:
            rowcount = 0
            def execute(self, sql, params):
                self.sql = sql
            def fetchone(self):
                # MySQL RR 的普通查询保持旧快照，锁定读取才返回并发提交值。
                return {'password': new_token if self.sql.endswith('FOR UPDATE') else 'old-password'}
        from types import SimpleNamespace
        adapter = MySQLConnectionAdapter(SimpleNamespace(cursor=SnapshotCursor))
        self.assertEqual(migrate_account_password(adapter, 'student', 'old-password'), new_token)

    def test_plural_promotion_never_copies_plaintext_without_a_key(self):
        self.insert_legacy_account()
        with get_db() as conn:
            conn.execute('CREATE TABLE user_accounts AS SELECT * FROM user_account')
            conn.execute('DELETE FROM user_account')
        with patch.dict(os.environ, {'URP_CREDENTIAL_KEY': ''}), get_db() as conn:
            with self.assertRaises(CredentialError):
                _migrate_plural_user_accounts(conn)
        with get_db() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) AS n FROM user_account').fetchone()['n'], 0)

    def test_startup_migration_encrypts_current_and_historical_passwords_idempotently(self):
        self.insert_legacy_account()
        with get_db() as conn:
            conn.execute("UPDATE users SET password = 'legacy-device-password'")
            conn.execute('CREATE TABLE user_accounts AS SELECT * FROM user_account')
            conn.execute('CREATE TABLE user_account_archive (batch_id TEXT, device_id TEXT, username TEXT, password TEXT, bind_time TEXT)')
            conn.execute('INSERT INTO user_account_archive VALUES (?, ?, ?, ?, ?)',
                         ('batch', 'device', 'student', 'archived-password', '2025-01-01'))
            conn.execute('CREATE TABLE binding_record_archive (batch_id TEXT, source_table TEXT, record_key TEXT, record_json TEXT)')
            conn.execute('INSERT INTO binding_record_archive VALUES (?, ?, ?, ?)',
                         ('batch', 'users', 'device', json.dumps({'username': 'student', 'password': 'record-password'})))
        init_db(self.config)
        with get_db() as conn:
            before = {table: conn.execute(f'SELECT password FROM {table}').fetchone()['password']
                      for table in ('user_account', 'users', 'user_accounts', 'user_account_archive')}
            archived = conn.execute('SELECT record_json FROM binding_record_archive').fetchone()['record_json']
        for table, password in (('user_account', 'old-password'), ('users', 'legacy-device-password'),
                                ('user_accounts', 'old-password'), ('user_account_archive', 'archived-password')):
            self.assert_encrypted(before[table], password)
        self.assert_encrypted(json.loads(archived)['password'], 'record-password')
        init_db(self.config)
        with get_db() as conn:
            after = {table: conn.execute(f'SELECT password FROM {table}').fetchone()['password'] for table in before}
            self.assertEqual(conn.execute('SELECT record_json FROM binding_record_archive').fetchone()['record_json'], archived)
        self.assertEqual(after, before)

    def test_archive_encrypts_the_latest_legacy_password_and_preserves_times(self):
        self.insert_legacy_account()
        with get_db() as conn:
            conn.execute("UPDATE users SET password = 'newer-password', bind_time = '2026-01-01'")
            result = archive_snapshot(conn, snapshot(conn), 'archive-batch')
        self.assertEqual(result['account_count'], 1)
        with get_db() as conn:
            row = conn.execute('SELECT * FROM user_account').fetchone()
            self.assert_encrypted(row['password'], 'newer-password')
            self.assertEqual(row['registered_at'], '2025-01-01')
            self.assertEqual(row['last_bind_time'], '2026-01-01')
            self.assertEqual(conn.execute('SELECT COUNT(*) AS n FROM users').fetchone()['n'], 0)

    def test_mysql_adapter_migration_encrypts_rows_using_bound_parameters(self):
        self.insert_legacy_account()
        with get_db() as conn:
            executed = []
            class Cursor:
                def execute(self, sql, params):
                    executed.append((sql, params))
                    if 'information_schema.COLUMNS' in sql:
                        self.cursor = conn.execute(f'PRAGMA table_info({params[0]})')
                    else:
                        # SQL 网络边界替身，真实行修改与事务使用隔离 SQLite。
                        self.cursor = conn.execute(sql.replace('%s', '?').replace('BINARY ', ''), params)
                def fetchall(self):
                    return self.cursor.fetchall()
            from types import SimpleNamespace
            adapter = MySQLConnectionAdapter(SimpleNamespace(cursor=Cursor))
            _migrate_urp_credentials(adapter, 'mysql')
            stored = conn.execute('SELECT password FROM user_account').fetchone()['password']
            self.assert_encrypted(stored, 'old-password')
            self.assertEqual(conn.execute('SELECT password FROM users').fetchone()['password'], '')
            updates = [(sql, params) for sql, params in executed if sql.startswith('UPDATE user_account')]
            self.assertEqual(len(updates), 1)
            sql, params = updates[0]
            self.assertIn('BINARY password = BINARY %s', sql)
            self.assertNotIn('old-password', sql)
            self.assertEqual(params[1:], ('student', 'old-password'))
            self.assertEqual(params[0], stored)

    def test_sqlite_import_encrypts_legacy_accounts_before_writing_target(self):
        source_path = Path(self.directory.name) / 'source.db'
        with sqlite3.connect(source_path) as source:
            source.execute('CREATE TABLE user_account (username TEXT, password TEXT, registered_at TEXT, last_bind_time TEXT, archived_at TEXT)')
            source.execute('INSERT INTO user_account VALUES (?, ?, ?, ?, ?)',
                           ('current', 'current-password', '2025-01-01', '2025-01-01', '2025-01-01'))
            source.execute('CREATE TABLE users (device_id TEXT, username TEXT, password TEXT, bind_time TEXT)')
            source.execute('INSERT INTO users VALUES (?, ?, ?, ?)', ('old-device', 'legacy', 'legacy-password', '2025-01-01'))
            source.execute('CREATE TABLE user_accounts AS SELECT * FROM user_account WHERE 0')
            source.execute('INSERT INTO user_accounts VALUES (?, ?, ?, ?, ?)',
                           ('plural', 'plural-password', '2025-01-01', '2025-01-01', '2025-01-01'))
        # 使用真实 SQLite 目标验证导入事务；这里只替代远程 MySQL 连接。
        from database import _connect_sqlite
        @contextmanager
        def target_connection(*_):
            conn = _connect_sqlite(self.config['database'])
            try:
                yield conn
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.close()
        with patch('database.get_database_config', return_value={'type': 'mysql'}), \
                patch('database.get_db', side_effect=target_connection), patch('database.init_db'):
            success, message, _ = migrate_sqlite_to_current_database(str(source_path))
        self.assertTrue(success, message)
        with get_db() as conn:
            rows = {row['username']: row['password'] for row in conn.execute('SELECT username, password FROM user_account')}
            self.assertEqual(conn.execute('SELECT password FROM users').fetchone()['password'], '')
        for username in ('current', 'legacy', 'plural'):
            self.assert_encrypted(rows[username], f'{username}-password')


if __name__ == '__main__':
    unittest.main()
