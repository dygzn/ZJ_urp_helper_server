"""Apple 快捷指令 API 及会员密钥管理路由。"""
from flask import Blueprint, jsonify

from auth import require_bindding, require_member
from services.shortcut_service import get_api_key_status, issue_api_key


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
