"""固定实验站的 WebForms 适配层；不接受客户端传入目标 URL。"""
import io
import hashlib
import json
import logging
import os
import re
import threading
import time
import weakref
from functools import wraps
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from database import get_db


BASE = 'http://192.168.16.235'
LOGIN = '/gzc_index/index.aspx'
CAPTCHA = '/gzc_index/GenerateIdentifyingCode.aspx'
MAX_PDF = 20 * 1024 * 1024
SESSION_TTL = 30 * 60
_states = {}
_states_lock = threading.RLock()
_operation_locks = weakref.WeakValueDictionary()
_logger = logging.getLogger(__name__)


def _serialized(action):
    """同一设备的 WebForms 查看与上传串行，避免报告页面上下文相互覆盖。"""
    @wraps(action)
    def run(key, *args, **kwargs):
        with _states_lock:
            lock = _operation_locks.get(key)
            if lock is None:
                lock = threading.RLock()
                _operation_locks[key] = lock
        with lock:
            return action(key, *args, **kwargs)
    return run


def forget_temporary_lab_session(username, device_id):
    """临时登录结束时，仅清掉这次设备的实验站会话。"""
    with _states_lock:
        _states.pop((username, device_id), None)


class LabError(Exception):
    pass


class LabSessionExpired(LabError):
    pass


def session_snapshot(key):
    """读取本设备尚未过期的实验列表，不触发登录或延长会话。"""
    with _states_lock:
        state = _states.get(key)
        if not state or time.monotonic() - state['at'] > SESSION_TTL or not state.get('list_url'):
            return None
        try:
            return parse_list(state)
        except LabError:
            return None


def _cipher():
    try:
        from cryptography.fernet import Fernet
    except ImportError as exc:
        raise LabError('服务器缺少 cryptography 依赖，请安装 requirements.txt') from exc
    key = os.environ.get('LAB_CREDENTIAL_KEY', '')
    if not key:
        raise LabError('服务器尚未配置 LAB_CREDENTIAL_KEY，不能安全保存实验站密码')
    try:
        return Fernet(key.encode())
    except (ValueError, TypeError) as exc:
        raise LabError('LAB_CREDENTIAL_KEY 格式无效') from exc


def credential_status(username):
    with get_db() as conn:
        row = conn.execute('SELECT username FROM lab_credentials WHERE username = ?', (username,)).fetchone()
    return bool(row)


def save_credential(username, password):
    token = _cipher().encrypt(password.encode()).decode()
    with get_db() as conn:
        conn.execute('INSERT OR REPLACE INTO lab_credentials (username, password_ciphertext, updated_at) VALUES (?, ?, ?)',
                     (username, token, str(int(time.time()))))


def read_credential(username):
    with get_db() as conn:
        row = conn.execute('SELECT password_ciphertext FROM lab_credentials WHERE username = ?', (username,)).fetchone()
    if not row:
        raise LabError('请先输入实验站密码')
    try:
        cipher = _cipher()
        return cipher.decrypt(row['password_ciphertext'].encode()).decode()
    except LabError:
        raise
    except Exception as exc:
        raise LabError('已保存的密码无法解密，请联系管理员检查加密密钥') from exc


def remove_credential(username):
    with get_db() as conn:
        conn.execute('DELETE FROM lab_credentials WHERE username = ?', (username,))
    with _states_lock:
        for key in list(_states):
            if key[0] == username:
                _states.pop(key, None)


def _safe_url(url):
    absolute = urljoin(BASE, url)
    parsed = urlparse(absolute)
    if parsed.scheme != 'http' or parsed.netloc != '192.168.16.235':
        raise LabError('实验站返回了不安全的跳转地址')
    return absolute


def _request(session, method, url, _hops=0, **kwargs):
    if _hops > 5:
        raise LabError('实验站跳转次数过多')
    try:
        response = session.request(method, _safe_url(url), timeout=(5, 20), allow_redirects=False, **kwargs)
    except requests.RequestException as exc:
        raise LabError('无法连接实验站，请确认服务器 VPN 已连接') from exc
    if response.status_code in (301, 302, 303, 307, 308):
        location = response.headers.get('Location', '')
        if not location:
            raise LabError('实验站跳转缺少目标地址')
        return _request(session, 'GET', urljoin(response.url, location), _hops=_hops + 1)
    if response.status_code != 200:
        raise LabError(f'实验站返回 HTTP {response.status_code}')
    if 'text/html' in response.headers.get('Content-Type', '').lower() and response.encoding in (None, 'ISO-8859-1'):
        response.encoding = response.apparent_encoding
    return response


def _fields(soup):
    result = {}
    for element in soup.select('input[name]'):
        if element.get('type', '').lower() not in ('file', 'submit', 'button', 'image'):
            result[element['name']] = element.get('value', '')
    for element in soup.select('select[name]'):
        selected = element.select_one('option[selected]') or element.select_one('option')
        if selected:
            result[element['name']] = selected.get('value', '')
    return result


def _new_state():
    session = requests.Session()
    session.headers['User-Agent'] = 'Mozilla/5.0 (compatible; URP-Lab-Assistant/1.0)'
    return {'session': session, 'at': time.monotonic(), 'page': None, 'list_url': None, 'items': {}}


def _put(key, state):
    with _states_lock:
        now = time.monotonic()
        for old_key, old_state in list(_states.items()):
            if now - old_state['at'] > SESSION_TTL:
                _states.pop(old_key, None)
        state['at'] = now
        _states[key] = state


def _get(key):
    with _states_lock:
        state = _states.get(key)
        if not state or time.monotonic() - state['at'] > SESSION_TTL:
            _states.pop(key, None)
            raise LabSessionExpired('实验站会话已过期，请重新登录查询')
        state['at'] = time.monotonic()
        return state


def new_captcha(key):
    state = _new_state()
    login = _request(state['session'], 'GET', LOGIN)
    state['login_html'] = login.text
    image = _request(state['session'], 'GET', CAPTCHA)
    if len(image.content) > 200_000:
        raise LabError('实验站验证码格式异常')
    if image.content.startswith((b'GIF87a', b'GIF89a')):
        mime = 'image/gif'
    elif image.content.startswith(b'\x89PNG\r\n\x1a\n'):
        mime = 'image/png'
    elif image.content.startswith(b'\xff\xd8\xff'):
        mime = 'image/jpeg'
    else:
        raise LabError('实验站验证码格式异常')
    _put(key, state)
    return image.content, mime


def _find_list_link(soup):
    for a in soup.select('a[href]'):
        if 'xkkebiaoForKC.aspx' in a['href']:
            return _safe_url(a['href'])
    match = re.search(r"(?:/student/|\.\./student/)xkkebiaoForKC\.aspx\?[^'\"\s<>]+", str(soup), re.I)
    if match:
        return _safe_url(match.group(0).replace('&amp;', '&'))
    return None


def _postback(state, target, overrides=None):
    if not re.fullmatch(r'[\w$]+', target):
        raise LabError('实验站操作标识无效')
    fields = _fields(BeautifulSoup(state['page'].text, 'html.parser'))
    fields.update(overrides or {})
    fields['__EVENTTARGET'] = target
    fields['__EVENTARGUMENT'] = ''
    return _request(state['session'], 'POST', state['page'].url, data=fields)


def _login_failure_kind(html):
    """仅根据实验站明确给出的错误字样分类；未知原因不能归咎于密码。"""
    text = BeautifulSoup(html, 'html.parser').get_text(' ', strip=True)
    # WebForms 常把提示写入 alert 脚本，get_text 不会包含脚本内容。
    scripts = ' '.join(script.get_text(' ', strip=True) for script in BeautifulSoup(html, 'html.parser').select('script'))
    evidence = f'{text} {scripts}'
    if re.search(r'(?:验证码|校验码).{0,10}(?:错误|不正确|有误|不匹配|失效|过期)', evidence):
        return 'captcha'
    if re.search(r'(?:密码|账号|用户名).{0,12}(?:错误|不正确|有误|不存在|被锁定)', evidence):
        return 'credentials'
    return 'unknown'


@_serialized
def login_and_list(key, username, password):
    try:
        import ddddocr
        ocr = ddddocr.DdddOcr(show_ad=False)
    except Exception as exc:
        raise LabError('服务器验证码识别组件不可用，请检查 ddddocr 依赖') from exc

    response = None
    state = None
    for _ in range(3):
        image, _ = new_captcha(key)
        try:
            captcha = re.sub(r'[^0-9A-Za-z]', '', ocr.classification(image) or '')
        except Exception as exc:
            raise LabError('实验站验证码识别失败，请稍后重试') from exc
        if len(captcha) != 4:
            continue
        state = _get(key)
        soup = BeautifulSoup(state['login_html'], 'html.parser')
        fields = _fields(soup)
        fields.update({'UserName': username, 'PassWord': password, 'txtIdentifyingCode': captcha})
        submit = soup.select_one('input[name=btnLogin]')
        if submit:
            fields['btnLogin'] = submit.get('value', '')
        response = _request(state['session'], 'POST', LOGIN, data=fields)
        intermediate = BeautifulSoup(response.text, 'html.parser')
        enter = intermediate.select_one('input[type=submit][name=Button1]')
        if enter and '进入管理' in enter.get('value', '') and not intermediate.select_one('input[name=PassWord]'):
            enter_fields = _fields(intermediate)
            enter_fields['Button1'] = enter.get('value', '')
            response = _request(state['session'], 'POST', response.url, data=enter_fields)
        if '/gzc_index/' not in urlparse(response.url).path.lower() and 'name="PassWord"' not in response.text:
            break
        failure_kind = _login_failure_kind(response.text)
        _logger.info('lab login rejected: path=%s reason=%s', urlparse(response.url).path, failure_kind)
        if failure_kind == 'captcha':
            continue
        if failure_kind == 'credentials':
            raise LabError('实验站明确提示账号或密码有误，请核对实验站账号与密码')
        raise LabError('实验站拒绝登录，无法确认原因；请稍后重试或到原站核对')
    else:
        raise LabError('实验站验证码自动识别失败，请重新点击查询')
    link = _find_list_link(BeautifulSoup(response.text, 'html.parser'))
    if not link:
        raise LabError('已登录，但未找到实验列表入口；请检查实验站页面是否改版')
    state['list_url'] = link
    state['page'] = _request(state['session'], 'GET', link)
    _put(key, state)
    return parse_list(state)


def parse_list(state):
    soup = BeautifulSoup(state['page'].text, 'html.parser')
    _check_session(state['page'])
    select = soup.select_one('select[name=ddlxq]')
    if not select:
        raise LabError('实验站页面缺少学期选择器')
    semesters = [{'value': o.get('value', ''), 'label': o.get_text(' ', strip=True)} for o in select.select('option') if o.get('value')]
    selected = _fields(soup).get('ddlxq')
    mode = _fields(soup).get('ddlBaoGaoType', '')
    if not selected and semesters:
        selected = semesters[0]['value']
    items = []
    state['items'] = {}
    table = soup.select_one('table#gvUser')
    if not table:
        action = next((a for a in soup.select('a[onclick], a[href]')
                       if re.search(r'\$lb(?:yx|bg)', f"{a.get('href', '')} {a.get('onclick', '')}")), None)
        table = action.find_parent('table') if action else None
    headers = [cell.get_text(' ', strip=True) for cell in table.select('tr th')] if table else []
    for row in table.select('tr') if table else []:
        columns = row.find_all('td', recursive=False)
        if not columns or len(columns) == 1 and columns[0].has_attr('colspan'):
            continue
        actions = {}
        for a in row.select('a[onclick], a[href]'):
            source = f"{a.get('href', '')} {a.get('onclick', '')}"
            match = re.search(r"__doPostBack\(['\"]([^'\"]+)['\"]", source)
            if match:
                if match.group(1).endswith('$lbyx'):
                    actions['pre'] = match.group(1)
                elif match.group(1).endswith('$lbbg'):
                    actions['report'] = match.group(1)
        cells = [c.get_text(' ', strip=True) for c in columns]
        if not cells:
            continue
        key = str(len(items))
        state['items'][key] = actions
        # 行号和报告字段可能在重登后变化，不能用它们定位上传对象。
        identity = [value for index, value in enumerate(cells)
                    if not re.search(r'编号|序号|报告|状态|成绩|分数|考核', headers[index] if index < len(headers) else '')
                    and not columns[index].select('a[onclick], a[href]')]
        task_key = hashlib.sha256(json.dumps([mode, identity], ensure_ascii=False).encode()).hexdigest()
        items.append({'id': key, 'task_key': task_key, 'cells': cells,
                      'pre': 'pre' in actions, 'report': 'report' in actions,
                      'reports': state.get('report_statuses', {}).get((selected, task_key), {})})
    result = {'semesters': semesters, 'semester': selected, 'mode': mode, 'headers': headers, 'items': items}
    state['listing'] = result
    return result


def _check_session(page):
    soup = BeautifulSoup(page.text, 'html.parser')
    scripts = ' '.join(script.get_text() for script in soup.select('script'))
    if ('/gzc_index/' in urlparse(getattr(page, 'url', '')).path.lower()
            or soup.select_one('input[name=PassWord]')
            or re.search(r'长时间没有操作本系统|请重新登[录陆]', scripts)):
        raise LabSessionExpired('实验站登录已过期，请重新登录查询')


def _with_relogin(key, action):
    """只重试未发送文件的操作；未绑定密码时保留原有登录入口。"""
    try:
        return action()
    except LabSessionExpired:
        forget_temporary_lab_session(*key)
        if not credential_status(key[0]):
            raise
    try:
        password = read_credential(key[0])
        login_and_list(key, key[0], password)
    except LabError as exc:
        forget_temporary_lab_session(*key)
        raise LabSessionExpired(f'自动重新登录失败：{exc}。请重新输入实验站密码查询，无需解绑') from exc
    try:
        return action()
    except LabSessionExpired:
        forget_temporary_lab_session(*key)
        raise


def _select_semester(state, semester):
    allowed = {v['value'] for v in parse_list(state)['semesters']}
    if semester not in allowed:
        raise LabError('无效的学期')
    state['page'] = _postback(state, 'ddlxq', {'ddlxq': semester})
    return parse_list(state)


@_serialized
def change_semester(key, semester):
    return _with_relogin(key, lambda: _select_semester(_get(key), semester))


def parse_report_status(page):
    _check_session(page)
    soup = BeautifulSoup(page.text, 'html.parser')
    file_input = soup.select_one('input[type=file][name=UpFile]')
    row = file_input.find_parent('tr') if file_input else None
    if not row:
        row = next((row for row in soup.select('tr')
                    if row.find('td') and row.find('td').get_text(strip=True) in ('实验报告', '预习报告')), None)
    file_link = next((a for a in row.select('a[href]')
                      if re.search(r'\.pdf(?:[?#]|$)', a['href'], re.I)
                      or a.get_text(strip=True).lower().endswith('.pdf')), None) if row else None
    file_name = file_link.get_text(' ', strip=True) if file_link else ''
    site_status = ''
    for text in soup.stripped_strings:
        match = re.fullmatch(r'状态\s*[:：]\s*(.{1,80})', text)
        if match:
            site_status = match.group(1).strip()
            break
    if not file_input and not row and not site_status:
        raise LabError('实验站报告页面发生变化，无法核实提交状态')
    status = 'unknown'
    if re.search(r'未提交|未上传', site_status):
        status = 'not_submitted'
    elif re.search(r'退回|驳回|重交', site_status):
        status = 'returned'
    elif file_name or re.search(r'待评阅|待批阅|已提交|已上传|已评阅|已批阅', site_status):
        status = 'submitted'
    label = site_status or ('已上传文件' if file_name else '未见已上传文件')
    return {'status': status, 'label': label, 'site_status': site_status, 'file_name': file_name}


@_serialized
def submission_statuses(key, semester, task_key=None):
    """仅打开报告查看表单；无文件上传，不下载已上传的报告。"""
    def run():
        state = _get(key)
        current = parse_list(state)
        if current['semester'] != semester:
            current = _select_semester(state, semester)
        tasks = [item for item in current['items'] if not task_key or item['task_key'] == task_key]
        if task_key and len(tasks) != 1:
            raise LabError('实验任务已变化或无法唯一匹配，请重新查询后选择报告')
        for item in tasks:
            reports = {}
            for kind in ('pre', 'report'):
                target = state['items'][item['id']].get(kind)
                if not target:
                    reports[kind] = {'status': 'unknown', 'label': '实验站未提供查看入口',
                                     'file_name': '', 'site_status': ''}
                    continue
                try:
                    reports[kind] = parse_report_status(_postback(state, target))
                except LabSessionExpired:
                    raise
                except LabError:
                    reports[kind] = {'status': 'unknown', 'label': '状态读取失败，请刷新重试',
                                     'file_name': '', 'site_status': ''}
            state.setdefault('report_statuses', {})[(semester, item['task_key'])] = reports
        return parse_list(state)
    return _with_relogin(key, run)


@_serialized
def upload(key, item_id, kind, filename, data, semester=None, task_key=None):
    if kind not in ('pre', 'report'):
        raise LabError('无效的报告类型')
    if not filename or not filename.lower().endswith('.pdf') or len(data) > MAX_PDF or len(data) < 8 or not data.startswith(b'%PDF-'):
        raise LabError('仅支持 20MB 以内的 PDF 文件')
    with _states_lock:
        old = _states.get(key)
        previous = old.get('listing') if old else None
    if previous and not task_key:
        item = next((item for item in previous['items'] if item['id'] == str(item_id)), None)
        if item:
            task_key = item['task_key']
            semester = previous['semester']

    def prepare():
        state = _get(key)
        if task_key and semester:
            current = parse_list(state)
            if current['semester'] != semester:
                current = _select_semester(state, semester)
            matches = [item for item in current['items'] if item['task_key'] == task_key]
            if len(matches) != 1:
                raise LabError('实验任务已变化或无法唯一匹配，请重新查询后选择报告')
            current_id = matches[0]['id']
        else:
            # 兼容旧客户端的当前会话；不能用旧行号在新会话中重放。
            if state is not old:
                raise LabError('实验会话已恢复，请重新查询后选择报告')
            current_id = str(item_id)
        target = state['items'].get(current_id, {}).get(kind)
        if not target:
            raise LabError('该实验没有对应的报告提交入口')
        page = _postback(state, target)
        _check_session(page)
        return state, page

    state, page = _with_relogin(key, prepare)
    soup = BeautifulSoup(page.text, 'html.parser')
    file_input = soup.select_one('input[type=file][name=UpFile]')
    submit = soup.select_one('input[name=btnSubmit]')
    if not file_input or not submit:
        raise LabError('实验站上传表单发生变化，未提交文件')
    fields = _fields(soup)
    fields['btnSubmit'] = submit.get('value', '')
    files = {'UpFile': (os.path.basename(filename), io.BytesIO(data), 'application/pdf')}
    if soup.select_one('input[type=file][name=UpFile2]'):
        files['UpFile2'] = ('', b'')
    try:
        result = _request(state['session'], 'POST', page.url, data=fields, files=files)
    except LabError as exc:
        raise LabError('未能确认文件上传结果，请先刷新任务或到实验站核对，勿重复提交') from exc
    result_soup = BeautifulSoup(result.text, 'html.parser')
    # WebForms 错误页与登录页不能被当作上传成功。
    try:
        _check_session(result)
    except LabSessionExpired:
        forget_temporary_lab_session(*key)
        raise LabSessionExpired('实验站登录已过期，未确认上传成功，请重新登录查询')
    error = result_soup.select_one('.validation-summary-errors, .field-validation-error')
    if error:
        raise LabError(f"实验站拒绝上传：{error.get_text(' ', strip=True)[:150]}")
    # 未观察到目标站成功响应时，明确保留“待核实”，避免虚报成功。
    answer = {'confirmed': False, 'message': '文件已发送至实验站，请在实验站核对提交状态'}
    if state.get('list_url'):
        try:
            state['page'] = _request(state['session'], 'GET', state['list_url'])
            current = parse_list(state)
            if semester and current['semester'] != semester:
                current = _select_semester(state, semester)
            if task_key and semester:
                current = submission_statuses(key, semester, task_key)
            answer['listing'] = current
        except LabError:
            # 文件已经发送，刷新失败不能诱导客户端重传。
            answer['message'] = '文件已发送，但提交状态刷新失败，请刷新任务或到实验站核对，勿重复提交'
    return answer
