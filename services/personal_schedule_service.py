"""个人课程与教务时间覆盖；原教务文件始终只读。"""
import copy
import hashlib
import json
import sqlite3
import time
import uuid
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from database import get_db
from services.temporary_session_service import current_temporary_session

try:
    CHINA = ZoneInfo('Asia/Shanghai')
except ZoneInfoNotFoundError:
    # Windows 未安装 IANA 时区库时也能使用当前中国标准时间，不新增依赖。
    CHINA = timezone(timedelta(hours=8), 'Asia/Shanghai')

class ScheduleError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def create_personal_tables(conn, db_type):
    text = 'LONGTEXT' if db_type == 'mysql' else 'TEXT'
    suffix = ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' if db_type == 'mysql' else ''
    conn.execute(f'''CREATE TABLE IF NOT EXISTS personal_schedule_state (
        owner_key VARCHAR(160) NOT NULL, semester_key VARCHAR(64) NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (owner_key, semester_key)
    ){suffix}''')
    conn.execute(f'''CREATE TABLE IF NOT EXISTS personal_schedule_items (
        id VARCHAR(160) NOT NULL, owner_key VARCHAR(160) NOT NULL,
        semester_key VARCHAR(64) NOT NULL, kind VARCHAR(16) NOT NULL,
        source_id VARCHAR(160), series_id VARCHAR(160) NOT NULL, original_week INTEGER NOT NULL,
        event_json {text} NOT NULL, version INTEGER NOT NULL, updated_at VARCHAR(40) NOT NULL,
        PRIMARY KEY (owner_key, semester_key, id)
    ){suffix}''')


def context_user(username):
    session = current_temporary_session(username)
    return {'username': username, 'temporary': bool(session), 'session_id': session['session_id'] if session else None}


def schedule_owner(user):
    if user.get('temporary'):
        session = current_temporary_session(user.get('username'))
        session_id = user.get('session_id') or (session or {}).get('session_id')
        if not session_id:
            raise ScheduleError('临时登录已到期，请重新登录', 401)
        return 'session:' + session_id
    return 'account:' + str(user['username'])


def schedule_semester_key(config):
    return hashlib.sha256(json.dumps([config.get('semester_start'), config.get('semester_cache_reset_at_ns')],
        ensure_ascii=False).encode()).hexdigest()


def _hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()[:32]


def _start(config):
    try:
        value = datetime.strptime(config['semester_start'], '%Y-%m-%d').replace(tzinfo=CHINA)
        if value.weekday() != 0: raise ValueError()
        return value
    except (ValueError, KeyError, TypeError):
        raise ScheduleError('请先由管理员设置有效的学期首周星期一')


def parse_time(value):
    try:
        dt = datetime.fromisoformat(str(value))
        if dt.tzinfo is None: dt = dt.replace(tzinfo=CHINA)
        return dt.astimezone(CHINA).replace(second=0, microsecond=0)
    except (ValueError, TypeError):
        raise ScheduleError('请输入有效的日期和时间')


def _iso(dt): return dt.isoformat(timespec='seconds')


def identify_schedule(schedule, semester_start, period_times):
    result = {}
    if not semester_start: return copy.deepcopy(schedule or {})
    try: start = _start({'semester_start': semester_start})
    except ScheduleError: return copy.deepcopy(schedule or {})
    for week_key, courses in (schedule or {}).items():
        try: week = int(week_key)
        except (TypeError, ValueError): continue
        if not 1 <= week <= 25 or not isinstance(courses, list): continue
        seen = {}
        result[str(week)] = []
        for raw in courses:
            if not isinstance(raw, dict): continue
            try:
                day, section, duration = int(raw['星期']), int(raw['节次']), max(1, int(raw.get('节数', 1)))
                if not 1 <= day <= 7 or section not in period_times:
                    result[str(week)].append(copy.deepcopy(raw)); continue
                end_period = min(section + duration - 1, max(period_times))
            except (ValueError, TypeError, KeyError):
                result[str(week)].append(copy.deepcopy(raw)); continue
            item = copy.deepcopy(raw)
            series = 'urp:' + _hash([raw.get('课程号'), raw.get('课程名'), raw.get('教师'), day, section, duration])
            index = seen.get(series, 0); seen[series] = index + 1
            date = start + timedelta(days=(week-1)*7+day-1)
            begin = date.replace(hour=period_times[section][0][0], minute=period_times[section][0][1])
            end = date.replace(hour=period_times[end_period][1][0], minute=period_times[end_period][1][1])
            item.update(event_id=f'{series}:{week}:{index}', series_id=series, source='urp', original_week=week,
                start_at=_iso(begin), end_at=_iso(end), version=0, time_mode='period', extra_fields=[])
            item['source_id'] = item['event_id']
            result[str(week)].append(item)
    return result


def _missing_table(exc):
    return ('no such table' in str(exc).lower() or (getattr(exc, 'args', [None])[0] == 1146))


def read_personal_schedule(owner, semester_key):
    try:
        with get_db() as conn:
            if isinstance(conn, sqlite3.Connection): conn.execute('BEGIN')
            state = conn.execute('SELECT revision FROM personal_schedule_state WHERE owner_key=? AND semester_key=?',
                (owner, semester_key)).fetchone()
            rows = conn.execute('SELECT * FROM personal_schedule_items WHERE owner_key=? AND semester_key=?',
                (owner, semester_key)).fetchall()
            return [dict(r) for r in rows], state['revision'] if state else 0
    except Exception as exc:
        if _missing_table(exc): return [], 0  # 兼容尚未执行新迁移的旧缓存读取。
        raise


def write_personal_schedule(owner, semester_key, revision, changes):
    with get_db() as conn:
        if isinstance(conn, sqlite3.Connection): conn.execute('BEGIN IMMEDIATE')
        if owner.startswith('session:'):
            locking = '' if isinstance(conn, sqlite3.Connection) else ' FOR UPDATE'
            session = conn.execute('SELECT expires_at FROM temporary_sessions WHERE session_id=?' + locking, (owner[len('session:'):],)).fetchone()
            if not session or session['expires_at'] <= time.time():
                raise ScheduleError('临时登录已到期，请重新登录',401)
        conn.execute('INSERT OR IGNORE INTO personal_schedule_state (owner_key,semester_key,revision) VALUES (?,?,0)', (owner, semester_key))
        changed = conn.execute('UPDATE personal_schedule_state SET revision=revision+1 WHERE owner_key=? AND semester_key=? AND revision=?',
            (owner, semester_key, revision))
        if changed.rowcount != 1: raise ScheduleError('课表已被其他操作修改，请刷新后重试', 409)
        stamp = _iso(datetime.now(CHINA))
        for item in changes:
            conn.execute('DELETE FROM personal_schedule_items WHERE owner_key=? AND semester_key=? AND id=?',
                (owner, semester_key, item['id']))
            if item.get('delete'): continue
            conn.execute('''INSERT INTO personal_schedule_items
                (id,owner_key,semester_key,kind,source_id,series_id,original_week,event_json,version,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)''', (item['id'],owner,semester_key,item['kind'],item.get('source_id'),
                item['series_id'],item['original_week'],json.dumps(item['event'],ensure_ascii=False),revision+1,stamp))
        return revision + 1


def clear_temporary_personal_schedule(session_ids):
    if not session_ids: return
    try:
        with get_db() as conn:
            for session_id in session_ids:
                for table in ('personal_schedule_items', 'personal_schedule_state'):
                    conn.execute(f'DELETE FROM {table} WHERE owner_key=?', ('session:'+session_id,))
    except Exception as exc:
        if not _missing_table(exc): raise


def _position(item, config, period_times):
    begin, end = parse_time(item['start_at']), parse_time(item['end_at'])
    start = _start(config)
    week = (begin.date()-start.date()).days//7+1
    item['星期'] = begin.isoweekday()
    touched = []
    for section, (a,b) in period_times.items():
        lower = begin.replace(hour=a[0], minute=a[1])
        upper = begin.replace(hour=b[0], minute=b[1])
        if begin < upper and end > lower: touched.append(section)
    item['节次'] = touched[0] if touched else 0
    item['节数'] = touched[-1]-touched[0]+1 if touched else 0
    return str(week)


def effective_schedule(user, raw_schedule, config, period_times):
    schedule = identify_schedule(raw_schedule, config.get('semester_start'), period_times)
    items, revision = read_personal_schedule(schedule_owner(user), schedule_semester_key(config))
    indexed = {c.get('event_id'): c for cs in schedule.values() for c in cs}
    notices = []
    overrides = {}
    custom = []
    for row in items:
        event = json.loads(row['event_json']); event['version'] = row['version']
        if row['kind'] == 'override':
            if row['source_id'] in indexed:
                # 调整仅覆盖时间；学校更新的教室等资料仍使用最新原课。
                merged_event=copy.deepcopy(indexed[row['source_id']])
                for field in ('start_at','end_at','version','time_mode'):
                    if field in event: merged_event[field]=event[field]
                overrides[row['source_id']] = merged_event
            else: notices.append({'event_id':row['id'], 'name':event.get('课程名','课程'), 'message':'原教务课程已不在当前缓存，可恢复教务时间或清除调整'})
        else: custom.append(event)
    merged = {}
    for week, courses in schedule.items():
        merged.setdefault(week, [])
        for course in courses:
            event = overrides.get(course.get('event_id'), course)
            bucket = _position(event, config, period_times) if event.get('start_at') else week
            merged.setdefault(bucket, []).append(event)
    for event in custom:
        merged.setdefault(_position(event, config, period_times), []).append(event)
    return {'schedule':merged, 'revision':revision, 'notices':notices, 'semester_key':schedule_semester_key(config), 'owner_token':_hash(schedule_owner(user))}


def _fields(payload):
    values = payload.get('extra_fields', [])
    if not isinstance(values, list) or len(values)>30: raise ScheduleError('额外信息最多添加30项')
    result = []
    for index, row in enumerate(values):
        if not isinstance(row, dict): raise ScheduleError('额外信息格式错误')
        name, value = row.get('name',''), row.get('value','')
        if not isinstance(name,str) or not isinstance(value,str): raise ScheduleError('额外信息须为文字')
        name, value = name.strip(), value.strip()
        if not name and not value: continue
        if not name or not value: raise ScheduleError(f'请完整填写第{index+1}项的数据名和内容')
        if len(name)>60 or len(value)>2000: raise ScheduleError('数据名最多60字，内容最多2000字')
        result.append({'name':name,'value':value})
    return result


def mutate_schedule(user, action, payload, raw_schedule, config, period_times):
    if not isinstance(payload,dict): raise ScheduleError('请求格式错误')
    if payload.get('scope') not in ('week','all'): raise ScheduleError('请选择仅本周或全部周')
    try: revision, week = int(payload['revision']), int(payload['week'])
    except (ValueError,TypeError,KeyError): raise ScheduleError('课表版本或周次无效')
    if not 1 <= week <= 25 or revision < 0: raise ScheduleError('周次或版本超出范围')
    owner, key = schedule_owner(user), schedule_semester_key(config)
    if payload.get('owner_token') is not None and payload['owner_token'] != _hash(owner):
        raise ScheduleError('账号或登录会话已变更，请刷新后重新编辑',409)
    if payload.get('semester_key') is not None and payload['semester_key'] != key:
        raise ScheduleError('学期已变更，请刷新课表后重新编辑', 409)
    original = identify_schedule(raw_schedule, config.get('semester_start'), period_times)
    effective = effective_schedule(user,raw_schedule,config,period_times)
    if effective['revision'] != revision: raise ScheduleError('课表已被修改，请刷新后重试',409)
    index = {c.get('event_id'):c for cs in effective['schedule'].values() for c in cs}
    original_index = {c.get('event_id'):c for cs in original.values() for c in cs}
    rows,_ = read_personal_schedule(owner,key)
    row_index = {r['id']:r for r in rows}
    selected = index.get(payload.get('event_id'))
    if action != 'create' and selected is None:
        if action=='restore' and payload.get('event_id') in row_index:
            selected=json.loads(row_index[payload['event_id']]['event_json'])
        else: raise ScheduleError('课程已不存在或不属于当前课表',404)
    if action in ('update','delete') and selected.get('source')!='custom': raise ScheduleError('只能编辑或删除自建课程')
    if action in ('override','restore') and selected.get('source')!='urp': raise ScheduleError('只能调整教务课程时间')
    template = {}
    if payload.get('template_event_id'):
        template = index.get(payload['template_event_id'])
        if not template: raise ScheduleError('请选择当前课表中的已有课程')
    end = begin = None
    if action in ('create','update','override'):
        begin, end = parse_time(payload.get('start_at')), parse_time(payload.get('end_at'))
        if end<=begin: raise ScheduleError('结束须晚于开始')
        start=_start(config)
        if not 1 <= (begin.date()-start.date()).days//7+1 <= 25: raise ScheduleError('开始日期不在当前学期内')
        if end > start + timedelta(weeks=26): raise ScheduleError('结束日期超出当前学期范围')
        name = payload.get('name', (selected or template).get('课程名',''))
        classroom = payload.get('classroom', (selected or {}).get('教室',''))
        if not isinstance(name,str) or not 1<=len(name.strip())<=120: raise ScheduleError('请填写课程名称（最多120字）')
        if not isinstance(classroom,str) or len(classroom)>200: raise ScheduleError('教室最多200字')
        extras = _fields(payload) if 'extra_fields' in payload else copy.deepcopy((selected or template).get('extra_fields',[]))
    changes=[]
    if action=='create':
        series='custom:'+uuid.uuid4().hex
        actual_week=(begin.date()-_start(config).date()).days//7+1
        weeks=range(1,26) if payload['scope']=='all' else [actual_week]
        for target_week in weeks:
            shift=timedelta(weeks=target_week-actual_week)
            item={k:copy.deepcopy(v) for k,v in template.items() if k in ('课程号','学分','教师','课程属性','考试类型','修读方式','选课状态','校区','教学楼','位置','教室')}
            item.update(event_id=f'{series}:{target_week}',series_id=series,source='custom',source_id=None,
                original_week=target_week,课程名=name.strip(),extra_fields=extras,start_at=_iso(begin+shift),end_at=_iso(end+shift))
            if classroom.strip(): item['教室']=classroom.strip(); item['位置']=classroom.strip()
            elif 'classroom' in payload: item['教室']='';item['位置']=''
            if not item.get('位置'): item['位置']=next((r['value'] for r in extras if r['name'] in ('地点','位置','教室')),'')
            changes.append({'id':item['event_id'],'kind':'custom','series_id':series,'original_week':target_week,'event':item})
    else:
        candidates = list(index.values())
        if action=='restore':
            candidates = [json.loads(r['event_json']) for r in rows if r['kind']=='override']
        targets = [c for c in candidates if c.get('series_id')==selected['series_id']] if payload['scope']=='all' else [selected]
        # 教务 series 标识已包含原星期/节次；不修改同名课程的其他时段。
        for target in targets:
            if action in ('restore','delete'):
                changes.append({'id':target['event_id'],'delete':True});continue
            item=copy.deepcopy(target)
            shift=timedelta(weeks=target['original_week']-selected['original_week'])
            item.update(start_at=_iso(begin+shift),end_at=_iso(end+shift),time_mode='period' if payload.get('time_mode')=='period' and action=='override' else 'precise')
            if action=='update':
                item.update(课程名=name.strip(),教室=classroom.strip(),extra_fields=extras)
                item['位置']=classroom.strip() or next((r['value'] for r in extras if r['name'] in ('地点','位置','教室')),'')
            changes.append({'id':target['event_id'],'kind':'custom' if action=='update' else 'override',
                'source_id':target.get('source_id'),'series_id':target['series_id'],'original_week':target['original_week'],'event':item})
    if not changes: raise ScheduleError('没有可修改的课程')
    semester_begin=_start(config)
    for change in changes:
        if change.get('delete'): continue
        changed_begin=parse_time(change['event']['start_at'])
        changed_end=parse_time(change['event']['end_at'])
        if not 1 <= (changed_begin.date()-semester_begin.date()).days//7+1 <= 25 or changed_end>semester_begin+timedelta(weeks=26):
            raise ScheduleError('部分课程将超出本学期，请选择仅本周或调整日期')
    write_personal_schedule(owner,key,revision,changes)
    return effective_schedule(user,raw_schedule,config,period_times)
