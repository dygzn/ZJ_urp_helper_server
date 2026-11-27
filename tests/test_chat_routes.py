import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
import unittest
import uuid
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from flask import Flask

from database import get_db, init_db

USER = '2315108133'
OTHER = '2415108134'
ADMIN = {'X-Admin-Key': 'testing-chat-admin'}


class ChatRoutesTest(unittest.TestCase):
    def setUp(self):
        stack = ExitStack()
        self.addCleanup(stack.close)
        directory = stack.enter_context(tempfile.TemporaryDirectory())
        stack.enter_context(patch('database.get_config', return_value={
            'database': {'type': 'sqlite', 'sqlite_path': str(Path(directory) / 'chat.db')},
        }))
        stack.enter_context(patch('auth.get_admin_key', return_value=ADMIN['X-Admin-Key']))
        stack.enter_context(patch('auth.check_login_status', side_effect=AssertionError('chat checked URP')))
        from routes.chat_routes import chat_bp

        init_db()
        with get_db() as conn:
            for device, username in (('one', USER), ('second-device', USER), ('other', OTHER)):
                conn.execute('INSERT OR IGNORE INTO user_account VALUES (?, ?, ?, ?, ?)',
                             (username, '', '2026-11-27', '2026-11-27', '2026-11-27'))
                conn.execute('INSERT INTO users (device_id, username, password, bind_time) VALUES (?, ?, ?, ?)',
                             (device, username, '', '2026-11-27'))
        app = Flask(__name__)
        app.secret_key = 'synthetic-chat-test-key'
        app.register_blueprint(chat_bp)
        self.app = app
        self.client = app.test_client()

    def enable(self, **settings):
        data = self.client.get('/api/admin/chat/settings', headers=ADMIN).json['data']
        response = self.client.put('/api/admin/chat/settings', headers=ADMIN, json={
            **data, 'if_settings_version': data['settings_version'], 'enabled': True, **settings,
        })
        self.assertEqual(response.status_code, 200)

    def room(self, device='one'):
        headers = {'X-Device-ID': device}
        response = self.client.get('/api/chat/bootstrap', headers=headers)
        self.assertEqual(response.status_code, 200)
        data = response.json['data']
        headers['X-Chat-Context'] = data['context']
        return headers, data

    def send(self, headers, content, **kwargs):
        return self.client.post('/api/chat/messages', headers=headers, json={
            'client_msg_id': str(uuid.uuid4()), 'content': content, **kwargs,
        })

    def test_visitor_and_disabled_read_never_return_messages(self):
        self.assertEqual(self.client.get('/api/chat/bootstrap').status_code, 401)
        self.assertEqual(self.client.get('/api/chat/unread', headers={'X-Device-ID': 'one'}).json['code'],
                         'CHAT_DISABLED')
        self.assertEqual(self.client.get('/api/admin/chat/messages').status_code, 403)

    def test_privacy_updates_history_and_references_without_exposing_identity(self):
        self.enable()
        sender, first = self.room()
        self.assertIn('23级 同学#', first['viewer']['display_name'])
        self.client.put('/api/chat/settings/privacy', headers=sender, json={'show_student_id': True})
        message = self.send(sender, '第一条').json['data']['message']
        self.assertEqual(message['author']['display_name'], USER)
        other, snapshot = self.room('other')
        reply = self.send(other, '第二条', reply_to_id=message['id'])
        self.assertEqual(reply.status_code, 201)
        self.client.put('/api/chat/settings/privacy', headers=sender, json={'show_student_id': False})
        outdated = self.client.get(
            f"/api/chat/messages?after_id={message['id']}&history_version={snapshot['history_version']}",
            headers=other,
        )
        self.assertTrue(outdated.json['data']['resync_required'])
        history = self.client.get('/api/chat/messages', headers=other)
        self.assertNotIn(USER, history.get_data(as_text=True))
        self.assertNotIn('device_id', history.get_data(as_text=True))
        self.assertNotIn('username', history.get_data(as_text=True))
        items = history.json['data']['messages']
        self.assertEqual(items[0]['author']['display_name'], items[1]['reply_to']['display_name'])
        self.assertEqual(history.headers['Cache-Control'], 'private, no-store')

    def test_retry_and_cross_device_rate_limit(self):
        self.enable()
        sender, _ = self.room()
        alternate, _ = self.room('second-device')
        key = str(uuid.uuid4())
        first = self.send(sender, '第一条', client_msg_id=key)
        retry = self.send(alternate, '第一条', client_msg_id=key)
        self.assertEqual(first.status_code, 201)
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(first.json['data']['message']['id'], retry.json['data']['message']['id'])
        limited = self.send(alternate, '另一条')
        self.assertEqual(limited.status_code, 429)
        self.assertGreater(int(limited.headers['Retry-After']), 0)

    def test_concurrent_posts_share_the_account_cooldown(self):
        self.enable()
        sender, _ = self.room()
        alternate, _ = self.room('second-device')
        start = Barrier(2, timeout=3)

        def send_from(headers):
            client = self.app.test_client()
            start.wait()
            return client.post('/api/chat/messages', headers=headers, json={
                'client_msg_id': str(uuid.uuid4()), 'content': headers['X-Device-ID'],
            }).status_code

        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = sorted(pool.map(send_from, (sender, alternate)))
        self.assertEqual(statuses, [201, 429])
        self.assertEqual(len(self.client.get('/api/chat/messages', headers=sender).json['data']['messages']), 1)

    def test_unicode_line_breaks_obey_message_line_limit(self):
        self.enable()
        sender, _ = self.room()
        too_many_lines = self.send(sender, '一\u2028' * 12 + '二')
        self.assertEqual(too_many_lines.status_code, 400)
        self.assertEqual(too_many_lines.json['code'], 'INVALID_INPUT')
        normal = self.send(sender, '第一行\u2029第二行👩‍💻')
        self.assertEqual(normal.status_code, 201)
        self.assertEqual(normal.json['data']['message']['content'], '第一行\n第二行👩‍💻')

    def test_content_filter_and_moderation(self):
        self.enable(sensitive_words=['广告'])
        sender, _ = self.room()
        other, _ = self.room('other')
        blocked = self.send(sender, '广\u200b告')
        self.assertEqual(blocked.json['code'], 'CONTENT_BLOCKED')
        message = self.send(sender, '正文').json['data']['message']
        route = f"/api/chat/messages/{message['id']}/report"
        self.assertEqual(self.client.post(route, headers=other, json={'reason': 'spam'}).status_code, 201)
        self.assertEqual(self.client.post(route, headers=other, json={'reason': 'spam'}).json['code'],
                         'ALREADY_REPORTED')
        reports = self.client.get('/api/admin/chat/reports', headers=ADMIN).json['data']['items']
        self.assertEqual(reports[0]['reporter_username'], OTHER)
        self.client.post('/api/admin/chat/mutes', headers=ADMIN,
                         json={'username': USER, 'duration': 'permanent', 'reason': '刷屏'})
        self.assertEqual(self.send(sender, '另一个正文').json['code'], 'CHAT_MUTED')
        action = self.client.post(f"/api/admin/chat/reports/{reports[0]['id']}/handle", headers=ADMIN,
                                  json={'action': 'delete_message'})
        self.assertEqual(action.status_code, 200)
        self.assertEqual(self.client.get('/api/admin/chat/reports', headers=ADMIN).json['data']['items'], [])
        items = self.client.get('/api/chat/messages', headers=other).json['data']['messages']
        self.assertEqual(items[0]['status'], 'deleted')
        self.assertIsNone(items[0]['content'])

    def test_recall_time_and_official_readonly(self):
        self.enable()
        sender, _ = self.room()
        message = self.send(sender, '即将过期').json['data']['message']
        with get_db() as conn:
            conn.execute('UPDATE chat_messages SET create_time=? WHERE id=?',
                         (int(time.time() * 1000) - 180_000, message['id']))
        expired = self.client.post(f"/api/chat/messages/{message['id']}/recall", headers=sender)
        self.assertEqual(expired.json['code'], 'RECALL_EXPIRED')
        self.enable(readonly=True)
        self.assertEqual(self.send(sender, '只读不能发言').json['code'], 'CHAT_READONLY')
        official = self.client.post('/api/admin/chat/messages', headers=ADMIN, json={
            'content': '群内通知', 'client_msg_id': str(uuid.uuid4()),
        })
        self.assertEqual(official.status_code, 201)
        items = self.client.get('/api/chat/messages', headers=sender).json['data']['messages']
        self.assertEqual(items[-1]['author'], {'role': 'admin', 'display_name': '管理员'})

    def test_read_snapshot_rejects_an_account_unbound_after_request_authentication(self):
        from services.user_service import get_user_by_device

        self.enable()
        sender, _ = self.room()
        self.assertEqual(self.send(sender, '不会返回给已解绑的设备').status_code, 201)

        def resolve_before_unbind(device_id):
            identity = get_user_by_device(device_id)
            with get_db() as conn:
                conn.execute('DELETE FROM users WHERE device_id = ?', (device_id,))
            return identity

        with patch('auth.get_user_by_device', side_effect=resolve_before_unbind):
            response = self.client.get('/api/chat/messages', headers=sender)
        self.assertEqual(response.status_code, 401)
        self.assertNotIn('不会返回', response.get_data(as_text=True))

    def test_temporary_session_is_accepted_but_old_context_cannot_write_as_new_account(self):
        self.enable()
        with get_db() as conn:
            conn.execute('INSERT INTO temporary_sessions VALUES (?, ?, ?, ?)',
                         ('temp-device', 'a' * 32, '2515999999', int(time.time()) + 600))
        temporary, _ = self.room('temp-device')
        self.assertEqual(self.send(temporary, '临时账号发言').status_code, 201)
        with get_db() as conn:
            conn.execute('UPDATE temporary_sessions SET username=?, session_id=? WHERE device_id=?',
                         (OTHER, 'b' * 32, 'temp-device'))
        self.assertEqual(self.send(temporary, '旧标签页').status_code, 401)

    def test_werkzeug_access_log_filter_skips_polls_and_redacts_admin_paths(self):
        import logging
        from services.chat_access_log import _WerkzeugChatAccessFilter

        log_filter = _WerkzeugChatAccessFilter()
        poll = logging.LogRecord(
            'werkzeug', logging.INFO, '', 0,
            '127.0.0.1 - - [27/Nov/2026 13:00:00] "\x1b[32mGET /api/chat/messages?after_id=1 HTTP/1.1\x1b[0m" 200 -',
            (), None,
        )
        self.assertFalse(log_filter.filter(poll))

        mute_delete = logging.LogRecord(
            'werkzeug', logging.INFO, '', 0,
            '127.0.0.1 - - [27/Nov/2026 13:00:00] "DELETE /api/admin/chat/mutes/2315108133 HTTP/1.1" 200 -',
            (), None,
        )
        self.assertTrue(log_filter.filter(mute_delete))
        self.assertNotIn('2315108133', mute_delete.getMessage())
        self.assertIn('/api/admin/chat/mutes/<username>', mute_delete.getMessage())

        admin_query = logging.LogRecord(
            'werkzeug', logging.INFO, '', 0,
            '127.0.0.1 - - [27/Nov/2026 13:00:00] "GET /api/admin/chat/messages?username=2315108133 HTTP/1.1" 200 -',
            (), None,
        )
        self.assertTrue(log_filter.filter(admin_query))
        self.assertNotIn('2315108133', admin_query.getMessage())
        self.assertIn('GET /api/admin/chat/messages HTTP/1.1', admin_query.getMessage())
