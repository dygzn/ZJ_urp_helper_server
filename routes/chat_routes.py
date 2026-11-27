"""Authenticated APIs for the user room and moderation workspace."""

import sqlite3

from flask import Blueprint, current_app, jsonify, request
from werkzeug.exceptions import RequestEntityTooLarge

try:
    from pymysql import MySQLError
except ImportError:
    class MySQLError(Exception):
        pass

from auth import require_admin, require_binding
from services import chat_service as chat
from services.chat_service import ChatError

chat_bp = Blueprint('chat', __name__)


def _success(data, status=200):
    return jsonify(success=True, message='', data=data), status


@chat_bp.after_request
def _private_response(response):
    response.headers['Cache-Control'] = 'private, no-store'
    return response


@chat_bp.errorhandler(ChatError)
def _chat_error(error):
    response = jsonify(success=False, message=str(error), code=error.code, data=error.data)
    if error.code == 'RATE_LIMITED':
        response.headers['Retry-After'] = str(error.data['retry_after'])
    return response, error.status


@chat_bp.errorhandler(MySQLError)
@chat_bp.errorhandler(sqlite3.Error)
def _database_error(error):
    current_app.logger.warning('聊天室数据库读取或写入失败 (%s %s)', request.endpoint, type(error).__name__)
    return _chat_error(ChatError('CHAT_UNAVAILABLE', '聊天室暂时不可用，请稍后重试。', 503))


def _int_arg(name, default=None, minimum=1, maximum=2**53 - 1):
    value = request.args.get(name)
    if value is None:
        return default
    if len(value) <= 16 and value.isascii() and value.isdecimal():
        number = int(value)
        if minimum <= number <= maximum:
            return number
    raise ChatError('INVALID_INPUT', '分页参数无效。')


def _limit():
    return _int_arg('limit', default=30, maximum=100)


def _text_arg(name, default='', maximum=100):
    value = request.args.get(name, default).strip()
    if len(value) > maximum:
        raise ChatError('INVALID_INPUT', '查询条件过长。')
    return value


def _body(max_bytes=16000):
    try:
        request.max_content_length = max_bytes
    except AttributeError:
        pass
    if request.content_length is not None and request.content_length > max_bytes:
        raise ChatError('INVALID_INPUT', '提交的内容过长。')
    try:
        raw = request.get_data(cache=True)
    except RequestEntityTooLarge:
        raise ChatError('INVALID_INPUT', '提交的内容过长。') from None
    if len(raw) > max_bytes:
        raise ChatError('INVALID_INPUT', '提交的内容过长。')
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ChatError('INVALID_INPUT', '提交的内容格式无效。')
    return data


def _context():
    return request.headers.get('X-Chat-Context', '')


@chat_bp.get('/api/chat/bootstrap')
@require_binding(auth_error=True)
def chat_bootstrap(user):
    return _success(chat.bootstrap(user))


@chat_bp.get('/api/chat/messages')
@require_binding(auth_error=True)
def chat_messages(user):
    before = _int_arg('before_id')
    after = _int_arg('after_id', minimum=0)
    if before is not None and after is not None:
        raise ChatError('INVALID_INPUT', '请选择一个消息分页游标。')
    return _success(chat.messages(user, _context(), before, after, _limit(),
                                  _int_arg('settings_version'), _int_arg('history_version')))


@chat_bp.get('/api/chat/unread')
@require_binding(auth_error=True)
def chat_unread(user):
    return _success(chat.unread(user))


@chat_bp.post('/api/chat/messages')
@require_binding(auth_error=True)
def chat_send(user):
    data, status = chat.send_message(_body(), user, _context())
    return _success(data, status)


@chat_bp.post('/api/chat/messages/<int:msg_id>/recall')
@require_binding(auth_error=True)
def chat_recall(user, msg_id):
    return _success(chat.recall(user, _context(), msg_id))


@chat_bp.post('/api/chat/messages/<int:msg_id>/report')
@require_binding(auth_error=True)
def chat_report(user, msg_id):
    return _success(chat.report(user, _context(), msg_id, _body()), 201)


@chat_bp.put('/api/chat/settings/privacy')
@require_binding(auth_error=True)
def chat_privacy(user):
    return _success(chat.set_privacy(user, _context(), _body()))


@chat_bp.get('/api/admin/chat/settings')
@require_admin
def admin_chat_settings():
    return _success(chat.admin_settings())


@chat_bp.put('/api/admin/chat/settings')
@require_admin
def admin_chat_save_settings():
    return _success(chat.save_admin_settings(_body(max_bytes=140000)))


@chat_bp.get('/api/admin/chat/messages')
@require_admin
def admin_chat_messages():
    return _success(chat.admin_messages(_text_arg('username', maximum=64), _text_arg('q'),
                                        _text_arg('status', 'all', 12), _int_arg('before_id'), _limit()))


@chat_bp.post('/api/admin/chat/messages')
@require_admin
def admin_chat_send():
    data, status = chat.send_message(_body())
    return _success(data, status)


@chat_bp.delete('/api/admin/chat/messages/<int:msg_id>')
@require_admin
def admin_chat_delete_message(msg_id):
    return _success(chat.delete_message(msg_id))


@chat_bp.get('/api/admin/chat/reports')
@require_admin
def admin_chat_reports():
    return _success(chat.admin_reports(_text_arg('status', 'pending', 12), _int_arg('before_id'), _limit()))


@chat_bp.post('/api/admin/chat/reports/<int:report_id>/handle')
@require_admin
def admin_chat_handle_report(report_id):
    return _success(chat.handle_report(report_id, _body()))


@chat_bp.get('/api/admin/chat/mutes')
@require_admin
def admin_chat_mutes():
    return _success(chat.admin_mutes(_text_arg('after_username', maximum=64), _limit()))


@chat_bp.post('/api/admin/chat/mutes')
@require_admin
def admin_chat_save_mute():
    return _success(chat.save_mute(_body()), 201)


@chat_bp.delete('/api/admin/chat/mutes/<username>')
@require_admin
def admin_chat_remove_mute(username):
    return _success(chat.remove_mute(username))
