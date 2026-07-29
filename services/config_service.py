"""
配置管理服务
"""
import json
import os
import hashlib
import tempfile
import threading
from urllib.parse import urlparse

from flask import g, has_request_context
from constants import CONFIG_FILE, ADMIN_KEY_FILE


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
    try:
        parsed = urlparse(url.strip())
        hostname = parsed.hostname
        _ = parsed.port
    except ValueError:
        return False
    return parsed.scheme in {'http', 'https'} and bool(hostname)


def load_json_file(filepath, default=None):
    """加载JSON文件"""
    if default is None:
        default = {}
    if os.path.exists(filepath):
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return default
    return default


def save_json_file(filepath, data):
    """保存JSON文件"""
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


def get_admin_key():
    """获取管理员密钥"""
    return "786171937Wzs"


def get_config():
    """获取系统配置"""
    default_config = {
        'urp_url': 'http://your-urp-url.com',
        'current_url_index': 0,
        'urp_urls': [
            'http://your-urp-url-1.com',
            'http://your-urp-url-2.com'
        ],
        'semester_start': '2026-03-02',
        'grades_require_member': True,
        'database': {
            'type': 'sqlite',
            'sqlite_path': 'data/urp_helper.db',
            'mysql': {
                'host': '',
                'port': 3306,
                'database': 'urp_helper',
                'user': '',
                'password': '',
            }
        },
    }
    return load_json_file(CONFIG_FILE, default_config)


def save_config(config):
    """保存系统配置"""
    save_json_file(CONFIG_FILE, config)


def update_config(mutator):
    with _CONFIG_LOCK:
        config = get_config()
        mutator(config)
        save_config(config)
        return config


def get_current_urp_url():
    """获取当前使用的教务系统URL"""
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
