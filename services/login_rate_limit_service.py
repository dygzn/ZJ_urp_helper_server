"""主动教务登录的温和限流；状态独立于业务库，同机进程共享。"""
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import ipaddress
import json
import logging
import math
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import uuid

from flask import current_app, jsonify, request
from urp.login import LOGIN_CREDENTIALS_ERROR

_logger = logging.getLogger(__name__)
_warning_lock = threading.Lock()
_last_warning = None


def _warn_unavailable():
    global _last_warning
    with _warning_lock:
        now = time.monotonic()
        if _last_warning is None or now - _last_warning >= 60:
            _last_warning = now
            _logger.warning('登录限流存储不可用，本次放行；请检查运行目录权限和存储状态')


@dataclass(frozen=True)
class LoginAttempt:
    limiter: object = None
    key: str = ''
    generation: str = ''
    retry_after: int = 0

    def finish(self, success, message):
        if self.limiter is not None and not self.retry_after:
            self.limiter.finish(self, success, message == LOGIN_CREDENTIALS_ERROR)


class LoginRateLimiter:
    def __init__(self, path, *, attempts=12, window=60, failures=8,
                 failure_window=600, cooldown=30, clock=None):
        self.path = Path(path)
        self.attempts = attempts
        self.window = window
        self.failures = failures
        self.failure_window = failure_window
        self.cooldown = cooldown
        self.clock = clock or time.time

    @contextmanager
    def _transaction(self):
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self.path), timeout=0.05)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute('''CREATE TABLE IF NOT EXISTS login_limits (
                key TEXT PRIMARY KEY, attempts TEXT NOT NULL, failures TEXT NOT NULL,
                blocked_until REAL NOT NULL, generation TEXT NOT NULL,
                updated_at REAL NOT NULL, expires_at REAL NOT NULL
            )''')
            conn.execute('CREATE INDEX IF NOT EXISTS login_limits_expiry ON login_limits(expires_at)')
            conn.execute('BEGIN IMMEDIATE')
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _read(self, conn, key, now):
        row = conn.execute('SELECT * FROM login_limits WHERE key=?', (key,)).fetchone()
        if not row or row['expires_at'] <= now or row['updated_at'] > now:
            return {'attempts': [], 'failures': [], 'blocked_until': 0,
                    'generation': uuid.uuid4().hex}
        return {
            'attempts': [at for at in json.loads(row['attempts']) if now - self.window < at <= now],
            'failures': [at for at in json.loads(row['failures']) if now - self.failure_window < at <= now],
            'blocked_until': row['blocked_until'], 'generation': row['generation'],
        }

    def _save(self, conn, key, state, now):
        conn.execute('''INSERT OR REPLACE INTO login_limits
            (key, attempts, failures, blocked_until, generation, updated_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)''', (
                key, json.dumps(state['attempts']), json.dumps(state['failures']),
                state['blocked_until'], state['generation'], now,
                now + max(self.window, self.failure_window, self.cooldown),
            ))

    def begin(self, source, username):
        key = hashlib.sha256(json.dumps([source, username], ensure_ascii=False).encode()).hexdigest()
        try:
            with self._transaction() as conn:
                now = self.clock()
                conn.execute('DELETE FROM login_limits WHERE expires_at<=?', (now,))
                state = self._read(conn, key, now)
                wait = state['blocked_until'] - now
                if len(state['attempts']) >= self.attempts:
                    wait = max(wait, state['attempts'][0] + self.window - now)
                if wait > 0:
                    # 拒绝不增加次数、不延长冷却，也不刷新记录过期时间。
                    return LoginAttempt(retry_after=max(1, math.ceil(wait)))
                state['attempts'].append(now)
                self._save(conn, key, state, now)
                return LoginAttempt(self, key, state['generation'])
        except (OSError, sqlite3.Error, ValueError, TypeError, KeyError):
            _warn_unavailable()
            return LoginAttempt()

    def finish(self, attempt, success, invalid_credentials):
        if not success and not invalid_credentials:
            return
        try:
            with self._transaction() as conn:
                now = self.clock()
                state = self._read(conn, attempt.key, now)
                if state['generation'] != attempt.generation:
                    # 成功登录或记录过期后，先前在途的失败不得恢复旧惩罚。
                    return
                if success:
                    state.update(failures=[], blocked_until=0, generation=uuid.uuid4().hex)
                else:
                    state['failures'] = (state['failures'] + [now])[-self.failures:]
                    if len(state['failures']) >= self.failures:
                        state['blocked_until'] = now + self.cooldown
                self._save(conn, attempt.key, state, now)
        except (OSError, sqlite3.Error, ValueError, TypeError, KeyError):
            _warn_unavailable()


def _address(value):
    address = ipaddress.ip_address(value.strip())
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        return address.ipv4_mapped
    return address


def client_source(trusted_proxies):
    """从直接对端开始剥离可信代理；不信任公网请求自报的转发头。"""
    try:
        peer = _address(request.remote_addr or '')
    except ValueError:
        return None  # 无法确定来源时不把所有用户归入一个共享桶。
    forwarded = request.headers.get('X-Forwarded-For', '')
    if len(forwarded) > 4096:
        return str(peer)
    for value in reversed(forwarded.split(',')):
        if not any(peer in network for network in trusted_proxies):
            break
        try:
            peer = _address(value)
        except ValueError:
            break
    return str(peer)


def _default_path():
    namespace = hashlib.sha256(str(Path(__file__).resolve().parents[1]).encode()).hexdigest()[:16]
    directory = Path('/dev/shm') if Path('/dev/shm').is_dir() else Path(tempfile.gettempdir())
    owner = str(os.getuid()) if hasattr(os, 'getuid') else 'local'
    return directory / f'urp-login-limits-{owner}-{namespace}' / 'limits.sqlite3'


def init_login_rate_limiting(app):
    """生产入口初始化；配置使用同名环境变量，独立 Flask 应用也可显式调用。"""
    app.config.setdefault('LOGIN_RATE_LIMIT_ENABLED',
                          os.environ.get('LOGIN_RATE_LIMIT_ENABLED', '1').lower() not in ('0', 'false', 'off'))
    app.config.setdefault('LOGIN_RATE_LIMIT_PATH', os.environ.get('LOGIN_RATE_LIMIT_PATH') or str(_default_path()))
    app.config.setdefault('LOGIN_RATE_LIMIT_TRUSTED_PROXIES',
                          os.environ.get('LOGIN_RATE_LIMIT_TRUSTED_PROXIES', '127.0.0.1/32,::1/128'))
    networks = tuple(ipaddress.ip_network(value.strip())
                     for value in app.config['LOGIN_RATE_LIMIT_TRUSTED_PROXIES'].split(',') if value.strip())
    settings = {}
    for name, default, argument in (
        ('ATTEMPTS', 12, 'attempts'), ('WINDOW', 60, 'window'),
        ('FAILURES', 8, 'failures'), ('FAILURE_WINDOW', 600, 'failure_window'),
        ('COOLDOWN', 30, 'cooldown'),
    ):
        key = 'LOGIN_RATE_LIMIT_' + name
        app.config.setdefault(key, int(os.environ.get(key, default)))
        value = int(app.config[key])
        if value < 1:
            raise ValueError(f'{key} 必须是正整数')
        settings[argument] = value
    app.extensions['login_rate_limit'] = (
        LoginRateLimiter(app.config['LOGIN_RATE_LIMIT_PATH'], **settings), networks,
    )


def begin_login_attempt(username):
    extension = current_app.extensions.get('login_rate_limit')
    if extension is None or not current_app.config.get('LOGIN_RATE_LIMIT_ENABLED', True):
        return LoginAttempt()
    limiter, proxies = extension
    source = client_source(proxies)
    return limiter.begin(source, username) if source else LoginAttempt()


def login_limit_response(attempt):
    response = jsonify(success=False, code='LOGIN_RATE_LIMITED', retry_after=attempt.retry_after,
                       message=f'登录尝试较频繁，请等待 {attempt.retry_after} 秒后重试。')
    response.status_code = 429
    response.headers['Retry-After'] = str(attempt.retry_after)
    response.headers['Cache-Control'] = 'no-store'
    return response
