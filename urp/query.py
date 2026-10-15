import json
import os
import re
from collections import defaultdict

import requests
import urllib3
from bs4 import BeautifulSoup
from urllib.parse import urlsplit
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
from urp.login import (
    VPNUnavailableError,
    _is_vpn_url,
    is_vpn_failure_response,
    load_shared_vpn_cookies,
    recover_vpn_session,
    start_vpn_keepalive,
)
from services.temporary_session_service import user_data_file

# 共享请求头（评教相关）
_EVAL_HEADERS_BASE = {
    'User-Agent': "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 Edg/137.0.0.0",
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.8,zh-TW;q=0.7,zh-HK;q=0.5,en-US;q=0.3,en;q=0.2',
    'Accept-Encoding': 'gzip, deflate, br',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Priority': 'u=4',
}


class URP_query:
    def __init__(self, url, account):
        self.url = url
        self.account = account
        self.x = requests.session()
        with open(user_data_file(self.account, 'cookie.json'), 'r', encoding='utf-8') as f:
            self.x.cookies.update(json.load(f))
        if _is_vpn_url(self.url):
            shared_vpn_cookies = load_shared_vpn_cookies()
            if shared_vpn_cookies:
                self.x.cookies.update(shared_vpn_cookies)
            start_vpn_keepalive()

    def _request(self, method, url, **kwargs):
        # 所有教务请求与 VPN 重试都限制等待；保留调用方的更短预算。
        if kwargs.get('timeout') is None:
            kwargs['timeout'] = 10
        response = self.x.request(method, url, **kwargs)
        if not _is_vpn_url(self.url) or not is_vpn_failure_response(response):
            response.raise_for_status()
            return response

        fresh = recover_vpn_session(self.x, self.url)
        self.x.cookies.update(fresh)
        retry = self.x.request(method, url, **kwargs)
        if is_vpn_failure_response(retry):
            raise VPNUnavailableError(
                'VPN \u901a\u9053\u6682\u4e0d\u53ef\u7528\uff0c'
                '\u5df2\u81ea\u52a8\u91cd\u8fde\u4f46\u672a\u6210\u529f\uff0c'
                '\u8bf7\u7a0d\u540e\u91cd\u8bd5'
            )
        retry.raise_for_status()
        return retry

    # ==================== 成绩查询 ====================

    def _fetch_score_html(self):
        """获取成绩总览页面 HTML"""
        score_url = f"{self.url}gradeLnAllAction.do?type=ln&oper=qbinfo&"
        return self._request('GET', score_url, verify=False, timeout=10).text

    def get_semesters(self):
        """获取所有学期列表（解析页面锚点）"""
        html = self._fetch_score_html()
        soup = BeautifulSoup(html, 'html.parser')
        anchors = soup.find_all('a', attrs={'name': True})
        semesters = []
        for a in anchors:
            name = a.get('name', '').strip()
            if name and ('学年' in name or '学期' in name):
                semesters.append(name)
        return semesters

    def score_by_semester(self, semester):
        """查询指定学期的及格成绩"""
        html = self._fetch_score_html()
        soup = BeautifulSoup(html, 'html.parser')

        anchor = soup.find('a', attrs={'name': semester})
        if not anchor:
            return []

        score_table = None
        for elem in anchor.next_siblings:
            if getattr(elem, 'name', None) == 'a' and elem.get('name'):
                break
            if getattr(elem, 'name', None):
                t = elem.find('table', class_='displayTag', id='user')
                if t:
                    score_table = t
                    break
        if not score_table:
            return []

        courses = []
        for r in score_table.find_all('tr'):
            tds = r.find_all('td')
            if len(tds) < 8:
                continue
            course = tds[2].get_text(strip=True)
            if not course or course in {'课程名', '课程名称', '课序号'}:
                continue
            courses.append({'课程名': course, '学分': tds[4].get_text(strip=True), '成绩': tds[7].get_text(strip=True)})
        return courses

    def score_current_semester(self):
        """查询本学期成绩"""
        response = self._request('GET', f'{self.url}bxqcjcxAction.do', params={
            'mytype': 'bxqcj', 'yzxh': self.account
        }, verify=False, timeout=10)
        soup = BeautifulSoup(response.text, 'html.parser')
        # 检测错误提示页面
        error_td = soup.find('td', class_='errorTop')
        if error_td:
            raise Exception('本学期成绩查询未打开')
        courses = []
        for row in soup.find_all('tr'):
            cols = row.find_all('td')
            if len(cols) >= 8:
                courses.append({
                    '课程名': cols[2].get_text(strip=True),
                    '学分': cols[4].get_text(strip=True),
                    '成绩': cols[7].get_text(strip=True),
                })
        return courses

    def score_failed(self):
        """查询不及格成绩，分为尚不及格和曾不及格"""
        response = self._request('GET', f'{self.url}gradeLnAllAction.do', params={
            'type': 'ln', 'oper': 'bjg', 'yzxh': self.account
        }, verify=False)
        soup = BeautifulSoup(response.text, 'html.parser')

        def parse_table(table):
            courses = []
            for row in table.find_all('tr'):
                cols = row.find_all('td')
                if len(cols) >= 9:
                    courses.append({
                        '课程名': cols[2].get_text(strip=True),
                        '成绩':   cols[7].get_text(strip=True).replace('\xa0', '').strip(),
                        '学分':   cols[4].get_text(strip=True),
                        '考试时间': cols[8].get_text(strip=True),
                    })
            return courses

        tables = soup.find_all('table', class_='displayTag')
        return {
            'current': parse_table(tables[0]) if len(tables) > 0 else [],
            'past':    parse_table(tables[1]) if len(tables) > 1 else [],
        }

    def _clean_cell_text(self, cell):
        return cell.get_text(' ', strip=True).replace('\xa0', ' ').strip()

    def _parse_gpa_detail_tables(self, soup):
        """解析绩点页面中的学期绩点明细表。"""
        for table in soup.find_all('table', class_='displayTag'):
            rows = table.find_all('tr')
            if len(rows) < 2:
                continue

            headers = [self._clean_cell_text(cell) for cell in rows[0].find_all(['th', 'td'])]
            if headers[:4] != ['学年学期', '学分绩点', '学位绩点', '加权学分学位绩点']:
                continue

            details = []
            for row in rows[1:]:
                cols = [self._clean_cell_text(cell) for cell in row.find_all('td')]
                if len(cols) < len(headers):
                    continue
                details.append({headers[index]: cols[index] for index in range(len(headers))})
            return details
        return []

    def score_gpa(self):
        """查询学分绩点、学位绩点和学期绩点明细"""
        response = self._request('GET', f'{self.url}gradeLnAllAction.do', params={'oper': 'queryXfjd'}, verify=False)
        soup = BeautifulSoup(response.content, 'html.parser', from_encoding='gb18030')
        inputs = soup.find_all('input', style="width: 60px;")
        return {
            '学分绩点': inputs[0].get('value') if len(inputs) > 0 else None,
            '学位绩点': inputs[1].get('value') if len(inputs) > 1 else None,
            '加权学分学位绩点': inputs[2].get('value') if len(inputs) > 2 else None,
            '学期绩点明细': self._parse_gpa_detail_tables(soup),
        }

    def get_exam_sessions(self, timeout=10):
        """获取考试成绩查询页面的所有学期及考试名称列表"""
        response = self._request('GET', f'{self.url}cjSearchAction.do', params={
            'oper': 'getKscjList', 'yzxh': self.account
        }, verify=False, timeout=timeout)
        response.raise_for_status()
        html = response.text
        soup = BeautifulSoup(html, 'html.parser')
        semesters = []
        select = soup.find('select', {'name': 'jxzxjh'})
        if select is None:
            raise RuntimeError('考试场次页面未返回学期列表，请检查教务登录状态')
        if select:
            for opt in select.find_all('option'):
                val = opt.get('value', '').strip()
                text = opt.get_text(strip=True)
                if val:
                    semesters.append({'value': val, 'text': text})
        exams = []
        for name, ksbh, jxzxjh in re.findall(
            r'new Array\("([^"]+)","([^"]+)","([^"]+)"\)', html
        ):
            exams.append({'name': name, 'ksbh': ksbh, 'jxzxjh': jxzxjh})
        return {'semesters': semesters, 'exams': exams}

    def score_resit(self, jxzxjh, ksbh, timeout=10):
        """查询指定考试的成绩"""
        response = self._request('POST', f'{self.url}cjSearchAction.do', params={'oper': 'tjcx'}, data={
            'jxzxjh': jxzxjh, 'ksbh': ksbh, 'yzxh': self.account
        }, verify=False, timeout=timeout)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, 'html.parser')
        if soup.find('input', attrs={'type': 'password'}) or soup.find('td', class_='errorTop'):
            raise RuntimeError('考试成绩页面未正常打开，请检查教务登录状态')
        courses = []
        for row in soup.find_all('tr'):
            cols = row.find_all('td', recursive=False)
            if len(cols) >= 6:
                course_name = cols[2].get_text(strip=True)
                credit = cols[4].get_text(strip=True)
                score = cols[5].get_text(strip=True)
                if not course_name or course_name in {'课序号', '课程名称', '课程名'}:
                    continue
                if credit in {'学时', '学分'} and score in {'学分', '考试成绩', '成绩'}:
                    continue
                courses.append({
                    '课程名': course_name,
                    '学分': credit,
                    '成绩': score,
                })
        return courses
    # ==================== 评教 ====================

    def check_evaluation(self):
        listWj_url = f"{self.url}jxpgXsAction.do?oper=listWj&yzxh={self.account}"
        headers = {
            **_EVAL_HEADERS_BASE,
            'Host': self.url,
            'Content-Length': '235',
            'Origin': self.url,
            'Referer': listWj_url,
        }
        response = self._request('GET', listWj_url, params={'oper': 'listWj', 'yzxh': self.account},
                              headers=headers, verify=False)
        pg_lists = response.text

        closed_markers = (
            '\u975e\u6559\u5b66\u8bc4\u4f30\u65f6\u671f',
            '\u8bc4\u4f30\u65f6\u95f4\u5df2\u8fc7',
        )
        text_candidates = [pg_lists]
        for encoding in ('utf-8', 'gbk', 'gb18030'):
            try:
                text_candidates.append(response.content.decode(encoding))
            except UnicodeDecodeError:
                pass
        if any(marker in text for text in text_candidates for marker in closed_markers):
            return []

        soup = BeautifulSoup(pg_lists, 'html.parser')

        pg_list = []
        for tr in soup.find_all('tr'):
            tds = tr.find_all('td')
            if len(tds) >= 4 and tds[3].get_text(strip=True) == '否':
                img_tag = tr.find('img')
                if img_tag and 'name' in img_tag.attrs:
                    parts = img_tag['name'].split('#@')
                    if len(parts) >= 6:
                        pg_list.append({
                            "未评课程": parts[4],
                            "教师": parts[2],
                            "wjbm": parts[0],
                            "bpr": parts[1],
                            "pgnr": parts[5],
                            "oper": "wjShow"
                        })
        return pg_list

    def do_evaluation(self, pg_list):
        url = f'{self.url}jxpgXsAction.do'
        wjpg_url = f'{self.url}jxpgXsAction.do?oper=wjpg'
        headers_show = {
            **_EVAL_HEADERS_BASE,
            'Host': self.url,
            'Content-Length': '235',
            'Origin': self.url,
            'Referer': f'{self.url}jxpgXsAction.do?oper=listWj&yzxh={self.account}',
        }
        headers_submit = {
            **_EVAL_HEADERS_BASE,
            'Host': self.url,
            'Origin': self.url,
            'Referer': url,
        }

        for course in pg_list:
            wjbm, bpr, pgnr = course['wjbm'], course['bpr'], course['pgnr']
            wjshow_r = self._request('POST', url, data={'wjbm': wjbm, 'bpr': bpr, 'pgnr': pgnr, 'oper': 'wjShow'}, headers=headers_show, verify=False).text
            if '您没有可回答的问卷' in wjshow_r:
                return False, '您没有可回答的问卷'

            soup = BeautifulSoup(wjshow_r, 'html.parser')

            # 动态解析题目 ID 和选项
            evaluation_data = {
                'wjbm': wjbm,
                'bpr': bpr,
                'pgnr': pgnr,
                'xumanyzg': 'zg',
                'wjbz': '',
                'zgpj': ''
            }

            # 遍历所有 tr，按题目收集选项
            question_options = {}  # {qid: [(name, value, score), ...]}
            for tr in soup.find_all('tr'):
                input_tags = tr.find_all('input')
                qids_in_row = []

                for inp in input_tags:
                    name = inp.get('name', '')
                    inp_type = inp.get('type', 'text')
                    value = inp.get('value', '')

                    if name.isdigit():
                        if name not in qids_in_row:
                            qids_in_row.append(name)
                        if inp_type in ('radio', 'checkbox'):
                            # 从 value 中提取分数，如 '20_1' → 20, '5_0.9' → 5
                            try:
                                score_part = value.split('_')[0]
                                score = float(score_part)
                            except (ValueError, IndexError):
                                score = 0
                            question_options.setdefault(name, []).append((name, value, score))

                # 同一行内的题目，选最高分
                for qid in qids_in_row:
                    if qid in question_options and qid not in evaluation_data:
                        opts = question_options[qid]
                        if opts:
                            best = max(opts, key=lambda x: x[2])
                            evaluation_data[qid] = best[1]

            # 处理未被 tr 行覆盖的题目（textarea、hidden、独立 radio 等）
            for inp in soup.find_all(['input', 'textarea']):
                name = inp.get('name', '')
                if name.isdigit() and name not in evaluation_data:
                    inp_type = inp.get('type', 'text')
                    if inp_type == 'radio' and inp.get('checked'):
                        evaluation_data[name] = inp.get('value', '')
                    elif inp_type not in ('radio', 'checkbox'):
                        evaluation_data[name] = inp.get('value', '')

            r = self._request('POST', wjpg_url, data=evaluation_data, headers=headers_submit, verify=False).text
            if '评估成功' not in r:
                return False, '评价失败'
        return True, '评价成功'

    # ==================== 课表查询 ====================

    def schedule_cx(self):
        """使用原课表接口获取当前学期课表并写入缓存。"""
        headers = {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
            'Connection': 'keep-alive',
            'Referer': f'{self.url}menu/menu.jsp',
            'Upgrade-Insecure-Requests': '1',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 Edg/145.0.0.0',
        }
        response = self._request(
            'GET',
            f'{self.url}xkAction.do',
            headers=headers,
            params={'actionType': '6', 'yzxh': self.account},
            verify=False,
        )
        soup = BeautifulSoup(response.text, 'html.parser')

        course_table = next(
            (table for table in soup.find_all('table')
             if any(
                 re.sub(r'\s+', '', cell.get_text(' ', strip=True)) == '课程名'
                 for cell in table.find_all(['th', 'td'], class_='sortable')
             )),
            None,
        )
        if not course_table:
            course_table = next(
                (table for table in soup.find_all('table')
                 if table.find('th', class_='sortable')),
                None,
            )
        if not course_table:
            raise Exception("未找到课表数据，学校可能暂未开放课表查询")

        def normalize_header(value):
            return re.sub(r'\s+', '', value or '')

        header_names = []
        for header_row in course_table.find_all('tr'):
            if header_row.find_parent('thead') is None:
                continue
            header_cells = header_row.find_all(['th', 'td'], recursive=False)
            candidate = [
                normalize_header(cell.get_text(' ', strip=True))
                for cell in header_cells
            ]
            if '课程名' in candidate:
                header_names = candidate
                break

        header_indexes = {name: index for index, name in enumerate(header_names)}

        def header_index(*names):
            for name in names:
                index = header_indexes.get(normalize_header(name))
                if index is not None:
                    return index
            return None

        def cell_text(cells, *names):
            index = header_index(*names)
            if index is None or index >= len(cells):
                return ''
            return cells[index].get_text(strip=True)

        schedule_by_week = defaultdict(list)
        current_course_info = {}

        for row in course_table.find_all('tr'):
            if row.find_parent('thead') is not None:
                continue

            tds = row.find_all('td', recursive=False)
            if not tds:
                continue

            is_full_course_row = bool(header_names) and len(tds) >= len(header_names)
            if is_full_course_row:
                current_course_info = {
                    '课程号': cell_text(tds, '课程号', '课程代码'),
                    '课程名': cell_text(tds, '课程名'),
                    '学分': cell_text(tds, '学分'),
                    '课程属性': cell_text(tds, '课程属性'),
                    '考试类型': cell_text(tds, '考试类型'),
                    '教师': cell_text(tds, '教师', '任课教师').rstrip('* '),
                    '修读方式': cell_text(tds, '修读方式'),
                    '选课状态': cell_text(tds, '选课状态'),
                }

            if len(tds) < 7 or not current_course_info.get('课程名'):
                continue

            if is_full_course_row:
                week_str = cell_text(tds, '周次', '上课周次')
                day_str = cell_text(tds, '星期', '上课星期')
                period_str = cell_text(tds, '节次', '上课节次')
                duration_str = cell_text(tds, '节数', '上课节数')
                campus_str = cell_text(tds, '校区')
                building_str = cell_text(tds, '教学楼')
                room_str = cell_text(tds, '教室')
            else:
                week_str, day_str, period_str, duration_str = (
                    tds[-7].get_text(strip=True),
                    tds[-6].get_text(strip=True),
                    tds[-5].get_text(strip=True),
                    tds[-4].get_text(strip=True),
                )
                campus_str, building_str, room_str = (
                    tds[-3].get_text(strip=True),
                    tds[-2].get_text(strip=True),
                    tds[-1].get_text(strip=True),
                )

            if not week_str:
                continue

            weeks = self._parse_weeks(week_str)
            period_num = self._parse_period(period_str)
            location = f'{campus_str}{building_str}{room_str}'
            for week in weeks:
                schedule_by_week[week].append({
                    **current_course_info,
                    '星期': day_str,
                    '节次': period_num,
                    '节数': duration_str,
                    '校区': campus_str,
                    '教学楼': building_str,
                    '教室': room_str,
                    '位置': location,
                })

        schedule_data = {str(week): courses for week, courses in schedule_by_week.items()}
        user_dir = os.path.dirname(user_data_file(self.account, 'schedule.json'))
        os.makedirs(user_dir, exist_ok=True)
        with open(os.path.join(user_dir, 'schedule.json'), 'w', encoding='utf-8') as f:
            json.dump(schedule_data, f, ensure_ascii=False, indent=2)

        return schedule_data

    def historical_schedule_cx(self, semester=None):
        """查询历年学期课表；未指定学期时自动选择页面中的最新学期。"""
        requested = (semester or '').strip()
        if requested:
            return self._fetch_historical_schedule(requested)

        initial = self._fetch_historical_schedule('')
        latest = self._select_latest_historical_semester(
            initial.get('semesters', [])
        )
        if not latest:
            return initial
        if initial.get('semester') == latest['value']:
            initial['semester'] = latest['value']
            return initial
        return self._fetch_historical_schedule(latest['value'])

    def _fetch_historical_schedule(self, semester):
        """请求并解析一个指定学期的历年课表页面。"""
        base_url = self.url.rstrip('/')
        schedule_url = f'{base_url}/lnkbcxAction.do'
        parsed_url = urlsplit(base_url)
        semester = (semester or '').strip()
        headers = {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
            'Cache-Control': 'max-age=0',
            'Connection': 'keep-alive',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Origin': f'{parsed_url.scheme}://{parsed_url.netloc}',
            'Referer': schedule_url,
            'Sec-Fetch-Dest': 'frame',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0',
            'sec-ch-ua': '"Chromium";v="152", "Not?A_Brand";v="24", "Microsoft Edge";v="152"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
        }
        response = self._request(
            'POST',
            schedule_url,
            headers=headers,
            data={'zxjxjhh': semester},
            verify=False,
        )
        soup = BeautifulSoup(response.text, 'html.parser')

        semesters = []
        for option in soup.select('select[name="zxjxjhh"] option'):
            value = option.get('value', '').strip()
            label = option.get_text(' ', strip=True)
            if value:
                semesters.append({'value': value, 'label': label})

        grid_table = self._find_historical_grid(soup)
        if not grid_table:
            raise Exception("未找到历年课表网格，学校可能暂未开放课表查询")

        return {
            'semester': semester,
            'semesters': semesters,
            'courses': self._parse_historical_grid(grid_table),
        }

    @staticmethod
    def _select_latest_historical_semester(semesters):
        """从 URP 学期选项中选择学年和学期最晚的一项。"""
        candidates = []
        for index, option in enumerate(semesters or []):
            if not isinstance(option, dict):
                continue

            value = str(option.get('value') or '').strip()
            label = str(option.get('label') or '').strip()
            if not value:
                continue

            years = re.findall(
                r'(?<!\d)(?:19|20)\d{2}(?!\d)', value
            )
            if len(years) < 2:
                years = re.findall(
                    r'(?<!\d)(?:19|20)\d{2}(?!\d)', label
                )
            if len(years) < 2:
                continue

            term = None
            term_match = re.search(r'-(1|2)(?:-|$)', value)
            if term_match:
                term = int(term_match.group(1))
            elif '下' in label or '春' in label:
                term = 2
            elif '上' in label or '秋' in label:
                term = 1
            if term is None:
                continue

            normalized = dict(option)
            normalized['value'] = value
            normalized['label'] = label
            candidates.append((int(years[1]), term, index, normalized))

        if not candidates:
            return None
        return max(candidates, key=lambda item: item[:3])[-1]

    @staticmethod
    def _find_historical_grid(soup):
        """定位 ``#dayin`` 中的星期网格，避免误选课程明细表。"""
        dayin = soup.find(id='dayin')
        tables = []
        if dayin:
            tables.extend(dayin.find_all('table', class_='displayTag'))
        # 部分学校页面可能没有保留 dayin 容器，保留兼容性回退；
        # 有 dayin 时不扫描容器外的表格，避免同页课程明细表被误选。
        if not tables and not dayin:
            tables = soup.find_all('table', class_='displayTag')

        for table in tables:
            thead = table.find('thead')
            if not thead:
                continue
            day_headers = thead.find_all('td', class_='sortable')
            if len(day_headers) == 9 and not thead.find('th', class_='sortable'):
                return table
        return None

    @classmethod
    def _parse_historical_grid(cls, grid_table):
        period_pattern = re.compile(r'第+\s*([一二三四五六七八九十\d]{1,3})\s*节+')
        courses = []

        for row in grid_table.find_all('tr'):
            cells = row.find_all(['td', 'th'], recursive=False)
            if not cells:
                continue

            period_index = None
            period = None
            for index, cell in enumerate(cells):
                match = period_pattern.search(cell.get_text(' ', strip=True))
                if match:
                    period_index = index
                    period = cls._parse_historical_period(match.group(1))
                    break
            if period_index is None or period is None:
                continue

            day_cells = cells[period_index + 1:period_index + 8]
            if len(day_cells) != 7:
                continue

            for day, cell in enumerate(day_cells, start=1):
                for text in cls._historical_cell_parts(cell):
                    course = cls._parse_historical_course_text(text)
                    if course:
                        course.update({
                            '星期': str(day),
                            '节次': str(period),
                        })
                        courses.append(course)

        courses.sort(key=lambda course: (
            int(course['星期']),
            int(course['节次']),
            course['课程名'],
            course.get('位置', ''),
        ))
        merged = []
        for course in courses:
            if merged:
                previous = merged[-1]
                previous_end = int(previous['节次']) + int(previous['节数'])
                if (
                    previous['星期'] == course['星期']
                    and previous['课程名'] == course['课程名']
                    and previous.get('课序', '') == course.get('课序', '')
                    and previous.get('位置', '') == course.get('位置', '')
                    and previous_end == int(course['节次'])
                ):
                    previous['节数'] = str(int(previous['节数']) + int(course['节数']))
                    continue
            merged.append(course)
        return merged

    @staticmethod
    def _parse_historical_period(token):
        if token.isdigit():
            return int(token)
        number_map = {
            '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
            '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
        }
        if token in number_map:
            return number_map[token]
        if len(token) == 2 and token[0] == '十' and token[1] in number_map:
            return 10 + number_map[token[1]]
        return None

    @staticmethod
    def _historical_cell_parts(cell):
        text = cell.get_text('\n', strip=True)
        parts = []
        for part in re.split(r'[\r\n]+', text):
            normalized = re.sub(r'\s+', ' ', part.replace('\xa0', ' ')).strip()
            if normalized:
                parts.append(normalized)
        return parts

    @staticmethod
    def _parse_historical_course_text(text):
        match = re.match(r'^(.*?)(?:_(\d+))?\s*\(([^()]*)\)\s*$', text)
        if match:
            course_name = match.group(1).strip()
            class_no = match.group(2) or ''
            location = match.group(3).strip()
        else:
            course_name = text.strip()
            class_no = ''
            location = ''
        if not course_name:
            return None

        campus = ''
        campus_match = re.search(r'(.+?校区)', location)
        if campus_match:
            campus = campus_match.group(1)

        return {
            '课程号': '',
            '课程名': course_name,
            '学分': '',
            '教师': '',
            '节数': '1',
            '校区': campus,
            '教学楼': '',
            '教室': '',
            '位置': location,
            '课序': class_no,
        }

    @staticmethod
    def _parse_weeks(week_str):
        """解析周次字符串，如 '第1-16周' '1,5-13周' → [1, 5, 6, ..., 13]"""
        week_str = week_str.replace('周', '').replace('第', '').strip()
        if not week_str:
            return []
        weeks = []
        for part in week_str.split(','):
            part = part.strip()
            if '-' in part:
                start, end = part.split('-')
                weeks.extend(range(int(start), int(end) + 1))
            elif part:
                weeks.append(int(part))
        return sorted(set(weeks))

    @staticmethod
    def _parse_period(period_str):
        """解析节次字符串，如 '第一节' -> '1'"""
        period_map = {
            '第一节': '1', '第二节': '2', '第三节': '3', '第四节': '4',
            '第五节': '5', '第六节': '6', '第七节': '7', '第八节': '8',
            '第九节': '9', '第十节': '10'
        }
        return period_map.get(period_str, period_str)

    # ==================== 考试查询 ====================

    def exam_cx(self):
        headers = {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
            'Connection': 'keep-alive',
            'Referer': f'{self.url}menu/menu.jsp',
            'Upgrade-Insecure-Requests': '1',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 Edg/144.0.0.0',
        }
        response = self._request('GET', f'{self.url}ksApCxAction.do',
                               params={'oper': 'getKsapXx', 'yzxh': self.account},
                               headers=headers, verify=False)
        soup = BeautifulSoup(response.text, 'html.parser')

        exam_table = next(
            (t for t in soup.find_all('table')
             if t.find_all('th') and any('考试名' in th.get_text() for th in t.find_all('th'))),
            None
        )
        if not exam_table:
            raise Exception("未找到考试安排表格，学校可能暂未开放考试查询")

        exams_by_week = {}
        for row in exam_table.find_all('tr', class_='odd'):
            cols = row.find_all('td')
            if len(cols) < 10:
                continue
            exam = {
                '考试名': cols[0].get_text(strip=True),
                '校区': cols[1].get_text(strip=True),
                '教学楼': cols[2].get_text(strip=True),
                '教室': cols[3].get_text(strip=True),
                '课程': cols[4].get_text(strip=True).replace('&nbsp;', '').strip(),
                '考试周次': cols[5].get_text(strip=True),
                '考试星期': cols[6].get_text(strip=True),
                '考试时间': cols[7].get_text(strip=True),
                '座位号': cols[8].get_text(strip=True),
            }
            exam['位置'] = f"{exam['校区']}{exam['教学楼']}{exam['教室']}"
            week = exam['考试周次']
            exams_by_week.setdefault(week, []).append(exam)

        with open(user_data_file(self.account, 'exams.json'), 'w', encoding='utf-8') as f:
            json.dump(exams_by_week, f, ensure_ascii=False, indent=2)

        return exams_by_week
