import base64
import json
import os
import random
import re
import threading
import time
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

VPN_HOST = '223.112.21.198'
VPN_PORT = 6443
VPN_BASE_URL = f'https://{VPN_HOST}:{VPN_PORT}'
VPN_LOGIN_PAGE = f'{VPN_BASE_URL}/vpn/theme/auth_home.html'
VPN_PORTAL_PAGE = f'{VPN_BASE_URL}/vpn/theme/portal_home.html'
VPN_AUTH_URL = f'{VPN_BASE_URL}/vpn/user/auth/password'
VPN_COOKIE_FILE = os.path.join('data', 'vpn_cookie.json')
VPN_KEEPALIVE_URL = f'{VPN_BASE_URL}/7b68f983/'
VPN_KEEPALIVE_INTERVAL = 300
VPN_AUTH_USERNAME = os.environ.get('VPN_AUTH_USERNAME')
VPN_AUTH_PASSWORD = os.environ.get('VPN_AUTH_PASSWORD')
VPN_AUTH_BODY = os.environ.get('VPN_AUTH_BODY')
MAX_CAPTCHA_ATTEMPTS = 8
SAVE_DEBUG_FILES = os.environ.get('URP_SAVE_DEBUG_FILES', '').lower() in {
    '1', 'true', 'yes', 'on'
}
DEBUG_FILE_THROTTLE_SECONDS = 60
_debug_file_times = {}
_debug_file_lock = threading.Lock()
VPN_COOKIE_PREFIX = 'VSG_'
_VPN_LOCK = threading.Lock()
_KEEPALIVE_STARTED = False


class VPNUnavailableError(RuntimeError):
    """Raised when VPN recovery cannot safely continue the request."""


def _filter_shared_vpn_cookies(cookies):
    if not isinstance(cookies, dict):
        return {}
    return {
        str(name): value
        for name, value in cookies.items()
        if str(name).upper().startswith(VPN_COOKIE_PREFIX)
    }


class LoginFormParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_login_form = False
        self.form_action = None
        self.inputs = {}
        self.title_parts = []
        self.in_title = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        tag = tag.lower()
        if tag == 'title':
            self.in_title = True
        if tag == 'form' and attrs.get('name') == 'loginForm':
            self.in_login_form = True
            self.form_action = attrs.get('action')
        if self.in_login_form and tag == 'input':
            name = attrs.get('name')
            if name:
                self.inputs[name] = attrs.get('value', '')

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag == 'title':
            self.in_title = False
        if tag == 'form' and self.in_login_form:
            self.in_login_form = False

    def handle_data(self, data):
        if self.in_title:
            self.title_parts.append(data.strip())

    @property
    def title(self):
        return ''.join(self.title_parts).strip()


def _is_vpn_url(url):
    parsed = urlparse(url)
    return parsed.hostname == VPN_HOST and parsed.port == VPN_PORT


def _normalize_captcha(value):
    return re.sub(r'[^0-9a-zA-Z]', '', value or '').strip()

def _load_vpn_credentials(default_username=None, default_password=None):
    username = VPN_AUTH_USERNAME
    password = VPN_AUTH_PASSWORD
    auth_body = VPN_AUTH_BODY
    try:
        with open(os.path.join('data', 'config.json'), 'r', encoding='utf-8') as f:
            config = json.load(f)
        username = username or config.get('vpn_username') or config.get('vpn_auth_username')
        password = password or config.get('vpn_password') or config.get('vpn_auth_password')
        auth_body = auth_body or config.get('vpn_auth_body')
    except Exception:
        pass
    return username or default_username, password or default_password, auth_body


def _parse_login_form(html):
    parser = LoginFormParser()
    parser.feed(html)
    if not parser.form_action:
        raise RuntimeError('Could not find loginForm action')
    return parser


def _page_title(html):
    parser = LoginFormParser()
    parser.feed(html)
    return parser.title


def _looks_logged_in(response):
    if is_vpn_failure_response(response) or _looks_like_urp_login_page(response):
        return False
    return _looks_like_urp_home_page(response)


def _extract_shared_cookies(payload):
    if isinstance(payload, dict) and isinstance(payload.get('cookies'), dict):
        return _filter_shared_vpn_cookies(payload['cookies'])
    return _filter_shared_vpn_cookies(payload)


def load_shared_vpn_cookies():
    if not os.path.exists(VPN_COOKIE_FILE):
        return {}
    try:
        with open(VPN_COOKIE_FILE, 'r', encoding='utf-8') as f:
            return _extract_shared_cookies(json.load(f))
    except Exception:
        return {}


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


def clear_shared_vpn_cookies():
    try:
        if os.path.exists(VPN_COOKIE_FILE):
            os.remove(VPN_COOKIE_FILE)
    except Exception:
        pass


def _looks_like_vpn_auth_page(resp):
    url = getattr(resp, 'url', '') or ''
    text = getattr(resp, 'text', '') or ''
    lowered = text.lower()
    return (
        '/vpn/theme/auth_home' in url
        or '/vpn/user/auth' in url
        or 'auth_home' in lowered
        or 'rmbpwd_browser' in lowered
        or 'vsg_verifycode_conf' in lowered
        or 'vsg_login' in lowered
    )


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
        or '\u767b\u5f55\u4f1a\u8bdd\u8d85\u65f6' in text
        or '\u7f51\u7ad9\u7ef4\u62a4' in text
        or '\u7f51\u7ad9\u6b63\u5728\u7ef4\u62a4' in text
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
        '\u4e2a\u4eba\u7ba1\u7406',
        '\u5b66\u751f\u4e2a\u4eba\u8bfe\u8868',
        '\u7f51\u4e0a\u9009\u8bfe',
        '\u4fe1\u606f\u67e5\u8be2',
        '\u6559\u5b66\u8bc4\u4ef7',
    ])
    return has_frameset or has_panel_signal


def is_vpn_failure_response(resp):
    return _looks_like_vpn_auth_page(resp) or _looks_like_vpn_error_page(resp)


def _html_hint(resp):
    url = getattr(resp, 'url', '') or ''
    content_type = resp.headers.get('Content-Type', '') if hasattr(resp, 'headers') else ''
    text = getattr(resp, 'text', '') or ''
    snippet = ' '.join(text.split())[:180]
    if _looks_like_vpn_auth_page(resp):
        page_type = 'VPN_AUTH_PAGE'
    elif 'loginAction.do' in url or 'validateCodeAction.do' in text:
        page_type = 'URP_LOGIN_PAGE'
    else:
        page_type = 'HTML_PAGE'
    return f'{page_type}; URL={url}; Content-Type={content_type}; Body={snippet}'


def _save_debug_file(filename, content):
    if not SAVE_DEBUG_FILES:
        return False

    now = time.monotonic()
    with _debug_file_lock:
        last_write = _debug_file_times.get(filename)
        if last_write is not None and now - last_write < DEBUG_FILE_THROTTLE_SECONDS:
            return False
        _debug_file_times[filename] = now

    try:
        os.makedirs('data', exist_ok=True)
        path = os.path.join('data', filename)
        if isinstance(content, bytes):
            Path(path).write_bytes(content)
        else:
            Path(path).write_text(content or '', encoding='utf-8')
        return True
    except Exception:
        return False


def _looks_like_image(resp):
    content_type = (resp.headers.get('Content-Type') or '').lower()
    content = resp.content or b''
    if content_type.startswith('image/'):
        return True
    return content.startswith((b'\xff\xd8\xff', b'\x89PNG', b'GIF87a', b'GIF89a', b'BM'))



def _ocr_dependency_diagnostics():
    checks = [
        ('numpy', 'numpy'),
        ('cv2', 'opencv-python-headless'),
        ('onnxruntime', 'onnxruntime'),
        ('PIL', 'Pillow'),
        ('ddddocr', 'ddddocr'),
    ]
    results = []
    for import_name, package_name in checks:
        try:
            module = __import__(import_name)
            version = getattr(module, '__version__', 'unknown')
            results.append(f'{package_name}=OK({version})')
        except Exception as exc:
            results.append(f'{package_name}=FAIL({type(exc).__name__}: {exc})')
    return '; '.join(results)
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


def _vpn_keepalive_loop():
    while True:
        time.sleep(VPN_KEEPALIVE_INTERVAL)
        cookies = load_shared_vpn_cookies()
        if not cookies:
            continue
        session = requests.session()
        session.verify = False
        session.cookies.update(cookies)
        if vpn_session_alive(session):
            save_shared_vpn_cookies(session.cookies.get_dict())
        else:
            clear_shared_vpn_cookies()


def start_vpn_keepalive():
    global _KEEPALIVE_STARTED
    if _KEEPALIVE_STARTED:
        return
    _KEEPALIVE_STARTED = True
    threading.Thread(target=_vpn_keepalive_loop, daemon=True).start()


def _vpn_unavailable_message(detail=''):
    message = (
        'VPN \u901a\u9053\u6682\u4e0d\u53ef\u7528\uff0c'
        '\u5df2\u81ea\u52a8\u91cd\u8fde\u4f46\u672a\u6210\u529f\uff0c'
        '\u8bf7\u7a0d\u540e\u91cd\u8bd5'
    )
    return f'{message}\uff1b{detail}' if detail else message


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
                _vpn_unavailable_message(
                    'VPN \u8ba4\u8bc1\u672a\u8fd4\u56de\u6709\u6548\u4f1a\u8bdd'
                )
            )
        session.cookies.update(fresh)
        if not vpn_session_alive(session, url):
            clear_shared_vpn_cookies()
            raise VPNUnavailableError(
                _vpn_unavailable_message(
                    'VPN \u91cd\u8fde\u540e\u4ecd\u65e0\u6cd5'
                    '\u8bbf\u95ee\u6559\u52a1\u7cfb\u7edf'
                )
            )
        return fresh


class URP_login:
    def __init__(self, url, account, password):
        self.url = url.rstrip('/')
        self.account = account
        self.password = password
        self.x = requests.session()
        self.x.verify = False
        self.x.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        })

    def _url(self, path=''):
        return f"{self.url}/{path.lstrip('/')}" if path else f'{self.url}/'

    def _save_cookies(self):
        cookie_dir = f'user_data/{self.account}'
        os.makedirs(cookie_dir, exist_ok=True)
        with open(f'{cookie_dir}/cookie.json', 'w', encoding='utf-8') as f:
            json.dump(self.x.cookies.get_dict(), f, ensure_ascii=False, indent=4)

    def _requires_vpn_auth(self):
        return _is_vpn_url(self.url)

    def _load_shared_vpn_cookies(self):
        cookies = load_shared_vpn_cookies()
        if cookies:
            self.x.cookies.update(cookies)
        return cookies

    def _set_vpn_bootstrap_cookies(self):
        self.x.cookies.set('VSG_VERIFYCODE_CONF', '0-0', domain=VPN_HOST, path='/')
        self.x.cookies.set('VSG_CLIENT_RUNNING', 'false', domain=VPN_HOST, path='/')
        self.x.cookies.set('VSG_LANGUAGE', 'zh_CN', domain=VPN_HOST, path='/')

    def _vpn_password_auth(self):
        vpn_username, vpn_password, auth_body = _load_vpn_credentials(self.account, self.password)
        if not auth_body:
            if not vpn_username or not vpn_password:
                return False, 'VPN auth failed; missing vpn_username/vpn_password'
            username = base64.b64encode(vpn_username.encode('utf-8')).decode('ascii')
            password = base64.b64encode(vpn_password.encode('utf-8')).decode('ascii')
            auth_body = f'username={username}&password={password}&encode=1&rmbpwd_browser=0'
        self._set_vpn_bootstrap_cookies()
        self.x.get(VPN_LOGIN_PAGE, timeout=20)
        resp = self.x.post(
            VPN_AUTH_URL,
            headers={
                'Accept': 'application/xml, text/xml, */*; q=0.01',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
                'Origin': VPN_BASE_URL,
                'Referer': VPN_LOGIN_PAGE,
            },
            data=auth_body,
            timeout=20,
        )
        resp.encoding = 'utf-8'
        _save_debug_file('last_vpn_auth_response.txt', resp.text)
        if resp.status_code != 200 or '0x00000000' not in resp.text:
            return False, f'VPN auth failed; status={resp.status_code}; {_html_hint(resp)}'
        portal = self.x.get(VPN_PORTAL_PAGE, timeout=20)
        _save_debug_file('last_vpn_portal_response.html', portal.text)
        save_shared_vpn_cookies(self.x.cookies.get_dict())
        start_vpn_keepalive()
        return True, 'VPN auth success'

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

    def _get_login_page(self):
        headers = {'Referer': VPN_PORTAL_PAGE} if self._requires_vpn_auth() else {}
        resp = self.x.get(self._url(), headers=headers, timeout=20)
        resp.encoding = 'gbk'
        _save_debug_file('last_jiaowu_login.html', resp.text)
        if is_vpn_failure_response(resp):
            raise VPNUnavailableError(
                _vpn_unavailable_message(_html_hint(resp))
            )
        return resp.url, _parse_login_form(resp.text)

    def _read_captcha(self, ocr, allow_vpn_retry=True):
        resp = self.x.get(
            self._url('validateCodeAction.do'),
            params={'random': str(random.random())},
            headers={'Referer': self._url()},
            timeout=20,
        )
        if not _looks_like_image(resp):
            _save_debug_file('last_vpn_captcha_response.html', resp.text)
            if self._requires_vpn_auth() and allow_vpn_retry:
                recover_vpn_session(self.x, self._url())
                self._save_cookies()
                return self._read_captcha(ocr, allow_vpn_retry=False)
            raise RuntimeError(f'captcha response was not an image; status={resp.status_code}; {_html_hint(resp)}')
        _save_debug_file('last_jiaowu_captcha.gif', resp.content)
        return _normalize_captcha(ocr.classification(resp.content))

    def _submit_login(self, form_url, parser, captcha_text):
        login_url = urljoin(form_url, parser.form_action)
        data = dict(parser.inputs)
        data.update({
            'zjh': self.account,
            'mm': self.password,
            'v_yzm': captcha_text,
        })
        resp = self.x.post(
            login_url,
            data=data,
            headers={
                'Origin': VPN_BASE_URL if self._requires_vpn_auth() else self.url,
                'Referer': form_url,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            allow_redirects=True,
            timeout=30,
        )
        resp.encoding = 'gbk'
        _save_debug_file('last_jiaowu_after_login.html', resp.text)
        return resp

    def login(self):
        success, message = self._ensure_vpn_session()
        if not success:
            return False, message, None

        try:
            import ddddocr
            form_url, parser = self._get_login_page()
            ocr = ddddocr.DdddOcr(show_ad=False)
            last_response = None
            for _ in range(MAX_CAPTCHA_ATTEMPTS):
                captcha_text = self._read_captcha(ocr)
                if not captcha_text:
                    continue
                last_response = self._submit_login(form_url, parser, captcha_text)
                if _looks_logged_in(last_response):
                    self._save_cookies()
                    if self._requires_vpn_auth():
                        save_shared_vpn_cookies(self.x.cookies.get_dict())
                    return True, '登录成功', self.x.cookies.get_dict()
                form_url, parser = self._get_login_page()
                time.sleep(0.5)
            if last_response is not None:
                return False, f'登录失败，最后页面: {_html_hint(last_response)}', None
            return False, '登录失败，验证码识别为空', None
        except Exception as e:
            error = str(e)
            if any(key in error.lower() for key in ('numpy', 'ddddocr', 'onnxruntime', 'cv2', 'opencv', 'pil')):
                diagnostics = _ocr_dependency_diagnostics()
                return False, f'OCR依赖加载失败: {error}; 依赖检测: {diagnostics}; 请在服务器重装 OCR 依赖后重启服务', None
            return False, f'登录异常: {error}', None

    def is_logined(self):
        check_url = self._url('menu/top.jsp')
        cookie_file = f'user_data/{self.account}/cookie.json'
        if not os.path.exists(cookie_file):
            return False
        try:
            with open(cookie_file, 'r', encoding='utf-8') as f:
                urp_cookie = json.load(f)
            self.x.cookies.update(urp_cookie)
            if self._requires_vpn_auth():
                shared_vpn_cookies = self._load_shared_vpn_cookies()
                start_vpn_keepalive()
                if not shared_vpn_cookies or not vpn_session_alive(self.x, self._url()):
                    success, _, _ = self.login()
                    return success
        except Exception:
            success, _, _ = self.login()
            return success
        try:
            r = self.x.get(check_url, timeout=5, verify=False).text
        except Exception:
            success, _, _ = self.login()
            return success
        if self.account in r:
            return True
        success, _, _ = self.login()
        return success
