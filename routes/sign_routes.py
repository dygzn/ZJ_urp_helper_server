"""
对分易签到代理路由

- 登录、状态、停止、日志流：绑定账号即可用
- 开始监控：白名单学号免费，其余需要 basic 会员
"""
import requests
import urllib3
from datetime import datetime
from flask import Blueprint, Response, jsonify, request, stream_with_context

from auth import require_bindding
from constants import DUIFENE_BASE_URL, SIGN_FREE_USERS
from database import get_db

urllib3.disable_warnings()

sign_bp = Blueprint('sign', __name__)

_session = requests.Session()
_session.headers['User-Agent'] = (
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 '
    '(KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.40(0x1800282a) '
    'NetType/WIFI Language/zh_CN'
)
_session.verify = False


def _check_sign_permission(username: str):
    """返回 None 表示有权限，否则返回错误响应。"""
    if username in SIGN_FREE_USERS:
        return None
    with get_db() as conn:
        row = conn.execute(
            'SELECT member_type, expire_time FROM memberships WHERE username = ?',
            (username,)
        ).fetchone()
    if not row or datetime.now() > datetime.fromisoformat(row['expire_time']):
        return jsonify({'success': False, 'message': '此功能需要会员，请前往会员购买页面开通', 'require_member': 'basic'})
    return None


@sign_bp.route('/api/sign/login', methods=['POST'])
@require_bindding
def sign_login(user):
    data = request.get_json(force=True, silent=True) or {}
    data['urp_username'] = user['username']
    try:
        resp = _session.post(f'{DUIFENE_BASE_URL}/login', json=data, timeout=15)
        return jsonify(resp.json()), resp.status_code
    except Exception as e:
        return jsonify({'success': False, 'msg': f'连接签到服务失败: {e}'}), 502


@sign_bp.route('/api/sign/login_link', methods=['POST'])
@require_bindding
def sign_login_link(user):
    data = request.get_json(force=True, silent=True) or {}
    try:
        resp = _session.post(f'{DUIFENE_BASE_URL}/login_link', json=data, timeout=15)
        return jsonify(resp.json()), resp.status_code
    except Exception as e:
        return jsonify({'success': False, 'msg': f'连接签到服务失败: {e}'}), 502


@sign_bp.route('/api/sign/status', methods=['GET'])
@require_bindding
def sign_status(user):
    try:
        resp = _session.get(f'{DUIFENE_BASE_URL}/api/user_status',
                            params={'username': user['username']}, timeout=10)
        return jsonify(resp.json()), resp.status_code
    except Exception as e:
        return jsonify({'success': False, 'msg': f'连接签到服务失败: {e}'}), 502


@sign_bp.route('/api/sign/start', methods=['POST'])
@require_bindding
def sign_start(user):
    err = _check_sign_permission(user['username'])
    if err:
        return err
    data = request.get_json(force=True, silent=True) or {}
    data['username'] = user['username']
    try:
        resp = _session.post(f'{DUIFENE_BASE_URL}/api/user_start', json=data, timeout=15)
        return jsonify(resp.json()), resp.status_code
    except Exception as e:
        return jsonify({'success': False, 'msg': f'连接签到服务失败: {e}'}), 502


@sign_bp.route('/api/sign/stop', methods=['POST'])
@require_bindding
def sign_stop(user):
    try:
        resp = _session.post(f'{DUIFENE_BASE_URL}/api/user_stop',
                             json={'username': user['username']}, timeout=10)
        return jsonify(resp.json()), resp.status_code
    except Exception as e:
        return jsonify({'success': False, 'msg': f'连接签到服务失败: {e}'}), 502


@sign_bp.route('/api/sign/stream')
@require_bindding
def sign_stream(user):
    def generate():
        try:
            with _session.get(f'{DUIFENE_BASE_URL}/api/user_stream',
                               params={'username': user['username']},
                               stream=True, timeout=35) as resp:
                for chunk in resp.iter_content(chunk_size=None):
                    if chunk:
                        yield chunk
        except Exception:
            yield b'data: {"msg": "[error] connection lost"}\n\n'

    return Response(
        stream_with_context(generate()),
        content_type='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
    )
