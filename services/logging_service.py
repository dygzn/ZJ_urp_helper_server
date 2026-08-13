"""
请求日志异步写入服务
"""
import threading
import queue as queue_module
from datetime import datetime, timedelta
from flask import request
from database import get_db

log_queue = queue_module.Queue()
_log_counter = 0


def _log_writer():
    """后台线程批量写入请求日志"""
    while True:
        batch = []
        batch.append(log_queue.get())
        while len(batch) < 50:
            try:
                batch.append(log_queue.get_nowait())
            except queue_module.Empty:
                break
        try:
            with get_db() as conn:
                conn.executemany(
                    'INSERT INTO request_logs (device_id, username, endpoint, method, status_code, request_time) VALUES (?, ?, ?, ?, ?, ?)',
                    batch
                )
        except Exception:
            pass


threading.Thread(target=_log_writer, daemon=True).start()


def init_logging(app):
    """注册 after_request 日志钩子"""

    @app.after_request
    def log_request(response):
        global _log_counter
        path = request.path

        if not path.startswith('/api/') or path.startswith('/api/admin/monitor'):
            return response

        endpoint_names = {
            '/api/check_bind': '检查绑定',
            '/api/rebind_notified': '换绑通知已读',
            '/api/login': '登录绑定',
            '/api/request_rebind': '申请换绑',
            '/api/check_login_status': '检查登录状态',
            '/api/urgent_event': '紧急事件',
            '/api/schedule': '课表查询',
            '/api/update_schedule': '更新课表',
            '/api/exams': '考试安排',
            '/api/update_exams': '更新考试',
            '/api/grades': '成绩查询',
            '/api/unevaluated_courses': '待评教课程',
            '/api/evaluation': '教务评价',
            '/api/announcements': '公告',
            '/api/feedback': '反馈建议',
            '/api/admin/pending_requests': '管理-待审批',
            '/api/admin/approve_rebind': '管理-审批换绑',
            '/api/admin/users': '管理-用户列表',
            '/api/admin/config': '管理-配置',
            '/api/admin/announcements': '管理-公告',
            '/api/admin/feedback': '管理-反馈',
        }

        endpoint_name = endpoint_names.get(path)
        if not endpoint_name:
            for prefix, name in endpoint_names.items():
                if path.startswith(prefix):
                    endpoint_name = name
                    break
        if not endpoint_name:
            endpoint_name = path

        device_id = request.headers.get('X-Device-ID', '')
        username = ''
        if device_id:
            try:
                with get_db() as conn:
                    user = conn.execute('SELECT username FROM users WHERE device_id = ?', (device_id,)).fetchone()
                    if user:
                        username = user['username']
            except Exception:
                pass

        now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        log_queue.put((device_id, username, endpoint_name, request.method, response.status_code, now))

        _log_counter += 1
        if _log_counter >= 1000:
            _log_counter = 0
            try:
                cutoff = (datetime.now() - timedelta(days=7)).strftime('%Y-%m-%d %H:%M:%S')
                with get_db() as conn:
                    conn.execute('DELETE FROM request_logs WHERE request_time < ?', (cutoff,))
            except Exception:
                pass

        return response
