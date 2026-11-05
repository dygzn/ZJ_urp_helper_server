"""北京时间今日活跃计数，同机 Gunicorn 进程共享，不访问业务数据库。"""
from contextlib import contextmanager
import hashlib
import logging
import os
from pathlib import Path
import struct
import tempfile
import threading
import time
from datetime import date, datetime, timedelta, timezone

from flask import request

from services.user_service import get_device_id


BEIJING_TIME = timezone(timedelta(hours=8))
SOURCES = ('web', 'miniprogram', 'app', 'unknown')


def request_source():
    if request.path.startswith('/api/wechat/'):
        return 'miniprogram'
    explicit = request.headers.get('X-Client-Type', '').lower()
    if explicit in SOURCES:
        return explicit
    agent = request.headers.get('User-Agent', '').lower()
    if 'dalvik/' in agent or 'cfnetwork/' in agent or 'okhttp/' in agent:
        return 'app'
    if 'mozilla/' in agent:
        return 'web'
    return 'unknown'


class DailyActivityTracker:
    def __init__(self):
        self._date = None
        self._accounts = set()
        self._sources = {source: set() for source in SOURCES}
        self._lock = threading.Lock()

    def _rollover(self, now):
        """调用方持锁；跨日立即释放前一天的去重集合。"""
        today = datetime.fromtimestamp(now, BEIJING_TIME).date().isoformat()
        if today != self._date:
            self._accounts.clear()
            for accounts in self._sources.values():
                accounts.clear()
            self._date = today

    def record(self, username, now=None, source='unknown'):
        if not username:
            return
        with self._lock:
            self._rollover(time.time() if now is None else now)
            self._accounts.add(username)
            self._sources[source if source in SOURCES else 'unknown'].add(username)

    def snapshot(self, now=None):
        with self._lock:
            self._rollover(time.time() if now is None else now)
            return {'date': self._date, 'active_users': len(self._accounts),
                    'sources': {key: len(value) for key, value in self._sources.items()}}


class SharedDailyActivityTracker:
    """只保存当天账号摘要；Linux 使用 /dev/shm，开发环境使用临时目录。

    每个账号和来源每天只追加一次。进程内命中直接返回，其他进程增量同步摘要；
    每次重新打开锁描述符，兼容 Gunicorn preload/fork。
    """

    _header = struct.Struct('!8sI')
    _magic = b'URPACT02'
    _old_magic = b'URPACT01'
    _digest_size = 33

    def __init__(self, path):
        self.path = os.fspath(path)
        self._date = None
        self._seen = set()
        self._offset = self._header.size

    @staticmethod
    def _day(now):
        return datetime.fromtimestamp(time.time() if now is None else now, BEIJING_TIME).date().toordinal()

    @contextmanager
    def _locked(self):
        import fcntl
        flags = os.O_CREAT | os.O_RDWR | getattr(os, 'O_CLOEXEC', 0) | getattr(os, 'O_NOFOLLOW', 0)
        descriptor = os.open(self.path, flags, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield descriptor
        finally:
            # 关闭本次独立描述符即释放锁，worker 退出也不会移除共享数据。
            os.close(descriptor)

    @staticmethod
    def _write(descriptor, data, offset):
        while data:
            written = os.pwrite(descriptor, data, offset)
            if not written:
                raise OSError('无法写入活跃统计共享状态')
            data = data[written:]
            offset += written

    def _prepare(self, descriptor, today):
        raw = os.pread(descriptor, self._header.size, 0)
        if len(raw) < self._header.size:
            stored_day = today
            self._write(descriptor, self._header.pack(self._magic, today), 0)
        else:
            magic, stored_day = self._header.unpack(raw)
            if magic not in (self._magic, self._old_magic) or not 1 <= stored_day <= date.max.toordinal():
                raise OSError('活跃统计共享状态格式无效')
            if magic == self._old_magic:
                old = os.pread(descriptor, max(0, os.fstat(descriptor).st_size - self._header.size), self._header.size)
                records = b''.join(bytes([3]) + old[i:i + 32] for i in range(0, len(old) - 31, 32))
                os.ftruncate(descriptor, self._header.size)
                self._write(descriptor, records, self._header.size)
                self._write(descriptor, self._header.pack(self._magic, stored_day), 0)
            if stored_day < today:
                # 只复用这一份状态，不生成逐日历史文件或请求明细。
                os.ftruncate(descriptor, self._header.size)
                self._write(descriptor, self._header.pack(self._magic, today), 0)
                stored_day = today
        size = os.fstat(descriptor).st_size
        complete_size = size - (size - self._header.size) % self._digest_size
        if size != complete_size:
            # worker 意外退出时，丢弃尚未完整写入的末条摘要。
            os.ftruncate(descriptor, complete_size)
        return stored_day, complete_size

    def _reset_cache(self, stored_day):
        self._seen.clear()
        self._offset = self._header.size
        self._date = stored_day

    def record(self, username, now=None, source='unknown'):
        if not username:
            return
        today = self._day(now)
        digest = bytes([SOURCES.index(source if source in SOURCES else 'unknown')]) + hashlib.sha256(username.encode('utf-8')).digest()
        if self._date == today and digest in self._seen:
            return
        with self._locked() as descriptor:
            today = self._day(now)
            stored_day, size = self._prepare(descriptor, today)
            # 零点前挂起的旧请求、时钟回拨都不能把当天状态清回前一天。
            if stored_day > today:
                return
            if self._date != stored_day or self._offset > size:
                self._reset_cache(stored_day)
            if self._offset < size:
                tail = os.pread(descriptor, size - self._offset, self._offset)
                if len(tail) != size - self._offset:
                    raise OSError('无法完整读取活跃统计共享状态')
                self._seen.update(tail[i:i + self._digest_size]
                                  for i in range(0, len(tail), self._digest_size))
                self._offset = size
            if digest not in self._seen:
                self._write(descriptor, digest, size)
                self._seen.add(digest)
                self._offset = size + self._digest_size

    def snapshot(self, now=None):
        with self._locked() as descriptor:
            stored_day, size = self._prepare(descriptor, self._day(now))
            if self._date != stored_day or self._offset > size:
                self._reset_cache(stored_day)
            if self._offset < size:
                tail = os.pread(descriptor, size - self._offset, self._offset)
                if len(tail) != size - self._offset:
                    raise OSError('无法完整读取活跃统计共享状态')
                self._seen.update(tail[i:i + self._digest_size] for i in range(0, len(tail), self._digest_size))
                self._offset = size
            return {'date': date.fromordinal(stored_day).isoformat(),
                    'active_users': len({entry[1:] for entry in self._seen}),
                    'sources': {source: sum(entry[0] == index for entry in self._seen)
                                for index, source in enumerate(SOURCES)}}


def _shared_activity_path():
    root = str(Path(__file__).resolve().parents[1])
    namespace = hashlib.sha256(root.encode('utf-8')).hexdigest()[:16]
    directory = '/dev/shm' if os.path.isdir('/dev/shm') else tempfile.gettempdir()
    return os.path.join(directory, f'urp-activity-{os.getuid()}-{namespace}.bin')


daily_activity = (SharedDailyActivityTracker(_shared_activity_path())
                  if os.name == 'posix' else DailyActivityTracker())
_logger = logging.getLogger(__name__)
_last_error_at = None


def _record_safely(tracker, username, source):
    global _last_error_at
    try:
        tracker.record(username, source=source)
    except OSError:
        # 统计不可用不能让用户登录/教务查询失败，也不循环刷写错误日志。
        now = time.monotonic()
        if _last_error_at is None or now - _last_error_at >= 60:
            _last_error_at = now
            _logger.warning('今日活跃统计共享状态不可用，请检查运行目录权限')


def record_daily_activity(username):
    _record_safely(daily_activity, username, request_source())


def get_today_activity():
    return daily_activity.snapshot()


def init_activity_tracking(app, tracker=None):
    tracker = tracker if tracker is not None else daily_activity

    @app.after_request
    def count_active_account(response):
        # 只消费业务代码已解析的身份，禁止为统计补查数据库或临时会话。
        if not request.path.startswith('/api/') or request.path.startswith('/api/admin/'):
            return response
        wechat_username = request.environ.get('urp.wechat_username')
        if wechat_username:
            _record_safely(tracker, wechat_username, 'miniprogram')
        device_id = get_device_id()
        cached = request.environ.get('urp.identity_cache', {}).get(device_id)
        if cached:
            user, temporary = cached
            if user and (not temporary or temporary['expires_at'] > time.time()):
                _record_safely(tracker, user['username'], request_source())
        return response
