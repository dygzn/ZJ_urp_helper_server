"""
会员支付辅助函数
"""
import hashlib
from services.config_service import get_config


def _generate_md5(s):
    hl = hashlib.md5()
    hl.update(s.encode('utf-8'))
    return hl.hexdigest()


def _get_server_url():
    config = get_config()
    return config.get('server_url', 'http://localhost:5000').rstrip('/')
