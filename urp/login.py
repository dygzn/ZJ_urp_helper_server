import requests
import urllib3
import json
import os
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


class URP_login:
    def __init__(self, url, account, password):
        self.url = url
        self.account = account
        self.password = password
        self.x = requests.session()

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
            yzm = ocr.classification(self.x.get(yzm_url, verify=False).content)
        except Exception as e:
            return False, f"验证码识别失败: {str(e)}", None

        data = {
            "zjh1": "", "tips": "", "lx": "", "evalue": "", "eflag": "",
            "fs": "", "dzslh": "",
            "zjh": self.account,
            "mm": self.password,
            "v_yzm": yzm
        }
        try:
            result = self.x.post(f"{self.url}/loginAction.do", data=data, headers=header, verify=False).text
            if '学分制综合教务' in result:
                cookie_dir = f'user_data/{self.account}'
                os.makedirs(cookie_dir, exist_ok=True)
                with open(f'{cookie_dir}/cookie.json', 'w', encoding='utf-8') as f:
                    json.dump(self.x.cookies.get_dict(), f, ensure_ascii=False, indent=4)
                return True, "登录成功", self.x.cookies.get_dict()
            elif '您的密码不正确，请您重新输入！' in result:
                return False, "密码错误", None
            elif '你输入的验证码错误，请您重新输入！' in result:
                for _ in range(3):
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
            with open(cookie_file, 'r', encoding='utf-8') as f:
                urp_cookie = json.load(f)
            self.x.cookies.update(urp_cookie)
        except Exception:
            success, _, _ = self.login()
            return success
        r = self.x.get(check_url, timeout=5, verify=False).text
        return self.account in r
