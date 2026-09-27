"""
用户认证相关路由
"""
from flask import Blueprint, request, jsonify
from database import get_db
from services.user_service import get_device_id, get_user_by_device, bind_user
from services.urp_service import urp_login, check_login_status
from services.config_service import get_current_urp_url
from services.temporary_session_service import (
    delete_temporary_session, save_temporary_session, user_data_file,
)

auth_bp = Blueprint('auth', __name__)


@auth_bp.route('/api/check_bind', methods=['GET'])
def check_bind():
    device_id = get_device_id()
    user = get_user_by_device(device_id)

    rebind_notifications = []
    with get_db() as conn:
        rows = conn.execute(
            "SELECT request_id, old_username, new_username, status FROM pending_requests WHERE device_id = ? AND status != 'pending' AND notified = 0",
            (device_id,)
        ).fetchall()
        for row in rows:
            rebind_notifications.append({
                'request_id': row['request_id'],
                'old_username': row['old_username'],
                'new_username': row['new_username'],
                'status': row['status']
            })

    if user:
        resp = {
            'success': True,
            'bound': True,
            'username': user['username'],
            'temporary': user.get('temporary', False),
        }
        if user.get('temporary'):
            resp['expires_at'] = user['expires_at']
    else:
        resp = {'success': True, 'bound': False}

    if rebind_notifications:
        resp['rebind_notifications'] = rebind_notifications
    return jsonify(resp)


@auth_bp.route('/api/rebind_notified', methods=['POST'])
def rebind_notified():
    device_id = get_device_id()
    data = request.get_json()
    request_ids = data.get('request_ids', [])

    if not request_ids:
        return jsonify({'success': False, 'message': '缺少 request_ids'})

    with get_db() as conn:
        placeholders = ','.join(['?'] * len(request_ids))
        conn.execute(
            f"UPDATE pending_requests SET notified = 1 WHERE request_id IN ({placeholders}) AND device_id = ?",
            request_ids + [device_id]
        )

    return jsonify({'success': True})


@auth_bp.route('/api/login', methods=['POST'])
def login():
    data = request.get_json() or {}
    username = data.get('username')
    password = data.get('password')
    # 旧客户端没有该字段，按原行为默认执行设备绑定；新客户端只有明确取消勾选才不绑定。
    bind_account = data.get('bind_account', True) is not False
    invitation_token = data.get('invitation_token')

    if not username or not password:
        return jsonify({'success': False, 'message': '用户名和密码不能为空'})

    if not bind_account:
        device_header = (request.headers.get('X-Device-ID') or '').strip()
        if not device_header or len(device_header) > 128:
            return jsonify({'success': False, 'message': '登录准备失败，请刷新页面后重试'}), 400

    success, message, cookies = urp_login(username, password, persist_cookies=bind_account)

    if success:
        if bind_account:
            device_id = get_device_id()
            bind_user(device_id, username, password, invitation_token)
            delete_temporary_session(device_id)
            return jsonify({
                'success': True,
                'bound': True,
                'message': '登录成功',
                'username': username,
            })

        expires_at = save_temporary_session(get_device_id(), username, cookies)
        return jsonify({
            'success': True,
            'bound': False,
            'temporary': True,
            'expires_at': expires_at,
            'message': '已登录，本次输入的密码不会保存。登录失效后请重新输入。',
            'username': username,
        })
    else:
        return jsonify({'success': False, 'message': message})


@auth_bp.route('/api/request_rebind', methods=['POST'])
def request_rebind():
    device_id = get_device_id()
    current_user = get_user_by_device(device_id)

    if not current_user:
        return jsonify({'success': False, 'message': '设备未绑定账号'})

    if current_user.get('temporary'):
        delete_temporary_session(device_id)
        return jsonify({'success': True, 'message': '已退出本次登录，请重新登录'})

    with get_db() as conn:
        conn.execute('DELETE FROM users WHERE device_id = ?', (device_id,))
        conn.execute(
            "DELETE FROM pending_requests WHERE device_id = ? AND status = 'pending'",
            (device_id,)
        )

    return jsonify({
        'success': True,
        'message': '当前设备已解绑，请重新绑定新账号'
    })


@auth_bp.route('/api/check_login_status', methods=['GET'])
def api_check_login_status():
    device_id = get_device_id()
    user = get_user_by_device(device_id)

    if not user:
        return jsonify({'success': True, 'logged_in': False, 'message': '未绑定账号'})

    username = user['username']
    password = user['password']

    from urp import URP_login
    url = get_current_urp_url()

    try:
        urp = URP_login(url, username, password, cookie_path=user_data_file(username, 'cookie.json'))
        is_logged_in = urp.is_logined()

        if is_logged_in is True:
            return jsonify({'success': True, 'logged_in': True, 'username': username, 'message': '登录状态正常'})
        else:
            if user.get('temporary'):
                return jsonify({
                    'success': True,
                    'logged_in': False,
                    'requires_relogin': True,
                    'username': username,
                    'message': '登录已失效，请重新输入学号和密码。',
                })
            success, message, _ = urp.login()
            if success:
                return jsonify({'success': True, 'logged_in': True, 'username': username, 'message': '重新登录成功'})
            else:
                return jsonify({'success': True, 'logged_in': False, 'username': username, 'message': message or '重新登录失败'})
    except Exception as e:
        return jsonify({'success': False, 'logged_in': False, 'message': f'检查登录状态失败: {str(e)}'})
