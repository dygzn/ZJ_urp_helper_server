"""普通教务地址：真实检测、密码解密、验证码提交、Cookie 保存全链路。"""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit

import requests
from cryptography.fernet import Fernet
from services import urp_service as service
from services.credential_service import CredentialCipher
from urp import session_store

URL = 'http://direct-urp.test/'
FORM = '<form name="loginForm" action="loginAction.do"><input name="token" value="synthetic"></form>'


class DirectCookieReloginTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.enterContext(patch.object(session_store, 'USER_DATA_DIR', Path(directory.name)))
        self.enterContext(patch.dict(os.environ, {'URP_CREDENTIAL_KEY': Fernet.generate_key().decode()}))
        self.password = CredentialCipher().encrypt('synthetic-password')
        service.invalidate_login_cache('student')
        self.addCleanup(lambda: service.invalidate_login_cache('student'))
        session_store.save_user_cookies('student', URL, {'JSESSIONID': 'old-cookie'})
        model = Mock()
        model.classification.return_value = '1234'
        self.enterContext(patch('ddddocr.DdddOcr',return_value=model))
        self.sent = []

    def network(self, outcomes):
        trace = self.sent
        iterator = iter(outcomes)
        class Adapter(requests.adapters.BaseAdapter):
            def send(adapter, request, **kwargs):
                trace.append(request)
                outcome = next(iterator)
                if isinstance(outcome, Exception):
                    raise outcome
                status, body = outcome
                result = requests.Response()
                result.status_code, result.url = status, request.url
                result._content = body.encode('gbk')
                result.encoding = 'utf-8'
                result.headers['Content-Type'] = 'image/png' if 'validateCodeAction' in request.url else 'text/html'
                if request.method == 'POST':
                    session.cookies.set('JSESSIONID','fresh-cookie')
                return result
            def close(adapter):
                pass
        session = requests.Session()
        session.mount('http://',Adapter())
        self.addCleanup(session.close)
        self.enterContext(patch('urp.login.requests.session',return_value=session))

    def assert_recovered(self):
        valid, details = service.check_login_status('student',self.password,url=URL)
        self.assertTrue(valid, details)
        self.assertTrue(details.relogged)
        posts = [request for request in self.sent if request.method == 'POST']
        self.assertEqual(len(posts),1)
        self.assertEqual(parse_qs(posts[0].body)['mm'],['synthetic-password'])
        self.assertEqual(session_store.load_user_cookies('student',URL)[0], {'JSESSIONID':'fresh-cookie'})
        count = len(self.sent)
        self.assertTrue(service.check_login_status('student',self.password,url=URL)[0])
        self.assertEqual(len(self.sent),count)

    def test_unknown_probe_pages_still_run_normal_saved_password_login(self):
        self.network([(500,'session expired'), (200,'<script>top.location="login.jsp";</script>'),
                      (200,FORM),(200,'synthetic captcha'),(200,'学生个人课表')])
        self.assert_recovered()

    def test_probe_timeout_but_login_available_recovers(self):
        self.network([requests.ReadTimeout('top endpoint timeout'),
                      (200,FORM),(200,'synthetic captcha'),(200,'学生个人课表')])
        self.assert_recovered()

    def test_unavailable_login_preserves_saved_cookie_and_cools_down(self):
        self.network([requests.ReadTimeout(), requests.ReadTimeout()])
        for _ in range(3):
            valid, details = service.check_login_status('student',self.password,url=URL)
            self.assertFalse(valid)
            self.assertTrue(details['retryable'])
        self.assertEqual(session_store.load_user_cookies('student',URL)[0], {'JSESSIONID':'old-cookie'})
        self.assertFalse(any(request.method=='POST' for request in self.sent))
        self.assertEqual(len(self.sent),2)
