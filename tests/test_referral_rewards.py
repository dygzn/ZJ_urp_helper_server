import os
import tempfile
import unittest
from unittest import mock

from flask import Flask

import auth
import database
import services.member_service as member_service
from routes import admin_routes, member_routes


class ReferralRewardServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.config = {
            'database': {
                'type': 'sqlite',
                'sqlite_path': os.path.join(self.temp_dir.name, 'referral.db'),
            }
        }
        database.init_db(self.config)

    def tearDown(self):
        self.temp_dir.cleanup()

    def add_paid_invitee(self, conn, invitee, order_no, paid_at, amount='3.00'):
        conn.execute(
            'INSERT INTO invitations (inviter_username, invitee_username, create_time) '
            'VALUES (?, ?, ?)',
            ('inviter', invitee, paid_at),
        )
        conn.execute(
            'INSERT INTO orders '
            '(order_no, device_id, username, member_type, amount, status, create_time, pay_time) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            (order_no, f'device-{invitee}', invitee, 'basic', amount, 'paid', paid_at, paid_at),
        )

    def add_paid_order(self, conn, invitee, order_no, paid_at, amount='3.00'):
        conn.execute(
            'INSERT INTO orders '
            '(order_no, device_id, username, member_type, amount, status, create_time, pay_time) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            (order_no, f'device-{invitee}', invitee, 'basic', amount, 'paid', paid_at, paid_at),
        )

    def test_configured_levels_and_post_upgrade_reward(self):
        self.assertEqual(
            [(level['min_count'], level['reward']) for level in member_service.REFERRAL_LEVELS],
            [(0, '0.80'), (3, '1.00'), (10, '1.10'), (20, '1.20')],
        )

        with database.get_db(self.config) as conn:
            self.add_paid_invitee(conn, 'invitee-1', 'order-1', '2026-09-02T10:01:00')
            self.add_paid_invitee(conn, 'invitee-2', 'order-2', '2026-09-02T10:02:00')
            self.add_paid_invitee(conn, 'invitee-3', 'order-3', '2026-09-02T10:03:00')
            self.add_paid_invitee(conn, 'invitee-4', 'order-4', '2026-09-02T10:04:00')
            self.add_paid_order(conn, 'invitee-3', 'renewal-3', '2026-10-01T10:00:00')

            member_service.ensure_invitation_earnings(conn, inviter_username='inviter')
            member_service.ensure_invitation_earnings(conn, inviter_username='inviter')

            earnings = conn.execute(
                'SELECT order_no, invitee_username, amount, rate '
                'FROM invitation_earnings WHERE username = ? ORDER BY order_no',
                ('inviter',),
            ).fetchall()
            claims = conn.execute(
                'SELECT username, invitee_username, order_no, amount, rate '
                'FROM invitation_reward_claims WHERE username = ? ORDER BY order_no',
                ('inviter',),
            ).fetchall()
            progress = member_service.get_referral_progress(conn, 'inviter')

        self.assertEqual(
            [dict(row) for row in earnings],
            [
                {'order_no': 'order-1', 'invitee_username': 'invitee-1', 'amount': '0.80', 'rate': '0.80元'},
                {'order_no': 'order-2', 'invitee_username': 'invitee-2', 'amount': '0.80', 'rate': '0.80元'},
                {'order_no': 'order-3', 'invitee_username': 'invitee-3', 'amount': '1.00', 'rate': '1.00元'},
                {'order_no': 'order-4', 'invitee_username': 'invitee-4', 'amount': '1.00', 'rate': '1.00元'},
            ],
        )
        self.assertEqual(
            [dict(row) for row in claims],
            [
                {'username': 'inviter', 'invitee_username': 'invitee-1', 'order_no': 'order-1', 'amount': '0.80', 'rate': '0.80元'},
                {'username': 'inviter', 'invitee_username': 'invitee-2', 'order_no': 'order-2', 'amount': '0.80', 'rate': '0.80元'},
                {'username': 'inviter', 'invitee_username': 'invitee-3', 'order_no': 'order-3', 'amount': '1.00', 'rate': '1.00元'},
                {'username': 'inviter', 'invitee_username': 'invitee-4', 'order_no': 'order-4', 'amount': '1.00', 'rate': '1.00元'},
            ],
        )
        self.assertEqual(progress['effective_invite_count'], 4)
        self.assertEqual(progress['current_reward'], '1.00')
        self.assertEqual(progress['next_level_count'], 10)
        self.assertEqual(progress['next_reward'], '1.10')

    def test_milestone_reward_is_one_time_and_uses_period_first_payments(self):
        milestone = {
            'id': 'test-monthly-3',
            'label': '测试月邀请3人',
            'start_at': '2026-09-01T00:00:00',
            'end_at': '2026-09-30T23:59:59',
            'target_count': 3,
            'bonus': '3.00',
        }
        with mock.patch.object(member_service, 'REFERRAL_MILESTONES', [milestone]):
            with database.get_db(self.config) as conn:
                self.add_paid_invitee(conn, 'invitee-1', 'order-1', '2026-09-02T10:01:00')
                self.add_paid_invitee(conn, 'invitee-2', 'order-2', '2026-09-03T10:01:00')
                self.add_paid_invitee(conn, 'invitee-3', 'order-3', '2026-09-04T10:01:00')

                member_service.ensure_invitation_earnings(conn, inviter_username='inviter')
                member_service.ensure_invitation_earnings(conn, inviter_username='inviter')

                reward_rows = conn.execute(
                    'SELECT username, milestone_id, amount FROM invitation_milestone_rewards'
                ).fetchall()
                total = member_service.get_invitation_earning_total(conn, 'inviter')
                status = member_service.get_referral_milestone_status(
                    conn, 'inviter', now='2026-09-15T12:00:00'
                )[0]

        self.assertEqual([dict(row) for row in reward_rows], [{
            'username': 'inviter', 'milestone_id': 'test-monthly-3', 'amount': '3.00',
        }])
        self.assertEqual(str(total), '5.60')
        self.assertEqual(status['count'], 3)
        self.assertTrue(status['completed'])
        self.assertTrue(status['rewarded'])


class ReferralRewardRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.config = {
            'database': {
                'type': 'sqlite',
                'sqlite_path': os.path.join(self.temp_dir.name, 'route.db'),
            }
        }
        database.init_db(self.config)
        self.app = Flask(__name__)
        self.app.config['TESTING'] = True
        self.app.register_blueprint(member_routes.member_bp)
        self.client = self.app.test_client()
        self.user = {'device_id': 'device-1', 'username': 'inviter'}
        self.db_patcher = mock.patch.object(
            member_routes, 'get_db', side_effect=lambda: database.get_db(self.config)
        )
        self.device_patcher = mock.patch.object(auth, 'get_device_id', return_value='device-1')
        self.user_patcher = mock.patch.object(auth, 'get_user_by_device', return_value=self.user)
        self.db_patcher.start()
        self.device_patcher.start()
        self.user_patcher.start()

    def tearDown(self):
        self.user_patcher.stop()
        self.device_patcher.stop()
        self.db_patcher.stop()
        self.temp_dir.cleanup()

    def test_earnings_endpoint_returns_tier_progress_and_milestones(self):
        with database.get_db(self.config) as conn:
            for index in range(1, 4):
                invitee = f'invitee-{index}'
                paid_at = f'2026-09-02T10:0{index}:00'
                conn.execute(
                    'INSERT INTO invitations (inviter_username, invitee_username, create_time) VALUES (?, ?, ?)',
                    ('inviter', invitee, paid_at),
                )
                conn.execute(
                    'INSERT INTO orders '
                    '(order_no, device_id, username, member_type, amount, status, create_time, pay_time) '
                    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    (f'order-{index}', f'device-{index}', invitee, 'basic', '3.00', 'paid', paid_at, paid_at),
                )

        response = self.client.get('/api/invitation/earnings')
        data = response.get_json()

        self.assertEqual(response.status_code, 200)
        self.assertTrue(data['success'])
        self.assertEqual(data['data']['effective_invite_count'], 3)
        self.assertEqual(data['data']['current_reward'], '1.00')
        self.assertEqual(data['data']['next_level_count'], 10)
        self.assertEqual(data['data']['next_reward'], '1.10')
        self.assertTrue(data['data']['levels'])
        self.assertIn('milestones', data['data'])

    def test_earnings_endpoint_marks_rate_as_tiered_legacy_label(self):
        response = self.client.get('/api/invitation/earnings')
        data = response.get_json()

        self.assertTrue(data['success'])
        self.assertEqual(data['data']['rate'], '阶梯奖励')
        self.assertEqual(data['data']['commission_mode'], 'tiered')
        self.assertEqual(data['data']['reward_per_invitee'], '0.80')


class ReferralRewardAdminTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.config = {
            'database': {
                'type': 'sqlite',
                'sqlite_path': os.path.join(self.temp_dir.name, 'admin.db'),
            }
        }
        database.init_db(self.config)
        self.app = Flask(__name__)
        self.app.config['TESTING'] = True
        self.app.register_blueprint(admin_routes.admin_bp)
        self.client = self.app.test_client()
        self.db_patcher = mock.patch.object(
            admin_routes, 'get_db', side_effect=lambda: database.get_db(self.config)
        )
        self.admin_key_patcher = mock.patch.object(auth, 'get_admin_key', return_value='test-admin-key')
        self.db_patcher.start()
        self.admin_key_patcher.start()

    def tearDown(self):
        self.admin_key_patcher.stop()
        self.db_patcher.stop()
        self.temp_dir.cleanup()

    def test_commission_stats_include_milestone_rewards(self):
        milestone = {
            'id': 'test-admin-2',
            'label': '测试任务',
            'start_at': '2026-09-01T00:00:00',
            'end_at': '2026-09-30T23:59:59',
            'target_count': 2,
            'bonus': '3.00',
        }
        with mock.patch.object(member_service, 'REFERRAL_MILESTONES', [milestone]):
            with database.get_db(self.config) as conn:
                for index in range(1, 3):
                    invitee = f'invitee-{index}'
                    paid_at = f'2026-09-02T10:0{index}:00'
                    conn.execute(
                        'INSERT INTO invitations (inviter_username, invitee_username, create_time) VALUES (?, ?, ?)',
                        ('inviter', invitee, paid_at),
                    )
                    conn.execute(
                        'INSERT INTO orders '
                        '(order_no, device_id, username, member_type, amount, status, create_time, pay_time) '
                        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                        (f'order-{index}', f'device-{index}', invitee, 'basic', '3.00', 'paid', paid_at, paid_at),
                    )

            response = self.client.get(
                '/api/admin/commission_stats',
                headers={'X-Admin-Key': 'test-admin-key'},
            )

        data = response.get_json()
        self.assertTrue(data['success'])
        user = next(item for item in data['data']['users'] if item['username'] == 'inviter')
        self.assertEqual(user['earned'], '4.60')
        self.assertEqual(user['milestone_count'], 1)


if __name__ == '__main__':
    unittest.main()
