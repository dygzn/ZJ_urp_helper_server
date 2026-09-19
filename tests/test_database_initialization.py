import os
import tempfile
import unittest
from unittest import mock

import database


class RecordingConnection:
    def __init__(self):
        self.statements = []

    def execute(self, sql, params=None):
        self.statements.append(sql)
        return mock.Mock()


class ApiKeySchemaInitializationTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_config = {
            'database': {
                'type': 'sqlite',
                'sqlite_path': os.path.join(self.temp_dir.name, 'schema.db'),
            }
        }

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_missing_api_keys_table_is_recreated(self):
        database.init_db(self.database_config)
        with database.get_db(self.database_config) as conn:
            conn.execute('DROP TABLE api_keys')

        database.ensure_api_keys_table(self.database_config)

        with database.get_db(self.database_config) as conn:
            table = conn.execute(
                "SELECT name FROM sqlite_master "
                "WHERE type = 'table' AND name = 'api_keys'"
            ).fetchone()
            columns = {
                row['name']
                for row in conn.execute('PRAGMA table_info(api_keys)').fetchall()
            }

        self.assertIsNotNone(table)
        self.assertEqual(columns, {'username', 'key_hash', 'key_prefix', 'create_time'})

    def test_mysql_schema_is_owned_by_username_and_has_hash_index(self):
        connection = RecordingConnection()
        context = mock.MagicMock()
        context.__enter__.return_value = connection
        context.__exit__.return_value = False

        with (
            mock.patch.object(
                database,
                'get_database_config',
                return_value={'type': 'mysql'},
            ),
            mock.patch.object(database, 'get_db', return_value=context),
        ):
            database.ensure_api_keys_table()

        table_sql = next(
            sql for sql in connection.statements
            if 'CREATE TABLE IF NOT EXISTS api_keys' in sql
        )
        self.assertIn('username VARCHAR(64) PRIMARY KEY', table_sql)
        self.assertNotIn('device_id', table_sql)
        self.assertIn('CREATE UNIQUE INDEX idx_api_keys_hash ON api_keys(key_hash)', connection.statements)

    def test_schema_initializer_only_ignores_idempotent_errors(self):
        class FailingConnection:
            def __init__(self, message):
                self.message = message

            def execute(self, sql, params=None):
                raise RuntimeError(self.message)

        database._exec_ignore(FailingConnection('index already exists'), 'CREATE INDEX x')
        with self.assertRaisesRegex(RuntimeError, 'permission denied'):
            database._exec_ignore(FailingConnection('permission denied'), 'CREATE INDEX x')


class AppDatabaseInitializationTests(unittest.TestCase):
    def test_startup_ensures_api_keys_table_when_full_init_fails(self):
        import app as app_module

        with (
            mock.patch.object(
                app_module,
                'init_db',
                side_effect=RuntimeError('legacy schema failed'),
            ),
            mock.patch.object(app_module, 'ensure_api_keys_table') as ensure,
        ):
            app_module.initialize_database()

        ensure.assert_called_once_with()


if __name__ == '__main__':
    unittest.main()
