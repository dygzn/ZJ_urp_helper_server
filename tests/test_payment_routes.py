import unittest
from pathlib import Path
from unittest import mock

from flask import Flask

import auth
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
