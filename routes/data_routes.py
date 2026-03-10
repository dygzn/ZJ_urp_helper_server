"""
教务数据相关路由
"""
import threading
from flask import Blueprint, request, jsonify
from auth import require_login, require_bindding
from services.urp_service import (
    get_urgent_event, get_schedule, get_exams, get_grades,
    get_unevaluated_courses, do_evaluation, check_and_auto_update,
    check_login_status, get_semesters, get_grades_by_semester,
    get_failed_grades, get_gpa, get_current_semester_grades
)
from services.config_service import get_current_urp_url

data_bp = Blueprint('data', __name__)


@data_bp.route('/api/urgent_event', methods=['GET'])
@require_bindding
def api_urgent_event(user):
    try:
        threading.Thread(
            target=check_and_auto_update,
            args=(user['username'], user['password']),
            daemon=True
        ).start()

        event = get_urgent_event(user['username'])
        return jsonify({'success': True, 'event': event})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@data_bp.route('/api/schedule', methods=['GET'])
@require_bindding
def api_schedule(user):
    week = request.args.get('week', type=int)
    try:
        schedule = get_schedule(user['username'], week)
        return jsonify({'success': True, 'data': schedule})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@data_bp.route('/api/update_schedule', methods=['POST'])
@require_login
def api_update_schedule(user):
    try:
        from URP import URP_query

        username = user['username']
        password = user['password']

        is_logged_in, _ = check_login_status(username, password, {})
        if not is_logged_in:
            return jsonify({'success': False, 'message': '登录已过期，请重新登录'})

        current_url = get_current_urp_url()
        urp = URP_query(current_url, username)
        schedule_data = urp.schedule_cx()

        return jsonify({'success': True, 'message': '课程表更新成功', 'data': schedule_data})
    except Exception as e:
        return jsonify({'success': False, 'message': f'更新失败: {str(e)}'})


@data_bp.route('/api/exams', methods=['GET'])
@require_bindding
def api_exams(user):
    try:
        exams = get_exams(user['username'])
        return jsonify({'success': True, 'exams': exams})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@data_bp.route('/api/update_exams', methods=['POST'])
@require_login
def api_update_exams(user):
    try:
        from URP import URP_query

        username = user['username']
        password = user['password']

        is_logged_in, _ = check_login_status(username, password, {})
        if not is_logged_in:
            return jsonify({'success': False, 'message': '登录已过期，请重新登录'})

        current_url = get_current_urp_url()
        urp = URP_query(current_url, username)
        exams_data = urp.exam_cx()

        return jsonify({'success': True, 'message': '考试安排更新成功', 'data': exams_data})
    except Exception as e:
        return jsonify({'success': False, 'message': f'更新失败: {str(e)}'})


@data_bp.route('/api/grades', methods=['GET'])
@require_login
def api_grades(user):
    try:
        grades = get_grades(user['username'])
        return jsonify({'success': True, 'grades': grades})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@data_bp.route('/api/grades/current', methods=['GET'])
@require_login
def api_grades_current(user):
    try:
        grades = get_current_semester_grades(user['username'])
        return jsonify({'success': True, 'grades': grades})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@data_bp.route('/api/grades/semesters', methods=['GET'])
@require_login
def api_grade_semesters(user):
    try:
        semesters = get_semesters(user['username'])
        return jsonify({'success': True, 'semesters': semesters})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@data_bp.route('/api/grades/by_semester', methods=['GET'])
@require_login
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
@require_login
def api_grades_failed(user):
    try:
        grades = get_failed_grades(user['username'])
        return jsonify({'success': True, 'grades': grades})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@data_bp.route('/api/grades/gpa', methods=['GET'])
@require_login
def api_grades_gpa(user):
    try:
        gpa = get_gpa(user['username'])
        return jsonify({'success': True, 'gpa': gpa})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@data_bp.route('/api/unevaluated_courses', methods=['GET'])
@require_login
def api_unevaluated_courses(user):
    try:
        courses = get_unevaluated_courses(user['username'])
        if courses is None:
            return jsonify({'success': True, 'has_courses': False, 'message': '没有未评估的课程', 'courses': []})
        return jsonify({'success': True, 'has_courses': True, 'courses': courses})
    except Exception as e:
        return jsonify({'success': False, 'message': f'查询失败: {str(e)}'})


@data_bp.route('/api/evaluation', methods=['POST'])
@require_login
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
