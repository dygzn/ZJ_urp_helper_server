"""
URP 教务系统交互服务
"""
import os
import json
import time
from datetime import datetime, timedelta
from database import get_db
from services.config_service import get_config, get_current_urp_url

# 登录状态验证缓存：{username: timestamp}，15分钟内只验证一次
_login_cache = {}
LOGIN_CACHE_TTL = 900


def urp_login(username, password):
    """
    登录URP教务系统
    返回: (success: bool, message: str, cookies: dict)
    """
    from URP import URP_login
    url = get_current_urp_url()
    try:
        urp = URP_login(url, username, password)
        success, message, cookies = urp.login()
        return success, message, cookies
    except Exception as e:
        return False, f"登录异常: {str(e)}", None


def check_login_status(username, password, cookies):
    """
    检查登录状态，如果未登录则重新登录
    返回: (is_logged_in: bool, cookies: dict)
    """
    now = time.time()

    if username in _login_cache and now - _login_cache[username] < LOGIN_CACHE_TTL:
        cookie_file = f'user_data/{username}/cookie.json'
        if os.path.exists(cookie_file):
            return True, {}

    from URP import URP_login
    url = get_current_urp_url()
    urp = URP_login(url, username, password)

    is_logged_in = urp.is_logined()

    if is_logged_in is True:
        _login_cache[username] = now
        current_cookies = urp.x.cookies.get_dict()
        return True, current_cookies
    else:
        _login_cache.pop(username, None)
        cookie_file = f'user_data/{username}/cookie.json'
        if os.path.exists(cookie_file):
            os.remove(cookie_file)

        try:
            success, _, new_cookies = urp.login()
            if success:
                _login_cache[username] = now
                return True, new_cookies or urp.x.cookies.get_dict()
            else:
                return False, {}
        except Exception as e:
            print(f"重新登录失败: {str(e)}")
            return False, {}


def get_urgent_event(username):
    """获取正在进行的课程和下一个最紧急的事件"""
    schedule_file = os.path.join('user_data', username, 'schedule.json')
    exams_file = os.path.join('user_data', username, 'exams.json')

    config = get_config()
    semester_start_str = config.get('semester_start', '2026-03-02')
    y, m, d = map(int, semester_start_str.split('-'))
    semester_start = datetime(y, m, d)
    now = datetime.now().replace(microsecond=0)

    days_passed = (now - semester_start).days
    current_week = max(1, (days_passed // 7) + 1) if days_passed >= 0 else 0

    period_times = {
        1: ((8, 20), (9, 5)),   2: ((9, 15), (10, 0)),
        3: ((10, 15), (11, 0)), 4: ((11, 10), (11, 55)),
        5: ((14, 10), (14, 55)), 6: ((15, 5), (15, 50)),
        7: ((16, 5), (16, 50)), 8: ((17, 0), (17, 45)),
        9: ((19, 0), (19, 45)), 10: ((19, 55), (20, 40))
    }

    current_class = None
    next_class = None
    next_class_time = None

    if os.path.exists(schedule_file):
        with open(schedule_file, 'r', encoding='utf-8') as f:
            schedule = json.load(f)

        for week_str in sorted(schedule.keys(), key=int):
            week = int(week_str)
            if week < current_week:
                continue
            if current_class and next_class and week > current_week:
                break

            seen = set()
            for course in schedule[week_str]:
                day = int(course['星期'])
                period = int(course['节次'])
                duration = int(course.get('节数', 1))

                if period not in period_times:
                    continue

                end_period = period + duration - 1
                if end_period not in period_times:
                    end_period = max(p for p in period_times if p <= end_period) if any(p <= end_period for p in period_times) else period

                dedup_key = (week, day, period)
                if dedup_key in seen:
                    continue
                seen.add(dedup_key)

                days_offset = (week - 1) * 7 + (day - 1)
                course_date = semester_start + timedelta(days=days_offset)

                start_h, start_m = period_times[period][0]
                end_h, end_m = period_times[end_period][1]

                course_start = course_date.replace(hour=start_h, minute=start_m, second=0, microsecond=0)
                course_end   = course_date.replace(hour=end_h,   minute=end_m,   second=0, microsecond=0)

                if course_start <= now <= course_end:
                    remaining = int((course_end - now).total_seconds() / 60)
                    if current_class is None or course_start > datetime.fromisoformat(current_class.get('_start', '2000-01-01')):
                        current_class = {
                            'type': 'class',
                            'title': course['课程名'],
                            'location': course['位置'],
                            'time': f"{start_h:02d}:{start_m:02d}-{end_h:02d}:{end_m:02d}",
                            'remaining': remaining,
                            '_start': course_start.isoformat()
                        }
                elif course_start > now:
                    if next_class_time is None or course_start < next_class_time:
                        next_class_time = course_start
                        next_class = {
                            'type': 'class',
                            'title': course['课程名'],
                            'location': course['位置'],
                            'time': course_start.strftime('%Y-%m-%d %H:%M'),
                            'countdown': int((course_start - now).total_seconds() / 60)
                        }

    if current_class:
        current_class.pop('_start', None)

    next_exam = None
    next_exam_time = None

    if os.path.exists(exams_file):
        with open(exams_file, 'r', encoding='utf-8') as f:
            exams = json.load(f)

        for week_str in sorted(exams.keys(), key=int):
            week = int(week_str)
            if week < current_week:
                continue

            for exam in exams[week_str]:
                day = int(exam['考试星期'])
                time_range = exam['考试时间']
                start_str = time_range.split('-')[0]
                hour, minute = map(int, start_str.split(':'))

                days_offset = (week - 1) * 7 + (day - 1)
                exam_date = semester_start + timedelta(days=days_offset)
                exam_time = exam_date.replace(hour=hour, minute=minute, second=0, microsecond=0)

                if exam_time > now:
                    if next_exam_time is None or exam_time < next_exam_time:
                        next_exam_time = exam_time
                        next_exam = {
                            'type': 'exam',
                            'title': exam['课程'],
                            'location': exam['位置'],
                            'time': exam_date.strftime('%Y-%m-%d') + ' ' + time_range,
                            'countdown': int((exam_time - now).total_seconds() / 60),
                            'seat': exam['座位号']
                        }

    next_event = None
    if next_class and next_exam:
        next_event = next_class if next_class_time < next_exam_time else next_exam
    elif next_class:
        next_event = next_class
    elif next_exam:
        next_event = next_exam

    return {
        'current': current_class,
        'next': next_event
    }


def check_and_auto_update(username, password):
    """检查是否需要自动更新课表和考试表（每日首次访问）"""
    from datetime import date
    today = date.today().isoformat()

    with get_db() as conn:
        cursor = conn.execute(
            'SELECT last_auto_update FROM users WHERE username = ?',
            (username,)
        )
        row = cursor.fetchone()

        if row is None:
            return False, '用户不存在'

        last_update = row[0]
        if last_update == today:
            return False, '今日已更新'

        try:
            from URP import URP_login, URP_query
            url = get_current_urp_url()

            urp = URP_login(url, username, password)
            if not urp.is_logined():
                urp.login()

            query = URP_query(url, username)
            query.schedule_cx()
            query.exam_cx()

            conn.execute(
                'UPDATE users SET last_auto_update = ? WHERE username = ?',
                (today, username)
            )
            conn.commit()

            return True, '自动更新成功'

        except Exception as e:
            return False, f'自动更新失败: {str(e)}'


def get_schedule(username, week=None):
    """读取课表文件"""
    schedule_file = os.path.join('user_data', username, 'schedule.json')

    if not os.path.exists(schedule_file):
        return {
            'week': week,
            'schedule': {},
            'message': '课表文件不存在，请先生成课表'
        }

    try:
        with open(schedule_file, 'r', encoding='utf-8') as f:
            schedule_data = json.load(f)

        if week is not None:
            week_str = str(week)
            if week_str in schedule_data:
                return {'week': week, 'schedule': {week_str: schedule_data[week_str]}}
            else:
                return {'week': week, 'schedule': {}, 'message': f'第{week}周没有课程'}

        return {
            'week': None,
            'schedule': schedule_data,
            'semester_start': get_config().get('semester_start', '2026-03-02')
        }
    except Exception as e:
        return {'week': week, 'schedule': {}, 'message': f'读取课表失败: {str(e)}'}


def get_exams(username):
    """读取考试安排文件"""
    exams_file = os.path.join('user_data', username, 'exams.json')

    if not os.path.exists(exams_file):
        return []

    try:
        with open(exams_file, 'r', encoding='utf-8') as f:
            exams_data = json.load(f)

        result = []
        if isinstance(exams_data, dict):
            for week, exams in exams_data.items():
                if isinstance(exams, list):
                    for exam in exams:
                        result.append({
                            'exam_name': exam.get('考试名', ''),
                            'course': exam.get('课程', ''),
                            'time': exam.get('考试时间', ''),
                            'week': exam.get('考试周次', ''),
                            'day': exam.get('考试星期', ''),
                            'location': exam.get('位置', ''),
                            'seat': exam.get('座位号', '')
                        })
            return result

        if isinstance(exams_data, list):
            return exams_data

        return []
    except Exception as e:
        print(f"读取考试安排失败: {str(e)}")
        return []


def get_grades(username):
    """获取成绩"""
    from URP import URP_query
    url = get_current_urp_url()
    try:
        urp_query = URP_query(url, username)
        courses = urp_query.score_query()
        return [{'course': c.get('课程名', ''), 'score': c.get('成绩', '')} for c in courses]
    except Exception as e:
        print(f"获取成绩失败: {str(e)}")
        return []


def get_unevaluated_courses(username):
    """获取未评估的课程列表"""
    try:
        from URP import URP_query
        urp_url = get_current_urp_url()
        query = URP_query(urp_url, username)
        return query.check_evaluation()
    except Exception as e:
        print(f"获取未评估课程失败: {str(e)}")
        return None


def do_evaluation(username, courses_data):
    """执行教务评价"""
    try:
        from URP import URP_query
        urp_url = get_current_urp_url()
        urp = URP_query(urp_url, username)
        result = urp.do_evaluation(courses_data)
        if result:
            return True, f"成功评价 {len(courses_data)} 门课程"
        else:
            return False, "评价失败"
    except Exception as e:
        return False, f"评价失败: {str(e)}"
