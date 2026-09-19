import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import database
from services import user_service


class UserAccountSourceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.config = {
            'database': {
                'type': 'sqlite',
                'sqlite_path': str(Path(self.tmp.name) / 'accounts.db'),
            }
        }
        database.init_db(self.config)
        self.db_patch = patch('services.user_service.get_db',
                              side_effect=lambda: database.get_db(self.config))
        self.db_patch.start()
        self.addCleanup(self.db_patch.stop)

    def test_canonical_singular_account_table_is_created(self):
        with database.get_db(self.config) as conn:
            tables = {row['name'] for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()}
        self.assertIn('user_account', tables)

    def test_binding_creates_one_account_and_device_row(self):
        user_service.bind_user('device-1', 'student', 'first-password')
        with database.get_db(self.config) as conn:
            account = conn.execute(
                'SELECT username, password, registered_at, last_bind_time FROM user_account'
            ).fetchone()
            binding = conn.execute(
                'SELECT device_id, username, password FROM users'
            ).fetchone()
        self.assertEqual(dict(account)['username'], 'student')
        self.assertEqual(dict(account)['password'], 'first-password')
        self.assertEqual(dict(binding), {'device_id': 'device-1', 'username': 'student', 'password': ''})

    def test_device_lookup_uses_account_password_not_users_password(self):
        user_service.bind_user('device-1', 'student', 'account-password')
        with database.get_db(self.config) as conn:
            conn.execute("UPDATE users SET password = 'stale-device-password'")
        user = user_service.get_user_by_device('device-1')
        self.assertEqual(user['password'], 'account-password')
        self.assertEqual(user['username'], 'student')

    def test_rebinding_updates_account_password_but_preserves_first_registration(self):
        user_service.bind_user('device-1', 'student', 'first-password')
        with database.get_db(self.config) as conn:
            first = conn.execute('SELECT registered_at FROM user_account').fetchone()['registered_at']
        user_service.bind_user('device-1', 'student', 'new-password')
        with database.get_db(self.config) as conn:
            row = conn.execute('SELECT * FROM user_account').fetchone()
        self.assertEqual(row['password'], 'new-password')
        self.assertEqual(row['registered_at'], first)

    def test_missing_account_does_not_authenticate_device(self):
        with database.get_db(self.config) as conn:
            conn.execute("INSERT INTO users (device_id, username, password, bind_time) VALUES ('device-1','student','legacy','2026')")
        self.assertIsNone(user_service.get_user_by_device('device-1'))

    def test_username_lookup_uses_account_source(self):
        user_service.bind_user('device-1', 'student', 'account-password')
        with database.get_db(self.config) as conn:
            conn.execute("UPDATE users SET password = 'stale-device-password'")
        user = user_service.get_user_by_username('student')
        self.assertEqual(user['password'], 'account-password')
        self.assertEqual(user['device_id'], 'device-1')

    def test_early_plural_table_is_migrated_to_canonical_source(self):
        with database.get_db(self.config) as conn:
            conn.execute('''CREATE TABLE user_accounts (
                username TEXT PRIMARY KEY, password TEXT NOT NULL,
                registered_at TEXT NOT NULL, last_bind_time TEXT NOT NULL,
                archived_at TEXT NOT NULL)''')
            conn.execute("INSERT INTO user_accounts VALUES ('student','legacy-password','2024','2024','2024')")
        database.init_db(self.config)
        with database.get_db(self.config) as conn:
            row = conn.execute('SELECT * FROM user_account WHERE username = ?', ('student',)).fetchone()
        self.assertEqual(row['password'], 'legacy-password')
        self.assertEqual(row['registered_at'], '2024')

    def test_repeated_startup_does_not_overwrite_canonical_account(self):
        with database.get_db(self.config) as conn:
            conn.execute('''CREATE TABLE user_accounts (
                username TEXT PRIMARY KEY, password TEXT NOT NULL,
                registered_at TEXT NOT NULL, last_bind_time TEXT NOT NULL,
                archived_at TEXT NOT NULL)''')
            conn.execute("INSERT INTO user_accounts VALUES ('student','legacy-password','2024','2026','2026')")
            conn.execute('''INSERT INTO user_account
                (username, password, registered_at, last_bind_time, archived_at)
                VALUES ('student', 'canonical-password', '2025', '2025', '2025')''')
        database.init_db(self.config)
        database.init_db(self.config)
        with database.get_db(self.config) as conn:
            row = conn.execute('SELECT * FROM user_account WHERE username = ?', ('student',)).fetchone()
        self.assertEqual(row['password'], 'canonical-password')
        self.assertEqual(row['registered_at'], '2025')
        self.assertEqual(row['last_bind_time'], '2025')

    def test_archiving_does_not_replace_account_password_with_device_placeholder(self):
        user_service.bind_user('device-1', 'student', 'account-password')
        from services import binding_archive_service
        with database.get_db(self.config) as conn:
            result = binding_archive_service.archive_snapshot(
                conn, binding_archive_service.snapshot(conn), 'archive-placeholder'
            )
            account = conn.execute(
                'SELECT password FROM user_account WHERE username = ?', ('student',)
            ).fetchone()
        self.assertEqual(result['account_count'], 1)
        self.assertEqual(account['password'], 'account-password')


if __name__ == '__main__':
    unittest.main()
