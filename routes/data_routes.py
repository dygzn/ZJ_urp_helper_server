"""
教务数据相关路由
"""
import os
import json
from flask import Blueprint, request, jsonify
from auth import require_login, require_binding, require_member, require_grade_login, require_member_login
from database import get_db
from services.config_service import get_config
from services.urp_service import (
    get_urgent_event, get_schedule, get_exams, is_calendar_cache_stale,
    get_unevaluated_courses, do_evaluation,
    get_semesters, get_grades_by_semester,
    get_failed_grades, get_gpa, get_current_semester_grades,
    get_latest_semester_grade_summary,
    get_exam_sessions, get_exam_scores, get_latest_makeup_grade_summary,
)
from services.config_service import get_current_urp_url

data_bp = Blueprint('data', __name__)


@data_bp.route('/api/urgent_event', methods=['GET'])
@require_binding
def api_urgent_event(user):
    try:
        event = get_urgent_event(user['username'])
        return jsonify({'success': True, 'event': event})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@data_bp.route('/api/schedule', methods=['GET'])
@require_binding
def api_schedule(user):
    week = request.args.get('week', type=int)
    try:
        config = get_config()
        schedule = get_schedule(user['username'], week, config)
        schedule['cache_stale'] = is_calendar_cache_stale(user['username'], 'schedule', config)
        exams = get_exams(user['username'])
        schedule['exams'] = [exam for exam in exams if week is None or str(exam.get('week')) == str(week)]
        schedule['exams_cache_stale'] = is_calendar_cache_stale(user['username'], 'exams', config)
        schedule['semester_start'] = config.get('semester_start', '')
        return jsonify({'success': True, 'data': schedule, 'account': user['username']})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@data_bp.route('/api/update_schedule', methods=['POST'])
@require_login
def api_update_schedule(user):
    try:
        from urp import URP_query

        username = user['username']
        current_url = get_current_urp_url()
        urp = URP_query(current_url, username)
        schedule_data = urp.schedule_cx()

        return jsonify({'success': True, 'message': '课程表更新成功', 'data': schedule_data})
    except Exception as e:
        return jsonify({'success': False, 'message': f'更新失败: {str(e)}'})


@data_bp.route('/api/historical_schedule', methods=['GET'])
@require_login
def api_historical_schedule(user):
    """查询指定历史学期的完整课表网格，不覆盖当前课表缓存。"""
    try:
        from urp import URP_query

        semester = request.args.get('semester', '').strip()
        current_url = get_current_urp_url()
        urp = URP_query(current_url, user['username'])
        historical_data = urp.historical_schedule_cx(semester)
        return jsonify({'success': True, 'data': historical_data})
    except Exception as e:
        return jsonify({'success': False, 'message': f'历年课表查询失败: {str(e)}'})


@data_bp.route('/api/exams', methods=['GET'])
@require_binding
def api_exams(user):
    try:
        exams = get_exams(user['username'])
        config = get_config()
        return jsonify({
            'success': True,
            'exams': exams,
            'account': user['username'],
            'semester_start': config.get('semester_start', ''),
            'cache_stale': is_calendar_cache_stale(user['username'], 'exams', config),
        })
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@data_bp.route('/api/update_exams', methods=['POST'])
@require_login
def api_update_exams(user):
    try:
        from urp import URP_query

        username = user['username']
        current_url = get_current_urp_url()
        urp = URP_query(current_url, username)
        exams_data = urp.exam_cx()

        return jsonify({'success': True, 'message': '考试安排更新成功', 'data': exams_data})
    except Exception as e:
        return jsonify({'success': False, 'message': f'更新失败: {str(e)}'})


@data_bp.route('/api/grades/current', methods=['GET'])
@require_grade_login('basic')
def api_grades_current(user):
    try:
        grades = get_current_semester_grades(user['username'])
        return jsonify({'success': True, 'grades': grades})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})

@data_bp.route('/api/grades/latest_summary', methods=['GET'])
@require_grade_login('basic')
def api_grades_latest_summary(user):
    try:
        result = get_latest_semester_grade_summary(user['username'])
        return jsonify({'success': True, **result})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})

@data_bp.route('/api/grades/semesters', methods=['GET'])
@require_grade_login('basic')
def api_grade_semesters(user):
    try:
        semesters = get_semesters(user['username'])
        return jsonify({'success': True, 'semesters': semesters})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@data_bp.route('/api/grades/by_semester', methods=['GET'])
@require_grade_login('basic')
def api_grades_by_semester(user):
    semester = request.args.get('semester', '')
    if not semester:
        return jsonify({'success': False, 'message': '请指定学期'})
    try:
        grades = get_grades_by_semester(user['username'], semester)
        return jsonify({'success': True, 'grades': grades, 'semester': semester})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@data_bp.route('/api/grades/failed', methods=['GET'])
@require_grade_login('basic')
def api_grades_failed(user):
    try:
        result = get_failed_grades(user['username'])
        return jsonify({'success': True, 'current': result['current'], 'past': result['past']})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@data_bp.route('/api/grades/gpa', methods=['GET'])
@require_grade_login('basic')
def api_grades_gpa(user):
    try:
        gpa = get_gpa(user['username'])
        return jsonify({'success': True, 'gpa': gpa})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@data_bp.route('/api/grades/exam_sessions', methods=['GET'])
@require_grade_login('basic')
def api_exam_sessions(user):
    try:
        sessions = get_exam_sessions(user['username'])
        return jsonify({'success': True, **sessions})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@data_bp.route('/api/grades/exam_scores', methods=['GET'])
@require_grade_login('basic')
def api_exam_scores(user):
    jxzxjh = request.args.get('jxzxjh', '')
    ksbh = request.args.get('ksbh', '')
    if not jxzxjh or not ksbh:
        return jsonify({'success': False, 'message': '请指定学期和考试名称'})
    try:
        grades = get_exam_scores(user['username'], jxzxjh, ksbh)
        return jsonify({'success': True, 'grades': grades})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@data_bp.route('/api/grades/latest_makeup', methods=['GET'])
@require_grade_login('basic')
def api_latest_makeup_grades(user):
    try:
        return jsonify({'success': True, **get_latest_makeup_grade_summary(user['username'])})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@data_bp.route('/api/unevaluated_courses', methods=['GET'])
@require_member_login('basic')
def api_unevaluated_courses(user):
    try:
        courses = get_unevaluated_courses(user['username'])
        if courses is None:
            return jsonify({'success': False, 'message': '查询失败，请稍后重试'})
        if not courses:
            return jsonify({
                'success': True,
                'has_courses': False,
                'message': '当前没有需要评估的课程，可能尚未到评估时间或评估已结束',
                'courses': []
            })
        return jsonify({'success': True, 'has_courses': True, 'courses': courses})
    except Exception as e:
        return jsonify({'success': False, 'message': f'查询失败: {str(e)}'})


@data_bp.route('/api/evaluation', methods=['POST'])
@require_member_login('basic')
def api_evaluation(user):
    try:
        data = request.get_json()
        courses_data = data.get('courses', [])
        if not courses_data:
            return jsonify({'success': False, 'message': '没有课程数据'})
        success, message = do_evaluation(user['username'], courses_data)
        return jsonify({'success': success, 'message': message})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@data_bp.route('/api/schedule/personal', methods=['POST'])
@data_bp.route('/api/schedule/personal/<event_id>', methods=['PATCH', 'DELETE'])
@data_bp.route('/api/schedule/overrides/<event_id>', methods=['PUT', 'DELETE'])
@data_bp.route('/api/schedule/undo', methods=['POST'])
@require_binding
def api_personal_schedule(user, event_id=None):
    from services.personal_schedule_service import mutate_schedule, ScheduleError
    from services.urp_service import read_raw_schedule, get_schedule_period_times
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({'success':False,'message':'请求格式错误'}),400
    payload = dict(payload)
    if event_id: payload['event_id'] = event_id
    if request.path == '/api/schedule/undo':
        action = 'undo'
    elif '/overrides/' in request.path:
        action = 'restore' if request.method == 'DELETE' else 'override'
    else:
        action = {'POST':'create','PATCH':'update','DELETE':'delete'}[request.method]
    try:
        config = get_config()
        result = mutate_schedule(user,action,payload,read_raw_schedule(user['username'],config),config,get_schedule_period_times(user['username']))
        message = '已撤销刚才的修改' if action=='undo' else '课程已保存' if action not in ('delete','restore') else '课表已更新'
        return jsonify({'success':True,'message':message,'data':result})
    except ScheduleError as exc:
        return jsonify({'success':False,'message':str(exc)}),exc.status
