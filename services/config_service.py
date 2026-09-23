"""
配置管理服务
"""
import json
import os
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
