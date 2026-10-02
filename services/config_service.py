"""
配置管理服务
"""
import json
import os
import secrets
from constants import CONFIG_FILE


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
    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def get_admin_key():
    """管理员密钥只从环境变量读取，未配置时保持为空并拒绝鉴权。"""
    return os.environ.get('ADMIN_KEY', '').strip()


_EXAMPLE_VALUES = frozenset({
    'your-secret-key-change-this', 'your-secret-key', 'your-admin-key',
    'your-pay-secret-key', 'your-merchant-num', 'your-merchant-number',
    'change-me', 'changeme', 'replace-me', 'secret', 'admin',
})


def configure_app_security(app):
    """在数据库初始化前检查安全配置，同时覆盖直接启动与 WSGI 导入。"""
    from constants import MERCHANT_NUM, PAY_SECRET_KEY

    debug = os.environ.get('FLASK_DEBUG', '').lower() in ('1', 'true', 'yes', 'on')
    app.debug = debug
    secret_key = os.environ.get('SECRET_KEY', '').strip()
    settings = {
        'SECRET_KEY': secret_key,
        'ADMIN_KEY': get_admin_key(),
        'MERCHANT_NUM': MERCHANT_NUM,
        'PAY_SECRET_KEY': PAY_SECRET_KEY,
    }
    invalid = [
        name for name, value in settings.items()
        if not value or value.lower() in _EXAMPLE_VALUES
    ]
    if invalid:
        # 只记录变量名，避免错误信息再次泄漏配置值。
        message = '安全配置缺失或不安全: ' + ', '.join(invalid)
        if not debug:
            app.logger.error(message)
            raise RuntimeError(message)
        app.logger.warning(message + '；当前仅允许本机开发调试')

    app.secret_key = secrets.token_hex(32) if debug and 'SECRET_KEY' in invalid else secret_key


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
        'member_page_enabled': True,
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
    config = load_json_file(CONFIG_FILE, default_config)
    if not isinstance(config, dict):
        return default_config
    config.setdefault('member_page_enabled', True)
    return config


def save_config(config):
    """保存系统配置"""
    save_json_file(CONFIG_FILE, config)


def get_current_urp_url():
    """获取当前使用的教务系统URL"""
    config = get_config()
    index = config.get('current_url_index', 0)
    urls = config.get('urp_urls', [])
    if urls and 0 <= index < len(urls):
        return urls[index]
    return config.get('urp_url', 'http://your-urp-url.com')
