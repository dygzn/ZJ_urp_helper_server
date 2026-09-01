"""
Apple 快捷指令 API 的密钥管理服务。
"""
import hashlib
import secrets
from datetime import datetime

from database import get_db
from services.config_service import get_current_urp_url
from services.urp_service import get_latest_semester_grade_summary


API_KEY_PREFIX = 'urp_'
API_KEY_PREFIX_LENGTH = 12


def hash_api_key(raw_key):
    """返回 API 密钥的 SHA-256 十六进制哈希。"""
    return hashlib.sha256(raw_key.encode('utf-8')).hexdigest()


def issue_api_key(username, now=None):
    """为学号创建或轮换唯一密钥，并只在本次调用中返回明文。"""
    if not isinstance(username, str) or not username.strip():
        raise ValueError('学号不能为空')

    username = username.strip()
    raw_key = f'{API_KEY_PREFIX}{secrets.token_urlsafe(32)}'
    key_hash = hash_api_key(raw_key)
    create_time = (now or datetime.now()).isoformat()
    key_prefix = raw_key[:API_KEY_PREFIX_LENGTH]

    with get_db() as conn:
        exists = conn.execute(
            'SELECT username FROM api_keys WHERE username = ?',
            (username,),
        ).fetchone()
        if exists:
            conn.execute(
                'UPDATE api_keys SET key_hash = ?, key_prefix = ?, create_time = ? '
                'WHERE username = ?',
                (key_hash, key_prefix, create_time, username),
            )
        else:
            conn.execute(
                'INSERT INTO api_keys (username, key_hash, key_prefix, create_time) '
                'VALUES (?, ?, ?, ?)',
                (username, key_hash, key_prefix, create_time),
            )

    return {
        'key': raw_key,
        'key_hash': key_hash,
        'key_prefix': key_prefix,
        'create_time': create_time,
    }


def get_api_key_status(username):
    """返回学号的密钥状态，不返回密钥明文或完整哈希。"""
    with get_db() as conn:
        row = conn.execute(
            'SELECT key_prefix, create_time FROM api_keys WHERE username = ?',
            (username,),
        ).fetchone()

    if not row:
        return {
            'has_key': False,
            'key_prefix': None,
            'create_time': None,
        }

    return {
        'has_key': True,
        'key_prefix': row['key_prefix'],
        'create_time': row['create_time'],
    }


def resolve_api_key(raw_key):
    """将明文密钥解析为学号；密钥不存在时返回 None。"""
    if not isinstance(raw_key, str) or not raw_key.strip():
        return None

    with get_db() as conn:
        row = conn.execute(
            'SELECT username FROM api_keys WHERE key_hash = ?',
            (hash_api_key(raw_key.strip()),),
        ).fetchone()
    return row['username'] if row else None


def revoke_api_key(username):
    """撤销学号当前密钥，返回是否存在并删除了记录。"""
    if not isinstance(username, str) or not username.strip():
        return False
    with get_db() as conn:
        cursor = conn.execute(
            'DELETE FROM api_keys WHERE username = ?',
            (username.strip(),),
        )
        return cursor.rowcount > 0


def _as_text(value):
    return '' if value is None else str(value)


def _as_positive_int(value):
    try:
        number = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def normalize_historical_schedule(student_id, result):
    """把中文课表字段转换为快捷指令易读取的稳定字段。"""
    result = result if isinstance(result, dict) else {}
    semester = _as_text(result.get('semester'))
    semester_name = ''
    for option in result.get('semesters') or []:
        if isinstance(option, dict) and _as_text(option.get('value')) == semester:
            semester_name = _as_text(option.get('label'))
            break

    weekday_names = ['', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日']
    courses = []
    for source in result.get('courses') or []:
        if not isinstance(source, dict):
            continue
        weekday = _as_positive_int(source.get('星期'))
        start_section = _as_positive_int(source.get('节次'))
        section_count = _as_positive_int(source.get('节数'))
        if (
            weekday is None
            or weekday > 7
            or start_section is None
            or section_count is None
        ):
            continue

        end_section = start_section + section_count - 1
        section_name = (
            f'第{start_section}节'
            if section_count == 1
            else f'第{start_section}-{end_section}节'
        )
        courses.append({
            'course_name': _as_text(source.get('课程名')),
            'weekday': weekday,
            'weekday_name': weekday_names[weekday],
            'start_section': start_section,
            'section_count': section_count,
            'section_name': section_name,
            'location': _as_text(source.get('位置')),
            'class_no': _as_text(source.get('课序')),
        })

    return {
        'student_id': _as_text(student_id),
        'semester': semester,
        'semester_name': semester_name,
        'course_count': len(courses),
        'courses': courses,
    }


def _normalize_grade_course(source, include_failed_fields=False):
    source = source if isinstance(source, dict) else {}
    item = {
        'course_name': _as_text(source.get('course')),
        'score': source.get('score', ''),
    }
    if include_failed_fields:
        item.update({
            'credit': source.get('credit', ''),
            'exam_time': source.get('exam_time', ''),
        })
    return item


def normalize_grade_summary(student_id, result):
    """把网页成绩汇总转换为扁平、便于快捷指令处理的字段。"""
    result = result if isinstance(result, dict) else {}
    passed = [
        _normalize_grade_course(course)
        for course in (result.get('passed') or [])
    ]
    failed = result.get('failed') or {}
    failed_current = [
        _normalize_grade_course(course, True)
        for course in (failed.get('current') or [])
    ]
    failed_past = [
        _normalize_grade_course(course, True)
        for course in (failed.get('past') or [])
    ]
    return {
        'student_id': _as_text(student_id),
        'semester': _as_text(result.get('semester')),
        'passed_count': len(passed),
        'failed_current_count': len(failed_current),
        'failed_past_count': len(failed_past),
        'passed': passed,
        'failed_current': failed_current,
        'failed_past': failed_past,
    }


def query_shortcut_data(student_id, action, params):
    """按快捷指令动作查询并规范化教务数据。"""
    if action not in {'historical_schedule', 'grades'}:
        raise ValueError('invalid_action')
    if not isinstance(params, dict):
        raise ValueError('invalid_params')

    if action == 'historical_schedule':
        semester = params.get('semester', '')
        if not isinstance(semester, str):
            raise ValueError('invalid_params')
        from URP import URP_query

        query = URP_query(get_current_urp_url(), student_id)
        result = query.historical_schedule_cx(semester)
        return normalize_historical_schedule(student_id, result)

    return normalize_grade_summary(
        student_id,
        get_latest_semester_grade_summary(student_id),
    )
