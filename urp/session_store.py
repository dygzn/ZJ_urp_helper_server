import json
import os
import tempfile
from collections.abc import Mapping
from pathlib import Path

from services.config_service import urp_url_fingerprint


USER_DATA_DIR = Path('user_data')
VPN_COOKIE_PREFIX = 'VSG_'


def _filter_user_cookies(cookies):
    if not isinstance(cookies, Mapping):
        return {}
    return {
        str(name): value
        for name, value in cookies.items()
        if not str(name).upper().startswith(VPN_COOKIE_PREFIX)
    }


def _account_directory(account):
    from services.temporary_session_service import current_temporary_session, user_data_file
    if current_temporary_session(account):
        return Path(user_data_file(account, 'cookie.json')).parent
    return Path(USER_DATA_DIR) / str(account)


def user_cookie_path(account, url):
    return (
        _account_directory(account)
        / 'cookies'
        / f'{urp_url_fingerprint(url)}.json'
    )


def legacy_cookie_path(account):
    return _account_directory(account) / 'cookie.json'


def _read_cookie_file(path, origin=None):
    try:
        payload = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError, TypeError):
        return {}
    if origin is not None and (not isinstance(payload, dict) or payload.get('url_fingerprint') != origin):
        return {}
    if isinstance(payload, dict) and isinstance(payload.get('cookies'), dict):
        payload = payload['cookies']
    return _filter_user_cookies(payload)


def load_user_cookies(account, url, allow_legacy=True, cookie_path=None):
    scoped = Path(cookie_path) if cookie_path is not None else user_cookie_path(account, url)
    if scoped.exists():
        return _read_cookie_file(scoped), 'scoped'
    if cookie_path is not None:
        return {}, 'missing'
    legacy = legacy_cookie_path(account)
    if allow_legacy and legacy.exists():
        from services.temporary_session_service import current_temporary_session
        # 旧临时 Cookie 没有来源，不能猜测当前 URL 并向其发送；提示用户重新输入密码。
        origin = urp_url_fingerprint(url) if current_temporary_session(account) else None
        return _read_cookie_file(legacy, origin=origin), 'legacy'
    return {}, 'missing'


def save_user_cookies(account, url, cookies, cookie_path=None):
    target = Path(cookie_path) if cookie_path is not None else user_cookie_path(account, url)
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
