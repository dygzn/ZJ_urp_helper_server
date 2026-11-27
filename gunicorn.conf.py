from gunicorn.glogging import Logger

from services.chat_access_log import chat_admin_log_path, skip_chat_poll


class UrpAccessLogger(Logger):
    def access(self, resp, req, environ, request_time):
        path = environ.get('PATH_INFO', '')
        method = environ.get('REQUEST_METHOD', '')
        if skip_chat_poll(method, path, resp.status):
            return
        admin_path = chat_admin_log_path(path)
        if admin_path is not None:
            self.access_log.info('%s %s %s %.3fs', method, admin_path, resp.status, request_time.total_seconds())
            return
        super().access(resp, req, environ, request_time)


logger_class = UrpAccessLogger
