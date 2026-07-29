# URP URL Session Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让管理员切换 URP URL 时，进行中的请求不漂移、每个用户在每个 URL 上复用独立教务会话，同时保持 VPN 全局单会话且只在确认失效后恢复一次。

**Architecture:** `services/config_service.py` 提供请求级 URL 快照和原子配置更新；新增 `urp/session_store.py` 集中管理 URL 指纹、用户 Cookie 隔离与旧文件迁移；`urp/login.py` 与 `urp/query.py` 只通过该存储访问用户 Cookie。`services/urp_service.py` 使用 URL 感知缓存和按用户/URL 加锁的自动登录，路由在请求或后台任务开始时捕获并显式传递同一个 URL。

**Tech Stack:** Python 3.12、Flask 3.1、requests 2.32、标准库 `unittest`、`threading`、`tempfile`

## Global Constraints

- 切换前已经开始的请求继续使用其进入请求时的 URL；切换后新请求使用新 URL。
- 用户教务 Cookie 按用户名和标准化 URL 隔离，文件名使用 URL 的 SHA-256 稳定摘要，不使用 URL 数组索引。
- 用户 Cookie 文件不得包含 `VSG_*`；`data/vpn_cookie.json` 仍是唯一 VPN Cookie 文件且只包含 `VSG_*`。
- URL 切换本身不得触发、清空或刷新 VPN 登录。
- VPN 仅在确认全局会话失效后进入 `_VPN_LOCK` 恢复；锁内二次检查后最多执行一次 `_vpn_password_auth()`。
- 同一用户、同一 URL 的并发教务自动登录只执行一次；不同 URL 互不阻塞。
- 旧 `user_data/{username}/cookie.json` 只作为首次迁移候选，验证成功后写入 URL 独立文件，暂不删除旧文件。
- 不自动回退旧 URL，不修改数据库结构和 API 响应协议，不新增第三方依赖。
- 不提交或覆盖现有的 `data/last_jiaowu_captcha.gif` 工作区修改。

---

## File Structure

- Create: `urp/session_store.py` — URL 规范化/指纹及用户 Cookie 的隔离、过滤、原子读写和旧文件候选加载。
- Create: `tests/test_urp_url_sessions.py` — Cookie 隔离、迁移、URL 感知缓存、并发登录和 VPN 不重复认证测试。
- Create: `tests/test_config_service.py` — 请求级 URL 快照及原子配置替换测试。
- Create: `tests/test_url_switch_routes.py` — 后台任务 URL 传递、评教登录保护和管理员 URL 校验测试。
- Modify: `services/config_service.py` — URL 快照、URL 校验、配置锁及原子更新。
- Modify: `urp/login.py` — 使用 URL 独立用户 Cookie，保持 VPN Cookie 只走全局文件，并让 `is_logined()` 只验证、不自行重复登录。
- Modify: `urp/query.py` — 按 URL 加载用户 Cookie，并在 VPN URL 上额外合并全局 VPN Cookie。
- Modify: `services/urp_service.py` — URL 感知登录缓存、缓存失效接口、按用户/URL 登录锁及后台任务显式 URL。
- Modify: `auth.py` — 所有登录装饰器捕获同一个 URL，并使用统一缓存失效接口。
- Modify: `routes/data_routes.py` — 后台更新传递 URL，实时评教改用会员+登录装饰器。
- Modify: `routes/admin_routes.py` — URL 列表和索引通过验证后在一次原子更新中保存。

---

### Task 1: 请求级 URL 快照与原子配置更新

**Files:**
- Create: `tests/test_config_service.py`
- Modify: `services/config_service.py:1-72`
- Modify: `routes/admin_routes.py:270-294`

**Interfaces:**
- Produces: `normalize_urp_url(url: str) -> str`
- Produces: `urp_url_fingerprint(url: str) -> str`
- Produces: `is_valid_urp_url(url: object) -> bool`
- Produces: `update_config(mutator: Callable[[dict], None]) -> dict`
- Produces: `get_current_urp_url() -> str`，在 Flask 请求上下文中首次调用后固定。
- Consumes: `constants.CONFIG_FILE`、Flask `g` 与 `has_request_context()`。

- [ ] **Step 1: 写 URL 快照和原子替换失败测试**

创建 `tests/test_config_service.py`：

```python
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from flask import Flask

import services.config_service as config_service


class UrlIdentityTests(unittest.TestCase):
    def test_normalization_and_fingerprint_ignore_trailing_slash(self):
        first = 'https://example.edu/urp'
        second = ' https://example.edu/urp/ '
        self.assertEqual(
            config_service.normalize_urp_url(first),
            'https://example.edu/urp/',
        )
        self.assertEqual(
            config_service.urp_url_fingerprint(first),
            config_service.urp_url_fingerprint(second),
        )

    def test_url_validation_accepts_only_http_urls_with_host(self):
        self.assertTrue(config_service.is_valid_urp_url('http://urp.test/a/'))
        self.assertTrue(config_service.is_valid_urp_url('https://urp.test/a/'))
        self.assertFalse(config_service.is_valid_urp_url(''))
        self.assertFalse(config_service.is_valid_urp_url('urp.test/a'))
        self.assertFalse(config_service.is_valid_urp_url('file:///tmp/config'))


class RequestUrlSnapshotTests(unittest.TestCase):
    def test_same_request_keeps_first_url_after_config_changes(self):
        app = Flask(__name__)
        configs = [
            {'urp_urls': ['http://url1.test/'], 'current_url_index': 0},
            {'urp_urls': ['http://url2.test/'], 'current_url_index': 0},
        ]
        with app.test_request_context('/api/grades'), patch.object(
            config_service,
            'get_config',
            side_effect=configs,
        ) as get_config:
            first = config_service.get_current_urp_url()
            second = config_service.get_current_urp_url()

        self.assertEqual(first, 'http://url1.test/')
        self.assertEqual(second, first)
        self.assertEqual(get_config.call_count, 1)

    def test_new_request_reads_new_url(self):
        app = Flask(__name__)
        with patch.object(
            config_service,
            'get_config',
            side_effect=[
                {'urp_urls': ['http://url1.test/'], 'current_url_index': 0},
                {'urp_urls': ['http://url2.test/'], 'current_url_index': 0},
            ],
        ):
            with app.test_request_context('/first'):
                first = config_service.get_current_urp_url()
            with app.test_request_context('/second'):
                second = config_service.get_current_urp_url()

        self.assertEqual(first, 'http://url1.test/')
        self.assertEqual(second, 'http://url2.test/')


class AtomicConfigTests(unittest.TestCase):
    def test_reader_sees_old_complete_json_until_replace(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'config.json'
            path.write_text('{"version": 1}', encoding='utf-8')
            half_written = threading.Event()
            allow_finish = threading.Event()

            def slow_dump(data, stream, **kwargs):
                stream.write('{"version":')
                stream.flush()
                half_written.set()
                self.assertTrue(allow_finish.wait(2))
                stream.write(str(data['version']))
                stream.write('}')

            with patch.object(config_service.json, 'dump', side_effect=slow_dump):
                writer = threading.Thread(
                    target=config_service.save_json_file,
                    args=(str(path), {'version': 2}),
                )
                writer.start()
                self.assertTrue(half_written.wait(2))
                observed = config_service.load_json_file(
                    str(path),
                    {'version': -1},
                )
                allow_finish.set()
                writer.join(2)

            self.assertFalse(writer.is_alive())
            self.assertEqual(observed, {'version': 1})
            self.assertEqual(
                json.loads(path.read_text(encoding='utf-8')),
                {'version': 2},
            )


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```powershell
D:\app\tool\python\python.exe -m unittest tests.test_config_service -v
```

Expected: `normalize_urp_url`、`urp_url_fingerprint`、`is_valid_urp_url` 尚不存在，快照测试第二次得到 URL2，原子写测试在半写入时得到默认值。

- [ ] **Step 3: 实现 URL 身份、请求快照和原子配置函数**

在 `services/config_service.py` 中加入以下核心实现，并让 `save_json_file()`、`get_current_urp_url()` 使用它们：

```python
import hashlib
import tempfile
import threading
from urllib.parse import urlparse

from flask import g, has_request_context

_CONFIG_LOCK = threading.RLock()
_REQUEST_URL_KEY = '_urp_url_snapshot'


def normalize_urp_url(url):
    value = str(url or '').strip()
    return value.rstrip('/') + '/' if value else ''


def urp_url_fingerprint(url):
    normalized = normalize_urp_url(url)
    return hashlib.sha256(normalized.encode('utf-8')).hexdigest()[:24]


def is_valid_urp_url(url):
    if not isinstance(url, str):
        return False
    parsed = urlparse(url.strip())
    return parsed.scheme in {'http', 'https'} and bool(parsed.netloc)


def save_json_file(filepath, data):
    target = os.path.abspath(filepath)
    directory = os.path.dirname(target)
    os.makedirs(directory, exist_ok=True)
    with _CONFIG_LOCK:
        descriptor, temporary = tempfile.mkstemp(
            prefix='.config-',
            suffix='.tmp',
            dir=directory,
            text=True,
        )
        try:
            with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
                json.dump(data, stream, ensure_ascii=False, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.remove(temporary)


def update_config(mutator):
    with _CONFIG_LOCK:
        config = get_config()
        mutator(config)
        save_config(config)
        return config


def get_current_urp_url():
    if has_request_context() and hasattr(g, _REQUEST_URL_KEY):
        return getattr(g, _REQUEST_URL_KEY)

    config = get_config()
    index = config.get('current_url_index', 0)
    urls = config.get('urp_urls', [])
    if urls and isinstance(index, int) and 0 <= index < len(urls):
        current = urls[index]
    else:
        current = config.get('urp_url', 'http://your-urp-url.com')
    current = normalize_urp_url(current)

    if has_request_context():
        setattr(g, _REQUEST_URL_KEY, current)
    return current
```

- [ ] **Step 4: 让管理员 URL 更新在同一把锁内验证并保存**

在 `routes/admin_routes.py` 导入 `is_valid_urp_url` 和 `update_config`，把 `admin_switch_url()` 的两个更新分支改为：

```python
if 'urls' in data:
    urls = data['urls']
    if (
        not isinstance(urls, list)
        or len(urls) < 2
        or not all(is_valid_urp_url(url) for url in urls)
    ):
        return jsonify({
            'success': False,
            'message': 'URL列表格式错误，需要至少2个有效HTTP/HTTPS地址',
        })

    normalized = [normalize_urp_url(url) for url in urls]

    def replace_urls(config):
        config['urp_urls'] = normalized
        if config.get('current_url_index', 0) >= len(normalized):
            config['current_url_index'] = 0

    config = update_config(replace_urls)
    return jsonify({
        'success': True,
        'message': 'URL列表已更新',
        'config': config,
    })

if 'url_index' in data:
    url_index = data['url_index']
    if not isinstance(url_index, int):
        return jsonify({'success': False, 'message': 'URL索引必须是整数'})

    error = {}

    def switch_index(config):
        urls = config.get('urp_urls', [])
        if not (0 <= url_index < len(urls)):
            error['message'] = 'URL索引超出范围'
            return
        if not is_valid_urp_url(urls[url_index]):
            error['message'] = '目标URL无效'
            return
        config['current_url_index'] = url_index

    config = update_config(switch_index)
    if error:
        return jsonify({'success': False, 'message': error['message']})
    return jsonify({
        'success': True,
        'message': f"已切换到URL: {config['urp_urls'][url_index]}",
        'config': config,
    })
```

- [ ] **Step 5: 运行测试并确认 GREEN**

Run:

```powershell
D:\app\tool\python\python.exe -m unittest tests.test_config_service -v
```

Expected: 全部通过，原子替换测试中并发读取只看到版本 1，写入结束后看到版本 2。

- [ ] **Step 6: 检查并提交**

```powershell
git diff --check
git add -- services/config_service.py routes/admin_routes.py tests/test_config_service.py
git commit -m "fix: snapshot URP URL and update config atomically"
```

---

### Task 2: 按 URL 隔离用户教务 Cookie

**Files:**
- Create: `urp/session_store.py`
- Create: `tests/test_urp_url_sessions.py`

**Interfaces:**
- Consumes: `normalize_urp_url()`、`urp_url_fingerprint()`。
- Produces: `user_cookie_path(account: str, url: str) -> Path`
- Produces: `load_user_cookies(account: str, url: str, allow_legacy: bool = True) -> tuple[dict, str]`，来源为 `scoped`、`legacy` 或 `missing`。
- Produces: `save_user_cookies(account: str, url: str, cookies: Mapping) -> Path`
- Produces: `delete_user_cookies(account: str, url: str) -> None`
- Produces: `user_cookie_exists(account: str, url: str) -> bool`

- [ ] **Step 1: 写 Cookie 隔离、过滤和迁移候选失败测试**

在 `tests/test_urp_url_sessions.py` 写入：

```python
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import requests

import services.config_service as config_service
import urp.session_store as session_store


URL1 = 'http://url1.test/urp/'
URL2 = 'https://url2.test/vpn/urp/'
VPN_URL = 'https://223.112.21.198:6443/7b68f983/'


class UserCookieStoreTests(unittest.TestCase):
    def test_same_user_uses_distinct_files_for_distinct_urls(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ):
            first = session_store.save_user_cookies(
                'student',
                URL1,
                {'JSESSIONID': 'url1'},
            )
            second = session_store.save_user_cookies(
                'student',
                URL2,
                {'JSESSIONID': 'url2'},
            )
            first_cookies, first_source = session_store.load_user_cookies(
                'student',
                URL1,
            )
            second_cookies, second_source = session_store.load_user_cookies(
                'student',
                URL2,
            )

        self.assertNotEqual(first, second)
        self.assertEqual(first_cookies, {'JSESSIONID': 'url1'})
        self.assertEqual(second_cookies, {'JSESSIONID': 'url2'})
        self.assertEqual((first_source, second_source), ('scoped', 'scoped'))

    def test_url_reordering_does_not_change_cookie_path(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ):
            first = session_store.user_cookie_path('student', URL1)
            second = session_store.user_cookie_path(
                'student',
                URL1.rstrip('/'),
            )

        self.assertEqual(first, second)

    def test_user_cookie_file_excludes_vpn_cookies(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ):
            path = session_store.save_user_cookies(
                'student',
                URL2,
                {
                    'JSESSIONID': 'student-session',
                    'route': 'backend',
                    'VSG_SESSIONID': 'vpn-session',
                },
            )
            payload = json.loads(path.read_text(encoding='utf-8'))

        self.assertEqual(
            payload,
            {'JSESSIONID': 'student-session', 'route': 'backend'},
        )

    def test_legacy_cookie_is_candidate_only_when_scoped_file_missing(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ):
            account_dir = Path(directory) / 'student'
            account_dir.mkdir(parents=True)
            (account_dir / 'cookie.json').write_text(
                json.dumps({
                    'JSESSIONID': 'legacy',
                    'VSG_SESSIONID': 'old-vpn',
                }),
                encoding='utf-8',
            )
            legacy, source = session_store.load_user_cookies('student', URL1)
            session_store.save_user_cookies(
                'student',
                URL1,
                {'JSESSIONID': 'scoped'},
            )
            scoped, scoped_source = session_store.load_user_cookies(
                'student',
                URL1,
            )

        self.assertEqual(legacy, {'JSESSIONID': 'legacy'})
        self.assertEqual(source, 'legacy')
        self.assertEqual(scoped, {'JSESSIONID': 'scoped'})
        self.assertEqual(scoped_source, 'scoped')


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```powershell
D:\app\tool\python\python.exe -m unittest tests.test_urp_url_sessions.UserCookieStoreTests -v
```

Expected: 导入 `urp.session_store` 失败。

- [ ] **Step 3: 实现集中式用户 Cookie 存储**

创建 `urp/session_store.py`：

```python
import json
import os
import tempfile
from pathlib import Path

from services.config_service import urp_url_fingerprint

USER_DATA_DIR = Path('user_data')
VPN_COOKIE_PREFIX = 'VSG_'


def _filter_user_cookies(cookies):
    if not isinstance(cookies, dict):
        return {}
    return {
        str(name): value
        for name, value in cookies.items()
        if not str(name).upper().startswith(VPN_COOKIE_PREFIX)
    }


def user_cookie_path(account, url):
    return (
        Path(USER_DATA_DIR)
        / str(account)
        / 'cookies'
        / f'{urp_url_fingerprint(url)}.json'
    )


def legacy_cookie_path(account):
    return Path(USER_DATA_DIR) / str(account) / 'cookie.json'


def _read_cookie_file(path):
    try:
        payload = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError, TypeError):
        return {}
    if isinstance(payload, dict) and isinstance(payload.get('cookies'), dict):
        payload = payload['cookies']
    return _filter_user_cookies(payload)


def load_user_cookies(account, url, allow_legacy=True):
    scoped = user_cookie_path(account, url)
    if scoped.exists():
        return _read_cookie_file(scoped), 'scoped'
    legacy = legacy_cookie_path(account)
    if allow_legacy and legacy.exists():
        return _read_cookie_file(legacy), 'legacy'
    return {}, 'missing'


def save_user_cookies(account, url, cookies):
    target = user_cookie_path(account, url)
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix='.cookie-',
        suffix='.tmp',
        dir=str(target.parent),
        text=True,
    )
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(
                _filter_user_cookies(cookies),
                stream,
                ensure_ascii=False,
                indent=4,
            )
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)
    return target


def delete_user_cookies(account, url):
    try:
        user_cookie_path(account, url).unlink()
    except FileNotFoundError:
        pass


def user_cookie_exists(account, url):
    return user_cookie_path(account, url).is_file()
```

- [ ] **Step 4: 运行测试并确认 GREEN**

Run:

```powershell
D:\app\tool\python\python.exe -m unittest tests.test_urp_url_sessions.UserCookieStoreTests -v
```

Expected: `Ran 4 tests`、`OK`。

- [ ] **Step 5: 检查并提交**

```powershell
git diff --check
git add -- urp/session_store.py tests/test_urp_url_sessions.py
git commit -m "feat: isolate user cookies by URP URL"
```

---

### Task 3: 登录与查询统一使用隔离 Cookie，VPN 仍只复用全局会话

**Files:**
- Modify: `tests/test_urp_url_sessions.py`
- Modify: `tests/test_vpn_session_recovery.py`
- Modify: `urp/login.py:1-541`
- Modify: `urp/query.py:1-55`

**Interfaces:**
- Consumes: Task 2 的 `load_user_cookies()` 与 `save_user_cookies()`。
- Produces: `URP_login.is_logined() -> bool` 只验证当前 URL 的现有教务会话，不在内部调用 `login()`。
- Produces: `URP_query(url, account)` 加载该 URL 的用户 Cookie；VPN URL 额外合并全局 `VSG_*`。
- Preserves: `recover_vpn_session()` 的 `_VPN_LOCK`、锁内二次检查和单次 VPN 密码认证。

- [ ] **Step 1: 添加登录、查询 Cookie 隔离失败测试**

在 `tests/test_urp_url_sessions.py` 追加：

```python
from unittest.mock import Mock

import urp.login as login_module
import urp.query as query_module


class CookieConsumerTests(unittest.TestCase):
    def test_login_saves_only_current_url_user_cookies(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ), patch.object(login_module.requests, 'session') as make_session:
            fake_session = Mock()
            fake_session.cookies = requests.cookies.RequestsCookieJar()
            fake_session.headers = {}
            fake_session.cookies.set('JSESSIONID', 'student')
            fake_session.cookies.set('VSG_SESSIONID', 'vpn')
            make_session.return_value = fake_session

            login = login_module.URP_login(URL2, 'student', 'password')
            login._save_cookies()
            cookies, source = session_store.load_user_cookies('student', URL2)

        self.assertEqual(cookies, {'JSESSIONID': 'student'})
        self.assertEqual(source, 'scoped')

    def test_query_loads_cookie_for_its_own_url(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ), patch.object(query_module.requests, 'session') as make_session:
            session_store.save_user_cookies(
                'student',
                URL1,
                {'JSESSIONID': 'url1'},
            )
            session_store.save_user_cookies(
                'student',
                URL2,
                {'JSESSIONID': 'url2'},
            )
            first_session = requests.Session()
            second_session = requests.Session()
            make_session.side_effect = [first_session, second_session]

            first = query_module.URP_query(URL1, 'student')
            second = query_module.URP_query(URL2, 'student')

        self.assertEqual(first.x.cookies.get('JSESSIONID'), 'url1')
        self.assertEqual(second.x.cookies.get('JSESSIONID'), 'url2')

    def test_valid_legacy_cookie_is_promoted_after_real_validation(self):
        response = Mock()
        response.text = 'student'
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ):
            account_dir = Path(directory) / 'student'
            account_dir.mkdir(parents=True)
            (account_dir / 'cookie.json').write_text(
                json.dumps({'JSESSIONID': 'legacy'}),
                encoding='utf-8',
            )
            login = login_module.URP_login(URL1, 'student', 'password')
            login.x.get = Mock(return_value=response)

            self.assertTrue(login.is_logined())
            promoted, source = session_store.load_user_cookies(
                'student',
                URL1,
                allow_legacy=False,
            )

        self.assertEqual(promoted, {'JSESSIONID': 'legacy'})
        self.assertEqual(source, 'scoped')

    def test_invalid_cookie_validation_does_not_call_login_recursively(self):
        response = Mock()
        response.text = '<form name="loginForm"></form>'
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ):
            session_store.save_user_cookies(
                'student',
                URL1,
                {'JSESSIONID': 'expired'},
            )
            login = login_module.URP_login(URL1, 'student', 'password')
            login.x.get = Mock(return_value=response)
            login.login = Mock()

            self.assertFalse(login.is_logined())
            login.login.assert_not_called()
```

- [ ] **Step 2: 添加 VPN 有效时不得密码重登测试**

在 `tests/test_vpn_session_recovery.py` 的 `VPNRecoveryTests` 追加：

```python
def test_ensure_vpn_session_reuses_global_login_without_password_auth(self):
    login = login_module.URP_login(
        'https://223.112.21.198:6443/7b68f983/',
        'student',
        'password',
    )
    with patch.object(
        login_module,
        'load_shared_vpn_cookies',
        return_value={'VSG_SESSIONID': 'alive'},
    ), patch.object(
        login_module,
        'vpn_session_alive',
        return_value=True,
    ), patch.object(
        login_module.URP_login,
        '_vpn_password_auth',
    ) as password_auth:
        success, _ = login._ensure_vpn_session()

    self.assertTrue(success)
    password_auth.assert_not_called()
```

- [ ] **Step 3: 运行新增测试并确认 RED**

Run:

```powershell
D:\app\tool\python\python.exe -m unittest tests.test_urp_url_sessions.CookieConsumerTests tests.test_vpn_session_recovery.VPNRecoveryTests.test_ensure_vpn_session_reuses_global_login_without_password_auth -v
```

Expected: 当前 `_save_cookies()` 和 `URP_query` 仍使用单个 `cookie.json`，旧 Cookie 不会提升，且 `is_logined()` 会自行调用 `login()`。

- [ ] **Step 4: 修改 `URP_login` 的用户 Cookie 生命周期**

在 `urp/login.py` 导入：

```python
from services.config_service import normalize_urp_url
from urp.session_store import (
    VPN_COOKIE_PREFIX,
    load_user_cookies,
    save_user_cookies,
)
```

把初始化和保存改为：

```python
def __init__(self, url, account, password):
    self.url = normalize_urp_url(url).rstrip('/')
    self.account = account
    self.password = password
    self.x = requests.session()
    self.x.verify = False
    self.x.headers.update({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    })


def _save_cookies(self):
    return save_user_cookies(
        self.account,
        self.url,
        self.x.cookies.get_dict(),
    )
```

删除 `_ensure_vpn_session()` 和 `_read_captcha()` 中仅因恢复 VPN 而调用的 `self._save_cookies()`。VPN 恢复只更新全局文件和当前内存 Session，不得生成或覆盖用户教务 Cookie。

将 `is_logined()` 改为纯验证逻辑：

```python
def is_logined(self):
    cookies, source = load_user_cookies(self.account, self.url)
    if not cookies:
        return False
    self.x.cookies.update(cookies)

    if self._requires_vpn_auth():
        success, _ = self._ensure_vpn_session()
        if not success:
            return False

    try:
        response = self.x.get(
            self._url('menu/top.jsp'),
            timeout=5,
            verify=False,
        )
    except Exception:
        return False

    if self.account not in response.text:
        return False
    if source == 'legacy':
        self._save_cookies()
    return True
```

`login()` 成功后继续先调用 `self._save_cookies()` 保存过滤后的用户 Cookie；VPN URL 再调用 `save_shared_vpn_cookies()`，后者仍只保存 `VSG_*`。

- [ ] **Step 5: 修改 `URP_query` 的 Cookie 装载**

在 `urp/query.py` 导入 `normalize_urp_url` 和 `load_user_cookies`，构造函数替换为：

```python
def __init__(self, url, account):
    self.url = normalize_urp_url(url)
    self.account = account
    self.x = requests.session()
    user_cookies, _ = load_user_cookies(
        self.account,
        self.url,
        allow_legacy=False,
    )
    self.x.cookies.update(user_cookies)
    if _is_vpn_url(self.url):
        shared_vpn_cookies = load_shared_vpn_cookies()
        if shared_vpn_cookies:
            self.x.cookies.update(shared_vpn_cookies)
        start_vpn_keepalive()
```

- [ ] **Step 6: 运行目标测试和 VPN 回归**

Run:

```powershell
D:\app\tool\python\python.exe -m unittest tests.test_urp_url_sessions.CookieConsumerTests tests.test_vpn_session_recovery -v
```

Expected: 新增 Cookie 消费者测试通过；原有 VPN Cookie 过滤、响应分类、恢复锁和单次重试测试全部通过。

- [ ] **Step 7: 检查并提交**

```powershell
git diff --check
git add -- urp/login.py urp/query.py tests/test_urp_url_sessions.py tests/test_vpn_session_recovery.py
git commit -m "fix: use URL-scoped URP cookies"
```

---

### Task 4: URL 感知登录缓存与单次并发教务登录

**Files:**
- Modify: `tests/test_urp_url_sessions.py`
- Modify: `services/urp_service.py:1-75`
- Modify: `auth.py:1-218`

**Interfaces:**
- Consumes: `user_cookie_exists()`、`delete_user_cookies()`、`urp_url_fingerprint()`。
- Produces: `invalidate_login_cache(username: str, url: str | None = None) -> None`
- Produces: `check_login_status(username, password, cookies=None, url=None) -> tuple[bool, dict]`
- Preserves: 15 分钟 TTL，但缓存键改为 `(username, url_fingerprint)`。

- [ ] **Step 1: 写 URL 感知缓存和并发单次登录失败测试**

在 `tests/test_urp_url_sessions.py` 追加：

```python
import services.urp_service as urp_service


class LoginStateTests(unittest.TestCase):
    def setUp(self):
        urp_service._login_cache.clear()
        urp_service._login_locks.clear()

    def tearDown(self):
        urp_service._login_cache.clear()
        urp_service._login_locks.clear()

    def test_url1_cache_does_not_skip_url2_validation(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ), patch.object(urp_service, 'URP_login') as login_class:
            session_store.save_user_cookies(
                'student',
                URL1,
                {'JSESSIONID': 'url1'},
            )
            session_store.save_user_cookies(
                'student',
                URL2,
                {'JSESSIONID': 'url2'},
            )
            first = login_class.return_value
            first.is_logined.return_value = True
            first.x.cookies.get_dict.return_value = {'JSESSIONID': 'url1'}

            self.assertTrue(
                urp_service.check_login_status(
                    'student',
                    'password',
                    url=URL1,
                )[0]
            )
            self.assertTrue(
                urp_service.check_login_status(
                    'student',
                    'password',
                    url=URL2,
                )[0]
            )

        self.assertEqual(login_class.call_count, 2)

    def test_concurrent_requests_perform_one_real_login(self):
        login_count = 0
        count_lock = threading.Lock()

        class FakeLogin:
            def __init__(self, url, account, password):
                self.url = url
                self.account = account
                self.x = requests.Session()

            def is_logined(self):
                return session_store.user_cookie_exists(
                    self.account,
                    self.url,
                )

            def login(self):
                nonlocal login_count
                with count_lock:
                    login_count += 1
                time.sleep(0.05)
                session_store.save_user_cookies(
                    self.account,
                    self.url,
                    {'JSESSIONID': 'fresh'},
                )
                return True, '登录成功', {'JSESSIONID': 'fresh'}

        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ), patch.object(urp_service, 'URP_login', FakeLogin):
            results = []
            threads = [
                threading.Thread(
                    target=lambda: results.append(
                        urp_service.check_login_status(
                            'student',
                            'password',
                            url=URL2,
                        )[0]
                    )
                )
                for _ in range(4)
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(2)

        self.assertEqual(results, [True, True, True, True])
        self.assertEqual(login_count, 1)

    def test_vpn_url_revalidates_instead_of_using_ttl_cache(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ), patch.object(urp_service, 'URP_login') as login_class:
            session_store.save_user_cookies(
                'student',
                VPN_URL,
                {'JSESSIONID': 'vpn-user'},
            )
            login = login_class.return_value
            login.is_logined.return_value = True
            login.x.cookies.get_dict.return_value = {
                'JSESSIONID': 'vpn-user',
            }

            for _ in range(2):
                self.assertTrue(
                    urp_service.check_login_status(
                        'student',
                        'password',
                        url=VPN_URL,
                    )[0]
                )

        self.assertEqual(login_class.call_count, 2)

    def test_invalidate_one_url_keeps_other_url_cache(self):
        first_key = (
            'student',
            config_service.urp_url_fingerprint(URL1),
        )
        second_key = (
            'student',
            config_service.urp_url_fingerprint(URL2),
        )
        urp_service._login_cache[first_key] = time.time()
        urp_service._login_cache[second_key] = time.time()

        urp_service.invalidate_login_cache('student', URL2)

        self.assertIn(first_key, urp_service._login_cache)
        self.assertNotIn(second_key, urp_service._login_cache)

    def test_failed_login_preserves_vpn_unavailable_message(self):
        class FailedLogin:
            def __init__(self, url, account, password):
                self.x = requests.Session()

            def is_logined(self):
                return False

            def login(self):
                return False, 'VPN 通道暂不可用，请稍后重试', None

        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ), patch.object(urp_service, 'URP_login', FailedLogin):
            success, details = urp_service.check_login_status(
                'student',
                'password',
                url=URL2,
            )

        self.assertFalse(success)
        self.assertEqual(
            details['message'],
            'VPN 通道暂不可用，请稍后重试',
        )
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```powershell
D:\app\tool\python\python.exe -m unittest tests.test_urp_url_sessions.LoginStateTests -v
```

Expected: `_login_locks`、模块级 `URP_login` 和 `invalidate_login_cache` 尚不存在，现有缓存会跨 URL 复用。

- [ ] **Step 3: 实现 URL 感知缓存、失效函数和登录锁**

在 `services/urp_service.py` 顶部统一导入依赖：

```python
import threading

from URP import URP_login
from urp.login import _is_vpn_url
from services.config_service import (
    get_config,
    get_current_urp_url,
    normalize_urp_url,
    urp_url_fingerprint,
)
from urp.session_store import (
    delete_user_cookies,
    user_cookie_exists,
)

_login_cache = {}
_login_locks = {}
_login_locks_guard = threading.Lock()
LOGIN_CACHE_TTL = 900


def _login_key(username, url):
    return username, urp_url_fingerprint(url)


def _get_login_lock(key):
    with _login_locks_guard:
        return _login_locks.setdefault(key, threading.Lock())


def invalidate_login_cache(username, url=None):
    if url is not None:
        _login_cache.pop(_login_key(username, url), None)
        return
    for key in list(_login_cache):
        if key[0] == username:
            _login_cache.pop(key, None)


def _has_fresh_login_cache(username, url, now):
    timestamp = _login_cache.get(_login_key(username, url))
    if _is_vpn_url(url):
        return False
    return (
        timestamp is not None
        and now - timestamp < LOGIN_CACHE_TTL
        and user_cookie_exists(username, url)
    )
```

把 `urp_login()` 增加可选 URL，以便调用者显式固定目标：

```python
def urp_login(username, password, url=None):
    target_url = normalize_urp_url(url or get_current_urp_url())
    try:
        urp = URP_login(target_url, username, password)
        return urp.login()
    except Exception as exc:
        return False, f'登录异常: {exc}', None
```

把 `check_login_status()` 替换为：

```python
def check_login_status(username, password, cookies=None, url=None):
    target_url = normalize_urp_url(url or get_current_urp_url())
    key = _login_key(username, target_url)
    now = time.time()
    if _has_fresh_login_cache(username, target_url, now):
        return True, {}

    with _get_login_lock(key):
        now = time.time()
        if _has_fresh_login_cache(username, target_url, now):
            return True, {}

        urp = URP_login(target_url, username, password)
        if urp.is_logined():
            _login_cache[key] = now
            return True, urp.x.cookies.get_dict()

        invalidate_login_cache(username, target_url)
        delete_user_cookies(username, target_url)
        try:
            success, message, new_cookies = urp.login()
        except Exception as exc:
            print(f'重新登录失败: {exc}')
            return False, {'message': f'登录异常: {exc}'}
        if not success:
            return False, {'message': message}

        _login_cache[key] = time.time()
        return True, new_cookies or urp.x.cookies.get_dict()
```

- [ ] **Step 4: 让三个登录装饰器固定 URL 并统一失效缓存**

`auth.py` 改为导入：

```python
from services.config_service import (
    get_admin_key,
    get_config,
    get_current_urp_url,
)
from services.urp_service import (
    check_login_status,
    invalidate_login_cache,
)
```

增加一个保持现有 JSON 协议的失败响应助手：

```python
def _login_failure_response(details):
    message = '登录已失效，请重新绑定'
    if isinstance(details, dict) and details.get('message'):
        message = details['message']
    return jsonify({'success': False, 'message': message})
```

三个装饰器在登录失败时都调用该助手，因此 VPN 恢复失败会显示“VPN 通道暂不可用”，普通无详情的失效仍显示原提示。

在 `require_login`、`require_grade_login`、`require_member_login` 的每个包装函数得到用户后立即捕获：

```python
urp_url = get_current_urp_url()
is_logged_in, login_details = check_login_status(
    username,
    password,
    {},
    url=urp_url,
)
if not is_logged_in:
    return _login_failure_response(login_details)
```

异常重试分支统一使用：

```python
invalidate_login_cache(username, urp_url)
is_logged_in, login_details = check_login_status(
    username,
    password,
    {},
    url=urp_url,
)
if not is_logged_in:
    return _login_failure_response(login_details)
```

不要再从 `auth.py` 导入或直接修改 `_login_cache`。会员规则保持原有返回内容和状态不变。

- [ ] **Step 5: 运行测试并确认 GREEN**

Run:

```powershell
D:\app\tool\python\python.exe -m unittest tests.test_urp_url_sessions.LoginStateTests -v
```

Expected: URL1 与 URL2 分别验证；4 个并发请求只有 1 次真实登录；指定 URL 的缓存失效不影响另一个 URL；VPN 恢复失败信息原样传给装饰器。

- [ ] **Step 6: 检查并提交**

```powershell
git diff --check
git add -- services/urp_service.py auth.py tests/test_urp_url_sessions.py
git commit -m "fix: serialize URP relogin per user and URL"
```

---

### Task 5: 让实时业务全程使用同一 URL 并补齐评教登录恢复

**Files:**
- Create: `tests/test_url_switch_routes.py`
- Modify: `services/urp_service.py:250-535`
- Modify: `routes/data_routes.py:1-315`
- Modify: `routes/admin_routes.py:270-294`

**Interfaces:**
- Consumes: Task 1 的请求 URL 快照、Task 4 的 `check_login_status(username, password, cookies=None, url=target_url)`。
- Produces: `check_and_auto_update(username, password, url=None) -> tuple[bool, str]`，后台任务显式使用传入 URL。
- Produces: 在线评教路由使用 `require_member_login('basic')`。
- Preserves: 本地课表/考试读取路由只校验绑定，不强制在线登录。

- [ ] **Step 1: 写后台 URL 固定和评教登录保护失败测试**

创建 `tests/test_url_switch_routes.py`：

```python
import unittest
from unittest.mock import Mock, patch

from flask import Flask

import routes.admin_routes as admin_routes
import routes.data_routes as data_routes


class BackgroundUrlTests(unittest.TestCase):
    def test_urgent_event_passes_request_url_to_background_update(self):
        app = Flask(__name__)
        fake_thread = Mock()
        with app.test_request_context('/api/urgent_event'), patch.object(
            data_routes,
            'get_current_urp_url',
            return_value='http://url1.test/',
        ), patch.object(
            data_routes.threading,
            'Thread',
            return_value=fake_thread,
        ) as thread_class, patch.object(
            data_routes,
            'get_urgent_event',
            return_value={'current': None, 'next': None},
        ):
            response = data_routes.api_urgent_event.__wrapped__(
                user={'username': 'student', 'password': 'password'},
            )

        self.assertTrue(response.get_json()['success'])
        self.assertEqual(
            thread_class.call_args.kwargs['args'],
            ('student', 'password', 'http://url1.test/'),
        )
        fake_thread.start.assert_called_once_with()


class EvaluationLoginTests(unittest.TestCase):
    def setUp(self):
        from app import app
        self.client = app.test_client()

    def test_unevaluated_courses_stops_before_query_when_login_fails(self):
        user = {'username': 'student', 'password': 'password'}
        with patch('auth.get_device_id', return_value='device'), patch(
            'auth.get_user_by_device',
            return_value=user,
        ), patch(
            'auth._check_member_access',
            return_value=(True, None),
        ), patch(
            'auth.check_login_status',
            return_value=(False, {}),
        ), patch.object(
            data_routes,
            'get_unevaluated_courses',
        ) as query:
            response = self.client.get('/api/unevaluated_courses')

        self.assertFalse(response.get_json()['success'])
        self.assertIn('登录已失效', response.get_json()['message'])
        query.assert_not_called()


class AdminUrlValidationTests(unittest.TestCase):
    def test_invalid_url_list_is_rejected_without_write(self):
        app = Flask(__name__)
        with app.test_request_context(
            '/api/admin/config/url',
            method='POST',
            json={'urls': ['http://valid.test/', 'not-a-url']},
        ), patch.object(admin_routes, 'update_config') as update:
            response = admin_routes.admin_switch_url.__wrapped__()

        self.assertFalse(response.get_json()['success'])
        update.assert_not_called()


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```powershell
D:\app\tool\python\python.exe -m unittest tests.test_url_switch_routes -v
```

Expected: 后台线程参数中没有 URL；评教接口未调用登录检查；管理员无效 URL 仍可能进入保存。

- [ ] **Step 3: 固定后台更新 URL 并统一实时查询入口**

把 `services/urp_service.py` 的后台更新签名改为：

```python
def check_and_auto_update(username, password, url=None):
    from datetime import date

    target_url = normalize_urp_url(url or get_current_urp_url())
    today = date.today().isoformat()
    with get_db() as conn:
        row = conn.execute(
            'SELECT last_auto_update FROM users WHERE username = ?',
            (username,),
        ).fetchone()
        if row is None:
            return False, '用户不存在'
        if row[0] == today:
            return False, '今日已更新'

        is_logged_in, _ = check_login_status(
            username,
            password,
            {},
            url=target_url,
        )
        if not is_logged_in:
            return False, '自动更新失败：教务登录不可用'

        try:
            from URP import URP_query
            query = URP_query(target_url, username)
            query.schedule_cx()
            query.exam_cx()
            conn.execute(
                'UPDATE users SET last_auto_update = ? WHERE username = ?',
                (today, username),
            )
            conn.commit()
            return True, '自动更新成功'
        except Exception as exc:
            return False, f'自动更新失败: {exc}'
```

`routes/data_routes.py` 导入 `require_member_login`，在 `api_urgent_event()` 创建线程前固定 URL：

```python
current_url = get_current_urp_url()
threading.Thread(
    target=check_and_auto_update,
    args=(user['username'], user['password'], current_url),
    daemon=True,
).start()
```

`api_update_schedule()` 与 `api_update_exams()` 删除装饰器之后的第二次 `check_login_status()`，只捕获一次 `current_url = get_current_urp_url()` 并传给 `URP_query`。因为装饰器和路由共享 `flask.g`，两者得到同一个快照。

只把两个评教路由的装饰器从 `require_member('basic')` 改为 `require_member_login('basic')`，函数体逐行保持现状：

```python
@data_bp.route('/api/unevaluated_courses', methods=['GET'])
@require_member_login('basic')


@data_bp.route('/api/evaluation', methods=['POST'])
@require_member_login('basic')
```

两个路由函数只改装饰器，其余现有响应逻辑逐行保留。将 `require_member_login()` 内的会员判断改为调用已有 `_check_member_access(username, level)`，确保测试与 `require_grade_login()` 使用同一规则。

- [ ] **Step 4: 完成管理员 URL 验证测试所需的原子更新接线**

确认 `routes/admin_routes.py` 已采用 Task 1 的 `is_valid_urp_url()`、`normalize_urp_url()` 和 `update_config()`。无效 URL 或非整数索引必须在变更 `current_url_index` 前返回，切换动作不得清理登录缓存、用户 Cookie 或 `data/vpn_cookie.json`。

- [ ] **Step 5: 运行路由测试并确认 GREEN**

Run:

```powershell
D:\app\tool\python\python.exe -m unittest tests.test_url_switch_routes -v
```

Expected: 后台任务收到 URL1 快照；评教登录失效时查询函数未被调用；无效 URL 不写配置。

- [ ] **Step 6: 检查并提交**

```powershell
git diff --check
git add -- services/urp_service.py routes/data_routes.py routes/admin_routes.py auth.py tests/test_url_switch_routes.py
git commit -m "fix: keep live URP requests on one URL"
```

---

### Task 6: 全量回归与切换场景验收

**Files:**
- Verify: `tests/test_config_service.py`
- Verify: `tests/test_urp_url_sessions.py`
- Verify: `tests/test_url_switch_routes.py`
- Verify: `tests/test_vpn_session_recovery.py`
- Verify: `tests/test_app_error_handling.py`
- Verify: `tests/test_schedule_weekend_visibility.py`
- Verify: `tests/test_schedule_weekend_visibility.js`

**Interfaces:**
- Consumes: 前五个任务的全部接口。
- Produces: 可证明 URL 切换不跨用用户会话、VPN 有效时不密码重登、VPN 失效时仍保持单次恢复的验证记录。

- [ ] **Step 1: 运行全部 Python 自动化测试**

Run:

```powershell
D:\app\tool\python\python.exe -m unittest discover -s tests -p "test_*.py" -v
D:\app\tool\python\python.exe -m unittest discover -s test -p "test_*.py" -v
```

Expected: 两条命令均以 `OK` 结束；`tests/test_vpn_session_recovery.py` 中原有 VPN 单次恢复测试继续通过。

- [ ] **Step 2: 运行课表前端回归**

Run:

```powershell
node tests/test_schedule_weekend_visibility.js
```

Expected: 输出 `3/3 tests passed`。

- [ ] **Step 3: 验证敏感 Cookie 边界**

Run:

```powershell
D:\app\tool\python\python.exe -m unittest tests.test_urp_url_sessions.UserCookieStoreTests.test_user_cookie_file_excludes_vpn_cookies tests.test_vpn_session_recovery.SharedCookieTests -v
```

Expected: 用户文件排除 `VSG_*`，共享 VPN 文件排除 `JSESSIONID`、`mapid` 和 `route`，全部通过。

- [ ] **Step 4: 验证 VPN 不反复认证与失效后的单次恢复**

Run:

```powershell
D:\app\tool\python\python.exe -m unittest tests.test_vpn_session_recovery.VPNRecoveryTests -v
```

Expected: 全局 VPN Cookie 有效时 `_vpn_password_auth()` 调用次数为 0；失效恢复场景只由持锁请求认证，其他请求复用新 Cookie。

- [ ] **Step 5: 检查工作区和提交边界**

Run:

```powershell
git diff --check
git status --short
git log -8 --oneline
```

Expected: 无空白错误；本任务代码和测试均已提交；用户已有的 `data/last_jiaowu_captcha.gif` 修改仍保留且未进入任何提交。

- [ ] **Step 6: 人工验收 URL1 → URL2 → URL1**

在 VPN 服务开放时使用一个测试账号执行：

1. URL1 查询成绩、更新课表和考试，确认功能正常。
2. 保持一个 URL1 请求进行中，在管理员后台切换 URL2；该请求应正常完成。
3. 新请求访问 URL2，首次缺少 URL2 教务 Cookie 时自动登录一次，随后各功能正常。
4. 连续刷新 URL2 的成绩/课表/考试/评教，不应重复进行 VPN 密码认证。
5. 切回 URL1，系统应加载原 URL1 Cookie；仍有效时不进行教务登录。
6. 使全局 VPN Cookie 失效后并发发起多个 URL2 请求，只出现一次 VPN 认证尝试；失败时返回“VPN 通道暂不可用”提示。

Expected: 两个 URL 的用户 Cookie 文件互不覆盖，切换不影响已开始请求，VPN 有效时零次重复密码认证。
