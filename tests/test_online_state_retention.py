"""在线状态清理及请求钩子的离线回归，不使用真实账号或数据库。"""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import os
import unittest
from unittest.mock import Mock, patch

from flask import Flask, jsonify

from routes.admin_routes import admin_bp
from services.logging_service import init_logging
from services.online_service import OnlineUserTracker


class OnlineRetentionTests(unittest.TestCase):
    def test_continuous_requests_release_expired_devices_without_a_snapshot(self):
        tracker = OnlineUserTracker(ttl_seconds=300)
        for index in range(1000):
            tracker.touch(f'device-{index}', now=index)

        # 清理最多延迟一分钟，保留量不能随服务运行时长持续增长。
        self.assertLessEqual(len(tracker._users), 361)
        self.assertNotIn('device-0', tracker._users)
        online = tracker.snapshot(now=999)
        self.assertEqual(online['online_count'], 301)
        self.assertEqual(online['users'][0]['device_id'], 'device-999')

    def test_request_cleanup_is_throttled_and_snapshot_resets_the_interval(self):
        tracker = OnlineUserTracker()
        # 包装真实清理，验证高频请求不会退化成每次遍历全部在线记录。
        with patch.object(tracker, '_prune_expired', wraps=tracker._prune_expired) as prune:
            tracker.touch('device', now=0)
            for second in range(1, 60):
                tracker.touch('device', now=second)
            self.assertEqual(prune.call_count, 1)
            tracker.touch('device', now=60)
            self.assertEqual(prune.call_count, 2)
            tracker.snapshot(now=90)
            self.assertEqual(prune.call_count, 3)
            tracker.touch('device', now=120)
            self.assertEqual(prune.call_count, 3)
            tracker.touch('device', now=150)
            self.assertEqual(prune.call_count, 4)

    def test_first_request_after_a_long_idle_period_releases_old_records(self):
        tracker = OnlineUserTracker()
        tracker.touch('old-device', now=0)
        tracker.touch('new-device', now=86400)
        self.assertEqual(set(tracker._users), {'new-device'})

    def test_recently_refreshed_device_survives_cleanup(self):
        tracker = OnlineUserTracker()
        tracker.touch('returning-device', username='old-name', now=0)
        tracker.touch('expired-device', now=0)
        tracker.touch('returning-device', username='new-name', endpoint='课表查询', now=290)
        tracker.touch('new-device', now=360)
        self.assertEqual(set(tracker._users), {'returning-device', 'new-device'})
        record = tracker.snapshot(now=360)['users'][1]
        self.assertEqual(record['username'], 'new-name')
        self.assertEqual(record['last_endpoint'], '课表查询')

    def test_exact_ttl_boundary_remains_online(self):
        tracker = OnlineUserTracker(ttl_seconds=300)
        tracker.touch('at-boundary', now=0)
        tracker.touch('new-device', now=300)
        self.assertIn('at-boundary', tracker._users)
        self.assertEqual(tracker.snapshot(now=300)['online_count'], 2)
        self.assertEqual(tracker.snapshot(now=300.001)['online_count'], 1)

    def test_short_custom_ttl_does_not_wait_a_full_minute_for_cleanup(self):
        tracker = OnlineUserTracker(ttl_seconds=2)
        tracker.touch('expired-device', now=0)
        tracker.touch('new-device', now=3)
        self.assertNotIn('expired-device', tracker._users)

    def test_clock_rollback_does_not_suspend_future_cleanup(self):
        tracker = OnlineUserTracker()
        tracker.touch('before-clock-change', now=1000)
        tracker.touch('after-clock-change', now=100)
        tracker.touch('new-device', now=401)
        self.assertNotIn('after-clock-change', tracker._users)
        self.assertIn('before-clock-change', tracker._users)

    def test_snapshot_keeps_original_public_fields_and_order(self):
        tracker = OnlineUserTracker()
        tracker.touch('older', now=100)
        tracker.touch('newer', username='synthetic-student', endpoint='考试安排', now=110)
        result = tracker.snapshot(now=111)
        self.assertEqual(set(result), {'online_count', 'users'})
        self.assertEqual([user['device_id'] for user in result['users']], ['newer', 'older'])
        self.assertEqual(result['users'][0], {
            'device_id': 'newer',
            'username': 'synthetic-student',
            'last_endpoint': '考试安排',
            'last_active': datetime.fromtimestamp(110).strftime('%Y-%m-%d %H:%M:%S'),
        })
        self.assertEqual(result['users'][1]['username'], '未绑定')

    def test_forget_and_empty_device_do_not_leave_records(self):
        tracker = OnlineUserTracker()
        tracker.touch('', now=0)
        tracker.touch(None, now=0)
        tracker.touch('device', now=0)
        tracker.forget('device')
        tracker.forget('missing')
        self.assertEqual(tracker.snapshot(now=1), {'online_count': 0, 'users': []})

    def test_default_clock_is_used_for_request_driven_cleanup(self):
        tracker = OnlineUserTracker()
        with patch('services.online_service.time.time', return_value=100):
            tracker.touch('expired-device')
        with patch('services.online_service.time.time', return_value=401):
            tracker.touch('new-device')
        self.assertNotIn('expired-device', tracker._users)

    def test_concurrent_requests_and_snapshots_keep_active_devices(self):
        tracker = OnlineUserTracker()
        tracker.touch('expired-device', now=0)

        def visit(worker):
            for index in range(100):
                tracker.touch(f'{worker}-{index}', now=1000)
                tracker.snapshot(now=1000)

        with ThreadPoolExecutor(max_workers=8) as executor:
            list(executor.map(visit, range(8)))
        self.assertEqual(tracker.snapshot(now=1000)['online_count'], 800)
        self.assertNotIn('expired-device', tracker._users)


class OnlineRequestHookTests(unittest.TestCase):
    def setUp(self):
        self.tracker = OnlineUserTracker()
        self.lookup = Mock(return_value={'username': 'synthetic-student'})
        self.app = Flask(__name__)
        self.app.register_blueprint(admin_bp)

        @self.app.get('/api/probe')
        def probe():
            return jsonify(success=True)

        @self.app.get('/public')
        def public():
            return 'public'

        init_logging(self.app, tracker=self.tracker, user_lookup=self.lookup)
        self.client = self.app.test_client()

    def test_oversized_device_is_ignored_before_lookup_or_retention(self):
        response = self.client.get('/api/probe', headers={'X-Device-ID': 'x' * 129})
        self.assertEqual(response.status_code, 200)
        self.lookup.assert_not_called()
        self.assertEqual(self.tracker.snapshot()['online_count'], 0)

    def test_valid_device_is_trimmed_and_maximum_length_is_accepted(self):
        device_id = 'x' * 128
        self.client.get('/api/probe', headers={'X-Device-ID': f'  {device_id}  '})
        self.lookup.assert_called_once_with(device_id)
        self.assertEqual(self.tracker.snapshot()['users'][0]['device_id'], device_id)

    def test_missing_or_blank_device_and_non_api_request_are_ignored(self):
        self.client.get('/api/probe')
        self.client.get('/api/probe', headers={'X-Device-ID': '   '})
        self.client.get('/public', headers={'X-Device-ID': 'device'})
        self.lookup.assert_not_called()
        self.assertEqual(self.tracker.snapshot()['online_count'], 0)

    def test_lookup_failure_keeps_response_and_anonymous_monitor_record(self):
        self.lookup.side_effect = RuntimeError('synthetic lookup failure')
        response = self.client.get('/api/probe', headers={'X-Device-ID': 'device'})
        self.assertEqual(response.get_json(), {'success': True})
        self.assertEqual(self.tracker.snapshot()['users'][0]['username'], '未绑定')

    def test_real_monitor_route_preserves_admin_auth_and_does_not_track_itself(self):
        self.tracker.touch('visitor', username='synthetic-student', endpoint='课表查询')
        with patch.dict(os.environ, {'ADMIN_KEY': 'synthetic-admin-key'}), \
                patch('services.online_service.online_tracker', self.tracker):
            denied = self.client.get('/api/admin/monitor/online', headers={'X-Device-ID': 'admin-device'})
            allowed = self.client.get('/api/admin/monitor/online', headers={
                'X-Device-ID': 'admin-device', 'X-Admin-Key': 'synthetic-admin-key',
            })
        self.assertEqual(denied.status_code, 403)
        payload = allowed.get_json()
        self.assertTrue(payload['success'])
        self.assertEqual(payload['data']['online_count'], 1)
        self.assertEqual(payload['data']['users'][0]['device_id'], 'visitor')
        self.lookup.assert_not_called()


if __name__ == '__main__':
    unittest.main()
