"""实验站表单解析和安全边界的离线回归测试。"""
import io
import unittest
import os
import tempfile
from contextlib import nullcontext
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import patch
from cryptography.fernet import Fernet
from database import get_db
from flask import Flask
from routes.lab_routes import lab_bp, upload as upload_route
from services import lab_service as lab

from services.lab_service import (LabError, _login_failure_kind, _safe_url, credential_status,
                                  change_semester, login_and_list, new_captcha, parse_list, read_credential,
                                  remove_credential, save_credential, upload)


HTML = '''<form>
<select name="ddlxq"><option value="2026-1" selected>2026 第一学期</option>
<option value="2025-2">2025 第二学期</option></select>
<select name="ddlBaoGaoType"><option value="1" selected>按实验项目</option></select>
<table><tr><th>编号</th><th>项目</th></tr>
<tr><td>1</td><td>物理实验</td><td><a href="javascript:__doPostBack('gvUser$ctl02$lbyx','')">预习报告</a></td>
<td><a href="javascript:__doPostBack('gvUser$ctl02$lbbg','')">实验报告</a></td></tr></table></form>'''

COURSE_HTML = '''<form>
<select name="ddlxq"><option selected="selected" value="2026-2027-1-1">2026-2027学年秋</option>
<option value="2025-2026-2-1">2025-2026学年春</option></select>
<select name="ddlBaoGaoType"><option value="按实验项目">按实验项目</option>
<option selected="selected" value="按课程">按课程</option></select>
<table id="gvUser"><tr><th>编号</th><th>课程</th><th>考核</th></tr>
<tr><td>1</td><td>课程甲</td><td><a href="javascript:__doPostBack(&#39;gvUser$ctl02$lbyx&#39;,&#39;&#39;)">预习报告</a>
<a href="javascript:__doPostBack(&#39;gvUser$ctl02$lbbg&#39;,&#39;&#39;)">实验报告</a></td></tr>
<tr><td>2</td><td>课程乙</td><td><a href="javascript:__doPostBack(&#39;gvUser$ctl03$lbyx&#39;,&#39;&#39;)">预习报告</a>
<a href="javascript:__doPostBack(&#39;gvUser$ctl03$lbbg&#39;,&#39;&#39;)">实验报告</a></td></tr>
</table></form>'''

SPRING_COURSE_HTML = '''<form>
<select name="ddlxq"><option value="2026-2027-1-1">2026-2027学年秋</option>
<option selected="selected" value="2025-2026-2-1">2025-2026学年春</option></select>
<select name="ddlBaoGaoType"><option value="按实验项目">按实验项目</option>
<option selected="selected" value="按课程">按课程</option></select>
<table id="gvUser"><tr><th>编号</th><th>课程</th><th>考核</th></tr>
<tr><td>1</td><td>课程丙</td><td><a href="javascript:__doPostBack(&#39;gvUser$ctl02$lbyx&#39;,&#39;&#39;)">预习报告</a>
<a href="javascript:__doPostBack(&#39;gvUser$ctl02$lbbg&#39;,&#39;&#39;)">实验报告</a></td></tr>
</table></form>'''

EMPTY_PROJECT_HTML = '''<form><select name="ddlxq"><option selected="selected" value="2026-2027-1-1">秋</option></select>
<select name="ddlBaoGaoType"><option selected="selected" value="按实验项目">按实验项目</option></select></form>'''


class LabServiceTests(unittest.TestCase):
    def test_project_query_status_and_upload_restore_the_selected_course(self):
        url = lab.BASE + '/student/xkkebiaoForKC.aspx'
        course_page = SimpleNamespace(url=url, text=COURSE_HTML)
        project_html = COURSE_HTML.replace('value="按实验项目"', 'value="按实验项目" selected').replace(
            'selected="selected" value="按课程"', 'value="按课程"').split('<table')[0] + '''
            <select name="ddlkc"><option value="">请选择</option><option value="course-a">课程甲</option></select>
            <button onclick="__doPostBack('ctl00','')">查询</button>'''
        empty_page = SimpleNamespace(url=lab.BASE + '/student/xkkebiao.aspx', text=project_html)
        populated = SimpleNamespace(url=empty_page.url, text=project_html.replace(
            'value="course-a"', 'value="course-a" selected') + '''
            <table id="gvUser"><tr><th>实验项目</th><th>报告</th></tr><tr><td>项目甲</td>
            <td><a href="javascript:__doPostBack('gvUser$ctl02$lbbg','')">实验报告</a></td></tr></table>''')
        form = SimpleNamespace(url=lab.BASE + '/student/report.aspx', text='''
            <form><input type="file" name="UpFile"><input type="submit" name="btnSubmit"></form>''')
        state = {'session': object(), 'page': course_page, 'list_url': url, 'items': {}}
        key = ('student', 'device')
        term = '2026-2027-1-1'
        mode = '按实验项目'
        def postback(state, target, overrides=None):
            if target == 'ddlBaoGaoType':
                self.assertEqual(overrides, {'ddlBaoGaoType': mode})
                return empty_page
            if target == 'ctl00':
                self.assertEqual(overrides, {'ddlkc': 'course-a'})
                return populated
            self.assertIs(state['page'], populated)
            self.assertEqual(target, 'gvUser$ctl02$lbbg')
            return form
        with patch.object(lab, '_get', return_value=state), patch.object(lab, '_postback', side_effect=postback), \
             patch.object(lab, '_request', side_effect=[form, course_page]) as network:
            empty = lab.change_semester(key, term, mode)
            self.assertEqual(empty['items'], [])
            self.assertEqual(empty['courses'][1]['label'], '课程甲')
            item = lab.change_semester(key, term, mode, 'course-a')['items'][0]
            self.assertEqual(item['cells'][0], '项目甲')
            with self.assertRaises(lab.LabError):
                lab.change_semester(key, term, mode, 'other-course')
            state['page'] = course_page
            result = upload(key, '0', 'report', 'report.pdf', b'%PDF-1.7\n', term, item['task_key'], mode, 'course-a')
            self.assertEqual(result['listing']['course'], 'course-a')
            self.assertEqual(result['listing']['mode'], mode)
            self.assertIn('report', result['listing']['items'][0]['reports'])
            self.assertEqual([call.args[1] for call in network.call_args_list], ['POST', 'GET'])

    def test_list_retains_rows_without_upload_actions_and_their_status(self):
        html = COURSE_HTML.replace('</table></form>', '''
<tr><td>3</td><td>课程丙</td><td>已提交</td></tr>
<tr><td colspan="3">1 2 下一页</td></tr></table></form>''')
        result = parse_list({'page': SimpleNamespace(text=html), 'items': {}})
        self.assertEqual(len(result['items']), 3)
        self.assertEqual(result['items'][2]['cells'], ['3', '课程丙', '已提交'])
        self.assertFalse(result['items'][2]['pre'])
        self.assertFalse(result['items'][2]['report'])
        self.assertEqual(result['headers'], ['编号', '课程', '考核'])

    def test_list_keeps_distinct_report_actions(self):
        state = {'page': SimpleNamespace(text=HTML), 'items': {}}
        result = parse_list(state)
        self.assertEqual(result['semester'], '2026-1')
        self.assertEqual(len(result['items']), 1)
        self.assertTrue(result['items'][0]['pre'])
        self.assertTrue(result['items'][0]['report'])
        self.assertNotEqual(state['items']['0']['pre'], state['items']['0']['report'])

    def test_target_cannot_redirect_off_lab_host(self):
        with self.assertRaises(LabError):
            _safe_url('http://example.org/upload')
        with self.assertRaises(LabError):
            _safe_url('//example.org/upload')

    def test_captcha_recognizes_gif_when_server_mislabels_it_html(self):
        login = SimpleNamespace(text='<form></form>')
        image = SimpleNamespace(content=b'GIF89a' + b'1' * 10, headers={'Content-Type': 'text/html'})
        with patch('services.lab_service._request', side_effect=[login, image]):
            data, mime = new_captcha(('student', 'device'))
        self.assertEqual(mime, 'image/gif')
        self.assertEqual(data, image.content)

    def test_rejects_non_pdf_before_network(self):
        with self.assertRaises(LabError):
            upload(('student', 'device'), '0', 'pre', 'report.pdf', b'not a pdf')
        with self.assertRaises(LabError):
            upload(('student', 'device'), '0', 'report', 'report.txt', b'%PDF-1.7')

    def test_report_upload_uses_report_link_not_attachment_field(self):
        state = {'items': {'0': {'pre': 'gvUser$ctl02$lbyx', 'report': 'gvUser$ctl02$lbbg'}},
                 'session': object(), 'at': 0}
        form = SimpleNamespace(text='<form><input type="hidden" name="__VIEWSTATE" value="state">'
                               '<input type="file" name="UpFile"><input type="file" name="UpFile2">'
                               '<input type="submit" name="btnSubmit" value="提交"></form>',
                               url='http://192.168.16.235/student/upload.aspx')
        result = SimpleNamespace(text='<html>已接收</html>', url=form.url)
        with patch.dict(lab._states, {('student', 'device'): state}, clear=True), \
             patch('services.lab_service._get', return_value=state), \
             patch('services.lab_service._postback', return_value=form) as postback, \
             patch('services.lab_service._request', return_value=result) as request:
            answer = upload(('student', 'device'), '0', 'report', 'test.pdf', b'%PDF-1.7\n')
        postback.assert_called_once_with(state, 'gvUser$ctl02$lbbg')
        self.assertEqual(request.call_args.kwargs['files']['UpFile2'], ('', b''))
        self.assertFalse(answer['confirmed'])

    def test_bound_password_is_encrypted_and_can_be_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            config = {'database': {'type': 'sqlite', 'sqlite_path': os.path.join(directory, 'lab.db')}}
            def db():
                return get_db(config)
            with db() as conn:
                conn.execute('CREATE TABLE lab_credentials (username TEXT PRIMARY KEY, password_ciphertext TEXT, updated_at TEXT)')
            with patch('services.lab_service.get_db', db), \
                 patch.dict(os.environ, {'LAB_CREDENTIAL_KEY': Fernet.generate_key().decode()}):
                save_credential('2026001', 'private-lab-password')
                with db() as conn:
                    raw = conn.execute('SELECT password_ciphertext FROM lab_credentials').fetchone()[0]
                self.assertNotIn('private-lab-password', raw)
                self.assertTrue(credential_status('2026001'))
                self.assertEqual(read_credential('2026001'), 'private-lab-password')
                remove_credential('2026001')
                self.assertFalse(credential_status('2026001'))

    def test_web_upload_checks_files_and_form_before_posting(self):
        app = Flask(__name__)
        key = ('student', 'device')
        state = {'items': {'0': {'report': 'target'}}, 'session': object()}
        form = SimpleNamespace(url=lab.BASE + '/student/sybgKc.aspx', text='''<form>
            <input type="file" name="UpFile"><input type="submit" name="btnSubmit">
            </form>''')

        def submit(file, attachment):
            data = {'kind': 'report', 'item_id': '0', 'file': (io.BytesIO(file), '报告.pdf'),
                    'attachment': (io.BytesIO(attachment), '../原始数据.zip')}
            with app.test_request_context('/api/lab/upload', method='POST', data=data,
                                          headers={'X-Device-ID': 'device'}):
                return app.make_response(upload_route.__wrapped__({'username': 'student'}))

        with patch.dict(lab._states, {key: state}, clear=True), patch.object(lab, 'MAX_ATTACHMENT', 16), \
             patch.object(lab, '_get', return_value=state), patch.object(lab, '_postback', return_value=form) as entry, \
             patch.object(lab, '_request', return_value=form) as request:
            for pdf, attachment, field in [(b'invalid', b'zip', 'file'), (b'%PDF-1.7', b'', 'attachment'),
                                            (b'%PDF-1.7', b'a' * 17, 'attachment')]:
                response = submit(pdf, attachment)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json['field'], field)
            entry.assert_not_called()

            response = submit(b'%PDF-1.7', b'zip')
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.json['field'], 'attachment')
            request.assert_not_called()

            form.text = form.text.replace('</form>', '<input type="file" name="UpFile2"></form>')
            self.assertTrue(submit(b'%PDF-1.7', b'zip').json['success'])
            request.assert_called_once()
            name, stream, mime = request.call_args.kwargs['files']['UpFile2']
            self.assertEqual((name, stream.read(), mime), ('原始数据.zip', b'zip', 'application/octet-stream'))
            self.assertGreater(request.call_args.kwargs['timeout'][1], 20)

    def test_web_upload_surfaces_script_alert_rejection_and_ignores_success_alert(self):
        state = {'items': {'0': {'report': 'gvUser$ctl02$lbbg'}}, 'session': object(), 'at': 0}
        form = SimpleNamespace(
            url=lab.BASE + '/student/sybgKc.aspx',
            text='<form><input type="file" name="UpFile"><input type="file" name="UpFile2">'
                 '<input type="submit" name="btnSubmit" value="提交"></form>',
        )
        rejected = SimpleNamespace(
            url=form.url,
            text='<script>alert("不支持该附件格式，上传失败");</script>',
        )
        accepted = SimpleNamespace(
            url=form.url,
            text='<script>alert("上传成功，等待教师评阅");</script>',
        )
        with patch.dict(lab._states, {('student', 'device'): state}, clear=True), \
             patch.object(lab, '_get', return_value=state), \
             patch.object(lab, '_postback', return_value=form), \
             patch.object(lab, '_request', return_value=rejected):
            with self.assertRaisesRegex(LabError, '不支持该附件格式，上传失败'):
                upload(('student', 'device'), '0', 'report', 'test.pdf', b'%PDF-1.7\n',
                       web=True, attachment=('bad.exe', b'bin'))
        with patch.dict(lab._states, {('student', 'device'): state}, clear=True), \
             patch.object(lab, '_get', return_value=state), \
             patch.object(lab, '_postback', return_value=form), \
             patch.object(lab, '_request', return_value=accepted):
            answer = upload(('student', 'device'), '0', 'report', 'test.pdf', b'%PDF-1.7\n',
                            web=True, attachment=('ok.zip', b'zip'))
        self.assertFalse(answer['confirmed'])

    def test_web_upload_marks_status_refreshed_only_when_target_status_is_read(self):
        url = lab.BASE + '/student/xkkebiaoForKC.aspx'
        list_page = SimpleNamespace(url=url, text=COURSE_HTML)
        state = {'session': object(), 'page': list_page, 'list_url': url, 'items': {}, 'at': 0}
        parsed = parse_list(state)
        task_key = parsed['items'][0]['task_key']
        form = SimpleNamespace(
            url=lab.BASE + '/student/sybgKc.aspx',
            text='<form><table><tr><td>实验报告</td><td><input type="file" name="UpFile">'
                 '<a href="/r.pdf">已交.pdf</a></td></tr>'
                 '<tr><td>其他附件</td><td><input type="file" name="UpFile2">'
                 '<a href="/a.zip">data.zip</a></td></tr>'
                 '<tr><td colspan="2">状态:待评阅</td></tr></table>'
                 '<input type="submit" name="btnSubmit" value="提交"></form>',
        )
        with patch.dict(lab._states, {('student', 'device'): state}, clear=True), \
             patch.object(lab, '_get', return_value=state), \
             patch.object(lab, '_postback', return_value=form), \
             patch.object(lab, '_request', side_effect=[SimpleNamespace(url=form.url, text='ok'), list_page]):
            refreshed = upload(('student', 'device'), '0', 'report', 'test.pdf', b'%PDF-1.7\n',
                               semester='2026-2027-1-1', task_key=task_key, web=True,
                               attachment=('data.zip', b'zip'))
        self.assertTrue(refreshed['status_refreshed'])
        self.assertIn('已刷新状态', refreshed['message'])
        self.assertNotIn('勿重复提交', refreshed['message'])

        with patch.dict(lab._states, {('student', 'device'): state}, clear=True), \
             patch.object(lab, '_get', return_value=state), \
             patch.object(lab, '_postback', return_value=form), \
             patch.object(lab, '_request', side_effect=[SimpleNamespace(url=form.url, text='ok'), LabError('刷新超时')]):
            unrefreshed = upload(('student', 'device'), '0', 'report', 'test.pdf', b'%PDF-1.7\n',
                                 semester='2026-2027-1-1', task_key=task_key, web=True)
        self.assertFalse(unrefreshed['status_refreshed'])
        self.assertIn('勿重复提交', unrefreshed['message'])

    def test_routes_require_basic_membership(self):
        app = Flask(__name__)
        app.register_blueprint(lab_bp)
        client = app.test_client()
        with patch('auth.get_user_by_device', return_value=None):
            self.assertFalse(client.get('/api/lab/status', headers={'X-Device-ID': 'device'}).json['success'])
        no_member = SimpleNamespace(execute=lambda *_: SimpleNamespace(fetchone=lambda: None))
        with patch('auth.get_user_by_device', return_value={'username': '2026001'}), \
             patch('auth.get_db', return_value=nullcontext(no_member)):
            self.assertEqual(client.get('/api/lab/status', headers={'X-Device-ID': 'device'}).json['require_member'], 'basic')
        active = {'member_type': 'basic', 'expire_time': (datetime.now() + timedelta(days=1)).isoformat()}
        member_db = SimpleNamespace(execute=lambda *_: SimpleNamespace(fetchone=lambda: active))
        with patch('auth.get_user_by_device', return_value={'username': '2026001'}), \
             patch('auth.get_db', return_value=nullcontext(member_db)), \
             patch('routes.lab_routes.lab.credential_status', return_value=False):
            response = client.get('/api/lab/status', headers={'X-Device-ID': 'device'})
        self.assertTrue(response.json['success'])
        self.assertEqual(response.json['student_id'], '2026001')

    def test_query_does_not_require_user_entered_captcha(self):
        app = Flask(__name__)
        app.register_blueprint(lab_bp)
        active = {'member_type': 'basic', 'expire_time': (datetime.now() + timedelta(days=1)).isoformat()}
        member_db = SimpleNamespace(execute=lambda *_: SimpleNamespace(fetchone=lambda: active))
        with patch('auth.get_user_by_device', return_value={'username': '2026001'}), \
             patch('auth.get_db', return_value=nullcontext(member_db)), \
             patch('routes.lab_routes.lab.login_and_list', return_value={'items': [], 'semesters': []}) as login:
            response = app.test_client().post('/api/lab/query', headers={'X-Device-ID': 'device'},
                                              json={'password': 'test-password'})
        self.assertTrue(response.json['success'])
        login.assert_called_once_with(('2026001', 'device'), '2026001', 'test-password')

    def test_ocr_value_is_submitted_with_the_same_lab_session(self):
        session = object()
        state = {'session': session, 'login_html': '<form><input name="__VIEWSTATE" value="state">'
                 '<input name="btnLogin" value="登 录"></form>', 'page': None, 'at': 0}
        main = SimpleNamespace(text='<a href="/student/xkkebiaoForKC.aspx?sid=1">实验</a>',
                               url='http://192.168.16.235/Main/Main.aspx')
        listing = SimpleNamespace(text='<html></html>',
                                  url='http://192.168.16.235/student/xkkebiaoForKC.aspx?sid=1')
        with patch('services.lab_service.new_captcha', return_value=(b'GIF89a-data', 'image/gif')) as captcha, \
             patch('services.lab_service._get', return_value=state), \
             patch('ddddocr.DdddOcr', return_value=SimpleNamespace(classification=lambda _: 'AB12')), \
             patch('services.lab_service._request', side_effect=[main, listing]) as request, \
             patch('services.lab_service.parse_list', return_value={'items': []}):
            result = login_and_list(('2026001', 'device'), '2026001', 'test-password')
        self.assertEqual(result, {'items': []})
        captcha.assert_called_once_with(('2026001', 'device'))
        self.assertIs(request.call_args_list[0].args[0], session)
        self.assertEqual(request.call_args_list[0].kwargs['data']['txtIdentifyingCode'], 'AB12')
        self.assertEqual(request.call_args_list[0].kwargs['data']['UserName'], '2026001')

    def test_login_enters_management_after_credentials_are_accepted(self):
        session = object()
        state = {'session': session, 'login_html': '<form><input name="btnLogin" value="登 录"></form>',
                 'at': 0}
        intermediate = SimpleNamespace(
            text='<form action="/gzc_index/index.aspx" method="post">'
                 '<input type="hidden" name="__VIEWSTATE" value="next-state">'
                 '<input name="tbname" value="">'
                 '<input type="submit" name="Button1" value="进入管理">'
                 '<input type="submit" name="Button2" value="退出"></form>',
            url='http://192.168.16.235/gzc_index/index.aspx')
        main = SimpleNamespace(text='<a href="/student/xkkebiaoForKC.aspx?sid=1">实验</a>',
                               url='http://192.168.16.235/Main/Main.aspx')
        listing = SimpleNamespace(text='<html></html>',
                                  url='http://192.168.16.235/student/xkkebiaoForKC.aspx?sid=1')
        with patch('services.lab_service.new_captcha', return_value=(b'GIF89a-data', 'image/gif')), \
             patch('services.lab_service._get', return_value=state), \
             patch('ddddocr.DdddOcr', return_value=SimpleNamespace(classification=lambda _: 'AB12')), \
             patch('services.lab_service._request', side_effect=[intermediate, main, listing]) as request, \
             patch('services.lab_service.parse_list', return_value={'items': []}):
            result = login_and_list(('student', 'device'), 'student', 'known-good-password')
        self.assertEqual(result, {'items': []})
        second = request.call_args_list[1]
        self.assertEqual(second.args, (session, 'POST', intermediate.url))
        self.assertEqual(second.kwargs['data']['Button1'], '进入管理')
        self.assertEqual(second.kwargs['data']['__VIEWSTATE'], 'next-state')
        self.assertNotIn('PassWord', second.kwargs['data'])

    def test_login_keeps_course_mode_when_project_mode_is_empty(self):
        state = {'session': object(), 'login_html': '<input name="btnLogin" value="登 录">', 'at': 0}
        main = SimpleNamespace(text='<a href="/student/xkkebiaoForKC.aspx?sid=1">实验</a>',
                               url='http://192.168.16.235/Main/Main.aspx')
        course_page = SimpleNamespace(text=COURSE_HTML, url='http://192.168.16.235/student/xkkebiaoForKC.aspx?sid=1')
        empty_project = SimpleNamespace(text=EMPTY_PROJECT_HTML, url=course_page.url)
        with patch('services.lab_service.new_captcha', return_value=(b'GIF89a-data', 'image/gif')), \
             patch('services.lab_service._get', return_value=state), \
             patch('ddddocr.DdddOcr', return_value=SimpleNamespace(classification=lambda _: 'AB12')), \
             patch('services.lab_service._request', side_effect=[main, course_page]), \
             patch('services.lab_service._postback', return_value=empty_project):
            result = login_and_list(('student', 'device'), 'student', 'test-password')
        self.assertEqual(result['semester'], '2026-2027-1-1')
        self.assertEqual([item['cells'][1] for item in result['items']], ['课程甲', '课程乙'])
        self.assertEqual(result['mode'], '按课程')
        self.assertEqual(state['items']['0'], {'pre': 'gvUser$ctl02$lbyx', 'report': 'gvUser$ctl02$lbbg'})

    def test_semester_change_keeps_course_mode_and_report_actions(self):
        url = 'http://192.168.16.235/student/xkkebiaoForKC.aspx?sid=1'
        state = {'session': object(), 'page': SimpleNamespace(text=COURSE_HTML, url=url), 'items': {}, 'at': 0}
        spring = SimpleNamespace(text=SPRING_COURSE_HTML, url=url)
        empty_project = SimpleNamespace(text=EMPTY_PROJECT_HTML, url=url)
        with patch('services.lab_service._get', return_value=state), \
             patch('services.lab_service._postback', side_effect=[spring, empty_project]):
            result = change_semester(('student', 'device'), '2025-2026-2-1')
        self.assertEqual(result['semester'], '2025-2026-2-1')
        self.assertEqual(result['mode'], '按课程')
        self.assertEqual([item['cells'][1] for item in result['items']], ['课程丙'])
        self.assertEqual(state['items']['0']['report'], 'gvUser$ctl02$lbbg')

    def test_unknown_login_rejection_does_not_blame_password(self):
        state = {'session': object(), 'login_html': '<input name="btnLogin" value="登 录">', 'at': 0}
        rejected = SimpleNamespace(text='<html><input name="PassWord"></html>',
                                   url='http://192.168.16.235/gzc_index/index.aspx')
        with patch('services.lab_service.new_captcha', return_value=(b'GIF89a-data', 'image/gif')), \
             patch('services.lab_service._get', return_value=state), \
             patch('ddddocr.DdddOcr', return_value=SimpleNamespace(classification=lambda _: 'AB12')), \
             patch('services.lab_service._request', return_value=rejected):
            with self.assertRaises(LabError) as caught:
                login_and_list(('student', 'device'), 'student', 'known-good-password')
        self.assertNotIn('密码', str(caught.exception))
        self.assertIn('无法确认', str(caught.exception))

    def test_error_classifier_only_trusts_explicit_site_messages(self):
        self.assertEqual(_login_failure_kind('<input placeholder="请输入验证码"><input name="PassWord">'), 'unknown')
        self.assertEqual(_login_failure_kind('<script>alert("验证码输入错误")</script>'), 'captcha')
        self.assertEqual(_login_failure_kind('<script>alert("用户名或密码错误")</script>'), 'credentials')

    def test_account_rejection_does_not_say_password_alone_is_wrong(self):
        state = {'session': object(), 'login_html': '<input name="btnLogin" value="登 录">', 'at': 0}
        rejected = SimpleNamespace(text='<script>alert("用户名不存在")</script><input name="PassWord">',
                                   url='http://192.168.16.235/gzc_index/index.aspx')
        with patch('services.lab_service.new_captcha', return_value=(b'GIF89a-data', 'image/gif')), \
             patch('services.lab_service._get', return_value=state), \
             patch('ddddocr.DdddOcr', return_value=SimpleNamespace(classification=lambda _: 'AB12')), \
             patch('services.lab_service._request', return_value=rejected):
            with self.assertRaises(LabError) as caught:
                login_and_list(('student', 'device'), 'student', 'known-good-password')
        self.assertIn('账号或密码', str(caught.exception))

    def test_captcha_input_error_retries_with_new_captcha(self):
        state = {'session': object(), 'login_html': '<input name="btnLogin" value="登 录">', 'at': 0}
        rejected = SimpleNamespace(text='<script>alert("验证码输入错误")</script><input name="PassWord">',
                                   url='http://192.168.16.235/gzc_index/index.aspx')
        main = SimpleNamespace(text='<a href="/student/xkkebiaoForKC.aspx?sid=1">实验</a>',
                               url='http://192.168.16.235/Main/Main.aspx')
        listing = SimpleNamespace(text='<html></html>',
                                  url='http://192.168.16.235/student/xkkebiaoForKC.aspx?sid=1')
        with patch('services.lab_service.new_captcha', return_value=(b'GIF89a-data', 'image/gif')) as captcha, \
             patch('services.lab_service._get', return_value=state), \
             patch('ddddocr.DdddOcr', return_value=SimpleNamespace(classification=lambda _: 'AB12')), \
             patch('services.lab_service._request', side_effect=[rejected, main, listing]), \
             patch('services.lab_service.parse_list', return_value={'items': []}):
            result = login_and_list(('student', 'device'), 'student', 'known-good-password')
        self.assertEqual(result, {'items': []})
        self.assertEqual(captcha.call_count, 2)


class SessionVisibilityTests(unittest.TestCase):
    def test_snapshot_is_device_scoped_and_does_not_extend_session(self):
        from services import lab_service as lab
        state = {'at': 10, 'list_url': '/student/list.aspx',
                 'page': SimpleNamespace(text=HTML), 'items': {}}
        with patch.dict(lab._states, {('student', 'device'): state}, clear=True), \
             patch('services.lab_service.time.monotonic', return_value=20), \
             patch('services.lab_service._request') as network:
            self.assertEqual(len(lab.session_snapshot(('student', 'device'))['items']), 1)
            self.assertIsNone(lab.session_snapshot(('student', 'other-device')))
            self.assertEqual(state['at'], 10)
            network.assert_not_called()
        with patch.dict(lab._states, {('student', 'device'): state}, clear=True), \
             patch('services.lab_service.time.monotonic', return_value=2000):
            self.assertIsNone(lab.session_snapshot(('student', 'device')))
            with self.assertRaises(lab.LabSessionExpired):
                lab._get(('student', 'device'))

    def test_login_page_is_an_expired_session(self):
        from services import lab_service as lab
        with self.assertRaises(lab.LabSessionExpired):
            lab.parse_list({'page': SimpleNamespace(text='<input name="PassWord">')})


if __name__ == '__main__':
    unittest.main()
