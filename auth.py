"""
认证装饰器
"""
from functools import wraps
from datetime import datetime
from flask import request, jsonify
from database import get_db
from services.config_service import get_admin_key, get_config
from services.user_service import get_device_id, get_user_by_device
from services.urp_service import check_login_status, _login_cache
from services.wechat_auth_service import get_wechat_request_session


def require_admin(f):
    """管理员权限装饰器"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        admin_key = request.headers.get('X-Admin-Key') or request.headers.get('Admin-Key') or request.args.get('admin_key')
        if admin_key != get_admin_key():
            return jsonify({'success': False, 'message': '管理员密钥错误'}), 403
        return f(*args, **kwargs)
    return decorated_function


def require_wechat_session(f):
    """校验小程序自定义登录态，允许未绑定教务账号进入绑定接口。"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        wechat_session = get_wechat_request_session()
        if not wechat_session:
            return jsonify({
                'success': False,
                'message': '微信登录已失效，请重新登录',
                'code': 'WECHAT_SESSION_REQUIRED',
            }), 401
        return f(wechat_session=wechat_session, *args, **kwargs)

    return decorated_function


def require_login(f):
    """用户登录状态检查装饰器"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        device_id = get_device_id()
        user = get_user_by_device(device_id)

        if not user:
            return jsonify({'success': False, 'message': '未绑定账号'})

        username = user['username']
        password = user['password']

        is_logged_in, _ = check_login_status(username, password, {})

        if not is_logged_in:
            return jsonify({'success': False, 'message': '登录已失效，请重新绑定'})

        try:
            return f(user=user, *args, **kwargs)
        except Exception:
            _login_cache.pop(username, None)
            is_logged_in, _ = check_login_status(username, password, {})
            if not is_logged_in:
                return jsonify({'success': False, 'message': '登录已失效，请重新绑定'})
            try:
                return f(user=user, *args, **kwargs)
            except Exception:
                raise

    return decorated_function


def require_bindding(f):
    """账号绑定检查装饰器（不验证URP登录状态）"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        device_id = get_device_id()
        user = get_user_by_device(device_id)

        if not user:
            return jsonify({'success': False, 'message': '请先绑定账号后使用此功能'})

        return f(user=user, *args, **kwargs)

    return decorated_function


def require_member(level='basic'):
    """会员权限装饰器，level: 'basic' 或 'advanced'"""
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            device_id = get_device_id()
            user = get_user_by_device(device_id)
            if not user:
                return jsonify({'success': False, 'message': '请先绑定账号后使用此功能'})
            username = user['username']
            with get_db() as conn:
                row = conn.execute(
                    'SELECT member_type, expire_time FROM memberships WHERE username = ?',
                    (username,)
                ).fetchone()
            if not row:
                level_name = '初级会员' if level == 'basic' else '高级会员'
                return jsonify({'success': False, 'message': f'此功能需要{level_name}，请前往会员购买页面开通', 'require_member': level})
            member_type = row['member_type']
            expire_time = datetime.fromisoformat(row['expire_time'])
            if datetime.now() > expire_time:
                return jsonify({'success': False, 'message': '您的会员已过期，请前往会员购买页面续费', 'require_member': level})
            if level == 'advanced' and member_type != 'advanced':
                return jsonify({'success': False, 'message': '此功能需要高级会员，请前往会员购买页面升级', 'require_member': level})
            return f(user=user, *args, **kwargs)
        return decorated_function
    return decorator


def _check_member_access(username, level):
    with get_db() as conn:
        row = conn.execute(
            'SELECT member_type, expire_time FROM memberships WHERE username = ?',
            (username,)
        ).fetchone()

    if not row:
        level_name = '初级会员' if level == 'basic' else '高级会员'
        return False, {'success': False, 'message': f'此功能需要{level_name}，请前往会员购买页面开通', 'require_member': level}

    member_type = row['member_type']
    expire_time = datetime.fromisoformat(row['expire_time'])
    if datetime.now() > expire_time:
        return False, {'success': False, 'message': '您的会员已过期，请前往会员购买页面续费', 'require_member': level}

    if level == 'advanced' and member_type != 'advanced':
        return False, {'success': False, 'message': '此功能需要高级会员，请前往会员购买页面升级', 'require_member': level}

    return True, None


def require_grade_login(level='basic'):
    """成绩查询权限：可由后台配置是否需要会员，同时始终检查教务登录状态。"""
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            device_id = get_device_id()
            user = get_user_by_device(device_id)
            if not user:
                return jsonify({'success': False, 'message': '请先绑定账号后使用此功能'})

            username = user['username']
            password = user['password']
            config = get_config()
            if config.get('grades_require_member', True):
                ok, error = _check_member_access(username, level)
                if not ok:
                    return jsonify(error)

            is_logged_in, _ = check_login_status(username, password, {})
            if not is_logged_in:
                return jsonify({'success': False, 'message': '登录已失效，请重新绑定'})

            try:
                return f(user=user, *args, **kwargs)
            except Exception:
                _login_cache.pop(username, None)
                is_logged_in, _ = check_login_status(username, password, {})
                if not is_logged_in:
                    return jsonify({'success': False, 'message': '登录已失效，请重新绑定'})
                try:
                    return f(user=user, *args, **kwargs)
                except Exception:
                    raise

        return decorated_function
    return decorator

def require_member_login(level='basic'):
    """会员权限 + URP 登录状态检查装饰器，level: 'basic' 或 'advanced'"""
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            device_id = get_device_id()
            user = get_user_by_device(device_id)
            if not user:
                return jsonify({'success': False, 'message': '请先绑定账号后使用此功能'})

            username = user['username']
            password = user['password']
            with get_db() as conn:
                row = conn.execute(
                    'SELECT member_type, expire_time FROM memberships WHERE username = ?',
                    (username,)
                ).fetchone()

            if not row:
                level_name = '初级会员' if level == 'basic' else '高级会员'
                return jsonify({'success': False, 'message': f'此功能需要{level_name}，请前往会员购买页面开通', 'require_member': level})

            member_type = row['member_type']
            expire_time = datetime.fromisoformat(row['expire_time'])
            if datetime.now() > expire_time:
                return jsonify({'success': False, 'message': '您的会员已过期，请前往会员购买页面续费', 'require_member': level})

            if level == 'advanced' and member_type != 'advanced':
                return jsonify({'success': False, 'message': '此功能需要高级会员，请前往会员购买页面升级', 'require_member': level})

            is_logged_in, _ = check_login_status(username, password, {})
            if not is_logged_in:
                return jsonify({'success': False, 'message': '登录已失效，请重新绑定'})

            try:
                return f(user=user, *args, **kwargs)
            except Exception:
                _login_cache.pop(username, None)
                is_logged_in, _ = check_login_status(username, password, {})
                if not is_logged_in:
                    return jsonify({'success': False, 'message': '登录已失效，请重新绑定'})
                try:
                    return f(user=user, *args, **kwargs)
                except Exception:
                    raise

        return decorated_function
    return decorator
