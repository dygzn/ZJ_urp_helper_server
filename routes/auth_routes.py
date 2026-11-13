"""
用户认证相关路由
"""
import re
from flask import Blueprint, request, jsonify, current_app
from database import get_db
from services.user_service import get_device_id, get_user_by_device, bind_user, unbind_user
from services.urp_service import urp_login, check_login_status, update_daily_exams
from services.activity_service import record_daily_activity
from services.config_service import get_current_urp_url
from services.credential_service import CredentialCipher, CredentialError
from services.temporary_session_service import (
    delete_temporary_session, save_temporary_session,
)

auth_bp = Blueprint('auth', __name__)


@auth_bp.route('/api/check_bind', methods=['GET'])
def check_bind():
    device_id = get_device_id()
    user = get_user_by_device(device_id)

    if user:
        update_daily_exams(user)
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

    return jsonify(resp)


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

    # 与微信绑定入口保持一致，校验后的学号才能用于教务登录和文件路径。
    if not isinstance(username, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', username.strip()):
        return jsonify({'success': False, 'message': '请输入有效学号'}), 400
    username = username.strip()

    device_id = get_device_id()
    if not device_id:
        return jsonify({'success': False, 'message': '登录准备失败，请刷新页面后重试'}), 400

    if bind_account:
        try:
            CredentialCipher().validate_configuration()
        except CredentialError:
            current_app.logger.exception('教务账号绑定的密码加密配置不可用')
            # 保持现有业务失败约定，避免代理将 503 替换为维护页 HTML。
            return jsonify({
                'success': False,
                'code': 'ACCOUNT_STORAGE_UNAVAILABLE',
                'message': '当前无法保存账号，请取消勾选后临时登录，或联系管理员。',
            })

    success, message, cookies = urp_login(username, password, persist_cookies=bind_account)

    if success:
        if bind_account:
            bind_user(device_id, username, password, invitation_token)
            delete_temporary_session(device_id)
            record_daily_activity(username)
            update_daily_exams({
                'username': username, 'password': password,
            })
            return jsonify({
                'success': True,
                'bound': True,
                'message': '登录成功',
                'username': username,
            })

        expires_at = save_temporary_session(device_id, username, cookies, url=get_current_urp_url())
        record_daily_activity(username)
        # 解析新会话后，查询缓存写入临时隔离目录。
        temporary_user = get_user_by_device(device_id)
        if temporary_user:
            update_daily_exams(temporary_user)
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

    unbind_user(device_id)

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

    url = get_current_urp_url()

    try:
        is_logged_in, login_details = check_login_status(
            username,
            password,
            {},
            url=url,
        )
        if is_logged_in:
            message = (
                '重新登录成功'
                if getattr(login_details, 'relogged', False)
                else '登录状态正常'
            )
            return jsonify({
                'success': True,
                'logged_in': True,
                'username': username,
                'message': message,
            })

        if isinstance(login_details, dict) and login_details.get('retryable'):
            return jsonify(success=False, logged_in=False, retryable=True, message=login_details['message'])

        if user.get('temporary'):
            return jsonify({
                'success': True, 'logged_in': False, 'requires_relogin': True,
                'username': username,
                'message': '登录已失效，请重新输入学号和密码。',
            })

        message = None
        if isinstance(login_details, dict):
            message = login_details.get('message')
        return jsonify({
            'success': True,
            'logged_in': False,
            'username': username,
            'message': message or '重新登录失败',
        })
    except Exception:
        current_app.logger.warning('教务登录状态检查异常')
        return jsonify({'success': False, 'logged_in': False, 'message': '检查登录状态失败，请稍后重试。'})
