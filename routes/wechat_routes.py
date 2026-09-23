"""微信小程序登录、独立绑定及专用数据接口。"""
from datetime import datetime
import re
from flask import Blueprint, jsonify, request, current_app
from auth import require_wechat_session, require_admin
from database import get_db
from services.urp_service import urp_login
from services.wechat_auth_service import WechatAuthError, code_to_session, create_session
from services.wechat_account_service import get_account, bind_account, unbind_account, BindingConflict
from services.wechat_access import require_wechat_account
from services import urp_service as urp
from services.ad_config_service import get_ad_config
from services.ad_service import EVENT_COLUMNS, record_ad_event
from services.config_service import get_current_urp_url

wechat_bp = Blueprint('wechat', __name__)


def body():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def membership_summary(username):
    summary = {'is_member': False, 'member_type': None, 'expire_time': None, 'is_expired': False}
    if not username:
        return summary
    with get_db() as conn:
        row = conn.execute(
            'SELECT member_type, expire_time FROM memberships WHERE username = ?',
            (username,),
        ).fetchone()
    if not row:
        return summary
    expire_time = row['expire_time']
    expire_value = expire_time.isoformat() if isinstance(expire_time, datetime) else (str(expire_time) if expire_time is not None else None)
    try:
        expire_dt = expire_time if isinstance(expire_time, datetime) else datetime.fromisoformat(expire_value)
        is_expired = datetime.now() > expire_dt
    except (TypeError, ValueError):
        is_expired = True
    summary.update({
        'is_member': not is_expired,
        'member_type': row['member_type'] if not is_expired else None,
        'expire_time': expire_value,
        'is_expired': is_expired,
    })
    return summary


@wechat_bp.post('/api/wechat/session')
def create_wechat_session():
    code = body().get('code')
    if not isinstance(code, str) or not code.strip():
        return jsonify(success=False, message='缺少微信登录凭证'), 400
    try:
        identity = code_to_session(code)
        token = create_session(identity['openid'])
        account = get_account(identity['openid'])
        result = dict(success=True, token=token, bound=bool(account))
        if account:
            result['username'] = account['username']
        return jsonify(result)
    except WechatAuthError as exc:
        return jsonify(success=False, message=str(exc)), 400
    except Exception:
        current_app.logger.exception('微信登录失败')
        return jsonify(success=False, message='微信登录失败，请稍后重试'), 500


@wechat_bp.get('/api/wechat/account')
@require_wechat_session
def account_status(wechat_session):
    account = get_account(wechat_session['openid'])
    username = account['username'] if account else ''
    return jsonify(success=True, bound=bool(account), username=username, membership=membership_summary(username))


@wechat_bp.post('/api/wechat/bind')
@require_wechat_session
def bind_wechat_account(wechat_session):
    data = body()
    username, password = data.get('username', ''), data.get('password', '')
    if not isinstance(username, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', username.strip()):
        return jsonify(success=False, message='请输入有效学号'), 400
    username = username.strip()
    if not isinstance(password, str) or not password or len(password) > 256:
        return jsonify(success=False, message='请输入教务密码'), 400
    existing = get_account(wechat_session['openid'])
    if existing and existing['username'] != username:
        return jsonify(success=False, message='请先解绑当前学号'), 409
    success, message, _ = urp_login(username, password)
    if not success:
        return jsonify(success=False, message=message or '教务验证失败'), 400
    try:
        bind_account(wechat_session['openid'], username, password)
    except BindingConflict as exc:
        return jsonify(success=False, message=str(exc)), 409
    return jsonify(success=True, bound=True, username=username, message='学号绑定成功')


@wechat_bp.delete('/api/wechat/binding')
@require_wechat_session
def unbind_wechat_account(wechat_session):
    unbind_account(wechat_session['openid'])
    return jsonify(success=True, bound=False, message='已解绑学号')


@wechat_bp.get('/api/wechat/urgent_event')
@require_wechat_account()
def urgent_event(account):
    return jsonify(success=True, event=urp.get_urgent_event(account['username']))


@wechat_bp.get('/api/wechat/schedule')
@require_wechat_account()
def schedule(account):
    week = request.args.get('week', type=int)
    if 'week' in request.args and (week is None or not 1 <= week <= 60):
        return jsonify(success=False, message='周次必须在 1 至 60 之间'), 400
    return jsonify(success=True, data=urp.get_schedule(account['username'], week))


@wechat_bp.post('/api/wechat/update_schedule')
@require_wechat_account(login=True)
def update_schedule(account):
    from urp import URP_query
    query = URP_query(get_current_urp_url(), account['username'])
    query.schedule_cx()
    return jsonify(success=True, data=urp.get_schedule(account['username']), message='课表已更新')


@wechat_bp.post('/api/wechat/refresh_events')
@require_wechat_account(login=True)
def refresh_events(account):
    from urp import URP_query
    query = URP_query(get_current_urp_url(), account['username'])
    query.schedule_cx()
    query.exam_cx()
    return jsonify(success=True, event=urp.get_urgent_event(account['username']))


@wechat_bp.get('/api/wechat/exams')
@require_wechat_account(login=True)
def exams(account):
    return jsonify(success=True, exams=urp.get_exams(account['username']))


@wechat_bp.post('/api/wechat/update_exams')
@require_wechat_account(login=True)
def update_exams(account):
    from urp import URP_query
    query = URP_query(get_current_urp_url(), account['username'])
    query.exam_cx()
    return jsonify(success=True, exams=urp.get_exams(account['username']), message='考试安排已更新')


@wechat_bp.get('/api/wechat/historical_schedule')
@require_wechat_account(login=True)
def historical_schedule(account):
    from urp import URP_query
    semester = request.args.get('semester', '').strip()
    if len(semester) > 100:
        return jsonify(success=False, message='请选择学期'), 400
    query = URP_query(get_current_urp_url(), account['username'])
    return jsonify(success=True, data=query.historical_schedule_cx(semester))


@wechat_bp.get('/api/wechat/semesters')
@require_wechat_account(login=True)
def semesters(account):
    try:
        result = urp.get_semesters(account['username'])
    except Exception:
        current_app.logger.exception('微信学期查询失败')
        return jsonify(success=False, message='教务查询失败，请稍后重试'), 502
    return jsonify(success=True, semesters=result)


@wechat_bp.get('/api/wechat/grades/<kind>')
@require_wechat_account(login=True, grades=True)
def grades(account, kind):
    username = account['username']
    try:
        if kind == 'current':
            result = {'grades': urp.get_current_semester_grades(username)}
        elif kind == 'latest_summary':
            result = urp.get_latest_semester_grade_summary(username)
        elif kind == 'semesters':
            result = {'semesters': urp.get_semesters(username)}
        elif kind == 'by_semester':
            semester = request.args.get('semester', '').strip()
            if not semester:
                return jsonify(success=False, message='请选择学期'), 400
            result = {'grades': urp.get_grades_by_semester(username, semester)}
        elif kind == 'failed':
            result = urp.get_failed_grades(username)
        elif kind == 'gpa':
            result = {'gpa': urp.get_gpa(username)}
        elif kind == 'exam_sessions':
            result = urp.get_exam_sessions(username)
        elif kind == 'exam_scores':
            term, exam = request.args.get('jxzxjh', ''), request.args.get('ksbh', '')
            if not term or not exam:
                return jsonify(success=False, message='请选择考试'), 400
            result = {'grades': urp.get_exam_scores(username, term, exam)}
        else:
            return jsonify(success=False, message='查询类型不存在'), 404
    except Exception:
        current_app.logger.exception('微信成绩查询失败')
        return jsonify(success=False, message='教务查询失败，请稍后重试'), 502
    return jsonify(success=True, **result)


@wechat_bp.get('/api/wechat/unevaluated_courses')
@require_wechat_account(login=True, member=True)
def unevaluated_courses(account):
    courses = urp.get_unevaluated_courses(account['username'])
    if courses is None:
        return jsonify(success=False, message='教务查询失败，请稍后重试'), 502
    return jsonify(success=True, courses=courses)


@wechat_bp.post('/api/wechat/evaluation')
@require_wechat_account(login=True, member=True)
def evaluation(account):
    if body().get('confirmed') is not True:
        return jsonify(success=False, message='请先确认提交评教'), 400
    courses = urp.get_unevaluated_courses(account['username'])
    if courses is None:
        return jsonify(success=False, message='教务查询失败，请重试'), 502
    if body().get('courses') != courses:
        return jsonify(success=False, message='待评课程已变化，请刷新后重新确认'), 409
    if not courses:
        return jsonify(success=True, message='当前没有待评课程')
    success, message = urp.do_evaluation(account['username'], courses)
    return jsonify(success=success, message=message)


@wechat_bp.get('/api/wechat/advertisement')
def advertisement():
    ad = get_ad_config()
    return jsonify(success=True, data=ad if ad['enabled'] else {'enabled': False})


@wechat_bp.post('/api/wechat/ad/event')
@require_wechat_session
def ad_event(wechat_session):
    event = body().get('event')
    if not isinstance(event, str) or event not in EVENT_COLUMNS:
        return jsonify(success=False, message='无效的广告事件'), 400
    if get_ad_config()['enabled']:
        account = get_account(wechat_session['openid'])
        record_ad_event(event, username=account['username'] if account else None)
    return jsonify(success=True)


@wechat_bp.get('/api/admin/wechat/bindings')
@require_admin
def admin_bindings():
    page = max(1, request.args.get('page', 1, type=int))
    username = request.args.get('username', '').strip()
    where = 'username IS NOT NULL' + (' AND username = ?' if username else '')
    params = (username,) if username else ()
    with get_db() as conn:
        rows = conn.execute(f'SELECT openid, username, bind_time, updated_at FROM wechat_account_bindings WHERE {where} ORDER BY updated_at DESC LIMIT 50 OFFSET ?', (*params, (page - 1) * 50)).fetchall()
        count = conn.execute(f'SELECT COUNT(*) AS n FROM wechat_account_bindings WHERE {where}', params).fetchone()['n']
    return jsonify(success=True, data=[dict(row) for row in rows], total=count, page=page)


@wechat_bp.delete('/api/admin/wechat/bindings/<openid>')
@require_admin
def admin_unbind(openid):
    unbind_account(openid)
    return jsonify(success=True, message='微信绑定已解除')


@wechat_bp.errorhandler(Exception)
def api_error(error):
    from werkzeug.exceptions import HTTPException
    if isinstance(error, HTTPException):
        return jsonify(success=False, message=error.description), error.code
    current_app.logger.exception('小程序接口失败')
    return jsonify(success=False, message='服务暂时不可用，请稍后重试'), 500
