"""根据原站报告查看页结构检查提交状态，不下载报告文件。"""
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from services import lab_service as lab
from test_lab_recovery import FORM, URL, listing, state


SUBMITTED = SimpleNamespace(url=lab.BASE + '/student/sybgKc.aspx', text='''
<form><table><tr><td>实验报告</td><td><input type="file" name="UpFile">
<a href="/reports/report.pdf">student--实验报告-1449590.pdf</a></td></tr>
<tr><td>其他附件</td><td><input type="file" name="UpFile2">无附件上传</td></tr>
<tr><td colspan="2"><span>状态:待评阅</span></td></tr>
<tr><td colspan="2">系统显示“上传成功，等待教师评阅”才表示报告上传成功</td></tr></table>
<input name="btnSubmit" type="submit" value="提交"></form>''')


class SubmissionStatusTests(unittest.TestCase):
    def test_uploaded_report_and_pending_review_come_from_form_not_list_button(self):
        result = lab.parse_report_status(SUBMITTED)
        self.assertEqual(result['status'], 'submitted')
        self.assertEqual(result['site_status'], '待评阅')
        self.assertEqual(result['file_name'], 'student--实验报告-1449590.pdf')

    def test_empty_valid_form_reports_no_file_without_guessing_submission_state(self):
        result = lab.parse_report_status(FORM)
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['label'], '未见已上传文件')
        self.assertEqual(result['file_name'], '')

    def test_file_name_remains_visible_when_the_site_uses_a_download_handler(self):
        page = SimpleNamespace(url=SUBMITTED.url, text=SUBMITTED.text.replace('/reports/report.pdf', '/download.aspx?id=1'))
        self.assertEqual(lab.parse_report_status(page)['file_name'], 'student--实验报告-1449590.pdf')

    def test_instructions_and_unrelated_attachments_do_not_prove_submission(self):
        page = SimpleNamespace(url=FORM.url, text='''<form><table>
            <tr><td><input type="file" name="UpFile"></td></tr>
            <tr><td><input type="file" name="UpFile2"><a href="/a.pdf">附件.pdf</a></td></tr>
            </table><p>上传成功，等待教师评阅才表示报告上传成功</p>
            <input name="btnSubmit"></form>''')
        result = lab.parse_report_status(page)
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['file_name'], '')

    def test_status_lookup_reads_each_report_and_retains_original_fields(self):
        key = ('status-student', 'device')
        current = state(listing(('课程甲',)))
        lab.parse_list(current)
        with patch.dict(lab._states, {key: current}, clear=True), \
             patch.object(lab, '_postback', return_value=SUBMITTED) as postback, \
             patch.object(lab, '_request') as network:
            result = lab.submission_statuses(key, 'spring')
        self.assertEqual(result['items'][0]['reports']['report']['site_status'], '待评阅')
        self.assertEqual(result['items'][0]['cells'], ['0', '课程甲', '实验报告'])
        self.assertEqual(postback.call_args.args[1], 'gvUser$ctl02$lbbg')
        network.assert_not_called()

    def test_refresh_failure_is_unknown_and_does_not_keep_stale_success(self):
        key = ('status-student', 'device')
        current = state(listing(('课程甲',)))
        with patch.dict(lab._states, {key: current}, clear=True), \
             patch.object(lab, '_postback', side_effect=[SUBMITTED, lab.LabError('连接失败')]):
            lab.submission_statuses(key, 'spring')
            result = lab.submission_statuses(key, 'spring')
        self.assertEqual(result['items'][0]['reports']['report']['status'], 'unknown')
        self.assertIn('失败', result['items'][0]['reports']['report']['label'])


if __name__ == '__main__':
    unittest.main()
