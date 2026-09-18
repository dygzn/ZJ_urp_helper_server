"""可配置广告内容，不向公开接口暴露其他系统配置。"""
from urllib.parse import urlsplit
from services.config_service import get_config

FIELDS = {'title': 80, 'summary': 200, 'image_url': 2000,
          'detail_title': 120, 'cover_url': 2000, 'body': 20000,
          'contact': 200, 'button_text': 40, 'button_url': 2000}


def validate_ad_config(data):
    if not isinstance(data, dict):
        raise ValueError('广告配置必须为对象')
    enabled = data.get('enabled', False)
    if not isinstance(enabled, bool):
        raise ValueError('广告开关必须为布尔值')
    result = {'enabled': enabled}
    for key, limit in FIELDS.items():
        value = data.get(key, '')
        if not isinstance(value, str) or len(value) > limit:
            raise ValueError(f'{key} 必须为文字且不超过 {limit} 字符')
        result[key] = value.strip()
    for key in ('image_url', 'cover_url', 'button_url'):
        value = result[key]
        if value:
            parsed = urlsplit(value)
            if parsed.scheme not in ('https', 'http') or not parsed.netloc or any(c.isspace() for c in value) or '\\' in value:
                raise ValueError('图片和跳转地址必须为完整的 HTTP / HTTPS 链接')
    if enabled and not all(result[key] for key in ('title', 'summary', 'body')):
        raise ValueError('开启广告前请填写标题、简介和详细正文')
    return result


def get_ad_config():
    try:
        return validate_ad_config(get_config().get('advertisement', {}))
    except (ValueError, TypeError):
        return validate_ad_config({})
