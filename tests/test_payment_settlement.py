"""支付结算离线回归：真实路由与临时 SQLite，不联系支付平台。"""
from contextlib import contextmanager
from datetime import datetime, timedelta
import hashlib
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from flask import Flask
from database import get_db, init_db
from routes.member_routes import member_bp


class PaymentSettlementTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        config = {'database': {'type': 'sqlite', 'sqlite_path': str(Path(directory.name) / 'test.db')}}
        for target, value in (
            ('database.get_config', config),
            ('routes.member_routes.MERCHANT_NUM', 'test-merchant'),
            ('routes.member_routes.PAY_SECRET_KEY', 'test-payment-secret'),
            ('auth.get_user_by_device', {'username': 'student', 'device_id': 'device'}),
        ):
            mock = patch(target, value) if isinstance(value, str) else patch(target, return_value=value)
            mock.start()
            self.addCleanup(mock.stop)
        init_db(config)
        self.app = Flask(__name__)
        self.app.testing = True
        self.app.register_blueprint(member_bp)
        self.client = self.app.test_client()
        with get_db() as conn:
            conn.execute('''INSERT INTO invitations
                (inviter_username, invitee_username, create_time) VALUES (?, ?, ?)''',
                ('inviter', 'student', datetime.now().isoformat()))

    def add_order(self, order_no='order', amount='3.00', status='pending', age=0):
        with get_db() as conn:
            conn.execute('''INSERT INTO orders
                (order_no, device_id, username, member_type, amount, pay_type, status, create_time, pay_url)
                VALUES (?, 'device', 'student', 'basic', ?, 'alipay', ?, ?, ?)''',
                (order_no, amount, status, (datetime.now() - timedelta(seconds=age)).isoformat(),
                 'https://payments.example.test/order'))

    def notify(self, *, method='post', order_no='order', amount='3.00', state='1', sign=None):
        if sign is None:
            sign = hashlib.md5((state + 'test-merchant' + order_no + amount + 'test-payment-secret').encode()).hexdigest()
        params = {'orderNo': order_no, 'amount': amount, 'state': state, 'sign': sign}
        if method == 'get':
            return self.client.get('/api/member/pay_notify', query_string=params)
        return self.client.post('/api/member/pay_notify', data=params)

    def order(self, order_no='order'):
        with get_db() as conn:
            return dict(conn.execute('SELECT * FROM orders WHERE order_no = ?', (order_no,)).fetchone())

    def entitlement(self):
        with get_db() as conn:
            member = conn.execute('SELECT * FROM memberships WHERE username = ?', ('student',)).fetchone()
            earnings = conn.execute('SELECT COUNT(*) AS n FROM invitation_earnings').fetchone()['n']
        return (dict(member) if member else None), earnings

    def assert_unsettled(self, response, order_no='order'):
        self.assertEqual((response.status_code, response.text), (400, 'fail'))
        self.assertEqual(self.order(order_no)['status'], 'pending')
        self.assertEqual(self.entitlement(), (None, 0))

    def test_signed_non_success_states_never_grant_membership_or_commission(self):
        for method in ('get', 'post'):
            for state in ('', '0', '2', 'SUCCESS', '01', ' 1'):
                with self.subTest(method=method, state=state):
                    order_no = f'{method}-{state}'
                    self.add_order(order_no)
                    self.assert_unsettled(self.notify(method=method, order_no=order_no, state=state), order_no)

    def test_callback_amount_is_never_rounded_to_order_amount(self):
        for method in ('get', 'post'):
            for amount in ('2.999', '3.001', '3.004', '3.000'):
                with self.subTest(method=method, amount=amount):
                    order_no = f'{method}-{amount}'
                    self.add_order(order_no)
                    self.assert_unsettled(self.notify(method=method, order_no=order_no, amount=amount), order_no)

    def test_malformed_or_nonpositive_amounts_fail_without_server_errors(self):
        for amount in ('', 'NaN', 'sNaN', 'Infinity', '-3', '0', '3e0', ' 3.00', '+3', '3.', '３.００'):
            with self.subTest(amount=amount):
                self.add_order(amount or 'empty')
                self.assert_unsettled(self.notify(order_no=amount or 'empty', amount=amount), amount or 'empty')

    def test_invalid_stored_amount_cannot_match_invalid_callback_as_zero(self):
        self.add_order(amount='invalid')
        self.assert_unsettled(self.notify(amount='invalid'))

    def test_invalid_stored_amounts_reject_a_valid_callback(self):
        for stored_amount in ('invalid', '0', '3.001', 'NaN'):
            with self.subTest(stored_amount=stored_amount):
                self.add_order(stored_amount, amount=stored_amount)
                self.assert_unsettled(self.notify(order_no=stored_amount), stored_amount)

    def test_legitimate_amount_formats_and_duplicate_callbacks_remain_compatible(self):
        self.add_order()
        for method, amount in (('get', '3'), ('post', '3.0'), ('post', '3.00')):
            response = self.notify(method=method, amount=amount)
            self.assertEqual((response.status_code, response.text), (200, 'success'))
            if amount == '3':
                original = self.entitlement()
            self.assertEqual(self.entitlement(), original)
        self.assertEqual(self.order()['status'], 'paid')
        self.assertEqual(original[1], 1)

    def test_paid_order_still_rejects_invalid_state_or_amount(self):
        self.add_order()
        self.notify()
        original = self.entitlement()
        for state, amount in (('0', '3.00'), ('1', '3.001')):
            response = self.notify(state=state, amount=amount)
            self.assertEqual((response.status_code, response.text), (400, 'fail'))
            self.assertEqual(self.entitlement(), original)
            self.assertEqual(self.order()['status'], 'paid')

    def test_wrong_signature_unknown_order_and_mismatched_amount_do_not_settle(self):
        self.add_order()
        self.assert_unsettled(self.notify(sign='invalid'))
        self.assert_unsettled(self.notify(amount='2.99'))
        response = self.notify(order_no='missing')
        self.assertEqual((response.status_code, response.text), (400, 'fail'))
        self.assertEqual(self.entitlement(), (None, 0))

    def test_delayed_success_for_expired_order_can_still_settle_once(self):
        self.add_order(status='failed', age=600)
        self.assertEqual(self.notify().text, 'success')
        original = self.entitlement()
        self.assertEqual(self.notify().text, 'success')
        self.assertEqual(self.entitlement(), original)
        self.assertEqual(self.order()['status'], 'paid')
        self.assertEqual(original[1], 1)

    def create_order(self):
        response = SimpleNamespace(text='{}', json=lambda: {'success': True, 'data': {'payUrl': 'https://payments.example.test/new'}})
        with patch('requests.post', return_value=response):
            return self.client.post('/api/member/create_order', json={'member_type': 'basic'}, headers={'X-Device-ID': 'device'})

    def test_expiration_does_not_overwrite_callback_that_committed_after_pending_read(self):
        self.add_order(age=600)
        first_read = True
        settled = None

        @contextmanager
        def db_with_callback_between_transactions():
            nonlocal first_read, settled
            inject = first_read
            first_read = False
            with get_db() as conn:
                yield conn
            if inject:
                # 快照读已关闭、超时 UPDATE 尚未执行时，确定性提交真实支付回调。
                self.assertEqual(self.notify().text, 'success')
                settled = self.entitlement()

        with patch('routes.member_routes.get_db', db_with_callback_between_transactions):
            response = self.create_order()
        self.assertTrue(response.get_json()['success'])
        self.assertEqual(self.order()['status'], 'paid')
        self.assertEqual(self.notify().text, 'success')
        self.assertEqual(self.entitlement(), settled)

    def test_expiration_still_marks_genuinely_pending_order_failed(self):
        self.add_order(age=600)
        self.assertTrue(self.create_order().get_json()['success'])
        self.assertEqual(self.order()['status'], 'failed')
        self.assertEqual(self.entitlement(), (None, 0))


if __name__ == '__main__':
    unittest.main()
