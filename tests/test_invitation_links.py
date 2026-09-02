import os
import tempfile
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlsplit

import database
import services.invitation_service as invitation_service


class RecordingConnection:
    def __init__(self):
        self.statements = []

    def execute(self, sql, params=None):
        self.statements.append(sql)
        return mock.Mock(rowcount=1)


class InvitationSchemaTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.config = {
            'database': {
                'type': 'sqlite',
                'sqlite_path': os.path.join(self.temp_dir.name, 'invitation.db'),
            }
        }

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_sqlite_initialization_is_idempotent_and_preserves_token(self):
        database.init_db(self.config)
        with database.get_db(self.config) as conn:
            conn.execute(
                'INSERT INTO invitation_links (username, token, create_time) VALUES (?, ?, ?)',
                ('inviter', 'fixed-token', '2026-09-02T12:00:00'),
            )

        database.init_db(self.config)

        with database.get_db(self.config) as conn:
            table = conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'invitation_links'"
            ).fetchone()
            columns = {
                row['name']
                for row in conn.execute('PRAGMA table_info(invitation_links)').fetchall()
            }
            row = conn.execute(
                'SELECT username, token FROM invitation_links WHERE username = ?',
                ('inviter',),
            ).fetchone()

        self.assertIsNotNone(table)
        self.assertEqual(columns, {'username', 'token', 'create_time'})
        self.assertEqual(dict(row), {'username': 'inviter', 'token': 'fixed-token'})

    def test_mysql_schema_declares_invitation_links(self):
        connection = RecordingConnection()

        database._create_schema_mysql(connection)

        table_sql = next(
            sql for sql in connection.statements
            if 'CREATE TABLE IF NOT EXISTS invitation_links' in sql
        )
        self.assertIn('username VARCHAR(64) PRIMARY KEY', table_sql)
        self.assertIn('token VARCHAR(128) NOT NULL UNIQUE', table_sql)
        self.assertIn('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4', table_sql)

    def test_mysql_schema_declares_invitation_milestone_rewards(self):
        connection = RecordingConnection()

        database._create_schema_mysql(connection)

        table_sql = next(
            sql for sql in connection.statements
            if 'CREATE TABLE IF NOT EXISTS invitation_milestone_rewards' in sql
        )
        self.assertIn('username VARCHAR(64) NOT NULL', table_sql)
        self.assertIn('milestone_id VARCHAR(128) NOT NULL', table_sql)
        self.assertIn('UNIQUE KEY uq_invitation_milestone (username, milestone_id)', table_sql)
        self.assertIn('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4', table_sql)

    def test_mysql_schema_declares_invitation_reward_claims(self):
        connection = RecordingConnection()

        database._create_schema_mysql(connection)

        table_sql = next(
            sql for sql in connection.statements
            if 'CREATE TABLE IF NOT EXISTS invitation_reward_claims' in sql
        )
        self.assertIn('username VARCHAR(64) NOT NULL', table_sql)
        self.assertIn('invitee_username VARCHAR(64) NOT NULL', table_sql)
        self.assertIn('UNIQUE KEY uq_invitation_reward_claim (username, invitee_username)', table_sql)
        self.assertIn('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4', table_sql)

    def test_migration_table_list_contains_invitation_links(self):
        self.assertEqual(
            database.MIGRATION_TABLES['invitation_links'],
            ['username', 'token', 'create_time'],
        )

    def test_migration_table_list_contains_invitation_milestone_rewards(self):
        self.assertEqual(
            database.MIGRATION_TABLES['invitation_milestone_rewards'],
            ['id', 'username', 'milestone_id', 'amount', 'create_time'],
        )

    def test_migration_table_list_contains_invitation_reward_claims(self):
        self.assertEqual(
            database.MIGRATION_TABLES['invitation_reward_claims'],
            ['id', 'username', 'invitee_username', 'order_no', 'amount', 'rate', 'create_time'],
        )


class InvitationServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.config = {
            'database': {
                'type': 'sqlite',
                'sqlite_path': os.path.join(self.temp_dir.name, 'service.db'),
            }
        }
        database.init_db(self.config)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_post_creation_is_fixed_and_builds_query_link(self):
        with database.get_db(self.config) as conn:
            first_url, first_created = invitation_service.get_or_create_invitation_link(
                conn, 'inviter', 'https://urp.example.com/'
            )
            second_url, second_created = invitation_service.get_or_create_invitation_link(
                conn, 'inviter', 'https://urp.example.com/'
            )

        self.assertTrue(first_created)
        self.assertFalse(second_created)
        self.assertEqual(first_url, second_url)
        query = parse_qs(urlsplit(first_url).query)
        self.assertEqual(set(query), {'invite'})
        self.assertEqual(len(query['invite'][0]), 32)

    def test_valid_token_creates_one_invitation_relation(self):
        with database.get_db(self.config) as conn:
            invite_url, _ = invitation_service.get_or_create_invitation_link(
                conn, 'inviter', 'https://urp.example.com'
            )
            token = parse_qs(urlsplit(invite_url).query)['invite'][0]
            self.assertTrue(
                invitation_service.bind_invitation_by_token(conn, 'invitee', token)
            )
            self.assertFalse(
                invitation_service.bind_invitation_by_token(conn, 'invitee', token)
            )
            row = conn.execute(
                'SELECT inviter_username, invitee_username FROM invitations'
            ).fetchone()

        self.assertEqual(dict(row), {
            'inviter_username': 'inviter',
            'invitee_username': 'invitee',
        })

    def test_invalid_and_self_tokens_are_non_blocking(self):
        with database.get_db(self.config) as conn:
            self.assertFalse(
                invitation_service.bind_invitation_by_token(conn, 'invitee', 'invalid')
            )
            invite_url, _ = invitation_service.get_or_create_invitation_link(
                conn, 'invitee', 'https://urp.example.com'
            )
            token = parse_qs(urlsplit(invite_url).query)['invite'][0]
            self.assertFalse(
                invitation_service.bind_invitation_by_token(conn, 'invitee', token)
            )

    def test_token_collision_retries_until_unique(self):
        with mock.patch.object(
            invitation_service.secrets,
            'token_urlsafe',
            side_effect=['duplicate-token', 'unique-token'],
        ):
            with database.get_db(self.config) as conn:
                conn.execute(
                    'INSERT INTO invitation_links (username, token, create_time) VALUES (?, ?, ?)',
                    ('existing', 'duplicate-token', '2026-09-02T12:00:00'),
                )
                url, created = invitation_service.get_or_create_invitation_link(
                    conn, 'new-user', 'https://urp.example.com'
                )

        self.assertTrue(created)
        self.assertTrue(url.endswith('?invite=unique-token'))


if __name__ == '__main__':
    unittest.main()
