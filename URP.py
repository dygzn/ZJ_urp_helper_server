import requests
import urllib3
from bs4 import BeautifulSoup
import json
import os
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

class URP_login:
    def __init__(self, url, account, password):
        self.url = url
        self.account = account
        self.password = password
        self.x = requests.session()


    '''
    def vpncookie_get(self):
        vpn_cookie = self.x.get(url='http://101.35.254.245/vpn',verify=False).json()
        self.x.cookies.update(vpn_cookie)
    '''
    def login(self):
        import ddddocr
        import random
        header = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 Edg/137.0.0.0",
            "Referer": f"{self.url}/loginAction.do",
            "Origin": f"{self.url}",
            "Content-Type": "application/x-www-form-urlencoded"
        }
        ocr = ddddocr.DdddOcr(show_ad=False)
        random_param = random.random()
        yzm_url = f"{self.url}/validateCodeAction.do?random={random_param}"
        try:
            yzm = ocr.classification(self.x.get(yzm_url,verify=False).content)
        except Exception as e:
            return False, f"验证码识别失败: {str(e)}", None
        data = {
            "zjh1": "",
            "tips": "",
            "lx": "",
            "evalue": "",
            "eflag": "",
            "fs": "",
            "dzslh": "",
            "zjh": self.account,
            "mm": self.password,
            "v_yzm": yzm
        }
        try:
            result = self.x.post(f"{self.url}/loginAction.do", data=data, headers=header,verify=False).text
            if '学分制综合教务' in result:
                cookie_file = f'user_data/{self.account}'
                os.makedirs(cookie_file, exist_ok=True)
                with open(f'user_data/{self.account}/cookie.json', 'w', encoding='utf-8') as f:
                    json.dump(self.x.cookies.get_dict(), f, ensure_ascii=False, indent=4)
                return True, "登录成功", self.x.cookies.get_dict()
            elif '您的密码不正确，请您重新输入！' in result:
                return False, "密码错误", None
            elif '你输入的验证码错误，请您重新输入！' in result:
                # 验证码错误，重试最多3次
                for i in range(3):
                    success, message, cookies = self.login()
                    if success:
                        return True, message, cookies
                return False, "验证码多次识别失败，请重试", None
            else:
                return False, "登录失败，请检查账号密码", None
        except Exception as e:
            return False, f"登录异常: {str(e)}", None

    def is_logined(self):
        check_url = f'{self.url}/menu/top.jsp'
        cookie_file = f'user_data/{self.account}/cookie.json'
        if not os.path.exists(cookie_file):
            return False
        try:
            with open(cookie_file,'r',encoding='utf-8') as f:
                urp_cookie = json.load(f)
                # 先获取VPN cookie，再合并URP cookie，确保两者都存在
                self.x.cookies.update(urp_cookie)
        except Exception:
            success, _, _ = self.login()
            return success
        r = self.x.get(check_url,timeout=5,verify=False).text
        if self.account in r:
            return True
        else:
            # cookie失效时，重新获取VPN cookie以便后续登录
            return False


class URP_query:
    def __init__(self, url, account):
        self.url = url
        self.account = account
        self.x = requests.session()
        with open(f'user_data/{self.account}/cookie.json', 'r', encoding='utf-8') as f:
            urp_cookie = json.load(f)
            self.x.cookies.update(urp_cookie)

    def score_query(self):
        score_url = f"{self.url}gradeLnAllAction.do?type=ln&oper=qbinfo&"
        html = self.x.get(score_url, verify=False, timeout=10).text
        soup = BeautifulSoup(html, 'html.parser')
        anchor = soup.find('a', attrs={'name': '2025-2026学年秋(两学期)'})
        if not anchor: return []
        score_table = None
        for elem in anchor.next_siblings:
            if getattr(elem, 'name', None) == 'a' and elem.get('name'): break
            if getattr(elem, 'name', None):
                t = elem.find('table', class_='displayTag', id='user')
                if t: score_table = t; break
        if not score_table: return []
        courses = []
        for r in score_table.find_all('tr'):
            tds = r.find_all('td')
            if len(tds) < 8: continue
            courses.append({'课程名': tds[2].get_text(strip=True), '成绩': tds[7].get_text(strip=True)})
        params = {
            'type': 'ln',
            'oper': 'bjg',
            'yzxh': f'{self.account}',
        }
        response = self.x.get(f'{self.url}gradeLnAllAction.do',params=params,verify=False)
        soup = BeautifulSoup(response.text, 'html.parser')
        rows = soup.find_all('tr', class_='odd')
        for row in rows:
            cols = row.find_all('td')
            if len(cols) >= 8:
                course_name = cols[2].get_text(strip=True)
                grade = cols[7].get_text(strip=True)
                courses.append({'课程名': course_name, '成绩': grade})
        params = {
            'oper': 'queryXfjd',
        }
        response = self.x.get(f'{self.url}gradeLnAllAction.do',params=params,verify=False,)
        soup = BeautifulSoup(response.text, 'html.parser')
        inputs = soup.find_all('input', style="width: 60px;")
        credit_gpa = inputs[0].get('value') if len(inputs) > 0 else None
        degree_gpa = inputs[1].get('value') if len(inputs) > 1 else None
        courses.append({'课程名': ' 学分绩点', '成绩':credit_gpa })
        courses.append({'课程名': ' 学位绩点', '成绩':degree_gpa })
        return courses

    def check_evaluation(self):
        listWj_url = f"{self.url}jxpgXsAction.do?oper=listWj&yzxh={self.account}"
        headers = {
            'Host': f'{self.url}',
            'User-Agent': "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 Edg/137.0.0.0",
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.8,zh-TW;q=0.7,zh-HK;q=0.5,en-US;q=0.3,en;q=0.2',
            'Accept-Encoding': 'gzip, deflate, br',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': '235',
            'Origin': f'{self.url}',
            'Connection': 'keep-alive',
            'Referer': f'{self.url}jxpgXsAction.do?oper=listWj&yzxh={self.account}',
            'Upgrade-Insecure-Requests': '1',
            'Priority': 'u=4',
        }
        params = {
            'oper': 'listWj',
            'yzxh': self.account,
        }
        # 获取课程列表
        pg_lists = self.x.get(listWj_url, params=params, headers=headers,verify=False).text
        soup = BeautifulSoup(pg_lists, 'html.parser')
        # 统计未评价课程数量
        pg_list = []
        # 找所有没评价的课程并提交评价
        for tr in soup.find_all('tr'):
            tds = tr.find_all('td')
            if len(tds) >= 4 and tds[3].get_text(strip=True) == '否':
                img_tag = tr.find('img')
                if img_tag and 'name' in img_tag.attrs:
                    name_field = img_tag['name']
                    parts = name_field.split('#@')
                    if len(parts) >= 6:
                        wjbm = parts[0]
                        bpr = parts[1]
                        pgnr = parts[5]
                        teacher_name = parts[2]
                        course_name = parts[4]
                        data = {
                            "未评课程": course_name,
                            "教师": teacher_name,
                            "wjbm": wjbm,
                            "bpr": bpr,
                            "pgnr": pgnr,
                            "oper": "wjShow"
                        }
                        pg_list.append(data)
                        return pg_list
        if not pg_list:
            return None

    def do_evaluation(self, pg_list):
        url= f'{self.url}jxpgXsAction.do'
        wjpg_url = f'{self.url}jxpgXsAction.do?oper=wjpg'
        headers1 = {
                    'Host': f'{self.url}',
                    'User-Agent': "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 Edg/137.0.0.0",
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'zh-CN,zh;q=0.8,zh-TW;q=0.7,zh-HK;q=0.5,en-US;q=0.3,en;q=0.2',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': '235',
                    'Origin': f'{self.url}',
                    'Connection': 'keep-alive',
                    'Referer': f'{self.url}jxpgXsAction.do?oper=listWj&yzxh={self.account}',
                    'Upgrade-Insecure-Requests': '1',
                    'Priority': 'u=4',
                    }
        headers2 = {
            'Host': f'{self.url}',
            'User-Agent': "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 Edg/137.0.0.0",
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.8,zh-TW;q=0.7,zh-HK;q=0.5,en-US;q=0.3,en;q=0.2',
            'Accept-Encoding': 'gzip, deflate, br',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Origin': f'{self.url}',
            'Connection': 'keep-alive',
            'Referer': f'{self.url}jxpgXsAction.do',
            'Upgrade-Insecure-Requests': '1',
            'Priority': 'u=4'
        }
        for course in pg_list:
            wjbm = course['wjbm']
            bpr = course['bpr']
            pgnr = course['pgnr']
            data = {
            "wjbm": wjbm,
            "bpr": bpr,
            "pgnr": pgnr,
            "oper": "wjShow"
            }
            self.x.post(url, data=data, headers=headers1,)
            pgnr_data = {
            'wjbm': wjbm,
            'bpr': bpr,
            'pgnr': pgnr,
            'xumanyzg': 'zg',
            'wjbz': '',
            '0000000005': '20_1',
            '0000000007': '0_0',
            '0000000008': '0_0',
            '0000000011': '0_0',
            '0000000012': '0_0',
            '0000000013': '0_0',
            '0000000018': '5_0.9',
            '0000000019': '0_0',
            '0000000014': '0_0',
            '0000000006': '20_1',
            '0000000002': '5_1',
            '0000000003': '10_1',
            '0000000017': '10_1',
            '0000000020': '20_1',
            '0000000015': '5_1',
            '0000000016': '5_0.7',
            'zgpj': ''
            }
            r = self.x.post(wjpg_url, data=pgnr_data, headers=headers2,).text
            if '评估成功' not in r:
                return False
        return True

    def schedule_cx(self):
        from collections import defaultdict
        headers = {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
            'Connection': 'keep-alive',
            'Referer': f'{self.url}menu/menu.jsp',
            'Sec-Fetch-Dest': 'frame',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 Edg/145.0.0.0',
            'sec-ch-ua': '"Not:A-Brand";v="99", "Microsoft Edge";v="145", "Chromium";v="145"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"'
        }
        params = {
            'actionType': '6',
            'yzxh': f'{self.account}',
        }
        response = self.x.get(f'{self.url}xkAction.do', headers=headers, params=params, verify=False)
        html = response.text
        print(html)                                                  
        soup = BeautifulSoup(html, 'html.parser')

        # 找到课程列表表格（包含 class="sortable" 的表头）
        course_table = None
        for table in soup.find_all('table'):
            if table.find('th', class_='sortable'):
                course_table = table
                break

        if not course_table:
            raise Exception("未找到课表数据，学校可能暂未开放课表查询")

        # 按周次组织课程
        schedule_by_week = defaultdict(list)
        rows = course_table.find_all('tr', class_='odd')
        current_course_info = {}

        for row in rows:
            tds = row.find_all('td')
            if not tds:
                continue

            # 检查是否有rowspan，表示新课程开始
            has_rowspan = any(td.get('rowspan') for td in tds)

            if has_rowspan:
                # 新课程行：提取课程号、课程名、学分（第2、3、5个有rowspan的td）
                rowspan_tds = [td for td in tds if td.get('rowspan')]
                if len(rowspan_tds) >= 5:
                    current_course_info['课程号'] = rowspan_tds[1].get_text(strip=True)
                    current_course_info['课程名'] = rowspan_tds[2].get_text(strip=True)
                    current_course_info['学分'] = rowspan_tds[4].get_text(strip=True)

            # 提取时间地点信息（最后7个td，无论是否有rowspan）
            # 从后往前取：教室、教学楼、校区、节数、节次、星期、周次
            if len(tds) >= 7:
                week_str = tds[-7].get_text(strip=True)
                day_str = tds[-6].get_text(strip=True)
                period_str = tds[-5].get_text(strip=True)
                duration_str = tds[-4].get_text(strip=True)
                campus_str = tds[-3].get_text(strip=True)
                building_str = tds[-2].get_text(strip=True)
                room_str = tds[-1].get_text(strip=True)

                if week_str and current_course_info.get('课程名'):
                    weeks = self._parse_weeks(week_str)
                    location = f"{campus_str}{building_str}{room_str}" if campus_str and building_str and room_str else ""

                    # 解析节次（"第一节" -> "1"）
                    period_num = self._parse_period(period_str)

                    for week in weeks:
                        schedule_by_week[week].append({
                            '课程号': current_course_info.get('课程号', ''),
                            '课程名': current_course_info['课程名'],
                            '学分': current_course_info.get('学分', ''),
                            '星期': day_str,
                            '节次': period_num,
                            '节数': duration_str,
                            '校区': campus_str,
                            '教学楼': building_str,
                            '教室': room_str,
                            '位置': location
                        })

        schedule_data = {str(k): v for k, v in schedule_by_week.items()}

        # 保存到 user_data/{account}/schedule.json
        user_dir = os.path.join('user_data', self.account)
        os.makedirs(user_dir, exist_ok=True)
        with open(os.path.join(user_dir, 'schedule.json'), 'w', encoding='utf-8') as f:
            json.dump(schedule_data, f, ensure_ascii=False, indent=2)

        return schedule_data

    @staticmethod
    def _parse_weeks(week_str):
        """解析周次字符串，如 '1,5-13周' → [1, 5, 6, ..., 13]"""
        week_str = week_str.replace('周', '').strip()
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
        """解析节次字符串，如 '第一节' -> '1', '第三节' -> '3'"""
        period_map = {
            '第一节': '1', '第二节': '2', '第三节': '3', '第四节': '4',
            '第五节': '5', '第六节': '6', '第七节': '7', '第八节': '8',
            '第九节': '9', '第十节': '10'
        }
        return period_map.get(period_str, period_str)






    def exam_cx(self):
        headers = {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
            'Connection': 'keep-alive',
            'Referer': f'{self.url}menu/menu.jsp',
            'Sec-Fetch-Dest': 'frame',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 Edg/144.0.0.0',
            'sec-ch-ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Microsoft Edge";v="144"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
        }

        params = {
            'oper': 'getKsapXx',
            'yzxh': f'{self.account}',
        }
        response = self.x.get(f'{self.url}ksApCxAction.do',params=params,headers=headers,verify=False)
        html = response.text
        soup = BeautifulSoup(html, 'html.parser')

        # 找到考试安排表格（包含"考试名"的表格）
        exam_table = None
        for table in soup.find_all('table'):
            headers = table.find_all('th')
            if headers and any('考试名' in th.get_text() for th in headers):
                exam_table = table
                break

        if not exam_table:
            raise Exception("未找到考试安排表格，学校可能暂未开放考试查询")

        # 提取考试数据
        exams = []
        rows = exam_table.find_all('tr', class_='odd')

        for row in rows:
            cols = row.find_all('td')
            if len(cols) >= 10:
                exam_data = {
                    '考试名': cols[0].get_text(strip=True),
                    '校区': cols[1].get_text(strip=True),
                    '教学楼': cols[2].get_text(strip=True),
                    '教室': cols[3].get_text(strip=True),
                    '课程': cols[4].get_text(strip=True).replace('&nbsp;', '').strip(),
                    '考试周次': cols[5].get_text(strip=True),
                    '考试星期': cols[6].get_text(strip=True),
                    '考试时间': cols[7].get_text(strip=True),
                    '座位号': cols[8].get_text(strip=True)
                }
                # 添加位置字段（类似schedule.json）
                exam_data['位置'] = f"{exam_data['校区']}{exam_data['教学楼']}{exam_data['教室']}"
                exams.append(exam_data)

        # 按周次分组（类似schedule.json的结构）
        exams_by_week = {}
        for exam in exams:
            week = exam['考试周次']
            if week not in exams_by_week:
                exams_by_week[week] = []
            exams_by_week[week].append(exam)
        # 保存到文件
        with open(f'user_data/{self.account}/exams.json', 'w', encoding='utf-8') as f:
            json.dump(exams_by_week, f, ensure_ascii=False, indent=2)

        return exams_by_week

    




if __name__ == '__main__':
    url = 'https://223.112.21.198:6443/7b68f983'
    account = '2415108133'
    password = '125979'
    u= URP_login(url, account, password)
    print(u.is_logined())