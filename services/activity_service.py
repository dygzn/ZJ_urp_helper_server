"""北京时间今日活跃账号去重计数，仅保存在当前进程内存中。"""
import threading
import time
from datetime import datetime, timedelta, timezone

from flask import request

from services.user_service import get_device_id


BEIJING_TIME = timezone(timedelta(hours=8))


class DailyActivityTracker:
    def __init__(self):
        self._date = None
        self._accounts = set()
        self._lock = threading.Lock()

    def _rollover(self, now):
        """调用方持锁；跨日立即释放前一天的去重集合。"""
        today = datetime.fromtimestamp(now, BEIJING_TIME).date().isoformat()
        if today != self._date:
            self._accounts.clear()
            self._date = today

    def record(self, username, now=None):
        if not username:
            return
        with self._lock:
            self._rollover(time.time() if now is None else now)
            self._accounts.add(username)

    def snapshot(self, now=None):
        with self._lock:
            self._rollover(time.time() if now is None else now)
            return {'date': self._date, 'active_users': len(self._accounts)}


daily_activity = DailyActivityTracker()


def get_today_activity():
    return daily_activity.snapshot()


def init_activity_tracking(app, tracker=None):
    tracker = tracker if tracker is not None else daily_activity

    @app.after_request
    def count_active_account(response):
        # 只消费业务代码已解析的身份，禁止为统计补查数据库或临时会话。
        if not request.path.startswith('/api/') or request.path.startswith('/api/admin/'):
            return response
        device_id = get_device_id()
        cached = request.environ.get('urp.identity_cache', {}).get(device_id)
        if cached:
            user, temporary = cached
            if user and (not temporary or temporary['expires_at'] > time.time()):
                tracker.record(user['username'])
        return response
