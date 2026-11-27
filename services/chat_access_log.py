"""Access log policy for chat polling and admin account paths."""

import logging
import re

_ANSI_ESCAPE = re.compile(r'\x1b\[[0-9;]*m')
_WERKZEUG_REQUEST = re.compile(
    r'"(?P<method>[A-Z]+)\s+(?P<target>[^\s"]+)(?P<proto>\s+HTTP/[0-9.]+)?"\s+(?P<status>\d{3})\b'
)


def skip_chat_poll(method, path, status):
    return (method == 'GET' and path in ('/api/chat/messages', '/api/chat/unread')
            and str(status).startswith('2'))


def chat_admin_log_path(path):
    if not path.startswith('/api/admin/chat/'):
        return None
    if path.startswith('/api/admin/chat/mutes/'):
        return '/api/admin/chat/mutes/<username>'
    return path


class _WerkzeugChatAccessFilter(logging.Filter):
    """Filter successful chat polling logs and redact admin chat paths in dev server logs."""

    _urp_chat_access_filter = True

    def filter(self, record):
        message = _ANSI_ESCAPE.sub('', record.getMessage())
        match = _WERKZEUG_REQUEST.search(message)
        if not match:
            return True
        method = match.group('method')
        raw_target = match.group('target')
        status = match.group('status')
        path = raw_target.partition('?')[0]
        if skip_chat_poll(method, path, status):
            return False
        admin_path = chat_admin_log_path(path)
        if admin_path is not None and raw_target != admin_path:
            proto = match.group('proto') or ''
            sanitized = (
                message[:match.start()]
                + f'"{method} {admin_path}{proto}" {status}'
                + message[match.end():]
            )
            record.msg = sanitized
            record.args = ()
        return True


def install_werkzeug_access_log_filter():
    logger = logging.getLogger('werkzeug')
    if not any(getattr(existing, '_urp_chat_access_filter', False) for existing in logger.filters):
        logger.addFilter(_WerkzeugChatAccessFilter())


def chat_request_handler():
    from werkzeug.serving import WSGIRequestHandler

    class ChatRequestHandler(WSGIRequestHandler):
        def log_request(self, code='-', size='-'):
            path = getattr(self, 'path', '').partition('?')[0]
            method = getattr(self, 'command', '')
            if skip_chat_poll(method, path, code):
                return
            admin_path = chat_admin_log_path(path)
            if admin_path is not None:
                self.log('info', '"%s %s" %s %s', method, admin_path, code, size)
                return
            super().log_request(code, size)

    return ChatRequestHandler
