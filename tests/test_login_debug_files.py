"""运行真实登录阶段，即使旧调试开关开启也不能保存响应快照。"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
RUN_FLOW = r'''
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
import requests
from urp.login import URP_login, VPN_BASE_URL

def response(text='', image=False):
    result = requests.Response()
    result.status_code = 200
    result.url = 'http://urp.example/loginAction.do'
    result.encoding = 'gbk'
    result.headers['Content-Type'] = 'image/gif' if image else 'text/html'
    result._content = b'GIF89a-synthetic' if image else text.encode('gbk')
    return result

helper = URP_login(VPN_BASE_URL if FLOW == 'vpn' else 'http://urp.example/',
                   'synthetic-student', 'synthetic-password', persist_cookies=False)
with patch('ddddocr.DdddOcr', return_value=SimpleNamespace(classification=lambda content: '1234')), \
     patch('urp.login.start_vpn_keepalive'):
    if FLOW == 'vpn':
        helper.x.get = Mock(side_effect=[response('vpn login'), response('vpn portal')])
        helper.x.post = Mock(return_value=response('0x00000000'))
        with patch('urp.login._load_vpn_credentials', return_value=('fake-vpn', 'fake-password', None)):
            result = helper._vpn_password_auth()
    else:
        form = '<form name="loginForm" action="/loginAction.do"></form>'
        helper.x.get = Mock(side_effect=[response(form), response('not an image') if FLOW == 'captcha' else response(image=True)])
        helper.x.post = Mock(return_value=response('<td class="errorTop">密码错误</td>' if FLOW == 'rejected' else 'menu/top.jsp menu/mainFrame.jsp'))
        result = helper.login()
files = sorted(str(p) for p in Path('.').rglob('*') if p.is_file())
helper.x.close()
print(json.dumps({'success': result[0], 'files': files}))
'''


class LoginWithoutSnapshotTests(unittest.TestCase):
    def run_flow(self, flow, debug='1'):
        env = dict(os.environ, URP_SAVE_DEBUG_FILES=debug, PYTHONPATH=str(ROOT))
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run([sys.executable, '-B', '-c', 'FLOW = '+repr(flow)+'\n'+RUN_FLOW],
                cwd=directory, env=env, capture_output=True, text=True, check=True)
        return json.loads(result.stdout)

    def test_successful_login_does_not_save_login_page_captcha_or_response(self):
        result = self.run_flow('success')
        self.assertTrue(result['success'])
        self.assertEqual(result['files'], [])

    def test_rejected_login_does_not_save_error_page(self):
        result = self.run_flow('rejected')
        self.assertFalse(result['success'])
        self.assertEqual(result['files'], [])

    def test_invalid_captcha_response_does_not_save_html(self):
        result = self.run_flow('captcha')
        self.assertFalse(result['success'])
        self.assertEqual(result['files'], [])

    def test_vpn_auth_keeps_session_cookie_without_response_snapshots(self):
        result = self.run_flow('vpn')
        self.assertTrue(result['success'])
        self.assertEqual(result['files'], ['data/vpn_cookie.json'])

    def test_login_still_succeeds_when_old_debug_flag_is_disabled(self):
        result = self.run_flow('success', debug='0')
        self.assertTrue(result['success'])
        self.assertEqual(result['files'], [])


if __name__ == '__main__':
    unittest.main()
