import os
import tempfile
import unittest
from unittest import mock

from flask import Flask

import auth
import database
from routes import member_routes


class InvitationRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_config = {
            'database': {
                'type': 'sqlite',
                'sqlite_path': os.path.join(self.temp_dir.name, 'routes.db'),
            }
        }
        database.init_db(self.database_config)
        self.app = Flask(__name__)
        self.app.config['TESTING'] = True
        self.app.register_blueprint(member_routes.member_bp)
        self.client = self.app.test_client()
        self.user = {
            'device_id': 'device-1',
            'username': 'invitee',
            'password': 'password',
            'bind_time': '2026-09-02T12:00:00',
        }
        self.db_patcher = mock.patch.object(
            member_routes,
            'get_db',
            side_effect=lambda: database.get_db(self.database_config),
        )
        self.device_patcher = mock.patch.object(
            auth, 'get_device_id', return_value='device-1'
        )
        self.user_patcher = mock.patch.object(
            auth, 'get_user_by_device', return_value=self.user
        )
        self.server_url_patcher = mock.patch.object(
            member_routes, '_get_server_url', return_value='https://urp.example.com'
        )
        self.db_patcher.start()
        self.device_patcher.start()
        self.user_patcher.start()
        self.server_url_patcher.start()

    def tearDown(self):
        self.server_url_patcher.stop()
        self.user_patcher.stop()
        self.device_patcher.stop()
        self.db_patcher.stop()
        self.temp_dir.cleanup()

    def test_bound_non_member_can_create_and_reuse_fixed_link(self):
        first = self.client.post('/api/invitation/link')
        second = self.client.post('/api/invitation/link')
        fetched = self.client.get('/api/invitation/link')

        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.get_json()['success'], True)
        self.assertTrue(first.get_json()['data']['created'])
        self.assertFalse(second.get_json()['data']['created'])
        self.assertEqual(
            first.get_json()['data']['invite_url'],
            second.get_json()['data']['invite_url'],
        )
        self.assertEqual(
            fetched.get_json()['data']['invite_url'],
            first.get_json()['data']['invite_url'],
        )

        with database.get_db(self.database_config) as conn:
            membership = conn.execute(
                'SELECT username FROM memberships WHERE username = ?',
                ('invitee',),
            ).fetchone()
        self.assertIsNone(membership)

    def test_manual_inviter_endpoint_is_removed(self):
        response = self.client.post(
            '/api/invitation/set',
            json={'inviter': 'manual-attacker'},
        )

        self.assertEqual(response.status_code, 404)

    def test_non_member_can_submit_withdrawal(self):
        with database.get_db(self.database_config) as conn:
            conn.execute(
                'INSERT INTO invitation_earnings '
                '(username, order_no, invitee_username, amount, rate, create_time) '
                'VALUES (?, ?, ?, ?, ?, ?)',
                (
                    'invitee',
                    'order-1',
                    'student-1',
                    '1.20',
                    '10%',
                    '2026-09-02T12:00:00',
                ),
            )

        response = self.client.post(
            '/api/invitation/withdraw',
            json={'real_name': '测试用户', 'alipay_account': 'test@example.com'},
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()['success'])
        with database.get_db(self.database_config) as conn:
            row = conn.execute(
                'SELECT username, amount, status FROM withdrawals WHERE username = ?',
                ('invitee',),
            ).fetchone()
        self.assertEqual(dict(row), {
            'username': 'invitee',
            'amount': '1.2',
            'status': 'pending',
        })


if __name__ == '__main__':
    unittest.main()
