import os
import sqlite3
import tempfile
import unittest
from unittest import mock

import database


class _TargetConnection:
    def __init__(self, fail_on=None):
        self.fail_on = fail_on
        self.executed = []

    def executemany(self, sql, values):
        self.executed.append((sql, list(values)))
        if self.fail_on and f' {self.fail_on} ' in sql:
            raise RuntimeError(f'cannot import {self.fail_on}')


class _TargetContext:
    def __init__(self, target):
        self.target = target

    def __enter__(self):
        return self.target

    def __exit__(self, exc_type, exc, tb):
        return False


class SqliteMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.sqlite_path = os.path.join(self.temp_dir.name, 'source.db')
        source = sqlite3.connect(self.sqlite_path)
        source.execute('''CREATE TABLE users (
            device_id TEXT PRIMARY KEY, username TEXT NOT NULL,
            password TEXT NOT NULL, bind_time TEXT NOT NULL,
            last_auto_update TEXT)''')
        source.execute(
            'INSERT INTO users VALUES (?, ?, ?, ?, ?)',
            ('device-1', 'student', 'password', '2026', None),
        )
        source.execute(
            'INSERT INTO users VALUES (?, ?, ?, ?, ?)',
            ('device-2', 'student', '', '2027', None),
        )
        source.commit()
        source.close()

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_any_table_error_returns_failure_instead_of_success(self):
        target = _TargetConnection(fail_on='users')
        context = _TargetContext(target)
        config = {'type': 'mysql', 'sqlite_path': self.sqlite_path}
        with (
            mock.patch.object(database, 'get_database_config', return_value=config),
            mock.patch.object(database, 'init_db'),
            mock.patch.object(database, 'get_db', return_value=context),
        ):
            ok, message, result = database.migrate_sqlite_to_current_database()

        self.assertFalse(ok)
        self.assertIn('已回滚', message)
        self.assertIn('users', result)
        self.assertIn('失败', result['users'])

    def test_legacy_users_also_seed_canonical_account_rows(self):
        target = _TargetConnection()
        context = _TargetContext(target)
        config = {'type': 'mysql', 'sqlite_path': self.sqlite_path}
        with (
            mock.patch.object(database, 'get_database_config', return_value=config),
            mock.patch.object(database, 'init_db'),
            mock.patch.object(database, 'get_db', return_value=context),
        ):
            ok, message, result = database.migrate_sqlite_to_current_database()

        self.assertTrue(ok, message)
        self.assertEqual(result['user_account_from_users'], 1)
        user_imports = [
            values for sql, values in target.executed
            if 'users' in sql and 'REPLACE' in sql
        ]
        self.assertEqual(user_imports[0][0][2], '')
        account_imports = [
            values for sql, values in target.executed
            if 'user_account' in sql and 'INSERT' in sql
        ]
        self.assertEqual(account_imports, [[
            ('student', 'password', '2026', '2027', mock.ANY),
        ]])

    def test_newer_users_binding_wins_over_legacy_plural_account(self):
        source = sqlite3.connect(self.sqlite_path)
        source.execute('''CREATE TABLE user_accounts (
            username TEXT PRIMARY KEY, password TEXT NOT NULL,
            registered_at TEXT NOT NULL, last_bind_time TEXT NOT NULL,
            archived_at TEXT)''')
        source.execute(
            'INSERT INTO user_accounts VALUES (?, ?, ?, ?, ?)',
            ('student', 'old-password', '2025', '2025', '2025'),
        )
        source.commit()
        source.close()

        target = _TargetConnection()
        context = _TargetContext(target)
        config = {'type': 'mysql', 'sqlite_path': self.sqlite_path}
        with (
            mock.patch.object(database, 'get_database_config', return_value=config),
            mock.patch.object(database, 'init_db'),
            mock.patch.object(database, 'get_db', return_value=context),
        ):
            ok, message, result = database.migrate_sqlite_to_current_database()

        self.assertTrue(ok, message)
        self.assertEqual(result['user_accounts'], 1)
        account_imports = [
            values for sql, values in target.executed
            if 'user_account' in sql and 'INSERT' in sql
        ]
        # users 里的 2027 绑定先导入；旧复数表只能补齐，不得覆盖较新密码。
        self.assertEqual(account_imports[0][0][0:4], (
            'student', 'password', '2026', '2027',
        ))


if __name__ == '__main__':
    unittest.main()
