import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import database


class ChatDatabaseTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.source_path = str(Path(directory.name) / 'source.db')
        self.target_config = {'database': {'type': 'sqlite',
                              'sqlite_path': str(Path(directory.name) / 'target.db')}}
        self.source_config = {'database': {'type': 'sqlite', 'sqlite_path': self.source_path}}

    def test_initialization_keeps_chat_closed_and_preserves_existing_configuration(self):
        database.init_db(self.target_config)
        with database.get_db(self.target_config) as conn:
            row = conn.execute('SELECT * FROM chat_settings').fetchone()
            self.assertEqual((row['enabled'], row['readonly'], row['sensitive_words']), (0, 0, '[]'))
            conn.execute('UPDATE chat_settings SET enabled = 1, settings_version = 5 WHERE id = 1')
        database.init_db(self.target_config)
        with database.get_db(self.target_config) as conn:
            row = conn.execute('SELECT * FROM chat_settings').fetchone()
            self.assertEqual((row['enabled'], row['settings_version']), (1, 5))

    def migrate(self):
        original_get_db = database.get_db
        physical_config = database.get_database_config(self.target_config)

        def target():
            return original_get_db(self.target_config)

        def config_for(config=None):
            return physical_config if config is self.target_config else {'type': 'mysql'}

        with (patch.object(database, 'get_database_config', side_effect=config_for),
              patch.object(database, 'get_db', side_effect=target),
              patch.object(database, 'init_db')):
            return database.migrate_sqlite_to_current_database(self.source_path)

    def seed_source(self):
        database.init_db(self.source_config)
        with database.get_db(self.source_config) as conn:
            conn.execute('UPDATE chat_settings SET enabled = 1, settings_version = 4, '
                         'history_version = 9 WHERE id = 1')
            conn.execute('INSERT INTO chat_user_settings VALUES (?, 0, ?, 1000)', ('demo', 'B29D'))
            conn.executemany('INSERT INTO chat_messages '
                             '(id, username, device_id, sender_role, content, reply_to_id, '
                             ' client_msg_id, create_time, updated_at) '
                             "VALUES (?, ?, 'preview-device', 'user', '消息', ?, ?, 1000, 1000)",
                             [(5, 'demo', None, 'u1'), (12, 'other', 5, 'u2')])
            conn.execute('INSERT INTO chat_reports '
                         '(id,message_id,reporter_username,reason,detail,create_time) '
                         "VALUES (7, 12, 'demo', 'spam', '', 1000)")

    def test_migration_preserves_message_ids_references_report_ids_and_settings_versions(self):
        self.seed_source()
        database.init_db(self.target_config)
        success, message, result = self.migrate()
        self.assertTrue(success, message)
        self.assertEqual(result['chat_messages'], 2)
        with database.get_db(self.target_config) as conn:
            self.assertEqual([tuple(row) for row in conn.execute(
                'SELECT id, reply_to_id FROM chat_messages ORDER BY id')], [(5, None), (12, 5)])
            self.assertEqual(tuple(conn.execute('SELECT id,message_id FROM chat_reports').fetchone()), (7, 12))
            self.assertEqual(tuple(conn.execute(
                'SELECT enabled,settings_version,history_version FROM chat_settings').fetchone()), (1, 4, 9))
            new_message = conn.execute('INSERT INTO chat_messages '
                                       '(sender_role,content,client_msg_id,create_time,updated_at) '
                                       "VALUES ('admin','群公告','u3',1001,1001)")
            self.assertGreater(new_message.lastrowid, 12)

    def test_migration_refuses_to_overwrite_target_chat(self):
        self.seed_source()
        database.init_db(self.target_config)
        with database.get_db(self.target_config) as conn:
            conn.execute('INSERT INTO chat_messages '
                         '(id,sender_role,content,client_msg_id,create_time,updated_at) '
                         "VALUES (12,'admin','目标公告','u3',1001,1001)")
        success, message, _ = self.migrate()
        self.assertFalse(success)
        self.assertIn('目标数据库已有聊天室数据', message)
        with database.get_db(self.target_config) as conn:
            self.assertEqual(tuple(conn.execute('SELECT id,content FROM chat_messages').fetchone()),
                             (12, '目标公告'))
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM chat_user_settings').fetchone()[0], 0)

    def test_duplicate_reports_for_same_message_and_account_are_rejected(self):
        self.seed_source()
        with database.get_db(self.source_config) as conn:
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute('INSERT INTO chat_reports '
                             '(message_id,reporter_username,reason,detail,create_time) '
                             "VALUES (12, 'demo', 'spam', '', 2000)")

    def test_migration_rolls_back_after_chat_insert_error_without_exposing_row_data(self):
        self.seed_source()
        database.init_db(self.target_config)
        with database.get_db(self.target_config) as conn:
            conn.execute('CREATE TRIGGER reject_chat_report BEFORE INSERT ON chat_reports '
                         "BEGIN SELECT RAISE(ABORT, 'demo-private-details'); END")
        success, message, _ = self.migrate()
        self.assertFalse(success)
        self.assertIn('聊天室数据导入失败', message)
        self.assertNotIn('demo-private-details', message)
        with database.get_db(self.target_config) as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM chat_messages').fetchone()[0], 0)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM chat_user_settings').fetchone()[0], 0)
            self.assertEqual(conn.execute('SELECT enabled FROM chat_settings').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
