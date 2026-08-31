import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from urp.query import URP_query


HISTORICAL_GRID_HTML = '''
<html>
  <select name="zxjxjhh">
    <option value="2024-2025-1-1">2024-2025学年秋(两学期)</option>
    <option value="2025-2026-2-1" selected="selected">2025-2026学年春(两学期)</option>
  </select>
  <table class="displayTag" id="outside-dayin">
    <thead><tr>
      <td class="sortable">误选</td><td class="sortable"></td>
      <td class="sortable">星期一</td><td class="sortable">星期二</td>
      <td class="sortable">星期三</td><td class="sortable">星期四</td>
      <td class="sortable">星期五</td><td class="sortable">星期六</td>
      <td class="sortable">星期日</td>
    </tr></thead>
  </table>
  <span id="dayin">
  <table class="displayTag" id="user">
    <thead><tr>
      <td class="sortable"></td><td class="sortable"></td>
      <td class="sortable">星期一</td><td class="sortable">星期二</td>
      <td class="sortable">星期三</td><td class="sortable">星期四</td>
      <td class="sortable">星期五</td><td class="sortable">星期六</td>
      <td class="sortable">星期日</td>
    </tr></thead>
    <tbody>
      <tr>
        <td rowspan="2">上午</td>
        <td>第第一节节(08:20-09:05)</td>
        <td></td><td></td><td>软件工程导论_01(仙林校区实C-501)</td>
        <td></td><td></td><td></td><td></td>
      </tr>
      <tr>
        <td>第第二节节(09:15-10:00)</td>
        <td></td><td></td><td>软件工程导论_01(仙林校区实C-501)</td>
        <td></td><td></td><td></td><td></td>
      </tr>
      <tr><td colspan="9">午休</td></tr>
      <tr>
        <td>下午</td>
        <td>第三节</td>
        <td>公差配合与测量技术_01(仙林校区实C-502)</td>
        <td></td><td></td><td></td><td></td><td></td><td></td>
      </tr>
    </tbody>
  </table>
  </span>
  <table class="displayTag" id="kclb">
    <thead><tr><th class="sortable">课程名</th></tr></thead>
    <tbody><tr><td>不应被选择的课程列表</td></tr></tbody>
  </table>
</html>
'''


class ScheduleRequestTests(unittest.TestCase):
    def test_schedule_cx_uses_original_xk_endpoint(self):
        query = object.__new__(URP_query)
        query.url = 'https://223.112.21.198:6443/7b68f983/'
        query.account = '2415108133'
        captured = {}

        def capture_request(method, url, **kwargs):
            captured.update(method=method, url=url, kwargs=kwargs)
            return SimpleNamespace(
                text='<table><tr><th class="sortable">课程</th></tr></table>'
            )

        query._request = capture_request

        with tempfile.TemporaryDirectory() as temp_dir:
            old_cwd = os.getcwd()
            os.chdir(temp_dir)
            try:
                query.schedule_cx()
            finally:
                os.chdir(old_cwd)

        self.assertEqual(captured['method'], 'GET')
        self.assertEqual(
            captured['url'],
            'https://223.112.21.198:6443/7b68f983/xkAction.do',
        )
        self.assertEqual(
            captured['kwargs']['params'],
            {'actionType': '6', 'yzxh': '2415108133'},
        )
        self.assertEqual(
            captured['kwargs']['headers']['Referer'],
            'https://223.112.21.198:6443/7b68f983/menu/menu.jsp',
        )

    def test_historical_schedule_cx_posts_and_parses_grid_courses(self):
        query = object.__new__(URP_query)
        query.url = 'https://223.112.21.198:6443/7b68f983/'
        query.account = '2415108133'
        captured = {}

        def capture_request(method, url, **kwargs):
            captured.update(method=method, url=url, kwargs=kwargs)
            return SimpleNamespace(text=HISTORICAL_GRID_HTML)

        query._request = capture_request

        result = query.historical_schedule_cx('2025-2026-2-1')

        self.assertEqual(captured['method'], 'POST')
        self.assertEqual(
            captured['url'],
            'https://223.112.21.198:6443/7b68f983/lnkbcxAction.do',
        )
        self.assertEqual(
            captured['kwargs']['data'],
            {'zxjxjhh': '2025-2026-2-1'},
        )
        self.assertEqual(
            captured['kwargs']['headers']['Origin'],
            'https://223.112.21.198:6443',
        )
        self.assertEqual(
            captured['kwargs']['headers']['Referer'],
            'https://223.112.21.198:6443/7b68f983/lnkbcxAction.do',
        )
        self.assertEqual(result['semester'], '2025-2026-2-1')
        self.assertEqual(
            result['semesters'],
            [
                {'value': '2024-2025-1-1', 'label': '2024-2025学年秋(两学期)'},
                {'value': '2025-2026-2-1', 'label': '2025-2026学年春(两学期)'},
            ],
        )
        self.assertEqual(len(result['courses']), 2)

        merged_course = next(
            course for course in result['courses']
            if course['课程名'] == '软件工程导论'
        )
        self.assertEqual(merged_course['星期'], '3')
        self.assertEqual(merged_course['节次'], '1')
        self.assertEqual(merged_course['节数'], '2')
        self.assertEqual(merged_course['位置'], '仙林校区实C-501')

        other_course = next(
            course for course in result['courses']
            if course['课程名'] == '公差配合与测量技术'
        )
        self.assertEqual(other_course['星期'], '1')
        self.assertEqual(other_course['节次'], '3')

    def test_historical_schedule_route_returns_query_data(self):
        from app import app

        expected_data = {
            'semester': '2025-2026-2-1',
            'semesters': [],
            'courses': [],
        }

        class FakeQuery:
            def __init__(self, url, account):
                self.url = url
                self.account = account

            def historical_schedule_cx(self, semester):
                self.semester = semester
                return expected_data

        with (
            patch('auth.get_user_by_device', return_value={
                'username': '2415108133',
                'password': 'password',
            }),
            patch('auth.check_login_status', return_value=(True, {})),
            patch('routes.data_routes.get_current_urp_url', return_value='https://urp.example/'),
            patch('URP.URP_query', FakeQuery),
        ):
            response = app.test_client().get(
                '/api/historical_schedule?semester=2025-2026-2-1',
                headers={'X-Device-ID': 'test-device'},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {'success': True, 'data': expected_data})


if __name__ == '__main__':
    unittest.main()
