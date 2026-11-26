import base64
import json
import logging
import os
import random
import re
import threading
import tempfile
import time
from html.parser import HTMLParser
from contextvars import ContextVar
from functools import wraps
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from services.credential_service import CredentialCipher
from services.config_service import normalize_urp_url
from urp.session_store import load_user_cookies, save_user_cookies
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
VPN_COOKIE_PREFIX = 'VSG_'
_VPN_LOCK = threading.Lock()
_KEEPALIVE_STARTED = False
_VPN_RECOVERY_GENERATION = 0
_VPN_LAST_RECOVERY_FAILURE = None
VPN_HEALTH_TTL = 30
VPN_FAILURE_COOLDOWN = 5
_VPN_HEALTH = {}
_VPN_FAILURES = {}


_LOGIN_DEADLINE = ContextVar('urp_login_deadline', default=None)


def _with_login_budget(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        existing = _LOGIN_DEADLINE.get()
        token = _LOGIN_DEADLINE.set(existing if existing is not None else time.monotonic() + 45)
        try:
            return function(*args, **kwargs)
        finally:
            _LOGIN_DEADLINE.reset(token)
    return wrapped


def _request_timeout(maximum):
    deadline = _LOGIN_DEADLINE.get()
    if deadline is None:
        return maximum
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise requests.Timeout('login time budget exhausted')
    return min(maximum, remaining)


class URPSessionExpiredError(requests.HTTPError):
    """上游明确返回教务登录页，允许调用者重新认证。"""


class VPNUnavailableError(RuntimeError):
    """Raised when VPN recovery cannot safely continue the request."""


class LoginPageUnavailableError(RuntimeError):
    """教务登录页不可用；异常消息只包含面向用户的提示。"""


class CaptchaUnavailableError(RuntimeError):
    """验证码接口没有返回可识别的图片。"""


LOGIN_CREDENTIALS_ERROR = '学号或密码不正确，请核对后重试。'
_LOGIN_FAILURE_MESSAGES = {
    'credentials': LOGIN_CREDENTIALS_ERROR,
    'captcha': '登录验证码校验未通过，请重试。',
    'locked': '教务账号暂时被限制登录，请到学校教务系统确认账号状态。',
    'maintenance': '学校教务系统正在维护，请稍后重试。',
    'unavailable': '学校教务系统暂不可用，请稍后重试。',
    'vpn': '教务连接暂不可用，请稍后重试。',
    'unknown': '教务登录失败，请稍后重试，或先到学校教务系统确认账号能否登录。',
}
_logger = logging.getLogger(__name__)


def _login_failure_reason(response):
    """只根据明确的错误区域或直接执行的 alert 识别原因，不回传上游原文。"""
    if response.status_code >= 400:
        return 'unavailable'

    soup = BeautifulSoup(response.text, 'html.parser')
    has_form = bool(soup.find('form'))
    for node in soup.find_all(True):
        if node.name is None:  # 祖先已被移除。
            continue
        style = re.sub(r'\s+', '', node.get('style', '').lower())
        hidden_style = re.search(
            r'(?:^|;)(?:display:none|visibility:(?:hidden|collapse))(?:!important)?(?:;|$)',
            style,
        )
        if (node.name in ('template', 'noscript') or node.has_attr('hidden')
                or node.get('aria-hidden', '').lower() == 'true' or hidden_style):
            node.decompose()
    messages = [node.get_text(' ', strip=True) for node in soup.select(
        '.errorTop, .error, .error-message, #error, #errorMsg, #errorMessage, '
        '[role="alert"], font[color="red"]'
    )]
    for script in soup.find_all('script'):
        script_type = script.get('type', '').strip().lower()
        if script.has_attr('src') or script_type not in (
            '', 'text/javascript', 'application/javascript',
            'text/ecmascript', 'application/ecmascript', 'module',
        ):
            continue
        # 登录页常含未执行的表单校验函数，不能据此认定密码或验证码错误。
        match = re.match(
            r'''\s*(?:<!--\s*)?(?:window\.)?alert\s*\(\s*(['"])(.*?)\1\s*\)''',
            script.get_text(), re.S,
        )
        if match:
            messages.append(match.group(2))
    for node in soup(['script', 'style', 'noscript']):
        node.decompose()
    # 独立错误页可能没有专用样式，正常登录表单的说明文字不作为错误依据。
    if not has_form:
        messages.append(soup.get_text(' ', strip=True))

    for message in messages:
        if re.search(r'(?:系统|网站).{0,8}(?:正在维护|维护中)|非开放时间', message):
            return 'maintenance'
        if re.search(r'(?:账号|帐号|账户|用户).{0,8}(?:锁定|冻结|停用|禁用|限制登录)', message):
            return 'locked'
        if re.search(r'(?:验证码|校验码).{0,10}(?:错误|不正确|不匹配|失效|过期)', message):
            return 'captcha'
        if re.search(
            r'(?:密码|用户名|学号|账号|帐号).{0,8}(?:错误|不正确|不存在)|'
            r'用户不存在|无此用户', message,
        ):
            return 'credentials'
    if is_vpn_failure_response(response):
        return 'vpn'
    return None


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
    if response.status_code >= 400:
        return False
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
    directory = os.path.dirname(VPN_COOKIE_FILE) or '.'
    os.makedirs(directory, exist_ok=True)
    shared_cookies = _filter_shared_vpn_cookies(cookies)
    descriptor, temporary_path = tempfile.mkstemp(
        prefix=f'.{os.path.basename(VPN_COOKIE_FILE)}.',
        suffix='.tmp',
        dir=directory,
        text=True,
    )
    try:
        stream = os.fdopen(descriptor, 'w', encoding='utf-8')
        descriptor = None
        with stream:
            json.dump(
                {'cookies': shared_cookies, 'updated_at': time.time()},
                stream,
                ensure_ascii=False,
                indent=4,
            )
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_path, VPN_COOKIE_FILE)
    except Exception:
        if descriptor is not None:
            os.close(descriptor)
        try:
            os.remove(temporary_path)
        except FileNotFoundError:
            pass
        raise


def clear_shared_vpn_cookies():
    _VPN_HEALTH.clear()
    try:
        if os.path.exists(VPN_COOKIE_FILE):
            os.remove(VPN_COOKIE_FILE)
    except Exception:
        pass


def _looks_like_vpn_auth_page(resp):
    url = str(getattr(resp, 'url', '') or '')
    text = _response_text(resp)
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
    content = getattr(resp, 'content', None)
    encoding = (getattr(resp, 'encoding', None) or '').strip().lower()
    if isinstance(content, (bytes, bytearray)) and encoding in ('', 'iso-8859-1', 'latin-1', 'latin1'):
        for candidate in ('utf-8', 'gb18030'):
            try:
                return bytes(content).decode(candidate)
            except UnicodeDecodeError:
                continue
    return getattr(resp, 'text', '') or ''


def _looks_like_vpn_error_page(resp):
    url = str(getattr(resp, 'url', '') or '').lower()
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
        re.search(r'(?:name|id)\s*=\s*["\']loginForm["\']', text, re.I)
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
    url = str(getattr(resp, 'url', '') or '')
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
            timeout=_request_timeout(8),
        )
    except Exception:
        return False
    if resp.status_code != 200 or is_vpn_failure_response(resp):
        return False
    return _looks_like_urp_login_page(resp) or _looks_like_urp_home_page(resp)


def _vpn_keepalive_once():
    with _VPN_LOCK:
        cookies = load_shared_vpn_cookies()
        if not cookies:
            return
        session = requests.session()
        session.verify = False
        session.cookies.update(cookies)
        if vpn_session_alive(session):
            save_shared_vpn_cookies(session.cookies.get_dict())
        else:
            clear_shared_vpn_cookies()


def _vpn_keepalive_loop():
    while True:
        time.sleep(VPN_KEEPALIVE_INTERVAL)
        _vpn_keepalive_once()


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


def _vpn_cookie_version(cookies):
    return tuple(sorted(_filter_shared_vpn_cookies(cookies).items()))


def _remember_vpn_health(key):
    # 限制失效版本及历史通道的数量；只有恢复锁内写入。
    if len(_VPN_HEALTH) >= 128:
        _VPN_HEALTH.clear()
    _VPN_HEALTH[key] = time.monotonic() + VPN_HEALTH_TTL


@_with_login_budget
def recover_vpn_session(session, url=VPN_KEEPALIVE_URL, *, force=False):
    """复用短期通道健康结论；明确 VPN 错误可强制淘汰当前版本。

    HTTP Session 始终属于调用方，仅 VSG_ Cookie 在账号之间共享。
    """
    global _VPN_RECOVERY_GENERATION, _VPN_LAST_RECOVERY_FAILURE
    channel = (os.path.abspath(VPN_COOKIE_FILE), normalize_urp_url(url))
    observed_generation = _VPN_RECOVERY_GENERATION
    failed_version = _vpn_cookie_version(session.cookies.get_dict()) if force else None

    def reuse(current):
        version = _vpn_cookie_version(current)
        key = (channel, version)
        # 若另一请求已经恢复到新版本，旧请求不再重复认证。
        stale_failure = force and failed_version == version and observed_generation == _VPN_RECOVERY_GENERATION
        if current and not stale_failure and _VPN_HEALTH.get(key, 0) > time.monotonic():
            session.cookies.update(current)
            return True
        return False

    current = load_shared_vpn_cookies()
    if reuse(current):
        return current
    with _VPN_LOCK:
        current = load_shared_vpn_cookies()
        if reuse(current):
            return current
        version = _vpn_cookie_version(current)
        failure = _VPN_FAILURES.get(channel)
        if failure and time.monotonic() < failure[0] and version in failure[1]:
            raise VPNUnavailableError(failure[2])
        if current:
            session.cookies.update(current)
            must_recover = force and failed_version == version and observed_generation == _VPN_RECOVERY_GENERATION
            if not must_recover and vpn_session_alive(session, url):
                _VPN_LAST_RECOVERY_FAILURE = None
                _VPN_FAILURES.pop(channel, None)
                _remember_vpn_health((channel, version))
                return current

        clear_shared_vpn_cookies()
        helper = URP_login(url, '', '')
        try:
            success, message = helper._vpn_password_auth()
            if not success:
                raise VPNUnavailableError(_vpn_unavailable_message(message))
            fresh = load_shared_vpn_cookies()
            if not fresh:
                raise VPNUnavailableError(_vpn_unavailable_message('VPN 认证未返回有效会话'))
            session.cookies.update(fresh)
            if not vpn_session_alive(session, url):
                clear_shared_vpn_cookies()
                raise VPNUnavailableError(_vpn_unavailable_message('VPN 重连后仍无法访问教务系统'))
        except Exception as exc:
            error = exc if isinstance(exc, VPNUnavailableError) else VPNUnavailableError(_vpn_unavailable_message(str(exc)))
            _VPN_LAST_RECOVERY_FAILURE = str(error)
            _VPN_RECOVERY_GENERATION += 1
            if len(_VPN_FAILURES) >= 128:
                _VPN_FAILURES.clear()
            # 清除文件后的空版本与本次失败版本共享冷却；新 cookie 可立即验证。
            _VPN_FAILURES[channel] = (time.monotonic() + VPN_FAILURE_COOLDOWN, (version, ()), str(error))
            raise error from (exc if error is not exc else None)
        _VPN_LAST_RECOVERY_FAILURE = None
        _VPN_FAILURES.pop(channel, None)
        _VPN_RECOVERY_GENERATION += 1
        _remember_vpn_health((channel, _vpn_cookie_version(fresh)))
        return fresh


class URP_login:
    def __init__(self, url, account, password, cookie_path=None, persist_cookies=True, stored_password=False):
        self.url = normalize_urp_url(url).rstrip('/')
        self.account = account
        self._password = password
        self._stored_password = stored_password
        self.cookie_path = cookie_path
        self._vpn_recovery_failure = None
        self.login_check_uncertain = False
        self.probe_uncertain = False
        self.persist_cookies = persist_cookies
        self.x = requests.session()
        self.x.verify = False
        self.x.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        })

    @property
    def password(self):
        # Cookie 检查不解密；只有需要发送登录凭据时才获取明文。
        return CredentialCipher().decrypt(self._password) if self._stored_password else self._password

    def _url(self, path=''):
        return f"{self.url}/{path.lstrip('/')}" if path else f'{self.url}/'

    def _save_cookies(self):
        if not self.persist_cookies:
            return
        return save_user_cookies(self.account, self.url, self.x.cookies.get_dict(), cookie_path=self.cookie_path)
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
        self.x.get(VPN_LOGIN_PAGE, timeout=_request_timeout(20))
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
            timeout=_request_timeout(20),
        )
        resp.encoding = 'utf-8'
        if resp.status_code != 200 or '0x00000000' not in resp.text:
            return False, f'VPN auth failed; status={resp.status_code}; {_html_hint(resp)}'
        self.x.get(VPN_PORTAL_PAGE, timeout=_request_timeout(20))
        save_shared_vpn_cookies(self.x.cookies.get_dict())
        start_vpn_keepalive()
        return True, 'VPN auth success'

    def _ensure_vpn_session(self):
        if not self._requires_vpn_auth():
            return True, ''
        if self._vpn_recovery_failure is not None:
            return False, self._vpn_recovery_failure
        try:
            recover_vpn_session(self.x, self._url())
            start_vpn_keepalive()
            return True, 'VPN already online'
        except VPNUnavailableError as exc:
            self._vpn_recovery_failure = str(exc)
            return False, self._vpn_recovery_failure

    def _get_login_page(self):
        headers = {'Referer': VPN_PORTAL_PAGE} if self._requires_vpn_auth() else {}
        for _ in range(2):
            resp = self.x.get(self._url(), headers=headers, timeout=_request_timeout(20))
            resp.encoding = 'gbk'
            reason = _login_failure_reason(resp)
            if reason in ('maintenance', 'unavailable'):
                raise LoginPageUnavailableError(_LOGIN_FAILURE_MESSAGES[reason])
            if is_vpn_failure_response(resp):
                raise VPNUnavailableError(_LOGIN_FAILURE_MESSAGES['vpn'])
            try:
                return resp.url, _parse_login_form(resp.text)
            except RuntimeError:
                continue
        raise LoginPageUnavailableError('暂时无法打开学校教务登录页，请稍后重试。')

    def _read_captcha(self, ocr, allow_vpn_retry=True):
        resp = self.x.get(
            self._url('validateCodeAction.do'),
            params={'random': str(random.random())},
            headers={'Referer': self._url()},
            timeout=_request_timeout(20),
        )
        if not _looks_like_image(resp):
            if self._requires_vpn_auth() and allow_vpn_retry:
                recover_vpn_session(self.x, self._url(), force=True)
                return self._read_captcha(ocr, allow_vpn_retry=False)
            raise CaptchaUnavailableError('暂时无法获取登录验证码，请稍后重试。')
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
            timeout=_request_timeout(30),
        )
        resp.encoding = 'gbk'
        return resp

    @_with_login_budget
    def login(self):
        stage = 'vpn'
        try:
            success, _ = self._ensure_vpn_session()
            if not success:
                _logger.warning('教务登录失败: stage=vpn')
                return False, _LOGIN_FAILURE_MESSAGES['vpn'], None

            stage = 'ocr'
            import ddddocr
            stage = 'login_page'
            form_url, parser = self._get_login_page()
            stage = 'ocr'
            ocr = ddddocr.DdddOcr(show_ad=False)
            last_response = None
            for attempt in range(MAX_CAPTCHA_ATTEMPTS):
                stage = 'captcha'
                captcha_text = self._read_captcha(ocr)
                if not captcha_text:
                    continue
                stage = 'submit'
                last_response = self._submit_login(form_url, parser, captcha_text)
                if _looks_logged_in(last_response):
                    stage = 'save_cookies'
                    self._save_cookies()
                    if self._requires_vpn_auth():
                        save_shared_vpn_cookies(self.x.cookies.get_dict())
                    return True, '登录成功', self.x.cookies.get_dict()
                reason = _login_failure_reason(last_response)
                if reason and reason != 'captcha':
                    _logger.warning('教务登录失败: reason=%s HTTP=%s', reason, last_response.status_code)
                    return False, _LOGIN_FAILURE_MESSAGES[reason], None
                if attempt + 1 < MAX_CAPTCHA_ATTEMPTS:
                    stage = 'login_page'
                    form_url, parser = self._get_login_page()
                    time.sleep(0.5)
            if last_response is not None:
                reason = _login_failure_reason(last_response) or 'unknown'
                _logger.warning('教务登录失败: reason=%s HTTP=%s', reason, last_response.status_code)
                return False, _LOGIN_FAILURE_MESSAGES[reason], None
            return False, '登录验证码自动识别未成功，请重试。', None
        except requests.Timeout:
            message = '学校教务系统响应超时，请稍后重试。'
        except requests.RequestException:
            message = '暂时无法连接学校教务系统，请稍后重试。'
        except VPNUnavailableError:
            message = _LOGIN_FAILURE_MESSAGES['vpn']
        except (LoginPageUnavailableError, CaptchaUnavailableError) as exc:
            message = str(exc)
        except Exception:
            message = ('登录验证码识别服务暂不可用，请稍后重试或联系管理员。'
                       if stage == 'ocr' else '登录服务暂时出现异常，请稍后重试或联系管理员。')
        # 不记录上游响应正文、完整 URL 或原始异常，避免带出凭据和登录票据。
        _logger.warning('教务登录异常: stage=%s', stage)
        return False, message, None

    @_with_login_budget
    def is_logined(self):
        # 保持 bool 接口；调用者可区分暂不可确认与已明确失效。
        self.login_check_uncertain = False
        self.probe_uncertain = False
        cookies, source = load_user_cookies(self.account, self.url, cookie_path=self.cookie_path)
        if not cookies:
            return False
        self.x.cookies.update(cookies)

        if self._requires_vpn_auth():
            success, _ = self._ensure_vpn_session()
            if not success:
                self.login_check_uncertain = True
                return False

        try:
            response = self.x.get(self._url('menu/top.jsp'), timeout=_request_timeout(5), verify=False)
            # VPN 的短期健康缓存可能刚好过期，真实响应已失效时必须强制恢复。
            if self._requires_vpn_auth() and is_vpn_failure_response(response):
                fresh = recover_vpn_session(self.x, self._url(), force=True)
                self.x.cookies.update(fresh)
                response = self.x.get(self._url('menu/top.jsp'), timeout=_request_timeout(5), verify=False)

            result = self._classify_login_probe(response)
            if result is None:
                # top.jsp 在会话过期时可能抛出 JSP 错误或只返回提示页。
                # 通过首页确认登录表单，不能把这种状态永久归为网络不可用。
                response = self.x.get(self._url(), timeout=_request_timeout(5), verify=False)
                result = self._classify_login_probe(response, allow_home_frameset=True)
        except VPNUnavailableError:
            self.login_check_uncertain = True
            return False
        except Exception:
            self.login_check_uncertain = True
            self.probe_uncertain = True
            return False

        if result is None:
            self.login_check_uncertain = True
            self.probe_uncertain = not is_vpn_failure_response(response)
            return False
        if not result:
            return False
        if source == 'legacy':
            self._save_cookies()
        return True

    def _classify_login_probe(self, response, allow_home_frameset=False):
        """True 已登录，False 明确失效，None 需要进一步确认。"""
        if is_vpn_failure_response(response):
            return None
        status_code = getattr(response, 'status_code', 200)
        if status_code == 401:
            return False
        if isinstance(status_code, int) and status_code >= 400:
            return None
        if _looks_like_urp_login_page(response):
            return False
        if self.account in _response_text(response):
            return True
        if _looks_like_urp_home_page(response):
            return None if allow_home_frameset else False
        return None
