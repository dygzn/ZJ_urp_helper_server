"""小程序专用鉴权。只接受微信 Token，不接受网页设备标识。"""
from functools import wraps
from flask import jsonify
from auth import require_wechat_session, _check_member_access
from services.wechat_account_service import get_account
from services import urp_service, config_service


def require_wechat_account(login=False, member=False, grades=False):
    def decorate(fn):
        @wraps(fn)
        @require_wechat_session
        def wrapped(wechat_session, *args, **kwargs):
            account = get_account(wechat_session['openid'])
            if not account:
                return jsonify(success=False, code='BINDING_REQUIRED', message='请先绑定学号'), 409
            if member or (grades and config_service.get_config().get('grades_require_member', True)):
                allowed, _ = _check_member_access(account['username'], 'basic')
                if not allowed:
                    return jsonify(success=False, code='MEMBER_REQUIRED',
                                   message='此功能需要有效会员，请前往网页端开通或续费会员后重试。小程序内不提供充值。'), 403
            if login:
                valid, _ = urp_service.check_login_status(account['username'], account['password'], {})
                if not valid:
                    return jsonify(success=False, code='URP_LOGIN_REQUIRED', message='教务登录失效，请解绑后重新验证学号和密码'), 409
            return fn(account=account, *args, **kwargs)
        return wrapped
    return decorate
