import unittest
from unittest.mock import patch
from flask import Flask
import auth

class AuthRetryTests(unittest.TestCase):
    def test_non_auth_failure_does_not_repeat_handler_or_login_check(self):
        app = Flask(__name__)
        calls = []
        @auth.require_login
        def handler(user):
            calls.append('write')
            raise RuntimeError('unrelated business failure')
        with app.test_request_context(), patch.object(auth,'get_device_id',return_value='device'), patch.object(auth,'get_user_by_device',return_value={'username':'test','password':'test'}), patch.object(auth,'get_current_urp_url',return_value='http://urp.test/'), patch.object(auth,'check_login_status',return_value=(True,{})) as check:
            with self.assertRaises(RuntimeError):
                handler()
            self.assertEqual(calls,['write'])
            self.assertEqual(check.call_count,1)

    def test_wechat_transient_outage_does_not_request_unbinding(self):
        from services import wechat_access
        app = Flask(__name__)
        @wechat_access.require_wechat_account(login=True)
        def handler(account):
            self.fail('must not run business query during outage')
        with app.test_request_context(), patch.object(auth,'get_wechat_request_session',return_value={'openid':'test'}), patch.object(wechat_access,'get_account',return_value={'username':'test','password':'test'}), patch.object(wechat_access.urp_service,'check_login_status',return_value=(False,{'retryable':True,'message':'暂不可用'})):
            response, status = handler()
            self.assertEqual(status,503)
            self.assertEqual(response.get_json()['code'],'URP_UNAVAILABLE')
