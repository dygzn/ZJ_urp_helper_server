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
