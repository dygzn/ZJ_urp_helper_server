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
