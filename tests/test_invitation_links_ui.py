from pathlib import Path
import unittest

from bs4 import BeautifulSoup


ROOT = Path(__file__).resolve().parents[1]


class InvitationLinksUiTests(unittest.TestCase):
    def setUp(self):
        self.html = (ROOT / 'templates/index.html').read_text(encoding='utf-8')
        self.script = (ROOT / 'static/js/main.js').read_text(encoding='utf-8')
        self.css = (ROOT / 'static/css/style.css').read_text(encoding='utf-8')
        self.soup = BeautifulSoup(self.html, 'html.parser')

    def test_login_form_has_no_manual_inviter_field(self):
        self.assertIsNone(self.soup.select_one('#inviter'))
        self.assertNotIn('邀请人学号', self.html)

    def test_member_card_contains_link_controls(self):
        card = self.soup.select_one('#invitation-card')
        self.assertIsNotNone(card)
        self.assertIsNotNone(card.select_one('#invitation-link-content'))
        self.assertIn('generateInvitationLink()', self.html + self.script)
        self.assertIn('copyInvitationLink()', self.html + self.script)

    def test_login_script_uses_session_token_and_new_request_field(self):
        self.assertIn('sessionStorage', self.script)
        self.assertIn('pending_invitation_token', self.script)
        self.assertIn('invitation_token', self.script)
        self.assertIn("get('invite')", self.script)
        self.assertNotIn('/api/invitation/set', self.script)
        self.assertNotIn('handleSetInviter', self.script)

    def test_non_member_copy_does_not_keep_membership_withdrawal_gate(self):
        self.assertNotIn('开通会员后可提现', self.script)
        self.assertNotIn('\\u5f00\\u901a\\u4f1a\\u5458\\u540e\\u53ef\\u63d0\\u73b0', self.script)
        self.assertIn('/api/invitation/link', self.script)
        self.assertIn('.invitation-link', self.css)
        self.assertNotIn('.inviter-set-form', self.css)


if __name__ == '__main__':
    unittest.main()
