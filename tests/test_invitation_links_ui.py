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

    def test_referral_copy_uses_tiered_first_payment_rewards(self):
        self.assertIn('每成功邀请1位新付费用户，获得最高1.2元奖励。', self.script)
        self.assertIn('当前每人奖励', self.script)
        self.assertIn('有效邀请', self.script)
        self.assertIn('每位被邀请用户首次完成付费时计为一次有效邀请，同一用户仅计一次', self.script)
        self.assertIn('历史奖励不补差价', self.script)
        self.assertNotIn('10% 起的邀请收益', self.script)
        self.assertNotIn("rateText = memberType === 'advanced'", self.script)


if __name__ == '__main__':
    unittest.main()
