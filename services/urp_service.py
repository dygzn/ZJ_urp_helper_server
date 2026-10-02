"""
URP 教务系统交互服务
"""
import os
import json
import re
import threading
import time
from datetime import datetime, timedelta
from database import get_db
from services.config_service import get_config, get_current_urp_url
from services.temporary_session_service import current_temporary_session, user_data_file

# 登录状态验证缓存：{username: timestamp}，15分钟内只验证一次
_login_cache = {}
LOGIN_CACHE_TTL = 900
_auto_update_state_lock = threading.Lock()
_auto_update_running = set()
_auto_update_context = threading.local()
LEGACY_GRADES_ENDPOINT_MESSAGE = (
    '该成绩接口已停用，请使用 /api/grades/latest_summary 或 /api/grades/current'
)


def urp_login(username, password, persist_cookies=True):
    """
    登录URP教务系统
    返回: (success: bool, message: str, cookies: dict)
    """
    from urp import URP_login
    url = get_current_urp_url()
    try:
        urp = URP_login(url, username, password, persist_cookies=persist_cookies)
        success, message, cookies = urp.login()
        return success, message, cookies
    except Exception as e:
        return False, f"登录异常: {str(e)}", None


def check_login_status(username, password, cookies):
    """检查教务登录状态；临时会话只使用自己的十分钟文件目录。"""
    now = time.time()
    url = get_current_urp_url()
    temporary = current_temporary_session(username)

    from urp import URP_login
    from urp.login import _is_vpn_url

    cookie_file = user_data_file(username, 'cookie.json')
    if not temporary and not _is_vpn_url(url) and username in _login_cache and now - _login_cache[username] < LOGIN_CACHE_TTL:
        if os.path.exists(cookie_file):
            return True, {}

    urp = URP_login(url, username, password, cookie_path=cookie_file)
    if urp.is_logined():
        if not temporary:
            _login_cache[username] = now
        return True, urp.x.cookies.get_dict()

    # 临时模式只有 Cookie；失效后等待用户重新输入密码，不尝试自动登录。
    if temporary:
        return False, {}

    if not temporary:
        _login_cache.pop(username, None)
    if os.path.exists(cookie_file):
        os.remove(cookie_file)

    try:
        success, _, new_cookies = urp.login()
        if success:
            if not temporary:
                _login_cache[username] = now
            return True, new_cookies or urp.x.cookies.get_dict()
        return False, {}
    except Exception as exc:
        print(f"重新登录失败: {str(exc)}")
        return False, {}


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


def _parse_semester_start(value):
    """解析管理员配置的学期首周星期一，非法值返回 None。"""
    try:
        parsed = datetime.strptime(str(value or '').strip(), '%Y-%m-%d')
    except (TypeError, ValueError):
        return None
    return parsed if parsed.weekday() == 0 else None


def _build_upcoming_classes(schedule, semester_start, now, period_times, current_week=1):
    """整理今天（或下一个有课日）的全部课程，并保留倒计时信息。"""
    if not isinstance(schedule, dict):
        return {
            'courses': [],
            'label': '今日安排',
            'date': None,
            'current': None,
            'next': None,
            'next_time': None,
        }

    def week_number(value):
        try:
            return int(value)
        except (TypeError, ValueError):
            return 10 ** 9

    def location_of(course):
        location = course.get('位置')
        if location:
            return str(location)
        return ''.join(str(course.get(key, '') or '') for key in ('校区', '教学楼', '教室')).strip()

    entries = []
    for week_key in sorted(schedule.keys(), key=week_number):
        week = week_number(week_key)
        if week == 10 ** 9 or week < current_week:
            continue
        seen = set()
        for course in schedule.get(week_key) or []:
            if not isinstance(course, dict):
                continue
            try:
                day = int(course.get('星期'))
                period = int(course.get('节次'))
                duration = max(1, int(course.get('节数', 1)))
            except (TypeError, ValueError):
                continue
            if period not in period_times or day < 1 or day > 7:
                continue

            dedup_key = (week, day, period)
            if dedup_key in seen:
                continue
            seen.add(dedup_key)

            end_period = period + duration - 1
            if end_period not in period_times:
                valid_periods = [item for item in period_times if item <= end_period]
                end_period = max(valid_periods) if valid_periods else period

            days_offset = (week - 1) * 7 + (day - 1)
            course_date = semester_start + timedelta(days=days_offset)
            start_h, start_m = period_times[period][0]
            end_h, end_m = period_times[end_period][1]
            course_start = course_date.replace(hour=start_h, minute=start_m, second=0, microsecond=0)
            course_end = course_date.replace(hour=end_h, minute=end_m, second=0, microsecond=0)

            if course_end < now:
                continue

            is_current = course_start <= now <= course_end
            start_delta = max(0, int((course_start - now).total_seconds() / 60))
            remaining = max(0, int((course_end - now).total_seconds() / 60))
            entries.append({
                'type': 'class',
                'title': str(course.get('课程名') or '课程'),
                'location': location_of(course),
                'time': f'{start_h:02d}:{start_m:02d}-{end_h:02d}:{end_m:02d}',
                'date': course_date.strftime('%Y-%m-%d'),
                'day': day,
                'week': week,
                'status': 'current' if is_current else 'upcoming',
                'countdown': start_delta,
                'remaining': remaining,
                'start_at': course_start.isoformat(),
                'end_at': course_end.isoformat(),
                '_start_dt': course_start,
                '_end_dt': course_end,
            })

    entries.sort(key=lambda item: item['_start_dt'])
    current_entries = [item for item in entries if item['status'] == 'current']
    current = max(current_entries, key=lambda item: item['_start_dt']) if current_entries else None
    future_entries = [item for item in entries if item['status'] == 'upcoming']
    next_class = future_entries[0] if future_entries else None

    today = now.date()
    today_entries = [item for item in entries if item['_start_dt'].date() == today]
    if today_entries:
        target_date = today
        label = '今日安排'
    else:
        future_dates = sorted({item['_start_dt'].date() for item in entries if item['_start_dt'].date() > today})
        target_date = future_dates[0] if future_dates else None
        tomorrow = today + timedelta(days=1)
        label = '明日安排' if target_date == tomorrow else (
            f'{target_date.month}月{target_date.day}日安排' if target_date else '今日安排'
        )

    def public(item):
        if not item:
            return None
        return {key: value for key, value in item.items() if not key.startswith('_')}

    courses = [public(item) for item in entries if target_date and item['_start_dt'].date() == target_date]
    public_next = public(next_class)
    if public_next:
        public_next['time_range'] = public_next['time']
        public_next['time'] = f"{public_next['date']} {public_next['time'].split('-')[0]}"

    return {
        'courses': courses,
        'label': label,
        'date': target_date.isoformat() if target_date else None,
        'current': public(current),
        'next': public_next,
        'next_time': next_class['_start_dt'] if next_class else None,
    }


def get_urgent_event(username):
    """获取正在进行的课程、当天剩余课程和下一个最紧急的事件"""
    schedule_file = user_data_file(username, 'schedule.json')
    exams_file = user_data_file(username, 'exams.json')

    config = get_config()
    schedule_cache_stale = is_calendar_cache_stale(username, 'schedule', config)
    exams_cache_stale = is_calendar_cache_stale(username, 'exams', config)
    semester_start_str = config.get('semester_start', '2026-03-02')
    semester_start = _parse_semester_start(semester_start_str)
    now = datetime.now().replace(microsecond=0)

    if semester_start:
        days_passed = (now - semester_start).days
        current_week = max(1, (days_passed // 7) + 1) if days_passed >= 0 else 0
    else:
        current_week = 0

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

    schedule = {}
    if os.path.exists(schedule_file) and not schedule_cache_stale:
        with open(schedule_file, 'r', encoding='utf-8') as f:
            schedule = json.load(f)

    upcoming_info = _build_upcoming_classes(
        schedule,
        semester_start,
        now,
        period_times,
        current_week=current_week,
    ) if semester_start else {
        'courses': [],
        'label': '今日安排',
        'date': None,
        'current': None,
        'next': None,
        'next_time': None,
    }
    current_class = upcoming_info['current']
    next_class = upcoming_info['next']
    next_class_time = upcoming_info['next_time']

    next_exam = None
    next_exam_time = None

    if semester_start and os.path.exists(exams_file) and not exams_cache_stale:
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
        'upcoming': upcoming_info['courses'],
        'upcoming_label': upcoming_info['label'],
        'upcoming_date': upcoming_info['date'],
        'is_freshman': _is_freshman(username),
        'semester_start_invalid': semester_start is None,
        'schedule_cache_stale': schedule_cache_stale,
        'exams_cache_stale': exams_cache_stale,
    }


def is_auto_update_running(username):
    """返回指定用户是否已有自动更新任务在执行。"""
    with _auto_update_state_lock:
        return username in _auto_update_running


def _try_start_auto_update(username):
    with _auto_update_state_lock:
        if username in _auto_update_running:
            return False
        _auto_update_running.add(username)
        return True


def _finish_auto_update(username):
    with _auto_update_state_lock:
        _auto_update_running.discard(username)


def start_auto_update(username, password):
    """异步启动每日更新；同一用户已有任务时直接跳过。"""
    if not _try_start_auto_update(username):
        return False

    def worker():
        _auto_update_context.slot_acquired = True
        try:
            check_and_auto_update(username, password)
        finally:
            _auto_update_context.slot_acquired = False
            _finish_auto_update(username)

    try:
        threading.Thread(target=worker, daemon=True).start()
    except Exception:
        _finish_auto_update(username)
        raise
    return True


def check_and_auto_update(username, password):
    """检查是否需要自动更新课表和考试表（每日首次访问）。"""
    slot_acquired = getattr(_auto_update_context, 'slot_acquired', False)
    if not slot_acquired and not _try_start_auto_update(username):
        return False, '更新进行中'

    try:
        return _perform_auto_update(username, password)
    finally:
        if not slot_acquired:
            _finish_auto_update(username)


def _perform_auto_update(username, password):
    """执行一次自动更新；网络请求期间不持有数据库连接。"""
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

        # SQLite 测试替身可能返回元组，而 MySQL DictCursor 返回字典；
        # 优先按列名读取，兼容两种连接实现。
        try:
            last_update = row['last_auto_update']
        except (KeyError, IndexError, TypeError):
            last_update = row[0]
        if last_update == today:
            return False, '今日已更新'

    try:
        from urp import URP_login, URP_query
        url = get_current_urp_url()

        urp = URP_login(url, username, password)
        if not urp.is_logined():
            urp.login()

        query = URP_query(url, username)
        query.schedule_cx()
        query.exam_cx()

        with get_db() as conn:
            conn.execute(
                'UPDATE users SET last_auto_update = ? WHERE username = ?',
                (today, username)
            )

        return True, '自动更新成功'

    except Exception as e:
        return False, f'自动更新失败: {str(e)}'


def get_schedule(username, week=None, config=None):
    """读取课表文件"""
    schedule_file = user_data_file(username, 'schedule.json')

    if not os.path.exists(schedule_file):
        return {
            'week': week,
            'schedule': {},
            'is_freshman': _is_freshman(username),
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
            'semester_start': (config if config is not None else get_config()).get('semester_start', '2026-03-02'),
            'is_freshman': _is_freshman(username),
        }
    except Exception as e:
        return {'week': week, 'schedule': {}, 'message': f'读取课表失败: {str(e)}'}


def is_calendar_cache_stale(username, kind, config=None):
    """管理员切换学期后，阻止把旧缓存按新日期解释。"""
    if kind not in ('schedule', 'exams'):
        raise ValueError('未知的教务缓存类型')
    marker = (config if config is not None else get_config()).get('semester_cache_reset_at_ns')
    try:
        marker_ns = int(marker)
        if marker_ns <= 0:
            return False
        cache_path = user_data_file(username, f'{kind}.json')
        return os.stat(cache_path).st_mtime_ns < marker_ns
    except (TypeError, ValueError, OSError):
        return False


def get_exams(username):
    """读取考试安排文件"""
    exams_file = user_data_file(username, 'exams.json')

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
                            'campus': exam.get('校区', ''),
                            'building': exam.get('教学楼', ''),
                            'room': exam.get('教室', ''),
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
    """旧成绩接口的兼容函数，避免把废弃查询伪装成空成绩。"""
    raise RuntimeError(LEGACY_GRADES_ENDPOINT_MESSAGE)


def get_semesters(username):
    """获取所有学期列表"""
    from urp import URP_query
    url = get_current_urp_url()
    urp_query = URP_query(url, username)
    return urp_query.get_semesters()


def get_current_semester_grades(username):
    """获取本学期成绩"""
    from urp import URP_query
    url = get_current_urp_url()
    urp_query = URP_query(url, username)
    courses = urp_query.score_current_semester()
    return [
        {
            'course': c.get('课程名', ''),
            'credit': c.get('学分', ''),
            'score': c.get('成绩', ''),
        }
        for c in courses
    ]


def get_grades_by_semester(username, semester):
    """获取指定学期的及格成绩"""
    from urp import URP_query
    url = get_current_urp_url()
    urp_query = URP_query(url, username)
    courses = urp_query.score_by_semester(semester)
    return [{'course': c.get('课程名', ''), 'score': c.get('成绩', '')} for c in courses]


def _format_grade_courses(courses, include_failed_fields=False):
    result = []
    for c in courses:
        item = {
            'course': c.get('\u8bfe\u7a0b\u540d', ''),
            'score': c.get('\u6210\u7ee9', ''),
        }
        if '学分' in c:
            item['credit'] = c['学分']
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
    elif '春' in text:
        term_key = 2
    elif '秋' in text:
        term_key = 1
    else:
        numeric_term = re.search(r'(?:19|20)\d{2}-(?:19|20)\d{2}-([1-4])(?:-|$)', text)
        if numeric_term:
            term_key = int(numeric_term.group(1))

    return (year_key, term_key, fallback_index)


def get_latest_semester_grade_summary(username):
    from urp import URP_query
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
    from urp import URP_query
    url = get_current_urp_url()
    urp_query = URP_query(url, username)
    result = urp_query.score_failed()
    def fmt(courses):
        return [{'course': c.get('课程名', ''), 'score': c.get('成绩', ''), 'credit': c.get('学分', ''), 'exam_time': c.get('考试时间', '')} for c in courses]
    return {'current': fmt(result.get('current', [])), 'past': fmt(result.get('past', []))}


def get_gpa(username):
    """获取学分绩点和学位绩点"""
    from urp import URP_query
    url = get_current_urp_url()
    urp_query = URP_query(url, username)
    return urp_query.score_gpa()


def get_exam_sessions(username):
    """获取考试成绩查询的所有学期和考试名称列表"""
    from urp import URP_query
    url = get_current_urp_url()
    urp_query = URP_query(url, username)
    return urp_query.get_exam_sessions()


def get_exam_scores(username, jxzxjh, ksbh):
    """查询指定考试的成绩"""
    from urp import URP_query
    url = get_current_urp_url()
    urp_query = URP_query(url, username)
    courses = urp_query.score_resit(jxzxjh, ksbh)
    return [{'course': c.get('课程名', ''), 'credit': c.get('学分', ''), 'score': c.get('成绩', '')} for c in courses]


_MAKEUP_TERM_NUMBERS = {
    '一': 1, '二': 2, '三': 3, '四': 4,
    '1': 1, '2': 2, '3': 3, '4': 4,
}


def _makeup_period_from_exam(name, fallback_semester=''):
    """从补考场次名称提取实际学期，名称无法识别时才使用接口学期。"""
    text = str(name or '').strip()
    year_range = re.search(r'((?:19|20)\d{2})\s*[-至]\s*((?:19|20)\d{2})', text)
    explicit_term = re.search(r'第\s*([一二三四1-4])\s*学期', text)
    season = re.search(r'((?:19|20)\d{2})\s*年?\s*([春秋])', text)

    if year_range:
        start, end = int(year_range.group(1)), int(year_range.group(2))
        if explicit_term:
            term = _MAKEUP_TERM_NUMBERS.get(explicit_term.group(1), 0)
        elif '秋' in text:
            term = 1
        elif '春' in text:
            term = 2
        else:
            term = 0
        if term:
            return start, end, term

    if season:
        year = int(season.group(1))
        if season.group(2) == '秋':
            return year, year + 1, 1
        return year - 1, year, 2

    fallback = re.search(r'((?:19|20)\d{2})-((?:19|20)\d{2})-([1-4])', str(fallback_semester or ''))
    if fallback:
        return int(fallback.group(1)), int(fallback.group(2)), int(fallback.group(3))
    return 0, 0, 0


def _makeup_period_label(period):
    start, end, term = period
    term_label = '秋' if term == 1 else '春' if term == 2 else f'第{term}'
    return f'{start}-{end}学年{term_label}学期'


def _clean_makeup_rows(rows, session_name):
    cleaned = []
    for row in rows or []:
        course = str(row.get('课程名') or '').strip()
        credit = str(row.get('学分') if row.get('学分') is not None else '').strip()
        score = str(row.get('成绩') if row.get('成绩') is not None else '').strip()
        if not course or course in {'课序号', '课程名称', '课程名'}:
            continue
        cleaned.append({
            'course': course,
            'credit': credit,
            'score': score,
            'session': session_name,
        })
    return cleaned


def _merge_makeup_results(rows, include_pending=False):
    merged = {}
    for row in rows:
        if not row['score'] and not include_pending:
            continue
        key = (row['course'], row['credit'], row['score'])
        if key not in merged:
            merged[key] = {
                'course': row['course'],
                'credit': row['credit'],
                'score': row['score'],
                'sessions': [],
            }
        if row['session'] not in merged[key]['sessions']:
            merged[key]['sessions'].append(row['session'])
    return list(merged.values())


def get_latest_makeup_grade_summary(username, max_periods=6):
    """返回最新补考场次状态与最近一次已发布的补考成绩。"""
    from urp import URP_query

    url = get_current_urp_url()
    urp_query = URP_query(url, username)
    deadline = time.monotonic() + 20
    sessions = urp_query.get_exam_sessions(timeout=6)
    groups = {}
    seen = set()
    for exam in sessions.get('exams', []):
        name = str(exam.get('name', '')).strip()
        if '补考' not in name:
            continue
        identity = (exam.get('jxzxjh'), exam.get('ksbh'))
        if not all(identity) or identity in seen:
            continue
        seen.add(identity)
        period = _makeup_period_from_exam(name, exam.get('jxzxjh', ''))
        groups.setdefault(period, []).append(exam)

    periods = sorted(groups, reverse=True)
    latest_session = None
    latest_published = None
    checked_periods = 0
    errors = []
    queried_sessions = 0
    truncated = False
    for period in periods[:max(1, int(max_periods or 1))]:
        checked_periods += 1
        exams = groups[period]
        rows = []
        group_errors = []
        for exam in exams:
            remaining = deadline - time.monotonic()
            name = str(exam.get('name', '')).strip()
            if remaining <= 0 or queried_sessions >= 16:
                truncated = True
                group_errors.append({'session': name, 'message': '查询达到时间或场次数量上限'})
                break
            queried_sessions += 1
            try:
                rows.extend(_clean_makeup_rows(
                    urp_query.score_resit(exam['jxzxjh'], exam['ksbh'], timeout=min(6, remaining)),
                    name,
                ))
            except Exception:
                group_errors.append({'session': name, 'message': '该场次查询失败，请稍后重试'})
        errors.extend(group_errors)
        published = _merge_makeup_results(rows)
        if latest_session is None:
            latest_session = {
                'period': f'{period[0]}-{period[1]}-{period[2]}',
                'label': _makeup_period_label(period) if period[0] else '学期未标明',
                'sessions': [str(exam.get('name', '')).strip() for exam in exams],
                'status': ('partial' if published or rows else 'error') if group_errors
                    else 'published' if published else 'pending' if rows else 'no_results',
            }
            pending_count = sum(1 for row in rows if not row['score'])
            if pending_count:
                latest_session['pending_count'] = pending_count
                latest_session['pending_results'] = _merge_makeup_results(
                    [row for row in rows if not row['score']], include_pending=True,
                )
        if published:
            latest_published = {
                'period': f'{period[0]}-{period[1]}-{period[2]}',
                'label': _makeup_period_label(period) if period[0] else '学期未标明',
                'results': published,
            }
            break
        if truncated:
            break

    return {
        'latest_session': latest_session,
        'latest_published': latest_published,
        'checked_periods': checked_periods,
        'errors': errors,
        'truncated': truncated or (latest_published is None and checked_periods < len(periods)),
    }


def get_unevaluated_courses(username):
    """获取未评估的课程列表"""
    try:
        from urp import URP_query
        urp_url = get_current_urp_url()
        query = URP_query(urp_url, username)
        return query.check_evaluation()
    except Exception as e:
        print(f"获取未评估课程失败: {str(e)}")
        return None


def do_evaluation(username, courses_data):
    """执行教务评价"""
    try:
        from urp import URP_query
        urp_url = get_current_urp_url()
        urp = URP_query(urp_url, username)
        success, message = urp.do_evaluation(courses_data)
        if success:
            return True, f"成功评价 {len(courses_data)} 门课程"
        else:
            return False, message
    except Exception as e:
        return False, f"评价失败: {str(e)}"
