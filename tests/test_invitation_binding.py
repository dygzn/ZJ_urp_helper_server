import os
import tempfile
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlsplit

from flask import Flask

import database
import services.user_service as user_service
from routes import auth_routes
from services.invitation_service import get_or_create_invitation_link


class InvitationBindingTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.config = {
            'database': {
                'type': 'sqlite',
                'sqlite_path': os.path.join(self.temp_dir.name, 'binding.db'),
            }
        }
        database.init_db(self.config)
        self.db_patcher = mock.patch.object(
            user_service,
            'get_db',
            side_effect=lambda: database.get_db(self.config),
        )
        self.db_patcher.start()

    def tearDown(self):
        self.db_patcher.stop()
        self.temp_dir.cleanup()

    def create_link(self, username='inviter'):
        with database.get_db(self.config) as conn:
            url, _ = get_or_create_invitation_link(
                conn, username, 'https://urp.example.com'
            )
        return parse_qs(urlsplit(url).query)['invite'][0]

    def test_bind_user_commits_device_and_first_invitation_together(self):
        token = self.create_link()

        result = user_service.bind_user(
            'device-2', 'invitee', 'password', token
        )

        with database.get_db(self.config) as conn:
            user = conn.execute(
                'SELECT username FROM users WHERE device_id = ?', ('device-2',)
            ).fetchone()
            invitation = conn.execute(
                'SELECT inviter_username, invitee_username FROM invitations'
            ).fetchone()

        self.assertTrue(result)
        self.assertEqual(user['username'], 'invitee')
        self.assertEqual(dict(invitation), {
            'inviter_username': 'inviter',
            'invitee_username': 'invitee',
        })

    def test_existing_invitation_wins_over_a_later_token(self):
        old_token = self.create_link('old-inviter')
        new_token = self.create_link('new-inviter')
        user_service.bind_user('device-1', 'invitee', 'password', old_token)

        result = user_service.bind_user(
            'device-2', 'invitee', 'password', new_token
        )

        with database.get_db(self.config) as conn:
            row = conn.execute(
                'SELECT inviter_username FROM invitations WHERE invitee_username = ?',
                ('invitee',),
            ).fetchone()
        self.assertFalse(result)
        self.assertEqual(row['inviter_username'], 'old-inviter')

    def test_invalid_token_still_binds_the_account(self):
        self.assertFalse(
            user_service.bind_user('device-1', 'invitee', 'password', 'bad-token')
        )
        with database.get_db(self.config) as conn:
            self.assertIsNotNone(
                conn.execute(
                    'SELECT username FROM users WHERE device_id = ?',
                    ('device-1',),
                ).fetchone()
            )

    def test_new_invitation_reconciles_preexisting_paid_orders(self):
        token = self.create_link()
        with database.get_db(self.config) as conn:
            conn.execute(
                'INSERT INTO orders '
                '(order_no, device_id, username, member_type, amount, status, create_time, pay_time) '
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                ('order-1', 'old-device', 'invitee', 'basic', '3.00', 'paid',
                 '2026-09-02T12:00:00', '2026-09-02T12:01:00'),
            )

        user_service.bind_user('device-1', 'invitee', 'password', token)

        with database.get_db(self.config) as conn:
            earning = conn.execute(
                'SELECT username, amount, rate FROM invitation_earnings'
            ).fetchone()
        self.assertEqual(dict(earning), {
            'username': 'inviter', 'amount': '0.3', 'rate': '10%',
        })


class LoginInvitationTokenTests(unittest.TestCase):
    def test_login_forwards_token_and_ignores_manual_inviter(self):
        app = Flask(__name__)
        app.config['TESTING'] = True
        app.register_blueprint(auth_routes.auth_bp)
        client = app.test_client()

        with (
            mock.patch.object(auth_routes, 'urp_login', return_value=(True, 'ok', {})),
            mock.patch.object(auth_routes, 'get_device_id', return_value='device-1'),
            mock.patch.object(auth_routes, 'bind_user') as bind_user,
        ):
            response = client.post('/api/login', json={
                'username': 'invitee',
                'password': 'password',
                'inviter': 'manual-attacker',
                'invitation_token': 'link-token',
            })

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()['success'])
        bind_user.assert_called_once_with(
            'device-1', 'invitee', 'password', 'link-token'
        )


if __name__ == '__main__':
    unittest.main()
