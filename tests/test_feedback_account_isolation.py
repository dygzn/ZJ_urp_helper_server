"""反馈归属使用认证学号，换绑设备不能继承旧账号的私密会话。"""

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from cryptography.fernet import Fernet
from flask import Flask

from database import get_db, init_db
from routes.auth_routes import auth_bp
from routes.misc_routes import misc_bp


class FeedbackAccountIsolationTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.config = {'database': {'type': 'sqlite', 'sqlite_path': str(Path(directory.name) / 'test.db')}}
        for mock in (
            patch('database.get_config', return_value=self.config),
            patch.dict(os.environ, {'URP_CREDENTIAL_KEY': Fernet.generate_key().decode(),
                                    'ADMIN_KEY': 'offline-feedback-admin'}),
            patch('services.temporary_session_service.TEMPORARY_DATA_ROOT', str(Path(directory.name) / 'sessions')),
            patch('routes.auth_routes.urp_login', return_value=(True, '登录成功', {})),
        ):
            mock.start()
            self.addCleanup(mock.stop)
        init_db(self.config)
        self.app = Flask(__name__)
        self.app.testing = True
        self.app.register_blueprint(auth_bp)
        self.app.register_blueprint(misc_bp)
        self.client = self.app.test_client()
        self._login('account-a', 'shared-device')
        self.private_id = self._post_feedback('shared-device', '仅账号A和管理员可见', 'self')
        self.public_id = self._post_feedback('shared-device', '账号A的公开反馈', 'public')
        response = self.client.post(f'/api/admin/feedback/{self.private_id}/reply',
                                    headers={'X-Admin-Key': 'offline-feedback-admin'},
                                    json={'content': '给账号A的私密回复'})
        self.assertTrue(response.get_json()['success'])

    def _login(self, username, device, save=True):
        response = self.client.post('/api/login', headers={'X-Device-ID': device}, json={
            'username': username, 'password': 'offline-test-password', 'bind_account': save,
        })
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()['success'])

    def _post_feedback(self, device, content, visibility):
        response = self.client.post('/api/feedback', headers={'X-Device-ID': device},
                                    json={'content': content, 'visibility': visibility})
        self.assertTrue(response.get_json()['success'])
        with get_db() as conn:
            return conn.execute('SELECT MAX(id) AS id FROM feedbacks').fetchone()['id']

    def _list(self, device):
        response = self.client.get('/api/feedback', headers={'X-Device-ID': device})
        self.assertEqual(response.status_code, 200)
        result = response.get_json()
        self.assertTrue(result['success'])
        return result

    def _reply(self, device, feedback_id, **payload):
        return self.client.post(f'/api/feedback/{feedback_id}/reply',
                                headers={'X-Device-ID': device},
                                json={'content': '离线测试回复', **payload}).get_json()

    def _reply_count(self, feedback_id):
        with get_db() as conn:
            return conn.execute('SELECT COUNT(*) AS n FROM feedback_replies WHERE feedback_id = ?',
                                (feedback_id,)).fetchone()['n']

    def test_rebinding_device_hides_previous_accounts_private_feedback_and_replies(self):
        self._login('account-b', 'shared-device')
        own_id = self._post_feedback('shared-device', '账号B的私密反馈', 'self')
        result = self._list('shared-device')
        self.assertEqual([row['id'] for row in result['my_feedbacks']], [own_id])
        self.assertEqual([row['id'] for row in result['public_feedbacks']], [self.public_id])
        self.assertFalse(result['public_feedbacks'][0]['is_own'])
        self.assertNotIn('仅账号A和管理员可见', str(result))
        self.assertNotIn('给账号A的私密回复', str(result))

    def test_rebinding_device_cannot_reply_to_previous_accounts_private_feedback(self):
        self._login('account-b', 'shared-device')
        before = self._reply_count(self.private_id)
        result = self._reply('shared-device', self.private_id)
        self.assertFalse(result['success'])
        self.assertEqual(self._reply_count(self.private_id), before)

    def test_same_account_on_another_device_retains_own_private_and_public_feedback(self):
        self._login('account-a', 'other-device')
        result = self._list('other-device')
        self.assertEqual({row['id'] for row in result['my_feedbacks']}, {self.private_id, self.public_id})
        self.assertEqual(result['public_feedbacks'], [])
        self.assertTrue(all(row['is_own'] for row in result['my_feedbacks']))
        private = next(row for row in result['my_feedbacks'] if row['id'] == self.private_id)
        self.assertEqual(private['replies'][0]['content'], '给账号A的私密回复')

    def test_same_account_on_another_device_can_reply_to_own_private_feedback(self):
        self._login('account-a', 'other-device')
        self.assertTrue(self._reply('other-device', self.private_id)['success'])
        with get_db() as conn:
            row = conn.execute('SELECT device_id, username FROM feedback_replies ORDER BY id DESC LIMIT 1').fetchone()
        self.assertEqual(dict(row), {'device_id': 'other-device', 'username': 'account-a'})

    def test_other_account_can_still_view_and_reply_to_public_feedback(self):
        self._login('account-b', 'other-device')
        result = self._list('other-device')
        self.assertEqual(result['my_feedbacks'], [])
        self.assertEqual([row['id'] for row in result['public_feedbacks']], [self.public_id])
        self.assertTrue(self._reply('other-device', self.public_id)['success'])
        self.assertFalse(self._reply('other-device', self.private_id)['success'])

    def test_temporary_login_of_different_account_on_same_device_cannot_inherit_private_feedback(self):
        self._login('account-b', 'shared-device', save=False)
        result = self._list('shared-device')
        self.assertEqual(result['my_feedbacks'], [])
        self.assertEqual([row['id'] for row in result['public_feedbacks']], [self.public_id])
        self.assertFalse(self._reply('shared-device', self.private_id)['success'])
        self.assertEqual(self._reply_count(self.private_id), 1)

    def test_temporary_login_of_same_account_on_new_device_can_access_own_feedback(self):
        self._login('account-a', 'temporary-device', save=False)
        self.assertEqual({row['id'] for row in self._list('temporary-device')['my_feedbacks']},
                         {self.private_id, self.public_id})
        self.assertTrue(self._reply('temporary-device', self.private_id)['success'])

    def test_payload_cannot_spoof_feedback_owner_or_reply_permission(self):
        self._login('account-b', 'shared-device')
        response = self.client.post('/api/feedback', headers={'X-Device-ID': 'shared-device'}, json={
            'content': '伪造归属测试', 'visibility': 'self', 'username': 'account-a', 'device_id': 'forged',
        })
        self.assertTrue(response.get_json()['success'])
        with get_db() as conn:
            row = conn.execute('SELECT username, device_id FROM feedbacks ORDER BY id DESC LIMIT 1').fetchone()
        self.assertEqual(dict(row), {'username': 'account-b', 'device_id': 'shared-device'})
        self.assertFalse(self._reply('shared-device', self.private_id,
                                     username='account-a', device_id='forged')['success'])

    def test_unauthenticated_requests_cannot_list_create_or_reply(self):
        responses = (
            self.client.get('/api/feedback'),
            self.client.post('/api/feedback', json={'content': '未登录提交'}),
            self.client.post(f'/api/feedback/{self.private_id}/reply', json={'content': '未登录回复'}),
        )
        self.assertTrue(all(not response.get_json()['success'] for response in responses))
        self.assertEqual(self._reply_count(self.private_id), 1)

    def test_admin_can_still_review_and_reply_to_all_accounts_feedback(self):
        self._login('account-b', 'shared-device')
        self._post_feedback('shared-device', '账号B的私密反馈', 'self')
        headers = {'X-Admin-Key': 'offline-feedback-admin'}
        result = self.client.get('/api/admin/feedback', headers=headers).get_json()
        self.assertTrue(result['success'])
        self.assertEqual({row['username'] for row in result['feedbacks']}, {'account-a', 'account-b'})
        response = self.client.post(f'/api/admin/feedback/{self.private_id}/reply',
                                    headers=headers, json={'content': '继续回复账号A'})
        self.assertTrue(response.get_json()['success'])
        self.assertFalse(self.client.get('/api/admin/feedback').get_json()['success'])

    def test_missing_feedback_still_returns_failure_without_writing(self):
        self.assertFalse(self._reply('shared-device', self.public_id + 100)['success'])
        self.assertEqual(self._reply_count(self.public_id + 100), 0)

    def test_reinitializing_database_preserves_feedback_history(self):
        init_db(self.config)
        self.assertEqual({row['id'] for row in self._list('shared-device')['my_feedbacks']},
                         {self.private_id, self.public_id})
        self.assertEqual(self._reply_count(self.private_id), 1)


if __name__ == '__main__':
    unittest.main()
