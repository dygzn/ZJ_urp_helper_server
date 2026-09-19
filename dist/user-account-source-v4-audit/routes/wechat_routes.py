"""微信小程序登录和教务账号绑定接口。"""

from flask import Blueprint, jsonify, request

from auth import require_wechat_session
from services.urp_service import urp_login
from services.user_service import (
    bind_user,
    get_user_by_device,
    get_user_by_username,
)
from services.wechat_auth_service import (
    WechatAuthError,
    bind_openid_to_device,
    code_to_session,
    create_session,
    get_binding,
    get_binding_by_device_id,
    get_unbound_device_id,
)


wechat_bp = Blueprint('wechat', __name__)


@wechat_bp.route('/api/wechat/session', methods=['POST'])
def create_wechat_session():
    data = request.get_json(silent=True) or {}
    code = data.get('code')
    if not isinstance(code, str) or not code.strip():
        return jsonify({'success': False, 'message': '缺少微信登录凭证'}), 400

    try:
        wechat_identity = code_to_session(code)
        token = create_session(
            wechat_identity['openid'],
            wechat_identity.get('unionid'),
        )
        binding = get_binding(wechat_identity['openid'])
        user = get_user_by_device(binding['device_id']) if binding else None
        response = {
            'success': True,
            'token': token,
            'bound': bool(user),
        }
        if user:
            response['username'] = user['username']
        return jsonify(response)
    except WechatAuthError as exc:
        return jsonify({'success': False, 'message': str(exc)}), 400
    except Exception:
        return jsonify({'success': False, 'message': '微信登录失败，请稍后重试'}), 500


@wechat_bp.route('/api/wechat/bind', methods=['POST'])
@require_wechat_session
def bind_wechat_account(wechat_session):
    data = request.get_json(silent=True) or {}
    username = str(data.get('username') or '').strip()
    password = str(data.get('password') or '')
    invitation_token = data.get('invitation_token')
    if not username or not password:
        return jsonify({'success': False, 'message': '用户名和密码不能为空'}), 400

    success, message, _ = urp_login(username, password)
    if not success:
        return jsonify({'success': False, 'message': message or '教务账号登录失败'})

    openid = wechat_session['openid']
    current_binding = get_binding(openid)
    existing_user = get_user_by_username(username)

    if current_binding:
        device_id = current_binding['device_id']
    elif existing_user and existing_user.get('device_id'):
        existing_binding = get_binding_by_device_id(existing_user['device_id'])
        if existing_binding and existing_binding['openid'] != openid:
            return jsonify({
                'success': False,
                'message': '该教务账号已绑定其他微信，请先解绑后再试',
            })
        device_id = existing_user['device_id']
    else:
        device_id = get_unbound_device_id(openid)

    try:
        bind_user(device_id, username, password, invitation_token)
        bind_openid_to_device(
            openid,
            device_id,
            wechat_session.get('unionid'),
        )
    except Exception:
        return jsonify({'success': False, 'message': '绑定保存失败，请稍后重试'}), 500

    return jsonify({
        'success': True,
        'bound': True,
        'username': username,
        'message': '微信与教务账号绑定成功',
    })
