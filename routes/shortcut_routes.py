"""Apple 快捷指令 API 及会员密钥管理路由。"""
from flask import Blueprint, jsonify, request

from auth import (
    _check_member_access,
    require_bindding,
    require_member,
)
from services.shortcut_service import (
    get_api_key_status,
    issue_api_key,
    query_shortcut_data,
    resolve_api_key,
)
from services.urp_service import check_login_status, start_auto_update
from services.user_service import get_user_by_username


shortcut_bp = Blueprint('shortcut', __name__)


@shortcut_bp.route('/api/member/api-key', methods=['GET'])
@require_bindding
def get_member_api_key(user):
    """查询当前绑定学号的密钥状态，不返回密钥明文。"""
    return jsonify({
        'success': True,
        'data': get_api_key_status(user['username']),
    })


@shortcut_bp.route('/api/member/api-key', methods=['POST'])
@require_member('basic')
def create_member_api_key(user):
    """生成或轮换当前绑定学号的 API 密钥。"""
    issued = issue_api_key(user['username'])
    return jsonify({
        'success': True,
        'data': {
            'key': issued['key'],
            'key_prefix': issued['key_prefix'],
            'create_time': issued['create_time'],
        },
    })


def _shortcut_error(action, error_code, message):
    return jsonify({
        'success': False,
        'action': action,
        'error_code': error_code,
        'message': message,
        'data': None,
    })


@shortcut_bp.route('/api/shortcut/query', methods=['POST'])
def shortcut_query():
    """使用按学号生成的密钥查询快捷指令数据。"""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return _shortcut_error(None, 'invalid_request', '请求体必须是 JSON')

    raw_key = payload.get('key')
    action = payload.get('action')
    params = payload.get('params', {})
    if not isinstance(raw_key, str) or not raw_key.strip():
        return _shortcut_error(
            action if isinstance(action, str) else None,
            'invalid_request',
            '缺少 key',
        )
    if not isinstance(action, str) or not action.strip():
        return _shortcut_error(None, 'invalid_request', '缺少 action')
    action = action.strip()
    if not isinstance(params, dict):
        return _shortcut_error(action, 'invalid_request', 'params 必须是对象')
    if action not in {'historical_schedule', 'grades', 'urgent_event'}:
        return _shortcut_error(action, 'invalid_action', '不支持的查询功能')

    username = resolve_api_key(raw_key.strip())
    if not username:
        return _shortcut_error(action, 'invalid_key', '密钥无效或已失效')

    member_ok, member_error = _check_member_access(username, 'basic')
    if not member_ok:
        return _shortcut_error(
            action,
            'member_required',
            member_error.get('message', '此功能需要初级会员'),
        )

    user = get_user_by_username(username)
    if not user:
        return _shortcut_error(action, 'login_required', '未找到该学号的绑定信息')
    is_logged_in, _ = check_login_status(username, user['password'], {})
    if not is_logged_in:
        return _shortcut_error(
            action,
            'login_required',
            '教务登录已失效，请先在网站重新绑定',
        )

    try:
        if action == 'urgent_event':
            start_auto_update(username, user['password'])
        data = query_shortcut_data(username, action, params)
    except ValueError as exc:
        error_code = str(exc)
        if error_code not in {'invalid_action', 'invalid_params'}:
            error_code = 'query_failed'
        message = (
            '不支持的查询功能'
            if error_code == 'invalid_action'
            else '查询参数无效'
        )
        return _shortcut_error(action, error_code, message)
    except Exception:
        return _shortcut_error(action, 'query_failed', '查询失败，请稍后重试')

    return jsonify({
        'success': True,
        'action': action,
        'message': '查询成功',
        'data': data,
    })
