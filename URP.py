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
        self.vpncookie_get()


    """测试方案"""
    def vpncookie_get(self):
        vpn_cookie = self.x.get(url='http://101.35.254.245/vpn',verify=False).json()
        self.x.cookies.update(vpn_cookie)
    def login(self):
        self.vpncookie_get()
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
                return True
            elif '您的密码不正确，请您重新输入！' in result:
                return {'Error':'密码错误'}
            elif '你输入的验证码错误，请您重新输入！' in result:
                for i in range(3):
                    if self.login():
                        return True
                    else:
                        return {'Error':'出错了，不过这不是你的问题，刷新页面试试'}
            else:
                return False
        except Exception as e:
            return False

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
            return self.login()
        r = self.x.get(check_url,timeout=5,verify=False).text
        if self.account in r:
            return True
        else:
            # cookie失效时，重新获取VPN cookie以便后续登录
            self.vpncookie_get()
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


            
    




if __name__ == '__main__':
    url = 'https://223.112.21.198:6443/7b68f983'
    account = '2415108133'
    password = '125979'
    u= URP_login(url, account, password)
    print(u.is_logined())