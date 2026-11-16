"""Offline regression tests for WeChat lab routes and scoped H5 uploads."""
import hashlib
import io
import os
import unittest
from contextlib import ExitStack, closing
from pathlib import Path
from unittest.mock import patch

from flask import Flask
from werkzeug.test import EnvironBuilder
from routes.lab_routes import lab_bp
from services import lab_service as lab

WEB = Path(__file__).resolve().parents[1]
KEY = ('student', 'wechat-lab:' + hashlib.sha256(b'openid-a').hexdigest())
TASK = {'item_id': '0', 'kind': 'report', 'semester': '2026-1', 'task_key': 'a' * 64}
LISTING = {'semester': '2026-1', 'items': [dict(id='0', task_key='a' * 64,
            pre=True, report=True, cells=['1', '物理实验'])]}


class WechatLabTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__, template_folder=str(WEB / 'templates'), static_folder=str(WEB / 'static'))
        self.app.register_blueprint(lab_bp)
        self.client = self.app.test_client()
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.dict(os.environ, {'WECHAT_MINIPROGRAM_SECRET': 'test-secret'}))
        self.auth = self.stack.enter_context(patch('auth.get_wechat_request_session', return_value={'openid': 'openid-a'}))
        self.session = self.stack.enter_context(patch('services.wechat_auth_service.get_wechat_request_session', return_value={'openid': 'openid-a'}))
        self.account = self.stack.enter_context(patch('services.wechat_access.get_account', return_value={'username': 'student'}))
        self.member = self.stack.enter_context(patch('services.wechat_access._check_member_access', return_value=(True, None)))
        self.headers = {'Authorization': 'Bearer business-token', 'X-Device-ID': 'spoofed'}

    def ticket(self):
        with patch.object(lab, 'session_snapshot', return_value=LISTING):
            response = self.client.post('/api/wechat/lab/local-ticket', json=TASK, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return response.json['ticket']

    def upload(self, path='/api/wechat/lab/upload', headers=None, **fields):
        data = dict(TASK, filename='中文实验报告.pdf', file=(io.BytesIO(b'%PDF-1.7\n'), 'wx-temp-name'))
        data.update(fields)
        with closing(EnvironBuilder(path=path, method='POST', headers=headers or self.headers, data=data)) as builder:
            environ = builder.get_environ()
            try:
                return self.client.open(environ)
            finally:
                environ['wsgi.input'].close()

    def test_requires_wechat_auth_and_membership(self):
        self.auth.return_value = None
        response = self.client.get('/api/wechat/lab/status', headers={'X-Device-ID': 'web-device'})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json['code'], 'WECHAT_SESSION_REQUIRED')
        self.auth.return_value = {'openid': 'openid-a'}
        self.member.return_value = (False, {})
        response = self.client.get('/api/wechat/lab/status', headers=self.headers)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json['code'], 'MEMBER_REQUIRED')

    def test_status_and_query_use_openid_scope(self):
        with patch.object(lab, 'session_snapshot', return_value=LISTING) as snap, \
                patch.object(lab, 'credential_status', return_value=False), \
                patch.object(lab, 'login_and_list', return_value=LISTING) as login:
            response = self.client.get('/api/wechat/lab/status', headers=self.headers)
            self.assertTrue(response.json['logged_in'])
            snap.assert_called_once_with(KEY)
            self.client.post('/api/wechat/lab/query', headers=self.headers, json={'password': 'lab-pw'})
            login.assert_called_once_with(KEY, 'student', 'lab-pw')

    def test_upload_preserves_original_filename_and_identity(self):
        with patch.object(lab, 'upload', return_value={'confirmed': False, 'message': '请核对'}) as upload:
            response = self.upload()
        self.assertTrue(response.json['success'])
        upload.assert_called_once_with(KEY, '0', 'report', '中文实验报告.pdf', b'%PDF-1.7\n',
                                       semester='2026-1', task_key='a' * 64)

    def test_upload_requires_strong_task_identity(self):
        for changes in ({'semester': ''}, {'task_key': ''}, {'task_key': 'not-a-key'}, {'kind': 'other'}):
            with self.subTest(changes=changes), patch.object(lab, 'upload') as upload:
                response = self.upload(**changes)
                self.assertEqual(response.status_code, 400)
                upload.assert_not_called()

    def test_real_service_rejects_invalid_or_oversize_pdf_without_network(self):
        for name, data in [('bad.pdf', b'not pdf!'), ('bad.txt', b'%PDF-1.7'),
                           ('big.pdf', b'%PDF-' + b'x' * lab.MAX_PDF)]:
            with self.subTest(name=name), patch.object(lab, '_request') as network:
                response = self.upload(filename=name, file=(io.BytesIO(data), name))
                self.assertEqual(response.status_code, 400)
                network.assert_not_called()

    def test_ticket_creation_rejects_stale_task_or_missing_entry(self):
        for changes in ({'item_id': '9'}, {'task_key': 'b' * 64}, {'semester': '2025'}, {'kind': 'other'}):
            with self.subTest(changes=changes), patch.object(lab, 'session_snapshot', return_value=LISTING):
                response = self.client.post('/api/wechat/lab/local-ticket', json=dict(TASK, **changes), headers=self.headers)
                self.assertEqual(response.status_code, 400)
        with patch.object(lab, 'session_snapshot', return_value=None):
            response = self.client.post('/api/wechat/lab/local-ticket', json=TASK, headers=self.headers)
            self.assertEqual(response.json['code'], 'LAB_SESSION_EXPIRED')

    def test_local_upload_uses_only_encrypted_ticket_task_fields(self):
        ticket = self.ticket()
        self.assertNotIn('openid-a', ticket)
        self.assertNotIn('student', ticket)
        with patch('services.wechat_account_service.get_account', return_value={'username': 'student'}), \
                patch('auth._check_member_access', return_value=(True, None)), \
                patch.object(lab, 'upload', return_value={'confirmed': False, 'message': '已发送，请核对'}) as upload:
            response = self.upload('/api/wechat/lab/local-upload', {'Authorization': 'LabUpload ' + ticket},
                                   item_id='99', kind='pre', semester='2025', task_key='b' * 64,
                                   file=(io.BytesIO(b'%PDF-1.7\n'), '中文实验报告.pdf'))
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        upload.assert_called_once_with(KEY, '0', 'report', '中文实验报告.pdf', b'%PDF-1.7\n',
                                       semester='2026-1', task_key='a' * 64)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')

    def test_local_ticket_tamper_expiry_unbinding_and_membership(self):
        ticket = self.ticket()
        with patch('services.wechat_account_service.get_account', return_value={'username': 'student'}), \
                patch('auth._check_member_access', return_value=(True, None)), patch.object(lab, 'upload') as upload:
            response = self.upload('/api/wechat/lab/local-upload', {'Authorization': 'LabUpload ' + ticket[:-5] + 'xxxxx'})
            self.assertEqual(response.status_code, 400)
            with patch('time.time', return_value=4102444800):
                response = self.upload('/api/wechat/lab/local-upload', {'Authorization': 'LabUpload ' + ticket})
                self.assertEqual(response.status_code, 400)
            upload.assert_not_called()
        with patch('services.wechat_account_service.get_account', return_value=None):
            self.assertEqual(self.upload('/api/wechat/lab/local-upload', {'Authorization': 'LabUpload ' + ticket}).status_code, 409)
        with patch('services.wechat_account_service.get_account', return_value={'username': 'student'}), \
                patch('auth._check_member_access', return_value=(False, {})):
            self.assertEqual(self.upload('/api/wechat/lab/local-upload', {'Authorization': 'LabUpload ' + ticket}).status_code, 403)

    def test_local_pdf_validation_can_reselect_without_sending_to_lab(self):
        ticket = self.ticket()
        with patch('services.wechat_account_service.get_account', return_value={'username': 'student'}), \
                patch('auth._check_member_access', return_value=(True, None)), patch.object(lab, 'upload') as upload:
            for name, data in [('fake.pdf', b'not a PDF'), ('large.pdf', b'%PDF-' + b'x' * lab.MAX_PDF)]:
                with self.subTest(name=name):
                    response = self.upload('/api/wechat/lab/local-upload', {'Authorization': 'LabUpload ' + ticket},
                                           file=(io.BytesIO(data), name))
                    self.assertEqual(response.status_code, 400)
                    self.assertTrue(response.json['retryable'])
            upload.assert_not_called()

    def test_local_page_security_and_ticket_context(self):
        ticket = self.ticket()
        response = self.client.get('/wechat/lab/local-upload')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertEqual(response.headers['Referrer-Policy'], 'no-referrer')
        with patch('services.wechat_account_service.get_account', return_value={'username': 'student'}), \
                patch('auth._check_member_access', return_value=(True, None)):
            response = self.client.get('/api/wechat/lab/local-ticket-info', headers={'Authorization': 'LabUpload ' + ticket})
        self.assertEqual(response.json['data']['kind_label'], '实验报告')
        self.assertIn('物理实验', response.json['data']['title'])


if __name__ == '__main__':
    unittest.main()
