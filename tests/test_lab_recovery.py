"""实验会话恢复的离线回归；不向真实实验站提交文件。"""
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from services import lab_service as lab


URL = lab.BASE + '/student/xkkebiaoForKC.aspx?sid=1'
FORM = SimpleNamespace(url=lab.BASE + '/student/upload.aspx', text='''<form>
<input type="file" name="UpFile"><input type="submit" name="btnSubmit" value="提交">
</form>''')
LOGIN_PAGE = SimpleNamespace(url=lab.BASE + lab.LOGIN, text='<input name="PassWord">')


def listing(names=('课程甲', '课程乙'), semester='spring'):
    rows = ''.join(f'''<tr><td>{i}</td><td>{name}</td><td>
        <a href="javascript:__doPostBack('gvUser$ctl{i + 2:02d}$lbbg','')">实验报告</a>
        </td></tr>''' for i, name in enumerate(names))
    return SimpleNamespace(url=URL, text=f'''<form>
        <select name="ddlxq"><option value="autumn" {'selected' if semester == 'autumn' else ''}>秋</option>
        <option value="spring" {'selected' if semester == 'spring' else ''}>春</option></select>
        <table id="gvUser"><tr><th>编号</th><th>课程</th><th>报告</th></tr>{rows}</table></form>''')


def state(page=None, expired=False):
    return {'page': page or listing(), 'session': object(), 'list_url': URL,
            'at': time.monotonic() - (lab.SESSION_TTL + 1 if expired else 0), 'items': {}}


class LabRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.key = ('student', 'device')
        self.states = patch.dict(lab._states, {}, clear=True)
        self.states.start()
        self.addCleanup(self.states.stop)

    def run_upload(self, old, fresh, first_expired=False, **context):
        lab._states[self.key] = old
        lab.parse_list(old)
        sent, entries, logins = [], [], []

        def login(key, username, password):
            logins.append((key, username, password))
            lab._put(key, fresh)
            return lab.parse_list(fresh)

        def postback(current, target, overrides=None):
            entries.append((current, target))
            if first_expired and len(entries) == 1:
                return LOGIN_PAGE
            if target == 'ddlxq':
                return listing(('课程乙', '课程甲'), overrides['ddlxq'])
            return FORM

        def request(session, method, url, **kwargs):
            if kwargs.get('files'):
                sent.append(kwargs['files']['UpFile'][1].read())
                return SimpleNamespace(url=FORM.url, text='已接收')
            return listing(('课程乙', '课程甲'))

        with patch.object(lab, 'credential_status', return_value=True), \
             patch.object(lab, 'read_credential', return_value='saved-password'), \
             patch.object(lab, 'login_and_list', side_effect=login), \
             patch.object(lab, '_postback', side_effect=postback), \
             patch.object(lab, '_request', side_effect=request):
            answer = lab.upload(self.key, '0', 'report', 'report.pdf', b'%PDF-1.7\n', **context)
        return answer, sent, entries, logins

    def test_local_expiry_recovers_original_course_after_reordering_and_term_change(self):
        answer, sent, entries, logins = self.run_upload(
            state(expired=True), state(listing(('课程乙', '课程甲'), 'autumn')))
        self.assertEqual(sent, [b'%PDF-1.7\n'])
        self.assertEqual(len(logins), 1)
        self.assertEqual([entry[1] for entry in entries][:2], ['ddlxq', 'gvUser$ctl03$lbbg'])
        self.assertIn('listing', answer)

    def test_upstream_login_page_before_upload_recovers_once(self):
        _, sent, entries, logins = self.run_upload(state(), state(listing(('课程乙', '课程甲'))), True)
        self.assertEqual(sent, [b'%PDF-1.7\n'])
        self.assertEqual(len(logins), 1)
        self.assertEqual(entries[-1][1], 'gvUser$ctl03$lbbg')

    def test_worker_without_session_uses_client_task_identity(self):
        old = state()
        task_key = lab.parse_list(old)['items'][0]['task_key']
        # Emulate a worker change: the new worker has no previous state.
        lab._states.clear()
        fresh = state(listing(('课程乙', '课程甲')))

        def login(*_):
            lab._put(self.key, fresh)
            return lab.parse_list(fresh)

        with patch.object(lab, 'credential_status', return_value=True), \
             patch.object(lab, 'read_credential', return_value='saved-password'), \
             patch.object(lab, 'login_and_list', side_effect=login), \
             patch.object(lab, '_postback', return_value=FORM) as postback, \
             patch.object(lab, '_request', return_value=SimpleNamespace(url=FORM.url, text='已接收')):
            lab.upload(self.key, '0', 'report', 'report.pdf', b'%PDF-1.7\n',
                       semester='spring', task_key=task_key)
        self.assertEqual(postback.call_args_list[0].args[1], 'gvUser$ctl03$lbbg')

    def test_missing_course_after_relogin_never_sends_file(self):
        with self.assertRaisesRegex(lab.LabError, '重新查询'):
            self.run_upload(state(expired=True), state(listing(('其他课程',))))

    def test_unbound_expiry_still_returns_session_error(self):
        old = state(expired=True)
        lab.parse_list(old)
        lab._states[self.key] = old
        with patch.object(lab, 'credential_status', return_value=False), \
             patch.object(lab, '_request') as request:
            with self.assertRaises(lab.LabSessionExpired):
                lab.upload(self.key, '0', 'report', 'report.pdf', b'%PDF-1.7\n')
        request.assert_not_called()

    def test_expiry_after_file_send_is_not_automatically_replayed(self):
        old = state()
        lab._states[self.key] = old
        lab.parse_list(old)
        with patch.object(lab, '_postback', return_value=FORM), \
             patch.object(lab, '_request', return_value=LOGIN_PAGE) as request, \
             patch.object(lab, 'login_and_list') as login:
            with self.assertRaises(lab.LabSessionExpired):
                lab.upload(self.key, '0', 'report', 'report.pdf', b'%PDF-1.7\n')
        self.assertEqual(request.call_count, 1)
        login.assert_not_called()

    def test_semester_query_recovers_upstream_expiry(self):
        old, fresh = state(), state(listing(semester='autumn'))
        lab._states[self.key] = old

        def login(*_):
            lab._put(self.key, fresh)
            return lab.parse_list(fresh)

        with patch.object(lab, 'credential_status', return_value=True), \
             patch.object(lab, 'read_credential', return_value='saved-password'), \
             patch.object(lab, 'login_and_list', side_effect=login), \
             patch.object(lab, '_postback', side_effect=[LOGIN_PAGE, listing()]):
            self.assertEqual(lab.change_semester(self.key, 'spring')['semester'], 'spring')

    def test_repeated_upstream_expiry_stops_after_one_login(self):
        old, fresh = state(), state()
        lab._states[self.key] = old

        def login(*_):
            lab._put(self.key, fresh)
            return lab.parse_list(fresh)

        with patch.object(lab, 'credential_status', return_value=True), \
             patch.object(lab, 'read_credential', return_value='saved-password'), \
             patch.object(lab, 'login_and_list', side_effect=login) as relogin, \
             patch.object(lab, '_postback', return_value=LOGIN_PAGE):
            with self.assertRaises(lab.LabSessionExpired):
                lab.change_semester(self.key, 'spring')
        self.assertEqual(relogin.call_count, 1)

    def test_site_script_expiry_is_a_session_error(self):
        page = SimpleNamespace(url=lab.BASE + '/student/sybgKc.aspx', text="""
            <script language=javascript>alert('您已长时间没有操作本系统，请重新登陆');
            top.location.href='../../index.aspx';</script>""")
        with self.assertRaises(lab.LabSessionExpired):
            lab.parse_list({'page': page})

    def test_network_failure_after_file_send_warns_against_duplicate_upload(self):
        current = state()
        lab.parse_list(current)
        lab._states[self.key] = current
        with patch.object(lab, '_postback', return_value=FORM), \
             patch.object(lab, '_request', side_effect=lab.LabError('无法连接实验站')) as request:
            with self.assertRaisesRegex(lab.LabError, '勿重复提交'):
                lab.upload(self.key, '0', 'report', 'report.pdf', b'%PDF-1.7\n')
        self.assertEqual(request.call_count, 1)

    def test_failed_automatic_login_restores_login_form_without_unbinding_password(self):
        with patch.object(lab, 'credential_status', return_value=True), \
             patch.object(lab, 'read_credential', return_value='saved-password'), \
             patch.object(lab, 'login_and_list', side_effect=lab.LabError('账号或密码有误')):
            with self.assertRaises(lab.LabSessionExpired):
                lab.change_semester(self.key, 'spring')

    def test_web_attachment_post_returning_login_page_is_pending_without_retry(self):
        current = state()
        lab.parse_list(current)
        lab._states[self.key] = current
        form = SimpleNamespace(url=FORM.url, text=FORM.text.replace('</form>',
            '<input type="file" name="UpFile2"></form>'))
        with patch.object(lab, '_postback', return_value=form), \
             patch.object(lab, '_request', return_value=LOGIN_PAGE) as request:
            with self.assertRaisesRegex(lab.LabUploadUnverified, '勿重复提交'):
                lab.upload(self.key, '0', 'report', 'report.pdf', b'%PDF-1.7\n',
                           web=True, attachment=('data.zip', b'zip'))
        request.assert_called_once()
        self.assertNotIn(self.key, lab._states)


if __name__ == '__main__':
    unittest.main()
