"""
教务数据相关路由
"""
import os
import json
import random
from flask import Blueprint, request, jsonify
from auth import require_login, require_bindding, require_member, require_grade_login
from database import get_db
from services.config_service import get_config
from services.urp_service import (
    get_urgent_event, get_schedule, get_exams, is_calendar_cache_stale,
    get_unevaluated_courses, do_evaluation, start_auto_update,
    check_login_status, get_semesters, get_grades_by_semester,
    get_failed_grades, get_gpa, get_current_semester_grades,
    get_latest_semester_grade_summary,
    get_exam_sessions, get_exam_scores, LEGACY_GRADES_ENDPOINT_MESSAGE
)
from services.config_service import get_current_urp_url
from services.temporary_session_service import current_temporary_session

data_bp = Blueprint('data', __name__)


@data_bp.route('/api/urgent_event', methods=['GET'])
@require_bindding
def api_urgent_event(user):
    try:
        if not current_temporary_session(user['username']):
            start_auto_update(user['username'], user['password'])

        event = get_urgent_event(user['username'])
        return jsonify({'success': True, 'event': event})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@data_bp.route('/api/schedule', methods=['GET'])
@require_bindding
def api_schedule(user):
    week = request.args.get('week', type=int)
    try:
        config = get_config()
        schedule = get_schedule(user['username'], week, config)
        schedule['cache_stale'] = is_calendar_cache_stale(user['username'], 'schedule', config)
        return jsonify({'success': True, 'data': schedule, 'account': user['username']})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@data_bp.route('/api/update_schedule', methods=['POST'])
@require_login
def api_update_schedule(user):
    try:
        from urp import URP_query

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
@require_bindding
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
@require_grade_login('basic')
def api_grades(user):
    """保留旧路径，但明确告知调用方改用新的成绩接口。"""
    return jsonify({
        'success': False,
        'error_code': 'deprecated_endpoint',
        'message': LEGACY_GRADES_ENDPOINT_MESSAGE,
    }), 410


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


@data_bp.route('/api/schedule/other_majors', methods=['GET'])
@require_bindding
def api_other_majors(user):
    """返回其他年级+专业+班级列表，格式：{grade: {major: [class, ...]}，仅含有课表缓存的组合"""
    my_username = user['username']
    with get_db() as conn:
        # 学号目录来自账号主表；users 只保存设备绑定，归档后可能为空。
        rows = conn.execute('SELECT username FROM user_account').fetchall()
    # result: {grade: {major: set(class_num)}}
    result = {}
    for row in rows:
        username = row['username']
        if len(username) < 10 or username == my_username:
            continue
        schedule_file = os.path.join('user_data', username, 'schedule.json')
        if not os.path.exists(schedule_file):
            continue
        grade = username[:2]
        major = username[4:7]
        class_num = username[7]  # 倒数第三位即第8位（0-indexed: index 7）
        result.setdefault(grade, {}).setdefault(major, set()).add(class_num)
    # 转为可序列化格式，排序
    serializable = {
        g: {m: sorted(classes) for m, classes in sorted(majors.items())}
        for g, majors in sorted(result.items())
    }
    return jsonify({'success': True, 'data': serializable})


@data_bp.route('/api/schedule/other_major', methods=['GET'])
@require_bindding
def api_other_major_schedule(user):
    """返回指定年级+专业+班级的脱敏课表，参数：grade（前2位）、major（第5-7位）、class_num（第8位）"""
    grade = request.args.get('grade', '').strip()
    major = request.args.get('major', '').strip()
    class_num = request.args.get('class_num', '').strip()
    if not grade or len(grade) != 2 or not major or len(major) != 3 or not class_num or len(class_num) != 1:
        return jsonify({'success': False, 'message': '请指定有效的年级、专业和班级'})

    with get_db() as conn:
        # 学号目录来自账号主表；users 只保存设备绑定，归档后可能为空。
        rows = conn.execute('SELECT username FROM user_account').fetchall()

    candidates = []
    for row in rows:
        username = row['username']
        if (len(username) >= 10 and username[:2] == grade
                and username[4:7] == major and username[7] == class_num):
            schedule_file = os.path.join('user_data', username, 'schedule.json')
            if os.path.exists(schedule_file):
                candidates.append((username, schedule_file))

    if not candidates:
        return jsonify({'success': False, 'message': f'暂无 {grade}级专业{major} {class_num}班 的课表数据'})

    username, schedule_file = random.choice(candidates)
    with open(schedule_file, 'r', encoding='utf-8') as f:
        raw = json.load(f)

    # 脱敏：只保留课程名、星期、节次、节数
    desensitized = {}
    for week, courses in raw.items():
        desensitized[week] = [
            {
                '课程名': c.get('课程名', ''),
                '星期': c.get('星期', ''),
                '节次': c.get('节次', ''),
                '节数': c.get('节数', ''),
            }
            for c in courses
        ]

    config = get_config()
    return jsonify({
        'success': True,
        'data': {
            'grade': grade,
            'major': major,
            'class_num': class_num,
            'schedule': desensitized,
            'semester_start': config.get('semester_start', ''),
        }
    })


@data_bp.route('/api/unevaluated_courses', methods=['GET'])
@require_member('basic')
def api_unevaluated_courses(user):
    try:
        courses = get_unevaluated_courses(user['username'])
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
@require_member('basic')
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
