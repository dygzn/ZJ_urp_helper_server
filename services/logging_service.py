"""在线用户跟踪服务。

请求日志已停用；这里仅在进程内维护最近活跃的设备，供管理员在线监控使用。
"""
from flask import request

from services.online_service import online_tracker
from services.user_service import get_user_by_device


ENDPOINT_NAMES = {
    '/api/check_bind': '检查绑定',
    '/api/rebind_notified': '换绑通知已读',
    '/api/login': '登录绑定',
    '/api/request_rebind': '申请换绑',
    '/api/check_login_status': '检查登录状态',
    '/api/urgent_event': '紧急事件',
    '/api/schedule': '课表查询',
    '/api/update_schedule': '更新课表',
    '/api/historical_schedule': '历年课表查询',
    '/api/member/api-key': '快捷指令密钥',
    '/api/shortcut/query': '快捷指令查询',
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


def _endpoint_name(path):
    endpoint_name = ENDPOINT_NAMES.get(path)
    if endpoint_name:
        return endpoint_name

    for prefix, name in ENDPOINT_NAMES.items():
        if path.startswith(prefix):
            return name
    return path


def init_logging(app, tracker=None, user_lookup=None):
    """注册在线状态钩子，保留旧函数名以兼容 app.py 的启动流程。"""
    tracker = tracker or online_tracker
    user_lookup = user_lookup or get_user_by_device

    @app.after_request
    def track_online_user(response):
        path = request.path
        if not path.startswith('/api/') or path.startswith('/api/admin/monitor'):
            return response

        device_id = (request.headers.get('X-Device-ID') or '').strip()
        if not device_id:
            return response

        username = ''
        try:
            user = user_lookup(device_id)
            if user:
                username = user.get('username', '')
        except Exception:
            pass

        tracker.touch(
            device_id,
            username=username,
            endpoint=_endpoint_name(path),
        )
        return response
