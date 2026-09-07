"""进程内在线用户状态跟踪。

在线状态只保留最近一段时间的访问记录，不写入数据库，避免在线监控
本身产生磁盘 I/O。
"""
import threading
import time
from datetime import datetime


ONLINE_TTL_SECONDS = 5 * 60


class OnlineUserTracker:
    """按设备记录最近活跃时间，并提供过期清理后的在线快照。"""

    def __init__(self, ttl_seconds=ONLINE_TTL_SECONDS):
        self.ttl_seconds = ttl_seconds
        self._users = {}
        self._lock = threading.Lock()

    def touch(self, device_id, username='', endpoint='', now=None):
        if not device_id:
            return

        observed_at = time.time() if now is None else float(now)
        with self._lock:
            self._users[device_id] = {
                'device_id': device_id,
                'username': username or '未绑定',
                'last_seen': observed_at,
                'last_active': datetime.fromtimestamp(observed_at).strftime(
                    '%Y-%m-%d %H:%M:%S'
                ),
                'last_endpoint': endpoint or '',
            }

    def snapshot(self, now=None):
        observed_at = time.time() if now is None else float(now)
        cutoff = observed_at - self.ttl_seconds

        with self._lock:
            expired = [
                device_id
                for device_id, user in self._users.items()
                if user['last_seen'] < cutoff
            ]
            for device_id in expired:
                self._users.pop(device_id, None)

            users = sorted(
                self._users.values(),
                key=lambda user: user['last_seen'],
                reverse=True,
            )
            users = [
                {
                    'device_id': user['device_id'],
                    'username': user['username'],
                    'last_active': user['last_active'],
                    'last_endpoint': user['last_endpoint'],
                }
                for user in users
            ]

        return {
            'online_count': len(users),
            'users': users,
        }


online_tracker = OnlineUserTracker()


def touch_online_user(device_id, username='', endpoint='', now=None):
    online_tracker.touch(device_id, username, endpoint, now=now)


def get_online_snapshot(now=None):
    return online_tracker.snapshot(now=now)
