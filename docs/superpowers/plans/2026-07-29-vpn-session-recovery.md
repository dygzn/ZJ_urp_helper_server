# VPN Session Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 VPN 模式在会话失效时自动重新认证并重试一次，同时隔离全局 VPN Cookie 与各用户 URP Cookie。

**Architecture:** `urp/login.py` 负责 Cookie 边界、响应分类和带锁的 VPN 恢复；`urp/query.py` 通过统一请求包装器识别 VPN 错误响应、恢复共享 VPN 身份并重放一次原请求。测试使用标准库 `unittest`、真实 `requests.Response` 和内存传输替身，不访问真实 VPN。

**Tech Stack:** Python 3.12、requests 2.32、Flask 3.1、unittest

## Global Constraints

- VPN 恢复成功时用户无感，恢复失败时返回明确中文错误。
- 每次业务请求最多重新认证 VPN 一次、最多重试原请求一次。
- 全局共享文件只允许保存 `VSG_*` Cookie。
- `JSESSIONID`、`mapid` 和 `route` 必须保留在各用户自己的 Cookie 文件中。
- 非 VPN URL 不执行恢复或重试。
- 不增加第三方依赖，不修改数据库结构。
- 不覆盖 `urp/query.py` 中现有未提交的绩点解析修改。

---

### Task 1: Cookie 边界与响应分类

**Files:**
- Create: `tests/test_vpn_session_recovery.py`
- Modify: `urp/login.py:16-225`

**Interfaces:**
- Consumes: `requests.Response` 的 `status_code`、`url`、`text`、`content` 和 `headers`。
- Produces: `VPNUnavailableError`、`is_vpn_failure_response(response) -> bool`、`_looks_like_urp_login_page(response) -> bool`、`_looks_like_urp_home_page(response) -> bool`、仅含 `VSG_*` 的 `load_shared_vpn_cookies()` 与 `save_shared_vpn_cookies(cookies)`。

- [ ] **Step 1: 创建测试辅助对象和 Cookie 隔离失败测试**

```python
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import requests

import urp.login as login_module


def make_response(text, url='https://223.112.21.198:6443/7b68f983/', status=200):
    response = requests.Response()
    response.status_code = status
    response.url = url
    response._content = text.encode('utf-8')
    response.encoding = 'utf-8'
    response.headers['Content-Type'] = 'text/html; charset=utf-8'
    return response


class SequenceSession:
    def __init__(self, responses):
        self.responses = list(responses)
        self.cookies = requests.cookies.RequestsCookieJar()
        self.requests = []

    def get(self, url, **kwargs):
        self.requests.append(('GET', url, kwargs))
        return self.responses.pop(0)

    def request(self, method, url, **kwargs):
        self.requests.append((method.upper(), url, kwargs))
        return self.responses.pop(0)


class SharedCookieTests(unittest.TestCase):
    def test_loading_legacy_file_excludes_user_session_cookies(self):
        payload = {
            'cookies': {
                'VSG_SESSIONID': 'vpn',
                'VSG_LANGUAGE': 'zh_CN',
                'JSESSIONID': 'student',
                'mapid': 'mapping',
                'route': 'backend',
            }
        }
        with tempfile.TemporaryDirectory() as directory:
            cookie_file = Path(directory) / 'vpn_cookie.json'
            cookie_file.write_text(json.dumps(payload), encoding='utf-8')
            with patch.object(login_module, 'VPN_COOKIE_FILE', str(cookie_file)):
                cookies = login_module.load_shared_vpn_cookies()

        self.assertEqual(
            cookies,
            {'VSG_SESSIONID': 'vpn', 'VSG_LANGUAGE': 'zh_CN'},
        )

    def test_saving_shared_file_excludes_user_session_cookies(self):
        with tempfile.TemporaryDirectory() as directory:
            cookie_file = Path(directory) / 'vpn_cookie.json'
            with patch.object(login_module, 'VPN_COOKIE_FILE', str(cookie_file)):
                login_module.save_shared_vpn_cookies({
                    'VSG_SESSIONID': 'vpn',
                    'JSESSIONID': 'student',
                    'mapid': 'mapping',
                    'route': 'backend',
                })
                payload = json.loads(cookie_file.read_text(encoding='utf-8'))

        self.assertEqual(payload['cookies'], {'VSG_SESSIONID': 'vpn'})
```

- [ ] **Step 2: 运行 Cookie 测试并确认 RED**

Run:

```powershell
D:\app\tool\python\python.exe -m unittest tests.test_vpn_session_recovery.SharedCookieTests -v
```

Expected: 两个测试失败，实际结果仍包含 `JSESSIONID`、`mapid` 和 `route`。

- [ ] **Step 3: 实现共享 Cookie 过滤**

在 `urp/login.py` 的 VPN 常量后添加：

```python
VPN_COOKIE_PREFIX = 'VSG_'


class VPNUnavailableError(RuntimeError):
    """VPN 自动恢复失败，业务请求不能安全继续。"""


def _filter_shared_vpn_cookies(cookies):
    if not isinstance(cookies, dict):
        return {}
    return {
        str(name): value
        for name, value in cookies.items()
        if str(name).upper().startswith(VPN_COOKIE_PREFIX)
    }
```

把 `_extract_shared_cookies()` 替换为：

```python
def _extract_shared_cookies(payload):
    if isinstance(payload, dict) and isinstance(payload.get('cookies'), dict):
        return _filter_shared_vpn_cookies(payload['cookies'])
    return _filter_shared_vpn_cookies(payload)
```

把 `save_shared_vpn_cookies()` 中写入的 Cookie 改为：

```python
def save_shared_vpn_cookies(cookies):
    os.makedirs(os.path.dirname(VPN_COOKIE_FILE), exist_ok=True)
    shared_cookies = _filter_shared_vpn_cookies(cookies)
    with open(VPN_COOKIE_FILE, 'w', encoding='utf-8') as f:
        json.dump(
            {'cookies': shared_cookies, 'updated_at': time.time()},
            f,
            ensure_ascii=False,
            indent=4,
        )
```

- [ ] **Step 4: 运行 Cookie 测试并确认 GREEN**

Run:

```powershell
D:\app\tool\python\python.exe -m unittest tests.test_vpn_session_recovery.SharedCookieTests -v
```

Expected: `Ran 2 tests`、`OK`。

- [ ] **Step 5: 添加 HTTP 200 错误页和正常 URP 页面失败测试**

在同一测试文件追加：

```python
class ResponseClassificationTests(unittest.TestCase):
    def test_http_200_vpn_timeout_page_is_not_alive(self):
        response = make_response(
            '<script>var errcode="0x10000001";'
            'var errmsg="登录会话超时，请重新登录";</script>'
            '<script>sslvpn({pageName: "error"});</script>'
        )
        session = SequenceSession([response])

        self.assertFalse(login_module.vpn_session_alive(session))

    def test_http_200_maintenance_page_is_not_alive(self):
        response = make_response(
            '<html><title>网站维护</title>'
            '<body>网站正在维护中，现在无法正常访问</body></html>'
        )
        session = SequenceSession([response])

        self.assertFalse(login_module.vpn_session_alive(session))

    def test_urp_login_page_proves_vpn_channel_is_alive(self):
        response = make_response(
            '<form name="loginForm" action="/7b68f983/loginAction.do"></form>'
        )
        session = SequenceSession([response])

        self.assertTrue(login_module.vpn_session_alive(session))

    def test_urp_frameset_is_logged_in_and_alive(self):
        response = make_response(
            '<frameset><frame src="/7b68f983/menu/top.jsp">'
            '<frame src="/7b68f983/menu/mainFrame.jsp"></frameset>'
        )
        session = SequenceSession([response])

        self.assertTrue(login_module.vpn_session_alive(session))
        self.assertTrue(login_module._looks_logged_in(response))
```

- [ ] **Step 6: 运行分类测试并确认 RED**

Run:

```powershell
D:\app\tool\python\python.exe -m unittest tests.test_vpn_session_recovery.ResponseClassificationTests -v
```

Expected: 超时页和维护页测试失败，因为旧实现仅检查 HTTP 200；明确首页测试暴露旧 `_looks_logged_in()` 的过宽判断。

- [ ] **Step 7: 实现响应分类和严格登录判断**

在 `_looks_like_vpn_auth_page()` 后添加：

```python
def _response_text(resp):
    return getattr(resp, 'text', '') or ''


def _looks_like_vpn_error_page(resp):
    url = (getattr(resp, 'url', '') or '').lower()
    text = _response_text(resp)
    lowered = text.lower()
    return (
        '/vpn/user/common/error' in url
        or 'pagename: "error"' in lowered
        or "pagename: 'error'" in lowered
        or 'var errmsg' in lowered
        or '登录会话超时' in text
        or '网站维护' in text
        or '网站正在维护' in text
    )


def _looks_like_urp_login_page(resp):
    text = _response_text(resp)
    return bool(
        re.search(r'name\s*=\s*["\']loginForm["\']', text, re.I)
        and re.search(r'loginAction\.do', text, re.I)
    )


def _looks_like_urp_home_page(resp):
    text = _response_text(resp)
    has_frameset = 'menu/top.jsp' in text and 'menu/mainFrame.jsp' in text
    has_panel_signal = any(signal in text for signal in [
        '个人管理',
        '学生个人课表',
        '网上选课',
        '信息查询',
        '教学评价',
        '涓汉绠＄悊',
        '瀛︾敓涓汉璇捐〃',
        '缃戜笂閫夎',
        '淇℃伅鏌ヨ',
        '鏁欏璇勪环',
    ])
    return has_frameset or has_panel_signal


def is_vpn_failure_response(resp):
    return _looks_like_vpn_auth_page(resp) or _looks_like_vpn_error_page(resp)
```

把 `_looks_logged_in()` 替换为：

```python
def _looks_logged_in(response):
    if is_vpn_failure_response(response) or _looks_like_urp_login_page(response):
        return False
    return _looks_like_urp_home_page(response)
```

把 `vpn_session_alive()` 替换为：

```python
def vpn_session_alive(session, url=VPN_KEEPALIVE_URL):
    try:
        resp = session.get(
            url,
            headers={'Referer': VPN_PORTAL_PAGE},
            verify=False,
            timeout=8,
        )
    except Exception:
        return False
    if resp.status_code != 200 or is_vpn_failure_response(resp):
        return False
    return _looks_like_urp_login_page(resp) or _looks_like_urp_home_page(resp)
```

- [ ] **Step 8: 运行 Task 1 全部测试并确认 GREEN**

Run:

```powershell
D:\app\tool\python\python.exe -m unittest tests.test_vpn_session_recovery.SharedCookieTests tests.test_vpn_session_recovery.ResponseClassificationTests -v
```

Expected: `Ran 6 tests`、`OK`。

- [ ] **Step 9: 提交 Task 1**

```powershell
git add tests/test_vpn_session_recovery.py urp/login.py
git commit -m "fix: isolate VPN cookies and classify gateway pages"
```

### Task 2: 带锁的 VPN 自动恢复

**Files:**
- Modify: `tests/test_vpn_session_recovery.py`
- Modify: `urp/login.py:225-440`

**Interfaces:**
- Consumes: 当前 `requests.Session`、目标 URP URL、配置中的现有 VPN 凭据。
- Produces: `recover_vpn_session(session, url) -> dict[str, str]`；成功返回新 `VSG_*` Cookie，失败抛出 `VPNUnavailableError`。

- [ ] **Step 1: 添加恢复成功、失败和避免重复登录测试**

在测试文件追加：

```python
class VPNRecoveryTests(unittest.TestCase):
    def test_recovery_reauthenticates_and_returns_fresh_vpn_cookies(self):
        stale = make_response(
            '<script>var errmsg="登录会话超时";'
            'sslvpn({pageName: "error"});</script>'
        )
        login_page = make_response(
            '<form name="loginForm" action="/7b68f983/loginAction.do"></form>'
        )
        session = SequenceSession([stale, login_page])
        session.cookies.set('JSESSIONID', 'student-session')

        with patch.object(login_module, 'load_shared_vpn_cookies',
                          side_effect=[
                              {'VSG_SESSIONID': 'stale'},
                              {'VSG_SESSIONID': 'fresh'},
                          ]), patch.object(
                              login_module.URP_login,
                              '_vpn_password_auth',
                              return_value=(True, 'VPN auth success'),
                          ):
            cookies = login_module.recover_vpn_session(
                session,
                'https://223.112.21.198:6443/7b68f983/',
            )

        self.assertEqual(cookies, {'VSG_SESSIONID': 'fresh'})
        self.assertEqual(session.cookies.get('JSESSIONID'), 'student-session')

    def test_recovery_raises_clear_error_when_vpn_auth_fails(self):
        stale = make_response(
            '<script>var errmsg="登录会话超时";'
            'sslvpn({pageName: "error"});</script>'
        )
        session = SequenceSession([stale])

        with patch.object(
            login_module,
            'load_shared_vpn_cookies',
            return_value={'VSG_SESSIONID': 'stale'},
        ), patch.object(
            login_module.URP_login,
            '_vpn_password_auth',
            return_value=(False, 'VPN auth failed'),
        ):
            with self.assertRaisesRegex(
                login_module.VPNUnavailableError,
                '已自动重连但未成功',
            ):
                login_module.recover_vpn_session(
                    session,
                    'https://223.112.21.198:6443/7b68f983/',
                )

    def test_recovery_reuses_session_refreshed_by_another_request(self):
        login_page = make_response(
            '<form name="loginForm" action="/7b68f983/loginAction.do"></form>'
        )
        session = SequenceSession([login_page])

        with patch.object(
            login_module,
            'load_shared_vpn_cookies',
            return_value={'VSG_SESSIONID': 'fresh'},
        ), patch.object(
            login_module.URP_login,
            '_vpn_password_auth',
        ) as password_auth:
            cookies = login_module.recover_vpn_session(
                session,
                'https://223.112.21.198:6443/7b68f983/',
            )

        self.assertEqual(cookies, {'VSG_SESSIONID': 'fresh'})
        password_auth.assert_not_called()
```

- [ ] **Step 2: 运行恢复测试并确认 RED**

Run:

```powershell
D:\app\tool\python\python.exe -m unittest tests.test_vpn_session_recovery.VPNRecoveryTests -v
```

Expected: `AttributeError: module 'urp.login' has no attribute 'recover_vpn_session'`。

- [ ] **Step 3: 实现带锁恢复入口**

在 `start_vpn_keepalive()` 后、`URP_login` 类前添加：

```python
def _vpn_unavailable_message(detail=''):
    message = 'VPN 通道暂不可用，已自动重连但未成功，请稍后重试'
    return f'{message}；{detail}' if detail else message


def recover_vpn_session(session, url=VPN_KEEPALIVE_URL):
    with _VPN_LOCK:
        current = load_shared_vpn_cookies()
        if current:
            session.cookies.update(current)
            if vpn_session_alive(session, url):
                return current

        clear_shared_vpn_cookies()
        helper = URP_login(url, '', '')
        success, message = helper._vpn_password_auth()
        if not success:
            raise VPNUnavailableError(_vpn_unavailable_message(message))

        fresh = load_shared_vpn_cookies()
        if not fresh:
            raise VPNUnavailableError(
                _vpn_unavailable_message('VPN 认证未返回有效会话')
            )
        session.cookies.update(fresh)
        if not vpn_session_alive(session, url):
            clear_shared_vpn_cookies()
            raise VPNUnavailableError(
                _vpn_unavailable_message('VPN 重连后仍无法访问教务系统')
            )
        return fresh
```

将 `URP_login._ensure_vpn_session()` 替换为：

```python
def _ensure_vpn_session(self):
    if not self._requires_vpn_auth():
        return True, ''
    try:
        recover_vpn_session(self.x, self._url())
        self._save_cookies()
        start_vpn_keepalive()
        return True, 'VPN already online'
    except VPNUnavailableError as exc:
        return False, str(exc)
```

将 `_get_login_page()` 中认证页判断扩展为：

```python
if is_vpn_failure_response(resp):
    raise VPNUnavailableError(_vpn_unavailable_message(_html_hint(resp)))
```

将 `_read_captcha()` 签名改为 `def _read_captcha(self, ocr, allow_vpn_retry=True):`，并把 VPN 非图片分支替换为：

```python
if self._requires_vpn_auth() and allow_vpn_retry:
    recover_vpn_session(self.x, self._url())
    self._save_cookies()
    return self._read_captcha(ocr, allow_vpn_retry=False)
```

非图片且已经重试过时沿用现有 `RuntimeError`，保证恢复不会递归循环。

- [ ] **Step 4: 运行恢复测试并确认 GREEN**

Run:

```powershell
D:\app\tool\python\python.exe -m unittest tests.test_vpn_session_recovery.VPNRecoveryTests -v
```

Expected: `Ran 3 tests`、`OK`。

- [ ] **Step 5: 运行 Task 1 和 Task 2 回归**

Run:

```powershell
D:\app\tool\python\python.exe -m unittest tests.test_vpn_session_recovery -v
```

Expected: `Ran 9 tests`、`OK`。

- [ ] **Step 6: 提交 Task 2**

```powershell
git add tests/test_vpn_session_recovery.py urp/login.py
git commit -m "fix: recover expired VPN sessions"
```

### Task 3: 所有 URP 查询自动重试一次

**Files:**
- Modify: `tests/test_vpn_session_recovery.py`
- Modify: `urp/query.py:1-470`

**Interfaces:**
- Consumes: `recover_vpn_session(session, url)` 和 `is_vpn_failure_response(response)`。
- Produces: `URP_query._request(method, url, **kwargs) -> requests.Response`。

- [ ] **Step 1: 添加查询恢复、最终失败和非 VPN 测试**

在测试文件追加：

```python
import urp.query as query_module


class QueryRetryTests(unittest.TestCase):
    def make_query(self, url, responses):
        query = object.__new__(query_module.URP_query)
        query.url = url
        query.account = 'student'
        query.x = SequenceSession(responses)
        query.x.cookies.set('JSESSIONID', 'student-session')
        return query

    def test_vpn_error_recovers_and_retries_original_request_once(self):
        timeout = make_response(
            '<script>var errmsg="登录会话超时";'
            'sslvpn({pageName: "error"});</script>'
        )
        grades = make_response('<table id="user"><tr><td>高等数学</td></tr></table>')
        query = self.make_query(
            'https://223.112.21.198:6443/7b68f983/',
            [timeout, grades],
        )

        with patch.object(
            query_module,
            'recover_vpn_session',
            return_value={'VSG_SESSIONID': 'fresh'},
        ):
            response = query._request(
                'GET',
                query.url + 'gradeLnAllAction.do',
                timeout=10,
            )

        self.assertIn('高等数学', response.text)
        self.assertEqual(len(query.x.requests), 2)
        self.assertEqual(query.x.cookies.get('JSESSIONID'), 'student-session')
        self.assertEqual(query.x.cookies.get('VSG_SESSIONID'), 'fresh')

    def test_second_vpn_error_raises_instead_of_becoming_empty_data(self):
        first = make_response(
            '<script>var errmsg="登录会话超时";'
            'sslvpn({pageName: "error"});</script>'
        )
        second = make_response(
            '<html><title>网站维护</title><body>网站正在维护中</body></html>'
        )
        query = self.make_query(
            'https://223.112.21.198:6443/7b68f983/',
            [first, second],
        )

        with patch.object(
            query_module,
            'recover_vpn_session',
            return_value={'VSG_SESSIONID': 'fresh'},
        ):
            with self.assertRaisesRegex(
                login_module.VPNUnavailableError,
                '已自动重连但未成功',
            ):
                query._request(
                    'GET',
                    query.url + 'gradeLnAllAction.do',
                    timeout=10,
                )

        self.assertEqual(len(query.x.requests), 2)

    def test_non_vpn_request_does_not_recover_or_retry(self):
        response = make_response(
            '<script>var errmsg="登录会话超时";'
            'sslvpn({pageName: "error"});</script>',
            url='http://192.168.16.207:9001/',
        )
        query = self.make_query('http://192.168.16.207:9001/', [response])

        with patch.object(query_module, 'recover_vpn_session') as recover:
            returned = query._request('GET', query.url, timeout=10)

        self.assertIs(returned, response)
        self.assertEqual(len(query.x.requests), 1)
        recover.assert_not_called()
```

- [ ] **Step 2: 运行查询测试并确认 RED**

Run:

```powershell
D:\app\tool\python\python.exe -m unittest tests.test_vpn_session_recovery.QueryRetryTests -v
```

Expected: `AttributeError: 'URP_query' object has no attribute '_request'`。

- [ ] **Step 3: 实现统一请求包装器**

把 `urp/query.py` 的登录模块导入改为：

```python
from urp.login import (
    VPNUnavailableError,
    _is_vpn_url,
    is_vpn_failure_response,
    load_shared_vpn_cookies,
    recover_vpn_session,
    start_vpn_keepalive,
)
```

在 `URP_query.__init__()` 后添加：

```python
def _request(self, method, url, **kwargs):
    response = self.x.request(method, url, **kwargs)
    if not _is_vpn_url(self.url) or not is_vpn_failure_response(response):
        return response

    fresh = recover_vpn_session(self.x, self.url)
    self.x.cookies.update(fresh)
    retry = self.x.request(method, url, **kwargs)
    if is_vpn_failure_response(retry):
        raise VPNUnavailableError(
            'VPN 通道暂不可用，已自动重连但未成功，请稍后重试'
        )
    return retry
```

- [ ] **Step 4: 运行查询测试并确认 GREEN**

Run:

```powershell
D:\app\tool\python\python.exe -m unittest tests.test_vpn_session_recovery.QueryRetryTests -v
```

Expected: `Ran 3 tests`、`OK`。

- [ ] **Step 5: 将查询网络调用切换到包装器**

在 `urp/query.py` 中把 11 个网络调用逐项替换为以下代码，其他解析逻辑保持不变：

```python
return self._request(
    'GET', score_url, verify=False, timeout=10
).text

response = self._request(
    'GET',
    f'{self.url}bxqcjcxAction.do',
    params={'mytype': 'bxqcj', 'yzxh': self.account},
    verify=False,
    timeout=10,
)

response = self._request(
    'GET',
    f'{self.url}gradeLnAllAction.do',
    params={'type': 'ln', 'oper': 'bjg', 'yzxh': self.account},
    verify=False,
)

response = self._request(
    'GET',
    f'{self.url}gradeLnAllAction.do',
    params={'oper': 'queryXfjd'},
    verify=False,
)

response = self._request(
    'GET',
    f'{self.url}cjSearchAction.do',
    params={'oper': 'getKscjList', 'yzxh': self.account},
    verify=False,
)

response = self._request(
    'POST',
    f'{self.url}cjSearchAction.do',
    params={'oper': 'tjcx'},
    data={'jxzxjh': jxzxjh, 'ksbh': ksbh, 'yzxh': self.account},
    verify=False,
)

response = self._request(
    'GET',
    listWj_url,
    params={'oper': 'listWj', 'yzxh': self.account},
    headers=headers,
    verify=False,
)

wjshow_r = self._request(
    'POST',
    url,
    data={'wjbm': wjbm, 'bpr': bpr, 'pgnr': pgnr, 'oper': 'wjShow'},
    headers=headers_show,
    verify=False,
).text

r = self._request(
    'POST',
    wjpg_url,
    data=evaluation_data,
    headers=headers_submit,
    verify=False,
).text

response = self._request(
    'GET',
    f'{self.url}xkAction.do',
    headers=headers,
    params={'actionType': '6', 'yzxh': self.account},
    verify=False,
)

response = self._request(
    'GET',
    f'{self.url}ksApCxAction.do',
    params={'oper': 'getKsapXx', 'yzxh': self.account},
    headers=headers,
    verify=False,
)
```

替换后运行：

```powershell
rg -n "self\.x\.(get|post)" urp/query.py
```

Expected: 无输出。

- [ ] **Step 6: 运行全部 VPN 回归测试**

Run:

```powershell
D:\app\tool\python\python.exe -m unittest tests.test_vpn_session_recovery -v
```

Expected: `Ran 12 tests`、`OK`。

- [ ] **Step 7: 提交 Task 3**

```powershell
git add tests/test_vpn_session_recovery.py urp/query.py
git commit -m "fix: retry URP queries after VPN recovery"
```

### Task 4: 集成验证

**Files:**
- Verify: `urp/login.py`
- Verify: `urp/query.py`
- Verify: `tests/test_vpn_session_recovery.py`
- Verify: `app.py`

**Interfaces:**
- Consumes: 前三项任务的完整实现。
- Produces: 可导入、可测试、路由完整的 Flask 应用。

- [ ] **Step 1: 运行完整 unittest**

```powershell
D:\app\tool\python\python.exe -m unittest discover -s tests -p "test_*.py" -v
```

Expected: 12 个测试全部通过，0 failures，0 errors。

- [ ] **Step 2: 编译相关 Python 源码**

```powershell
D:\app\tool\python\python.exe -m py_compile app.py auth.py database.py URP.py urp/login.py urp/query.py services/urp_service.py routes/data_routes.py
```

Expected: 退出码 0，无输出。

- [ ] **Step 3: 验证 Flask 应用导入及关键路由**

```powershell
D:\app\tool\python\python.exe -c "import app; rules={r.rule for r in app.app.url_map.iter_rules()}; required={'/','/api/login','/api/grades','/api/schedule','/api/exams','/api/unevaluated_courses'}; missing=required-rules; print('routes', len(rules), 'missing', sorted(missing)); raise SystemExit(bool(missing))"
```

Expected: `missing []`，退出码 0。

- [ ] **Step 4: 检查格式与变更范围**

```powershell
git diff --check
git status --short
git diff -- urp/login.py urp/query.py tests/test_vpn_session_recovery.py
```

Expected: `git diff --check` 退出码 0；差异只包含 VPN 修复和已有的绩点解析改动，没有覆盖其他工作区文件。

- [ ] **Step 5: 执行回归测试的变异检查**

临时把 `is_vpn_failure_response()` 对 `_looks_like_vpn_error_page()` 的调用改为固定 `False`，运行分类和查询测试，确认至少一个测试失败；随后恢复该行并重新运行完整 unittest，确认全部通过。此步骤只验证测试能捕获核心回归，不提交临时变异。

- [ ] **Step 6: 最终提交（仅在仍有未提交的本任务文件时）**

```powershell
git add tests/test_vpn_session_recovery.py urp/login.py urp/query.py
git commit -m "test: verify VPN recovery integration"
```

如果 Task 1-3 的提交后没有本任务残留差异，则跳过该提交。
