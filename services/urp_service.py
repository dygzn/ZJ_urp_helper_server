"""
URP 教务系统交互服务
"""
import os
import json
import re
import threading
import time
from datetime import datetime, timedelta

from URP import URP_login
from database import get_db
from services.config_service import (
    get_config,
    get_current_urp_url,
    normalize_urp_url,
    urp_url_fingerprint,
)
from urp.login import _is_vpn_url
from urp.session_store import (
    VPN_COOKIE_PREFIX,
    delete_user_cookies,
    user_cookie_exists,
)

# Login cache: {(username, url_fingerprint): timestamp}
_login_cache = {}
_login_locks = {}
_login_locks_guard = threading.Lock()
LOGIN_CACHE_TTL = 900


class _LoginDetails(dict):
    def __init__(self, cookies=None, relogged=False):
        super().__init__(cookies or {})
        self.relogged = relogged


def _login_key(username, url):
    return username, urp_url_fingerprint(url)


def _get_login_lock(key):
    with _login_locks_guard:
        return _login_locks.setdefault(key, threading.Lock())


def invalidate_login_cache(username, url=None):
    if url is not None:
        _login_cache.pop(_login_key(username, url), None)
        return
    for key in list(_login_cache):
        if key[0] == username:
            _login_cache.pop(key, None)


def _has_fresh_login_cache(username, url, now):
    timestamp = _login_cache.get(_login_key(username, url))
    if _is_vpn_url(url):
        return False
    return (
        timestamp is not None
        and now - timestamp < LOGIN_CACHE_TTL
        and user_cookie_exists(username, url)
    )


def _clear_non_vpn_session_cookies(urp):
    session = getattr(urp, 'x', None)
    cookies = getattr(session, 'cookies', None)
    if cookies is None:
        return
    for cookie in list(cookies):
        if str(cookie.name).upper().startswith(VPN_COOKIE_PREFIX):
            continue
        try:
            cookies.clear(cookie.domain, cookie.path, cookie.name)
        except KeyError:
            pass


def urp_login(username, password, url=None):
    """
    登录URP教务系统
    返回: (success: bool, message: str, cookies: dict)
    """
    target_url = normalize_urp_url(url or get_current_urp_url())
    try:
        urp = URP_login(target_url, username, password)
        return urp.login()
    except Exception as exc:
        return False, f'登录异常: {exc}', None


def check_login_status(username, password, cookies=None, url=None):
    """
    检查登录状态，如果未登录则重新登录
    返回: (is_logged_in: bool, cookies: dict)
    """
    target_url = normalize_urp_url(url or get_current_urp_url())
    key = _login_key(username, target_url)
    now = time.time()
    if _has_fresh_login_cache(username, target_url, now):
        return True, {}

    with _get_login_lock(key):
        now = time.time()
        if _has_fresh_login_cache(username, target_url, now):
            return True, {}

        urp = URP_login(target_url, username, password)
        if urp.is_logined():
            _login_cache[key] = now
            return True, _LoginDetails(urp.x.cookies.get_dict())

        invalidate_login_cache(username, target_url)
        delete_user_cookies(username, target_url)
        _clear_non_vpn_session_cookies(urp)
        try:
            success, message, new_cookies = urp.login()
        except Exception as exc:
            print(f'重新登录失败: {exc}')
            return False, {'message': f'登录异常: {exc}'}
        if not success:
            return False, {'message': message}

        _login_cache[key] = time.time()
        return True, _LoginDetails(
            new_cookies or urp.x.cookies.get_dict(),
            relogged=True,
        )


def _get_freshman_year():
    """返回当前最新一届新生的入学年份（4位整数）。
    每年 8 月份起换届：
      - 1–7 月：上一学年入学的新生（如 2026-03 → 2025）
      - 8–12 月：当年入学的新生（如 2026-09 → 2026）
    """
    now = datetime.now()
    return now.year if now.month >= 8 else now.year - 1


def _is_freshman(username):
    """判断用户是否属于最新一届新生（使用不同校区作息）。
    学号格式为 YY + 系科代码 + 流水号，前两位即入学年份（如 2415108133 → 24届）。
    """
    year = _get_freshman_year()
    if len(username) >= 2 and username[:2].isdigit():
        return int(username[:2]) == year % 100
    return False


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

    # 最新一届新生（另一校区）：45分钟/节，课间10分钟，大课间（2-3、6-7）15分钟
    # 上午 08:00 起，下午 13:30 起，晚上 18:30 起
    if _is_freshman(username):
        period_times = {
            1: ((8,  0),  (8, 45)),  2: ((8, 55),  (9, 40)),
            3: ((9, 55),  (10, 40)), 4: ((10, 50), (11, 35)),
            5: ((13, 30), (14, 15)), 6: ((14, 25), (15, 10)),
            7: ((15, 25), (16, 10)), 8: ((16, 20), (17, 5)),
            9: ((18, 30), (19, 15)), 10: ((19, 25), (20, 10)),
        }
    else:
        period_times = {
            1: ((8, 20), (9, 5)),   2: ((9, 15), (10, 0)),
            3: ((10, 15), (11, 0)), 4: ((11, 10), (11, 55)),
            5: ((14, 10), (14, 55)), 6: ((15, 5), (15, 50)),
            7: ((16, 5), (16, 50)), 8: ((17, 0), (17, 45)),
            9: ((19, 0), (19, 45)), 10: ((19, 55), (20, 40)),
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
        'next': next_event,
        'is_freshman': _is_freshman(username),
    }


def check_and_auto_update(username, password, url=None):
    """检查是否需要自动更新课表和考试表（每日首次访问）"""
    from datetime import date

    target_url = normalize_urp_url(url or get_current_urp_url())
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

        is_logged_in, _ = check_login_status(
            username,
            password,
            {},
            url=target_url,
        )
        if not is_logged_in:
            return False, '自动更新失败：教务登录不可用'

        try:
            from URP import URP_query

            query = URP_query(target_url, username)
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


def get_semesters(username):
    """获取所有学期列表"""
    from URP import URP_query
    url = get_current_urp_url()
    try:
        urp_query = URP_query(url, username)
        return urp_query.get_semesters()
    except Exception as e:
        print(f"获取学期列表失败: {str(e)}")
        return []


def get_current_semester_grades(username):
    """获取本学期成绩"""
    from URP import URP_query
    url = get_current_urp_url()
    urp_query = URP_query(url, username)
    courses = urp_query.score_current_semester()
    return [{'course': c.get('课程名', ''), 'score': c.get('成绩', '')} for c in courses]


def get_grades_by_semester(username, semester):
    """获取指定学期的及格成绩"""
    from URP import URP_query
    url = get_current_urp_url()
    try:
        urp_query = URP_query(url, username)
        courses = urp_query.score_by_semester(semester)
        return [{'course': c.get('课程名', ''), 'score': c.get('成绩', '')} for c in courses]
    except Exception as e:
        print(f"获取学期成绩失败: {str(e)}")
        return []


def _format_grade_courses(courses, include_failed_fields=False):
    result = []
    for c in courses:
        item = {
            'course': c.get('\u8bfe\u7a0b\u540d', ''),
            'score': c.get('\u6210\u7ee9', ''),
        }
        if include_failed_fields:
            item.update({
                'credit': c.get('\u5b66\u5206', ''),
                'exam_time': c.get('\u8003\u8bd5\u65f6\u95f4', ''),
            })
        result.append(item)
    return result


def _semester_sort_key(semester, fallback_index):
    text = str(semester or '')
    years = [int(y) for y in re.findall(r'(?:19|20)\d{2}', text)]
    if years:
        year_key = max(years)
    else:
        short_years = [int(y) for y in re.findall(r'(?<!\d)\d{2}(?!\d)', text)]
        year_key = 2000 + max(short_years) if short_years else -1

    term_key = 0
    term_match = re.search(r'第\s*([一二三四五六七八九十\d]+)\s*学期', text)
    if term_match:
        raw = term_match.group(1)
        cn_terms = {'一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10}
        term_key = int(raw) if raw.isdigit() else cn_terms.get(raw, 0)
    elif '下' in text:
        term_key = 2
    elif '上' in text:
        term_key = 1

    return (year_key, term_key, fallback_index)


def get_latest_semester_grade_summary(username):
    from URP import URP_query
    url = get_current_urp_url()
    urp_query = URP_query(url, username)

    semesters = [s for s in urp_query.get_semesters() if s]
    latest_semester = max(
        enumerate(semesters),
        key=lambda item: _semester_sort_key(item[1], item[0])
    )[1] if semesters else ''

    passed = urp_query.score_by_semester(latest_semester) if latest_semester else []
    failed = urp_query.score_failed()
    return {
        'semester': latest_semester,
        'passed': _format_grade_courses(passed),
        'failed': {
            'current': _format_grade_courses(failed.get('current', []), True),
            'past': _format_grade_courses(failed.get('past', []), True),
        }
    }

def get_failed_grades(username):
    """获取不及格成绩，分为尚不及格和曾不及格"""
    from URP import URP_query
    url = get_current_urp_url()
    urp_query = URP_query(url, username)
    result = urp_query.score_failed()
    def fmt(courses):
        return [{'course': c.get('课程名', ''), 'score': c.get('成绩', ''), 'credit': c.get('学分', ''), 'exam_time': c.get('考试时间', '')} for c in courses]
    return {'current': fmt(result.get('current', [])), 'past': fmt(result.get('past', []))}


def get_gpa(username):
    """获取学分绩点和学位绩点"""
    from URP import URP_query
    url = get_current_urp_url()
    try:
        urp_query = URP_query(url, username)
        return urp_query.score_gpa()
    except Exception as e:
        print(f"获取绩点失败: {str(e)}")
        return {}


def get_exam_sessions(username):
    """获取考试成绩查询的所有学期和考试名称列表"""
    from URP import URP_query
    url = get_current_urp_url()
    try:
        urp_query = URP_query(url, username)
        return urp_query.get_exam_sessions()
    except Exception as e:
        print(f"获取考试列表失败: {str(e)}")
        return {'semesters': [], 'exams': []}


def get_exam_scores(username, jxzxjh, ksbh):
    """查询指定考试的成绩"""
    from URP import URP_query
    url = get_current_urp_url()
    try:
        urp_query = URP_query(url, username)
        courses = urp_query.score_resit(jxzxjh, ksbh)
        return [{'course': c.get('课程名', ''), 'credit': c.get('学分', ''), 'score': c.get('成绩', '')} for c in courses]
    except Exception as e:
        print(f"查询考试成绩失败: {str(e)}")
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
        success, message = urp.do_evaluation(courses_data)
        if success:
            return True, f"成功评价 {len(courses_data)} 门课程"
        else:
            return False, message
    except Exception as e:
        return False, f"评价失败: {str(e)}"
