"""
用户认证相关路由
"""
import uuid
from datetime import datetime
from flask import Blueprint, request, jsonify
from database import get_db
from auth import require_bindding
from services.user_service import get_device_id, get_user_by_device, bind_user, unbind_user
from services.urp_service import urp_login, check_login_status
from services.config_service import get_current_urp_url

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
        resp = {'success': True, 'bound': True, 'username': user['username']}
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
    data = request.get_json()
    username = data.get('username')
    password = data.get('password')
    inviter = (data.get('inviter') or '').strip()

    if not username or not password:
        return jsonify({'success': False, 'message': '用户名和密码不能为空'})

    success, message, _ = urp_login(username, password)

    if success:
        device_id = get_device_id()

        bind_user(device_id, username, password)

        # 设置邀请人（仅当该用户尚未被邀请过）
        if inviter and inviter != username:
            with get_db() as conn:
                already_invited = conn.execute(
                    'SELECT id FROM invitations WHERE invitee_username = ?', (username,)
                ).fetchone()
                if not already_invited:
                    inviter_exists = conn.execute(
                        'SELECT username FROM users WHERE username = ?', (inviter,)
                    ).fetchone()
                    if inviter_exists:
                        conn.execute(
                            'INSERT OR IGNORE INTO invitations (inviter_username, invitee_username, create_time) VALUES (?, ?, ?)',
                            (inviter, username, datetime.now().isoformat())
                        )

        return jsonify({'success': True, 'message': '登录成功', 'username': username})
    else:
        return jsonify({'success': False, 'message': message})


@auth_bp.route('/api/request_rebind', methods=['POST'])
def request_rebind():
    data = request.get_json() or {}
    device_id = get_device_id()
    current_user = get_user_by_device(device_id)

    if not current_user:
        return jsonify({'success': False, 'message': '设备未绑定账号'})

    new_username = (data.get('new_username') or '').strip()
    reason = (data.get('reason') or '').strip()

    if not new_username:
        return jsonify({'success': False, 'message': '请填写新学号'})
    if not reason:
        return jsonify({'success': False, 'message': '请填写换绑原因'})

    request_id = str(uuid.uuid4())

    with get_db() as conn:
        existing = conn.execute(
            "SELECT request_id FROM pending_requests WHERE device_id = ? AND status = 'pending'",
            (device_id,)
        ).fetchone()
        if existing:
            return jsonify({'success': False, 'message': '你已有换绑申请正在等待管理员审批'})

        conn.execute("""
            INSERT INTO pending_requests
            (request_id, device_id, old_username, new_username, reason, request_time, status)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            request_id,
            device_id,
            current_user['username'],
            new_username,
            reason,
            datetime.now().isoformat(),
            'pending'
        ))

    return jsonify({
        'success': True,
        'message': '换绑请求已提交，等待管理员审批',
        'request_id': request_id
    })


@auth_bp.route('/api/check_login_status', methods=['GET'])
def api_check_login_status():
    device_id = get_device_id()
    user = get_user_by_device(device_id)

    if not user:
        return jsonify({'success': True, 'logged_in': False, 'message': '未绑定账号'})

    username = user['username']
    password = user['password']

    from URP import URP_login
    url = get_current_urp_url()

    try:
        urp = URP_login(url, username, password)
        is_logged_in = urp.is_logined()

        if is_logged_in is True:
            return jsonify({'success': True, 'logged_in': True, 'username': username, 'message': '登录状态正常'})
        else:
            success, message, _ = urp.login()
            if success:
                return jsonify({'success': True, 'logged_in': True, 'username': username, 'message': '重新登录成功'})
            else:
                return jsonify({'success': True, 'logged_in': False, 'username': username, 'message': message or '重新登录失败'})
    except Exception as e:
        return jsonify({'success': False, 'logged_in': False, 'message': f'检查登录状态失败: {str(e)}'})
