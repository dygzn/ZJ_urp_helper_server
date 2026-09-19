import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from flask import Flask

import auth
import database
from routes import member_routes


ROOT = Path(__file__).resolve().parents[1]


class PaymentRouteTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.config['TESTING'] = True
        self.app.register_blueprint(member_routes.member_bp)
        self.client = self.app.test_client()
        self.user = {
            'device_id': 'device-1',
            'username': 'student-1',
            'password': 'password',
        }
        self.device_patcher = mock.patch.object(
            auth, 'get_device_id', return_value='device-1'
        )
        self.user_patcher = mock.patch.object(
            auth, 'get_user_by_device', return_value=self.user
        )
        self.device_patcher.start()
        self.user_patcher.start()

    def tearDown(self):
        self.user_patcher.stop()
        self.device_patcher.stop()

    def _set_up_database(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_config = {
            'database': {
                'type': 'sqlite',
                'sqlite_path': os.path.join(self.temp_dir.name, 'payment.db'),
            }
        }
        database.init_db(self.database_config)
        self.db_patcher = mock.patch.object(
            member_routes,
            'get_db',
            side_effect=lambda: database.get_db(self.database_config),
        )
        self.db_patcher.start()
        self.addCleanup(self.db_patcher.stop)
        self.addCleanup(self.temp_dir.cleanup)

    def _insert_pending_order(self, amount='10'):
        with database.get_db(self.database_config) as conn:
            conn.execute('''INSERT INTO orders
                (order_no, device_id, username, member_type, amount, pay_type,
                 status, create_time)
                VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)''',
                ('order-1', 'device-1', 'student-1', 'basic', amount,
                 'alipay', '2026-09-19T10:00:00'))

    def _notify(self, amount='10'):
        with mock.patch.object(member_routes, 'MERCHANT_NUM', 'merchant'), \
                mock.patch.object(member_routes, 'PAY_SECRET_KEY', 'secret'):
            state = 'success'
            sign = member_routes._generate_md5(
                state + 'merchant' + 'order-1' + amount + 'secret'
            )
            return self.client.post('/api/member/pay_notify', data={
                'orderNo': 'order-1',
                'amount': amount,
                'state': state,
                'sign': sign,
            })

    def test_callback_rejects_amount_different_from_order(self):
        self._set_up_database()
        self._insert_pending_order('10')
        response = self._notify('9')

        self.assertEqual(response.status_code, 400)
        with database.get_db(self.database_config) as conn:
            row = conn.execute(
                'SELECT status FROM orders WHERE order_no = ?', ('order-1',)
            ).fetchone()
        self.assertEqual(row['status'], 'pending')

    def test_duplicate_callback_does_not_extend_membership_twice(self):
        self._set_up_database()
        self._insert_pending_order('10')
        first = self._notify('10')
        with database.get_db(self.database_config) as conn:
            first_membership = conn.execute(
                'SELECT member_type, expire_time FROM memberships WHERE username = ?',
                ('student-1',),
            ).fetchone()
        second = self._notify('10')

        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.get_data(as_text=True), 'success')
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.get_data(as_text=True), 'success')
        with database.get_db(self.database_config) as conn:
            row = conn.execute(
                'SELECT status FROM orders WHERE order_no = ?', ('order-1',)
            ).fetchone()
            membership = conn.execute(
                'SELECT member_type, expire_time FROM memberships WHERE username = ?',
                ('student-1',),
            ).fetchone()
        self.assertEqual(row['status'], 'paid')
        self.assertEqual(dict(membership), dict(first_membership))

    def test_wechat_payment_is_rejected(self):
        response = self.client.post(
            '/api/member/create_order',
            json={'member_type': 'basic', 'pay_type': 'wechat'},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {
            'success': False,
            'message': '目前仅支持支付宝支付',
        })


class PaymentTemplateTests(unittest.TestCase):
    def test_payment_dialog_only_exposes_alipay(self):
        html = (ROOT / 'templates' / 'index.html').read_text(encoding='utf-8')

        self.assertIn('id="pay-type-alipay"', html)
        self.assertNotIn('id="pay-type-wechat"', html)


if __name__ == '__main__':
    unittest.main()
