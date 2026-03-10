import json
import os
import requests
import urllib3
from collections import defaultdict
from bs4 import BeautifulSoup
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

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
        with open(f'user_data/{self.account}/cookie.json', 'r', encoding='utf-8') as f:
            self.x.cookies.update(json.load(f))

    # ==================== 成绩查询 ====================

    def _fetch_score_html(self):
        """获取成绩总览页面 HTML"""
        score_url = f"{self.url}gradeLnAllAction.do?type=ln&oper=qbinfo&"
        return self.x.get(score_url, verify=False, timeout=10).text

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
            courses.append({'课程名': tds[2].get_text(strip=True), '成绩': tds[7].get_text(strip=True)})
        return courses

    def score_current_semester(self):
        """查询本学期成绩"""
        response = self.x.get(f'{self.url}bxqcjcxAction.do', params={
            'mytype': 'bxqcj', 'yzxh': self.account
        }, verify=False, timeout=10)
        soup = BeautifulSoup(response.text, 'html.parser')
        # 检测错误提示页面
        error_td = soup.find('td', class_='errorTop')
        if error_td:
            raise Exception('本学期成绩查询未打开')
        courses = []
        for row in soup.find_all('tr', class_='odd'):
            cols = row.find_all('td')
            if len(cols) >= 8:
                courses.append({'课程名': cols[2].get_text(strip=True), '成绩': cols[7].get_text(strip=True)})
        return courses

    def score_failed(self):
        """查询全部不及格成绩"""
        response = self.x.get(f'{self.url}gradeLnAllAction.do', params={
            'type': 'ln', 'oper': 'bjg', 'yzxh': self.account
        }, verify=False)
        soup = BeautifulSoup(response.text, 'html.parser')
        courses = []
        for row in soup.find_all('tr', class_='odd'):
            cols = row.find_all('td')
            if len(cols) >= 8:
                courses.append({'课程名': cols[2].get_text(strip=True), '成绩': cols[7].get_text(strip=True)})
        return courses

    def score_gpa(self):
        """查询学分绩点和学位绩点"""
        response = self.x.get(f'{self.url}gradeLnAllAction.do', params={'oper': 'queryXfjd'}, verify=False)
        soup = BeautifulSoup(response.text, 'html.parser')
        inputs = soup.find_all('input', style="width: 60px;")
        return {
            '学分绩点': inputs[0].get('value') if len(inputs) > 0 else None,
            '学位绩点': inputs[1].get('value') if len(inputs) > 1 else None,
        }

    def score_query(self):
        score_url = f"{self.url}gradeLnAllAction.do?type=ln&oper=qbinfo&"
        html = self.x.get(score_url, verify=False, timeout=10).text
        soup = BeautifulSoup(html, 'html.parser')

        anchor = soup.find('a', attrs={'name': '2025-2026学年秋(两学期)'})
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
            courses.append({'课程名': tds[2].get_text(strip=True), '成绩': tds[7].get_text(strip=True)})

        # 不及格成绩
        response = self.x.get(f'{self.url}gradeLnAllAction.do', params={
            'type': 'ln', 'oper': 'bjg', 'yzxh': self.account
        }, verify=False)
        soup = BeautifulSoup(response.text, 'html.parser')
        for row in soup.find_all('tr', class_='odd'):
            cols = row.find_all('td')
            if len(cols) >= 8:
                courses.append({'课程名': cols[2].get_text(strip=True), '成绩': cols[7].get_text(strip=True)})

        # 绩点
        response = self.x.get(f'{self.url}gradeLnAllAction.do', params={'oper': 'queryXfjd'}, verify=False)
        soup = BeautifulSoup(response.text, 'html.parser')
        inputs = soup.find_all('input', style="width: 60px;")
        courses.append({'课程名': ' 学分绩点', '成绩': inputs[0].get('value') if len(inputs) > 0 else None})
        courses.append({'课程名': ' 学位绩点', '成绩': inputs[1].get('value') if len(inputs) > 1 else None})
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
        pg_lists = self.x.get(listWj_url, params={'oper': 'listWj', 'yzxh': self.account},
                               headers=headers, verify=False).text
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
        return None if not pg_list else pg_list

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
            self.x.post(url, data={'wjbm': wjbm, 'bpr': bpr, 'pgnr': pgnr, 'oper': 'wjShow'}, headers=headers_show)
            pgnr_data = {
                'wjbm': wjbm, 'bpr': bpr, 'pgnr': pgnr,
                'xumanyzg': 'zg', 'wjbz': '',
                '0000000005': '20_1', '0000000007': '0_0', '0000000008': '0_0',
                '0000000011': '0_0', '0000000012': '0_0', '0000000013': '0_0',
                '0000000018': '5_0.9', '0000000019': '0_0', '0000000014': '0_0',
                '0000000006': '20_1', '0000000002': '5_1', '0000000003': '10_1',
                '0000000017': '10_1', '0000000020': '20_1', '0000000015': '5_1',
                '0000000016': '5_0.7', 'zgpj': ''
            }
            r = self.x.post(wjpg_url, data=pgnr_data, headers=headers_submit).text
            if '评估成功' not in r:
                return False
        return True

    # ==================== 课表查询 ====================

    def schedule_cx(self):
        headers = {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
            'Connection': 'keep-alive',
            'Referer': f'{self.url}menu/menu.jsp',
            'Upgrade-Insecure-Requests': '1',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 Edg/145.0.0.0',
        }
        response = self.x.get(f'{self.url}xkAction.do', headers=headers,
                               params={'actionType': '6', 'yzxh': self.account}, verify=False)
        soup = BeautifulSoup(response.text, 'html.parser')

        course_table = next(
            (t for t in soup.find_all('table') if t.find('th', class_='sortable')),
            None
        )
        if not course_table:
            raise Exception("未找到课表数据，学校可能暂未开放课表查询")

        schedule_by_week = defaultdict(list)
        current_course_info = {}

        for row in course_table.find_all('tr', class_='odd'):
            tds = row.find_all('td')
            if not tds:
                continue

            if any(td.get('rowspan') for td in tds):
                rowspan_tds = [td for td in tds if td.get('rowspan')]
                if len(rowspan_tds) >= 5:
                    current_course_info['课程号'] = rowspan_tds[1].get_text(strip=True)
                    current_course_info['课程名'] = rowspan_tds[2].get_text(strip=True)
                    current_course_info['学分'] = rowspan_tds[4].get_text(strip=True)
                if len(rowspan_tds) >= 8:
                    current_course_info['教师'] = rowspan_tds[7].get_text(strip=True).rstrip('* ')

            if len(tds) >= 7 and current_course_info.get('课程名'):
                week_str, day_str, period_str, duration_str = (
                    tds[-7].get_text(strip=True), tds[-6].get_text(strip=True),
                    tds[-5].get_text(strip=True), tds[-4].get_text(strip=True)
                )
                campus_str, building_str, room_str = (
                    tds[-3].get_text(strip=True), tds[-2].get_text(strip=True),
                    tds[-1].get_text(strip=True)
                )

                if week_str:
                    weeks = self._parse_weeks(week_str)
                    location = f"{campus_str}{building_str}{room_str}"
                    period_num = self._parse_period(period_str)
                    for week in weeks:
                        schedule_by_week[week].append({
                            '课程号': current_course_info.get('课程号', ''),
                            '课程名': current_course_info['课程名'],
                            '学分': current_course_info.get('学分', ''),
                            '教师': current_course_info.get('教师', ''),
                            '星期': day_str,
                            '节次': period_num,
                            '节数': duration_str,
                            '校区': campus_str,
                            '教学楼': building_str,
                            '教室': room_str,
                            '位置': location
                        })

        schedule_data = {str(k): v for k, v in schedule_by_week.items()}

        user_dir = os.path.join('user_data', self.account)
        os.makedirs(user_dir, exist_ok=True)
        with open(os.path.join(user_dir, 'schedule.json'), 'w', encoding='utf-8') as f:
            json.dump(schedule_data, f, ensure_ascii=False, indent=2)

        return schedule_data

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
        response = self.x.get(f'{self.url}ksApCxAction.do',
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

        with open(f'user_data/{self.account}/exams.json', 'w', encoding='utf-8') as f:
            json.dump(exams_by_week, f, ensure_ascii=False, indent=2)

        return exams_by_week
