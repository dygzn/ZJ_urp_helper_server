import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from flask import Flask

import app as app_module


class InvitationUrlCleanupTests(unittest.TestCase):
    def setUp(self):
        self.client = app_module.app.test_client()

    def test_payment_return_redirect_keeps_only_page_and_invite(self):
        response = self.client.get(
            '/?page=member&invite=inviter-token&out_trade_no=order-1&'
            'trade_status=TRADE_SUCCESS&sign=payment-signature',
            follow_redirects=False,
        )

        self.assertEqual(response.status_code, 302)
        location = response.headers['Location']
        self.assertEqual(urlsplit(location).path, '/')
        self.assertEqual(parse_qs(urlsplit(location).query), {
            'page': ['member'],
            'invite': ['inviter-token'],
        })


class InvitationUrlJavascriptTests(unittest.TestCase):
    def test_main_script_contains_payment_query_cleanup_and_own_token_sync(self):
        script = (Path(__file__).resolve().parents[1] / 'static/js/main.js').read_text(
            encoding='utf-8'
        )

        self.assertIn('sanitizeIndexUrl', script)
        self.assertIn('replaceState', script)
        self.assertIn('ensureOwnInvitationTokenInUrl', script)


if __name__ == '__main__':
    unittest.main()
