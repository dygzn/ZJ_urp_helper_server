# URP 后端信息获取功能复现规格（交给另一个 AI）

> 文档日期：2026-09-04  
> 适用代码快照：当前工作区 E:\URP\web（包括尚未提交的本地修改）  
> 目标：让另一个 AI 仅凭本文件和合法的运行配置，复现本项目的后端信息获取能力。  
> 边界：前端只需能生成设备 ID、登录并调用 JSON API；不要求复刻现有页面样式、动画、广告、支付、管理员后台或其它非爬虫业务。  
> 安全说明：本文不包含真实 URP/VPN 账号、密码、Cookie、支付密钥、管理员密钥、数据库口令或用户数据。为保证源码快照可核对，附录保留了当前登录模块中公开可见的固定 VPN 网关地址；它不是凭据，复现时仍应改成部署配置。附录源码是兼容性参考，必须结合第 14 节的修正要求实现，不能不加判断地直接上线。

## 0. 给实现 AI 的直接任务

请实现一个 Flask 后端，使合法用户能够：

1. 使用设备 ID 绑定 URP 学号，并完成 VPN（需要时）与 URP 登录。
2. 保存、检查、恢复和刷新登录 Cookie。
3. 获取并解析当前课表、历年课表、考试安排、本学期成绩、指定学期成绩、不及格成绩、绩点、考试场次、指定考试成绩和待评课程。
4. 在用户明确提交时完成教学评估。
5. 将当前课表与考试安排保存为本地缓存，并根据缓存计算当前/下一紧急事项。
6. 通过稳定的 JSON API 把结果交给任意网页或 App。
7. 对网络失败、登录失效、页面结构变化、无数据和权限不足作出可区分的响应。
8. 不复制本项目中已经确认的安全缺陷和错误吞噬行为。

“复现完成”不是指页面能打开，而是第 16 节中的接口、解析器、缓存、登录恢复和错误场景全部通过验收。

## 1. 范围与非目标

### 1.1 必须复现

- 设备绑定与登录：X-Device-ID、学号、密码、Cookie。
- VPN 通道：共享 VSG_ Cookie、密码认证、探活、单飞恢复、后台保活。
- URP 登录：动态登录表单、验证码 OCR、最多 8 次识别、首页判定、状态检查。
- 教务信息：
  - 当前课表；
  - 历年课表及学期列表；
  - 考试安排；
  - 本学期成绩；
  - 成绩学期列表和指定学期成绩；
  - 最新学期成绩汇总；
  - 尚不及格与曾不及格；
  - 总体绩点与学期绩点；
  - 考试场次与指定考试成绩；
  - 待评课程与批量评教。
- 缓存与派生信息：
  - schedule.json；
  - exams.json；
  - 当前课程、下一课程或考试；
  - 每日异步自动更新与同学号并发抑制。
- Flask JSON API 和最小客户端调用约定。

### 1.2 可选兼容功能

- 快捷指令统一查询接口：historical_schedule、grades、urgent_event。
- 其它年级/专业/班级课表：它读取已有用户缓存，不直接访问 URP。
- 会员门禁：若不复现支付，可用配置开关或人工授权记录代替。
- SQLite 与 MySQL 双后端：最小复现只要求 SQLite。

### 1.3 不在本次范围

- 原网站的 HTML/CSS/SPA 视觉复刻。
- 广告、公告、反馈、管理员统计、邀请返佣、支付、提现。
- 对分易签到代理。它是第三方服务代理，不属于 URP 信息爬虫。
- AI 论文生成功能。
- 抓取未经授权的账号、绕过访问控制或规避学校限制。

## 2. 总体架构与数据流

建议保持以下分层，避免把登录、解析和 HTTP 路由写进同一个文件：

~~~text
客户端
  │  X-Device-ID + JSON
  ▼
Flask 路由层
  │  绑定/登录/会员装饰器
  ▼
业务服务层
  ├─ 登录状态缓存（900 秒）
  ├─ 课表/考试缓存读取
  ├─ 每日自动更新
  └─ 返回字段规范化
  ▼
URP 爬虫层
  ├─ requests.Session
  ├─ VPN 会话恢复
  ├─ URP 登录 + OCR
  ├─ 页面请求
  └─ BeautifulSoup/正则解析
  ▼
学校 VPN / URP
~~~

建议目录：

~~~text
app.py
auth.py
database.py
requirements.txt
data/
  config.example.json
  config.json                 # 不提交
  vpn_cookie.json             # 运行时生成，不提交
user_data/
  <student_id>/
    cookie.json               # 运行时生成，不提交
    schedule.json
    exams.json
routes/
  auth_routes.py
  data_routes.py
  shortcut_routes.py          # 可选
services/
  config_service.py
  user_service.py
  urp_service.py
  shortcut_service.py         # 可选
urp/
  __init__.py
  login.py
  query.py
  schedule_legacy.py
URP.py                        # 兼容导出
tests/
  fixtures/
  test_login_parser.py
  test_query_parsers.py
  test_api_contracts.py
~~~

完整调用链：

~~~text
POST /api/login
  -> URP_login.login()
  -> 条件性 VPN 登录/恢复
  -> GET URP 登录页
  -> GET 验证码 + ddddocr
  -> POST 动态登录表单
  -> user_data/<学号>/cookie.json
  -> users 表写入设备绑定

信息 API
  -> 权限装饰器
  -> services.urp_service
  -> URP_query
  -> 上游 Action.do
  -> HTML 解析
  -> JSON 返回
  -> 当前课表/考试额外写本地缓存
~~~

### 2.1 必须提供的 Python 接口

| 模块 | 必须存在的接口 |
|---|---|
| services.config_service | get_config()；get_current_urp_url()。后者优先返回 urp_urls[current_url_index]，索引无效时回退 urp_url，并统一补尾斜杠 |
| database | init_db()；get_db() 上下文管理器；SQLite 连接使用 sqlite3.Row |
| services.user_service | get_device_id()、get_user_by_device()、get_user_by_username()、bind_user()、unbind_user() |
| urp.login.URP_login | login()、is_logined() |
| urp.query.URP_query | schedule_cx()、historical_schedule_cx()、exam_cx()、各 score 方法、check_evaluation()、do_evaluation() |
| services.urp_service | urp_login()、check_login_status()、缓存读取、成绩包装、评教包装、start_auto_update() |
| auth | require_bindding、require_login、require_grade_login、require_member_login |
| routes | auth_bp、data_bp；可选 shortcut_bp |

若不复现会员支付，仍需让权限函数有确定行为：grades_require_member=false 时成绩只检查登录；评教可以由独立 allow_evaluation 配置或人工授权表控制，不能留下无法满足的会员依赖。

## 3. 运行环境与依赖

当前项目锁定的依赖如下：

~~~text
Flask==3.1.2
requests==2.32.5
urllib3==2.1.0
beautifulsoup4==4.12.2
numpy==1.26.4
opencv-python-headless==4.10.0.84
onnxruntime==1.18.1
Pillow==10.4.0
ddddocr==1.4.11
PyMySQL==1.1.1
~~~

最小启动流程：

~~~powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
~~~

生产环境要求：

- Python 3.10 或更新的稳定版本。
- 服务时区明确设为 Asia/Hong_Kong 或学校所在地时区，否则周次和紧急事项可能错位。
- user_data 与 data 目录可写。
- 多进程部署时，内存登录缓存、VPN 恢复锁和自动更新锁必须迁移到 Redis/数据库锁，或明确只运行一个 worker。
- OCR 依赖必须在目标机器实际 import 成功；只安装 ddddocr 不代表 onnxruntime、OpenCV、NumPy、Pillow 都可用。
- 学校系统可能仅支持旧 TLS/GBK 页面；应按主机细粒度配置，不要全局关闭安全校验。

## 4. 配置、秘密与 URL 约定

### 4.1 安全配置模板

只提交示例文件，不提交真实值：

~~~json
{
  "urp_url": "https://<兜底-urp-host>/<可选前缀>/",
  "urp_urls": [
    "https://<直接访问的-urp-host>/<可选前缀>/",
    "https://<vpn-host>:<port>/<urp-映射前缀>/"
  ],
  "current_url_index": 0,
  "semester_start": "YYYY-MM-DD",
  "grades_require_member": false,
  "database": {
    "type": "sqlite",
    "sqlite_path": "data/urp_helper.db"
  }
}
~~~

VPN 凭据优先从环境变量读取：

~~~text
VPN_AUTH_USERNAME=<vpn-user>
VPN_AUTH_PASSWORD=<vpn-password>
VPN_AUTH_BODY=<仅在上游要求完整原始表单体时使用>
URP_SAVE_DEBUG_FILES=false
FLASK_SECRET_KEY=<随机长字符串>
~~~

实现规则：

- VPN_AUTH_BODY 的优先级可高于用户名/密码，但日志中绝不能打印它。
- URP 学号和密码来自用户登录请求；VPN 账号可以是独立公共通道账号，也可以由部署者配置。
- config.json、cookie.json、vpn_cookie.json、数据库和调试 HTML 必须加入忽略规则。
- 日志只记录错误类型、上游阶段、状态码和请求 ID，不记录密码、Cookie、验证码、完整表单、学号或响应正文。
- 不要从当前项目的 constants.py、config_service.py 或 data/config.json 复制任何真实秘密值。

### 4.2 URL 拼接

当前查询源码多数使用 base_url + Action.do，因此旧实现隐含要求 base_url 以斜杠结尾；历年课表又单独执行了 rstrip。新实现应统一：

~~~python
from urllib.parse import urljoin

def normalize_base_url(value: str) -> str:
    return value.rstrip('/') + '/'

def endpoint(base_url: str, path: str) -> str:
    return urljoin(normalize_base_url(base_url), path.lstrip('/'))
~~~

所有路由只接收服务端配置里的 base URL，不能让客户端提交任意 URL，以免形成 SSRF。

## 5. 持久化与运行时状态

### 5.1 最小数据库结构

复现信息获取只需 users 表；若启用会员成绩/评教和快捷指令，再加入 memberships 与 api_keys。

~~~sql
CREATE TABLE IF NOT EXISTS users (
    device_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    bind_time TEXT NOT NULL,
    last_auto_update TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_username
ON users(username);

CREATE TABLE IF NOT EXISTS memberships (
    username TEXT PRIMARY KEY,
    member_type TEXT NOT NULL,
    expire_time TEXT NOT NULL,
    create_time TEXT
);

CREATE TABLE IF NOT EXISTS api_keys (
    username TEXT PRIMARY KEY,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    create_time TEXT NOT NULL
);
~~~

兼容现状时，users.password 是可回登的明文密码；安全复现必须改成应用级加密后保存，密钥来自部署环境。若不允许保存密码，则 Cookie 失效后返回 login_required，由用户重新输入密码。

### 5.2 文件结构和格式

| 路径 | 内容 | 写入者 | 读取者 |
|---|---|---|---|
| data/vpn_cookie.json | 仅共享 VSG_ Cookie 与 updated_at | VPN 登录/保活 | 所有 VPN Session |
| user_data/<username>/cookie.json | 该用户 requests Cookie 字典 | URP 登录 | URP_query、状态检查 |
| user_data/<username>/schedule.json | 按周分组的当前课表 | schedule_cx | 课表 API、紧急事项 |
| user_data/<username>/exams.json | 按考试周分组 | exam_cx | 考试 API、紧急事项 |

建议使用临时文件 + os.replace 原子写入，避免进程中断留下半截 JSON。username 必须先通过严格学号正则校验，例如仅允许 6 至 20 位字母数字，禁止斜杠、点号和控制字符。

## 6. 设备绑定、权限与公共响应

### 6.1 设备身份

客户端首次运行生成 UUID，持久化后在所有用户 API 中发送：

~~~http
X-Device-ID: <uuid>
Content-Type: application/json
~~~

现有代码在缺少 Header 时回退为 MD5(User-Agent + IP)。为了避免碰撞和网络变化，新实现应直接返回参数错误；只有兼容旧客户端时才启用回退。更重要的是，device_id 只是设备标识，不应单独充当认证凭证：登录成功后应由服务端签发 HttpOnly、Secure、SameSite Cookie 会话或短期 Bearer Token，并把它与 device_id 和 username 绑定。迁移期可以继续接收 X-Device-ID，但受保护接口必须同时验证服务端会话。

### 6.2 权限层

| 权限 | 检查 | 用于 |
|---|---|---|
| bound | 有效服务端会话 + X-Device-ID 对应 users 记录 | 读课表/考试缓存、紧急事项 |
| login | bound + URP Cookie 有效，必要时自动重登 | 实时课表、历年课表、考试 |
| grade_login | login + 可配置会员检查 | 全部成绩 |
| member_login | login + basic/advanced 会员 | 待评课程和提交评教 |
| api_key_login | API key 有效 + 会员 + 学号存在 + URP 登录 | 可选快捷指令 |

评教在当前代码中仅使用 member，未预先检查 URP 登录。正确复现应使用 member_login。

### 6.3 统一响应

建议所有接口使用真实 HTTP 状态码，同时保留 success 字段：

~~~json
{
  "success": false,
  "error_code": "login_required",
  "message": "登录已过期，请重新登录",
  "data": null,
  "request_id": "<trace-id>"
}
~~~

推荐状态码：

| 状态 | HTTP |
|---|---:|
| 参数错误 | 400 |
| 未绑定/未登录 | 401 |
| 无会员或权限不足 | 403 |
| 上游暂不可用 | 502 |
| 上游超时 | 504 |
| 页面结构变化/解析失败 | 502 |
| 服务器内部错误 | 500 |

若必须完全兼容现有前端，可继续为多数业务失败返回 HTTP 200，但客户端仍必须检查 success；不要再把异常伪装为空数据的成功响应。

## 7. VPN 与 URP 登录状态机

### 7.1 VPN 会话

仅当配置的 URP URL 指向 VPN 映射主机时执行：

1. 从 data/vpn_cookie.json 读取 Cookie。
2. 只接受名字以 VSG_ 开头的 Cookie，防止不同用户的 URP Cookie进入共享池。
3. 用共享 Cookie访问映射后的 URP 根地址探活。
4. 若有效，合并到用户 Session。
5. 若无效，在进程级互斥锁内再次检查，避免并发重复登录。
6. 设置上游要求的启动 Cookie。
7. GET VPN 登录页。
8. POST VPN 密码认证接口。用户名与密码按当前上游要求 Base64，表单包含 encode=1；若部署配置给出完整认证体则按原始字符串提交。
9. 只有 HTTP 200 且响应含上游成功码才算成功。
10. GET VPN 门户页，使 Cookie 完整。
11. 仅保存 VSG_ Cookie。
12. 启动唯一后台线程，每 300 秒探活；失败时删除共享 Cookie，下一次真实请求再恢复。

所有经过 VPN 的数据请求都遵循：

~~~text
发送原请求
  -> 响应不是 VPN 登录/错误/维护页：直接返回
  -> 命中 VPN 失败页：
       recover_vpn_session（锁内）
       -> 恢复成功后，在锁外重试原请求一次
       -> 再失败：抛 VPNUnavailableError
~~~

注意：恢复锁只保护“恢复会话”，不包住重试请求。

### 7.2 URP 登录

1. GET URP 根页，VPN 模式带门户 Referer。
2. 按 GBK 解释登录页。
3. 找 form[name=loginForm]。
4. 保存 form action，并收集该 form 内所有带 name 的 input 当前 value；不是只收 hidden。
5. 创建 ddddocr.DdddOcr(show_ad=False)。
6. GET validateCodeAction.do，Query 为随机 random。
7. 验证 Content-Type 或文件魔数确实是图片；若收到 VPN HTML，先恢复 VPN 后只重试一次验证码。
8. OCR 后只保留 ASCII 字母和数字；空结果继续下一次。
9. 用 urljoin(form_url, form_action) 得到登录提交 URL。
10. POST 原表单字段，并覆盖：
    - zjh：学号；
    - mm：密码；
    - v_yzm：验证码。
11. 成功判定不是只看 HTTP 200，而是页面含 frameset 地址或“个人管理、学生个人课表、网上选课、信息查询、教学评价”等首页信号，且不是 URP 登录页/VPN 失败页。
12. 失败后重新 GET 登录页和动态字段，再识别下一张验证码。
13. 最多 8 次。
14. 成功后保存完整用户 Cookie；VPN 模式还更新共享 VSG_ Cookie。
15. 返回三元组：success、message、cookies。

### 7.3 登录状态检查

- Cookie 文件不存在：未登录。
- 加载 Cookie 到 Session。
- VPN 模式先合并共享 Cookie并探活；失败时调用完整 login。
- GET menu/top.jsp，5 秒超时。
- 响应正文含当前学号：有效。
- 不含或请求异常：调用完整 login。
- 业务服务层可缓存检查结果 900 秒；VPN URL 不建议使用这个短路缓存，因为共享通道随时可能失效。
- Cookie 失效并重登失败时，删除用户 Cookie 文件并返回明确 login_required。

## 8. 上游请求完整矩阵

以下路径均相对于服务端配置的 urp_base。方法、参数与解析依据是复现的核心。

| 功能 | HTTP 与路径 | Query/Form | 编码与解析 | 原始结果 |
|---|---|---|---|---|
| URP 登录页 | GET 根路径 | 无 | GBK；loginForm 全部 input | form action/fields |
| 验证码 | GET validateCodeAction.do | Query random | 图片 + OCR | 字母数字验证码 |
| 登录提交 | POST 动态 form action | zjh、mm、v_yzm + 动态字段 | GBK；首页信号 | Cookie |
| 登录检查 | GET menu/top.jsp | 无 | 正文含学号 | bool |
| 当前课表 | GET xkAction.do | actionType=6、yzxh | sortable 表、rowspan | 按周课程对象 |
| 历年课表 | POST lnkbcxAction.do | Form zxjxjhh | select + #dayin 星期网格 | 学期与课程 |
| 考试安排 | GET ksApCxAction.do | oper=getKsapXx、yzxh | 表头含“考试名”、tr.odd | 按周考试对象 |
| 成绩总览 | GET gradeLnAllAction.do | type=ln、oper=qbinfo | 学期锚点 + displayTag#user | 学期列表/课程 |
| 本学期成绩 | GET bxqcjcxAction.do | mytype=bxqcj、yzxh | td.errorTop、tr.odd | 课程名/成绩 |
| 不及格 | GET gradeLnAllAction.do | type=ln、oper=bjg、yzxh | 前两个 displayTag 表 | current/past |
| 绩点 | GET gradeLnAllAction.do | oper=queryXfjd | GB18030；input + 明细表 | 总体/学期绩点 |
| 考试场次 | GET cjSearchAction.do | oper=getKscjList、yzxh | select + JS new Array | 学期/考试 |
| 考试成绩 | POST cjSearchAction.do | Query oper=tjcx；Form jxzxjh、ksbh、yzxh | tr.odd | 课程/学分/成绩 |
| 待评课程 | GET jxpgXsAction.do | oper=listWj、yzxh | 第 4 列“否”；img.name | 课程和问卷键 |
| 打开问卷 | POST jxpgXsAction.do | wjbm、bpr、pgnr、oper=wjShow | 数字 name 的题目 | 选项表 |
| 提交问卷 | POST jxpgXsAction.do | Query oper=wjpg；动态答案 + 固定字段 | 正文含“评估成功” | success/message |

VPN 上游矩阵：

| 阶段 | 方法与地址形态 | 请求 | 成功判定 |
|---|---|---|---|
| 启动页 | GET https://<vpn-host>:<port>/vpn/theme/auth_home.html | 启动 Cookie | 建立会话 |
| 密码认证 | POST /vpn/user/auth/password | Base64 用户名/密码、encode=1 | HTTP 200 + 成功码 |
| 门户 | GET /vpn/theme/portal_home.html | 已认证 Session | 获得 VSG_ Cookie |
| 探活 | GET 映射后的 URP 根地址 | Portal Referer | 200、非 VPN 错误页且像 URP 登录/首页 |

超时建议：登录页/验证码/VPN 20 秒，登录提交 30 秒，状态检查 5 秒，普通数据请求 20 至 30 秒。当前部分查询没有 timeout；新实现必须全部设置。

## 9. 页面解析规则与数据结构

### 9.1 当前课表

解析步骤：

1. 找第一个含 th.sortable 的 table。
2. 遍历 tbody 行。
3. 前四个课程元数据列可能使用 rowspan；缓存每一列的剩余跨度和值。
4. 每行最后 7 列依次为周次、星期、开始节次、节数、校区、教学楼、教室。
5. 周次支持“第1-16周”“1,5-13周”和逗号分段。
6. 为每个周数字复制一条课程。
7. 位置为校区 + 教学楼 + 教室。
8. 写 schedule.json。

~~~json
{
  "1": [
    {
      "课程号": "COURSE001",
      "课程名": "示例课程",
      "学分": "2.0",
      "教师": "教师名",
      "星期": "1",
      "节次": "1",
      "节数": "2",
      "校区": "主校区",
      "教学楼": "A楼",
      "教室": "101",
      "位置": "主校区A楼101"
    }
  ]
}
~~~

GET /api/schedule 不传 week 时：

~~~json
{
  "success": true,
  "data": {
    "week": null,
    "schedule": {},
    "semester_start": "YYYY-MM-DD"
  }
}
~~~

传 week=3 时，schedule 只包含该周的课程数组。

### 9.2 历年课表

- POST zxjxjhh 为空时先取得学期 option。
- 未指定学期时，从 option value 或 label 解析起止年份和上下学期，选择结束年份、学期序号最大的项，再请求一次。
- 优先在 #dayin 内寻找 displayTag 表。
- 合法网格表头应有 9 个 td.sortable，且不是 th.sortable 明细表。
- 每一行先找到“第 N 节”，之后恰好取 7 个星期单元格。
- 单元格文本通常为“课程名_课序(位置)”。
- 相同星期、课程名、课序、位置且节次连续的记录合并。

~~~json
{
  "semester": "2025-2026-2",
  "semesters": [
    {"value": "2025-2026-2", "label": "2025-2026学年第二学期"}
  ],
  "courses": [
    {
      "课程号": "",
      "课程名": "示例课程",
      "学分": "",
      "教师": "",
      "节数": "2",
      "校区": "主校区",
      "教学楼": "",
      "教室": "",
      "位置": "主校区A101",
      "课序": "01",
      "星期": "1",
      "节次": "3"
    }
  ]
}
~~~

该页面没有课程号、学分、教师等信息时必须保留空字符串，不能臆造。

### 9.3 考试安排

寻找表头包含“考试名”的 table，读取 tr.odd。至少 10 个 td；字段来源为第 1 至 9 列。

~~~json
{
  "18": [
    {
      "考试名": "期末考试",
      "校区": "主校区",
      "教学楼": "A楼",
      "教室": "101",
      "课程": "示例课程",
      "考试周次": "18",
      "考试星期": "3",
      "考试时间": "09:00-11:00",
      "座位号": "25",
      "位置": "主校区A楼101"
    }
  ]
}
~~~

缓存读取服务扁平化为：

~~~json
[
  {
    "exam_name": "期末考试",
    "course": "示例课程",
    "time": "09:00-11:00",
    "week": "18",
    "day": "3",
    "location": "主校区A楼101",
    "seat": "25"
  }
]
~~~

### 9.4 成绩总览、学期与本学期成绩

成绩总览：

- GET gradeLnAllAction.do，type=ln、oper=qbinfo。
- 学期列表来自带 name 且文本含“学年”或“学期”的 a。
- 指定学期从 a[name=<semester>] 开始，向后找到下一个学期锚点前的 table.displayTag#user。
- tr.odd 的第 3 列是课程名，第 8 列是成绩。

本学期：

- GET bxqcjcxAction.do，mytype=bxqcj、yzxh。
- 出现 td.errorTop 时抛出“本学期成绩查询未打开”。
- tr.odd 的第 3、8 列分别为课程名、成绩。

爬虫结构：

~~~json
[
  {"课程名": "高等数学", "成绩": "88"}
]
~~~

服务/API结构：

~~~json
[
  {"course": "高等数学", "score": "88"}
]
~~~

最新学期汇总应选正确的最新学期，而不是假设 DOM 第一个或字符串字典序一定最新：

~~~json
{
  "success": true,
  "semester": "2025-2026学年第二学期",
  "passed": [{"course": "课程A", "score": "88"}],
  "failed": {
    "current": [{"course": "课程B", "score": "50", "credit": "2", "exam_time": "2026-06-01"}],
    "past": []
  }
}
~~~

### 9.5 不及格成绩

GET gradeLnAllAction.do，type=ln、oper=bjg、yzxh。第一个 table.displayTag 是尚不及格，第二个是曾不及格。每行取课程名、成绩、学分、考试时间。

~~~json
{
  "current": [
    {"课程名": "课程A", "成绩": "50", "学分": "2", "考试时间": "2026-01-10"}
  ],
  "past": []
}
~~~

服务层字段转换为 course、score、credit、exam_time。

### 9.6 绩点

- GET gradeLnAllAction.do，oper=queryXfjd。
- 用 GB18030 解码。
- 三个 style 含 width: 60px 的 input 依次为学分绩点、学位绩点、加权学分学位绩点。
- 明细表表头严格匹配“学年学期、学分绩点、学位绩点、加权学分学位绩点”。

~~~json
{
  "学分绩点": "3.50",
  "学位绩点": "3.40",
  "加权学分学位绩点": "3.45",
  "学期绩点明细": [
    {
      "学年学期": "2025-2026学年第一学期",
      "学分绩点": "3.60",
      "学位绩点": "3.50",
      "加权学分学位绩点": "3.55"
    }
  ]
}
~~~

### 9.7 考试场次与成绩

场次页面：

- GET cjSearchAction.do，oper=getKscjList、yzxh。
- 学期读取 select[name=jxzxjh] option，格式为 value/text。
- 考试读取页面脚本中的 new Array("名称","ksbh","jxzxjh")。

指定考试：

- POST cjSearchAction.do?oper=tjcx。
- Form：jxzxjh、ksbh、yzxh。
- tr.odd 第 3、5、6 列分别为课程名、学分、成绩。

~~~json
{
  "semesters": [{"value": "2025-2026-2", "text": "2025-2026学年第二学期"}],
  "exams": [{"name": "期末考试", "ksbh": "01", "jxzxjh": "2025-2026-2"}]
}
~~~

~~~json
[
  {"course": "课程A", "credit": "2", "score": "88"}
]
~~~

### 9.8 待评课程与评教

待评列表：

- GET jxpgXsAction.do，oper=listWj、yzxh。
- 当前源码在 URL 和 params 中重复带相同 Query，属于实现瑕疵；新实现默认只发送一组。
- 页面可能使用 UTF-8、GBK 或 GB18030；任一解码结果出现“非教学评估时期”或“评估时间已过”时返回空列表。
- 遍历 tr；第 4 个 td 文本为“否”表示未评。
- img 的 name 属性用 #@ 切分，至少 6 段。

~~~json
[
  {
    "未评课程": "示例课程",
    "教师": "教师名",
    "wjbm": "问卷编码",
    "bpr": "被评人编码",
    "pgnr": "评估内容编码",
    "oper": "wjShow"
  }
]
~~~

提交每门课程：

1. POST jxpgXsAction.do，oper=wjShow，带 wjbm、bpr、pgnr。
2. 对所有 name 为纯数字的 radio/checkbox 读取 value 下划线前的数字作为分值。
3. 每题选择最高分选项。
4. 对独立 input/textarea 补齐默认值。
5. 加固定字段 xumanyzg=zg、wjbz 为空、zgpj 为空。
6. POST jxpgXsAction.do?oper=wjpg。
7. 响应含“评估成功”才继续下一门，否则立即失败。

评教会产生真实外部副作用。测试环境必须 mock 上游提交，线上必须由已登录用户明确发起，不能由后台自动运行。

### 9.9 紧急事项

它不是实时爬虫，而是读取 schedule.json 与 exams.json，再按 semester_start、当前时区和两套作息时间计算：

~~~json
{
  "current": {
    "type": "class",
    "title": "课程名",
    "location": "地点",
    "time": "08:20-10:00",
    "remaining": 35
  },
  "next": {
    "type": "class",
    "title": "课程名",
    "location": "地点",
    "time": "YYYY-MM-DD HH:mm",
    "countdown": 120
  },
  "is_freshman": false
}
~~~

请求紧急事项时可异步触发每日更新，但当前响应不等待更新完成，所以可能返回旧缓存。若产品要求强一致，应增加 refresh=true 并同步等待，或在响应中返回 cache_age 和 update_running。

## 10. Flask API 契约

### 10.1 认证与绑定

| 方法与路径 | 权限 | 请求 | 成功返回 |
|---|---|---|---|
| GET /api/check_bind | 设备 | Header X-Device-ID | bound、username? |
| POST /api/login | 设备 | JSON username、password | success、message、username |
| GET /api/check_login_status | 设备 | Header | logged_in、username?、message |
| POST /api/request_rebind | bound | 空 JSON | 解除当前设备绑定 |

登录成功后再写 users 绑定；不要先写数据库再验证账号。若同设备已绑定其它学号，返回明确冲突或执行经过确认的换绑流程。

### 10.2 教务信息

| 方法与路径 | 权限 | 请求 | 成功返回 |
|---|---|---|---|
| GET /api/urgent_event | bound | 无 | event={current,next,is_freshman} |
| GET /api/schedule | bound | Query week? | data={week,schedule,semester_start?} |
| POST /api/update_schedule | login | 无 | message、data={周:[课程]} |
| GET /api/historical_schedule | login | Query semester? | data={semester,semesters,courses} |
| GET /api/exams | bound | 无 | exams=[扁平考试] |
| POST /api/update_exams | login | 无 | message、data={周:[考试]} |
| GET /api/grades/current | grade_login | 无 | grades=[{course,score}] |
| GET /api/grades/latest_summary | grade_login | 无 | semester、passed、failed |
| GET /api/grades/semesters | grade_login | 无 | semesters=[字符串] |
| GET /api/grades/by_semester | grade_login | Query semester | grades、semester |
| GET /api/grades/failed | grade_login | 无 | current、past |
| GET /api/grades/gpa | grade_login | 无 | gpa={中文绩点字段} |
| GET /api/grades/exam_sessions | grade_login | 无 | semesters、exams |
| GET /api/grades/exam_scores | grade_login | Query jxzxjh、ksbh | grades=[{course,credit,score}] |
| GET /api/unevaluated_courses | member_login | 无 | has_courses、courses、message? |
| POST /api/evaluation | member_login | JSON courses[] | success、message |

旧 GET /api/grades 调用了不存在的 score_query。正确复现方式二选一：

- 删除该废弃接口并让客户端使用 /api/grades/latest_summary；或
- 保留路径但让它显式调用一个真实实现，并记录废弃提示。

绝不能继续返回 success=true、grades=[] 来掩盖异常。

### 10.3 可选快捷指令

POST /api/shortcut/query：

~~~json
{
  "key": "<一次显示的 API key>",
  "action": "historical_schedule",
  "params": {"semester": "2025-2026-2"}
}
~~~

支持 action：

| action | params | data |
|---|---|---|
| historical_schedule | semester 可选 | 学期、课程数量、标准化课程 |
| grades | 无 | 最新学期、及格和两类不及格 |
| urgent_event | 无 | 只取 next 事项 |

失败结构应固定包含 action、error_code、message、data=null。数据库只保存 API key 的 SHA-256 哈希和短前缀，明文仅生成时返回一次。

## 11. 缓存、并发和更新策略

### 11.1 登录缓存

- 进程内键：username。
- 值：最后成功检查时间。
- TTL：900 秒。
- URL 为 VPN 映射时不使用快速命中，避免共享会话失效未被发现。
- 登录失败、查询遇到明确登录页或用户重新绑定时清除。
- 多 worker 环境改用 Redis，或接受每个 worker 独立检查。

### 11.2 当前课表与考试

- GET /api/schedule 和 GET /api/exams 只读缓存，速度快且不要求实时登录。
- POST /api/update_schedule 和 POST /api/update_exams 访问上游并覆盖缓存。
- 缓存不存在时返回空数据和“请先更新”信息；是否自动更新由客户端决定。
- 成绩、绩点、评教、历年课表默认实时查询，不落业务缓存。
- 所有 JSON 写入应原子化并带 updated_at 元数据；若要完全兼容旧格式，可把元数据放独立 sidecar 文件。

### 11.3 每日自动更新

现有语义：

1. 每个 username 每天最多自动更新一次。
2. 进程内集合阻止同学号同时启动两个线程。
3. 后台线程登录后依次更新课表和考试。
4. 更新成功后写 users.last_auto_update。
5. 紧急事项请求不等待线程，失败也不会回传给当前请求。

改进建议：记录 update_running、last_attempt、last_success、last_error、cache_age，并提供只读状态字段。不要因为启动过线程就错误标记成功。

## 12. 最小前端调用说明

前端只需维护 device_id、登录和调用 API。以下代码足以验证后端，不要求复刻页面。

~~~javascript
function getDeviceId() {
  let id = localStorage.getItem('device_id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('device_id', id);
  }
  return id;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-Device-ID': getDeviceId(),
      ...(options.headers || {})
    }
  });
  const body = await response.json();
  if (!response.ok || !body.success) {
    throw new Error(body.message || '请求失败');
  }
  return body;
}

async function login(username, password) {
  return api('/api/login', {
    method: 'POST',
    body: JSON.stringify({username, password})
  });
}

async function refreshSchedule() {
  return api('/api/update_schedule', {method: 'POST'});
}

async function loadLatestGrades() {
  return api('/api/grades/latest_summary');
}
~~~

最小页面只需要：

- 学号与密码输入框；
- 登录按钮；
- “更新课表/考试”按钮；
- 若干查询按钮；
- 一个 pre 或 JSON viewer 展示结果；
- 对评教提交增加明确确认框。

## 13. 实现顺序

按以下顺序实现，前一步通过测试后再继续：

1. 配置读取、目录创建、SQLite users 表、设备 ID 校验。
2. 纯函数解析器和离线 HTML fixtures，不接真实学校。
3. URP_login 的非 VPN 登录、验证码和 Cookie 保存。
4. VPN 会话建立、共享 Cookie过滤、探活、锁内恢复和保活。
5. URP_query 的统一 _request、超时、登录页/VPN 失败识别。
6. 当前课表、历年课表、考试解析与缓存。
7. 成绩、绩点、考试成绩解析。
8. 待评列表；提交评教最后实现，并先只接 mock。
9. urp_service 的缓存读取、字段规范化、登录 TTL、自动更新。
10. Flask 认证装饰器与 API。
11. 可选快捷指令。
12. 最小 HTML/JavaScript 调用页。
13. 受控测试账号的线上只读冒烟测试；评教提交单独人工确认。

## 14. 当前源码中必须修正或明确选择的行为

附录保存的是“当前实现”，其中以下内容不能作为推荐设计直接复制：

1. 旧 /api/grades 调用不存在的 URP_query.score_query，异常被捕获后返回空数组。应删除或改成真实查询。
2. get_semesters、get_grades_by_semester、get_gpa、get_exam_sessions、get_exam_scores 等函数会把异常吞成空值；get_unevaluated_courses 会把异常变成 None，再被路由解释为“无待评课程”。应区分 no_data 与 upstream_error。
3. 多数查询关闭 verify=False。只能在确有旧证书问题、且限制到已知主机时使用；优先安装正确 CA 或证书指纹校验。
4. 密码、Cookie 和 VPN 认证体以明文保存。生产版本应加密、限制文件权限并支持撤销。
5. 硬编码的管理密钥、支付密钥和 Flask secret 不得复制。
6. Flask debug 不能在生产启用。
7. 评教应要求会员和有效 URP 登录，并由用户明确确认。
8. 待评课程请求不应重复同一组 Query 参数，除非抓包证明特定上游依赖该异常行为。
9. 所有上游请求必须有 connect/read timeout、有限重试和请求阶段标签。
10. base URL 必须统一归一化；不能同时依赖有无尾斜杠。
11. username 进入文件路径前必须严格校验，防止路径穿越。
12. 错误响应不能包含 HTML 正文、Cookie、密码或完整请求表单。
13. require_login 在路由抛任意异常后重跑路由，可能重复有副作用的 POST。只对幂等只读请求自动重试；评教绝不自动重放。
14. 自动更新线程的异常目前不反馈给触发请求；应记录可查询状态。
15. 内存锁和缓存只在单进程有效，多 worker 必须使用共享协调机制。
16. 页面选择器依赖旧 URP HTML。解析失败要保存经脱敏的结构诊断或指标，而不是静默返回空。
17. 当前源码将 Host Header 设为完整 URL 的可能性不符合标准；新实现应让 requests 自动生成 Host，除非经过抓包验证。
18. 当前源码内某些 User-Agent、Content-Length、Sec-CH-UA 是浏览器快照值；不要手工固定 Content-Length，UA 只需稳定合理。
19. 当前源码保存调试 HTML/验证码的开关必须默认关闭，并按用户/时间限流；生产环境不应保存含个人信息的页面。
20. 所有爬取必须遵守学校授权、使用条款和频率限制；添加每账号限速和指数退避。
21. 当前 /api/request_rebind 没有权限装饰器，只凭可伪造的设备 ID 就会立即删除绑定；新实现必须验证服务端会话、当前绑定和用户二次确认，或只创建待审批请求。
22. X-Device-ID 不能单独作为认证凭证；它只能参与设备识别，真正权限必须来自服务端签发且可撤销的会话或 Token。

### 14.1 兼容模式与安全模式

建议实现两个显式配置档：

- compatibility：保留中文字段、现有 URL/选择器、缓存文件和 API 包装；只用于迁移。
- safe：严格状态码、错误分类、加密凭据、TLS 验证、无设备 ID 回退、无异常吞噬、共享锁和结构化日志。

安全模式应是默认值。

## 15. 错误分类

定义内部异常，不要靠字符串猜测：

~~~python
class CrawlerError(Exception):
    error_code = 'crawler_error'

class LoginRequiredError(CrawlerError):
    error_code = 'login_required'

class VPNUnavailableError(CrawlerError):
    error_code = 'vpn_unavailable'

class UpstreamTimeoutError(CrawlerError):
    error_code = 'upstream_timeout'

class UpstreamUnavailableError(CrawlerError):
    error_code = 'upstream_unavailable'

class ParseChangedError(CrawlerError):
    error_code = 'page_structure_changed'

class NoDataError(CrawlerError):
    error_code = 'no_data'
~~~

只有学校明确显示“查询未开放”“非评教时期”“没有记录”时才返回 no_data；找不到预期表格、列数不符、编码异常应返回 page_structure_changed。

## 16. 测试与验收

### 16.1 离线 fixtures

为每类页面保存经脱敏的最小 HTML：

- URP 登录页；
- 登录成功首页；
- VPN 认证页、错误页、维护页；
- 当前课表：普通行、rowspan、多周区间、周末课；
- 历年课表：学期 option、9 列网格、连续节次、无 #dayin 回退；
- 考试安排：正常、有表无记录、缺表；
- 成绩总览：多个学期；
- 本学期关闭页；
- 不及格两张表；
- 绩点 GB18030；
- 考试场次脚本数组；
- 待评列表与问卷；
- 页面结构改变的反例。

fixtures 必须删除姓名、学号、Cookie、教师工号、问卷真实编码和其它个人数据。

### 16.2 单元测试

至少覆盖：

- loginForm 收集全部 input，action 使用 urljoin。
- OCR 过滤非字母数字，空结果继续，最多 8 次。
- VPN Cookie 只保留 VSG_。
- 同时触发恢复时只有一个线程执行 VPN 登录。
- 原请求在恢复后只重试一次。
- _parse_weeks 支持单周、范围、逗号混合和去重。
- 当前课表 rowspan 继承正确。
- 历年学期选择按年份和学期排序。
- 连续历史课程合并且不同地点不合并。
- 没有预期表格时抛 ParseChangedError，而不是返回空。
- 各成绩列映射正确。
- 绩点用 GB18030。
- 评教每题选择最高分，且提交失败不继续。
- schedule/exams 原子写入和损坏文件恢复。
- 登录 TTL 命中、过期、失败清除。
- 自动更新同学号去重。
- 所有 API 响应 schema 固定。

### 16.3 端到端验收清单

- [ ] 新设备未绑定时，受保护接口返回未绑定。
- [ ] 合法账号可登录并生成 cookie.json。
- [ ] 错误账号/验证码耗尽不会写 users。
- [ ] VPN Cookie 失效后能单次恢复并重试。
- [ ] 当前课表更新后，缓存读取与实时返回一致。
- [ ] 历年课表不覆盖当前课表缓存。
- [ ] 考试更新后按周缓存，读取接口正确扁平化。
- [ ] 八类成绩接口能区分“无数据”和“上游错误”。
- [ ] URP Cookie 失效时只读请求可安全重登。
- [ ] 评教提交不被自动重试，且必须二次确认。
- [ ] 日志和响应中没有密码、Cookie、认证体或完整个人页面。
- [ ] 所有请求有超时；重试次数有上限。
- [ ] 关闭网络时 API 返回 502/504，不返回 success=true 的空数组。
- [ ] 多个并发用户不会串用 URP Cookie；只有 VSG_ Cookie允许共享。
- [ ] 最小前端能完成登录、课表、考试、成绩查询和评教确认。

### 16.4 受控线上测试

只使用用户本人授权的测试账号：

1. 先运行只读接口。
2. 限制频率，记录阶段和耗时但不记录响应正文。
3. 将实际 HTML 与 fixture 的结构签名比较。
4. 评教属于写操作，默认不在自动测试中执行。
5. 若学校页面结构改变，只更新对应解析器与 fixture，不在路由层打补丁。

## 17. 附录源码的使用方式

下方完整收录与后端信息获取直接相关的当前源码：

- 兼容导出；
- VPN/URP 登录；
- 全部教务页面查询与解析；
- 当前课表缓存；
- 服务编排、登录缓存和自动更新；
- 设备绑定；
- Flask 登录/数据路由；
- 权限装饰器；
- 可选快捷指令。

使用原则：

1. 源码附录用于确认当前行为、字段名和选择器。
2. 第 8 至 10 节是接口兼容基线。
3. 第 14 至 16 节是新实现的规范性要求，优先级高于附录中的缺陷。
4. 不要把本文件之外的运行时 Cookie、配置秘密或用户缓存打包给另一个 AI。
5. 若只做最小版本，可先不复制 shortcut 两个文件和其它专业课表接口。
6. 各源码段以 SOURCE_BEGIN/SOURCE_END 标记，便于脚本提取。

## 18. 完整后端信息获取源码

### 18.1 URP.py：兼容导出入口

当前快照行数：5。

<!-- SOURCE_BEGIN path="URP.py" -->
~~~~python
# 兼容入口：保持 `from URP import URP_login, URP_query` 不变
from urp.login import URP_login
from urp.query import URP_query

__all__ = ["URP_login", "URP_query"]
~~~~
<!-- SOURCE_END path="URP.py" -->

### 18.2 urp/__init__.py：包级兼容导出

当前快照行数：4。

<!-- SOURCE_BEGIN path="urp/__init__.py" -->
~~~~python
from urp.login import URP_login
from urp.query import URP_query

__all__ = ['URP_login', 'URP_query']
~~~~
<!-- SOURCE_END path="urp/__init__.py" -->

### 18.3 urp/login.py：VPN、URP 登录、OCR、Cookie 与恢复

当前快照行数：560。

<!-- SOURCE_BEGIN path="urp/login.py" -->
~~~~python
import base64
import json
import os
import random
import re
import threading
import time
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

VPN_HOST = '223.112.21.198'
VPN_PORT = 6443
VPN_BASE_URL = f'https://{VPN_HOST}:{VPN_PORT}'
VPN_LOGIN_PAGE = f'{VPN_BASE_URL}/vpn/theme/auth_home.html'
VPN_PORTAL_PAGE = f'{VPN_BASE_URL}/vpn/theme/portal_home.html'
VPN_AUTH_URL = f'{VPN_BASE_URL}/vpn/user/auth/password'
VPN_COOKIE_FILE = os.path.join('data', 'vpn_cookie.json')
VPN_KEEPALIVE_URL = f'{VPN_BASE_URL}/7b68f983/'
VPN_KEEPALIVE_INTERVAL = 300
VPN_AUTH_USERNAME = os.environ.get('VPN_AUTH_USERNAME')
VPN_AUTH_PASSWORD = os.environ.get('VPN_AUTH_PASSWORD')
VPN_AUTH_BODY = os.environ.get('VPN_AUTH_BODY')
MAX_CAPTCHA_ATTEMPTS = 8
SAVE_DEBUG_FILES = os.environ.get('URP_SAVE_DEBUG_FILES', '').lower() in {
    '1', 'true', 'yes', 'on'
}
DEBUG_FILE_THROTTLE_SECONDS = 60
_debug_file_times = {}
_debug_file_lock = threading.Lock()
VPN_COOKIE_PREFIX = 'VSG_'
_VPN_LOCK = threading.Lock()
_KEEPALIVE_STARTED = False


class VPNUnavailableError(RuntimeError):
    """Raised when VPN recovery cannot safely continue the request."""


def _filter_shared_vpn_cookies(cookies):
    if not isinstance(cookies, dict):
        return {}
    return {
        str(name): value
        for name, value in cookies.items()
        if str(name).upper().startswith(VPN_COOKIE_PREFIX)
    }


class LoginFormParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_login_form = False
        self.form_action = None
        self.inputs = {}
        self.title_parts = []
        self.in_title = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        tag = tag.lower()
        if tag == 'title':
            self.in_title = True
        if tag == 'form' and attrs.get('name') == 'loginForm':
            self.in_login_form = True
            self.form_action = attrs.get('action')
        if self.in_login_form and tag == 'input':
            name = attrs.get('name')
            if name:
                self.inputs[name] = attrs.get('value', '')

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag == 'title':
            self.in_title = False
        if tag == 'form' and self.in_login_form:
            self.in_login_form = False

    def handle_data(self, data):
        if self.in_title:
            self.title_parts.append(data.strip())

    @property
    def title(self):
        return ''.join(self.title_parts).strip()


def _is_vpn_url(url):
    parsed = urlparse(url)
    return parsed.hostname == VPN_HOST and parsed.port == VPN_PORT


def _normalize_captcha(value):
    return re.sub(r'[^0-9a-zA-Z]', '', value or '').strip()

def _load_vpn_credentials(default_username=None, default_password=None):
    username = VPN_AUTH_USERNAME
    password = VPN_AUTH_PASSWORD
    auth_body = VPN_AUTH_BODY
    try:
        with open(os.path.join('data', 'config.json'), 'r', encoding='utf-8') as f:
            config = json.load(f)
        username = username or config.get('vpn_username') or config.get('vpn_auth_username')
        password = password or config.get('vpn_password') or config.get('vpn_auth_password')
        auth_body = auth_body or config.get('vpn_auth_body')
    except Exception:
        pass
    return username or default_username, password or default_password, auth_body


def _parse_login_form(html):
    parser = LoginFormParser()
    parser.feed(html)
    if not parser.form_action:
        raise RuntimeError('Could not find loginForm action')
    return parser


def _page_title(html):
    parser = LoginFormParser()
    parser.feed(html)
    return parser.title


def _looks_logged_in(response):
    if is_vpn_failure_response(response) or _looks_like_urp_login_page(response):
        return False
    return _looks_like_urp_home_page(response)


def _extract_shared_cookies(payload):
    if isinstance(payload, dict) and isinstance(payload.get('cookies'), dict):
        return _filter_shared_vpn_cookies(payload['cookies'])
    return _filter_shared_vpn_cookies(payload)


def load_shared_vpn_cookies():
    if not os.path.exists(VPN_COOKIE_FILE):
        return {}
    try:
        with open(VPN_COOKIE_FILE, 'r', encoding='utf-8') as f:
            return _extract_shared_cookies(json.load(f))
    except Exception:
        return {}


def save_shared_vpn_cookies(cookies):
    os.makedirs(os.path.dirname(VPN_COOKIE_FILE), exist_ok=True)
    shared_cookies = _filter_shared_vpn_cookies(cookies)
    with open(VPN_COOKIE_FILE, 'w', encoding='utf-8') as f:
        json.dump(
            {'cookies': shared_cookies, 'updated_at': time.time()},
            f,
            ensure_ascii=False,
            indent=4,
        )


def clear_shared_vpn_cookies():
    try:
        if os.path.exists(VPN_COOKIE_FILE):
            os.remove(VPN_COOKIE_FILE)
    except Exception:
        pass


def _looks_like_vpn_auth_page(resp):
    url = getattr(resp, 'url', '') or ''
    text = getattr(resp, 'text', '') or ''
    lowered = text.lower()
    return (
        '/vpn/theme/auth_home' in url
        or '/vpn/user/auth' in url
        or 'auth_home' in lowered
        or 'rmbpwd_browser' in lowered
        or 'vsg_verifycode_conf' in lowered
        or 'vsg_login' in lowered
    )


def _response_text(resp):
    return getattr(resp, 'text', '') or ''


def _looks_like_vpn_error_page(resp):
    url = (getattr(resp, 'url', '') or '').lower()
    text = _response_text(resp)
    lowered = text.lower()
    return (
        '/vpn/user/common/error' in url
        or 'pagename: "error"' in lowered
        or "pagename: 'error'" in lowered
        or 'var errmsg' in lowered
        or '\u767b\u5f55\u4f1a\u8bdd\u8d85\u65f6' in text
        or '\u7f51\u7ad9\u7ef4\u62a4' in text
        or '\u7f51\u7ad9\u6b63\u5728\u7ef4\u62a4' in text
    )


def _looks_like_urp_login_page(resp):
    text = _response_text(resp)
    return bool(
        re.search(r'name\s*=\s*["\']loginForm["\']', text, re.I)
        and re.search(r'loginAction\.do', text, re.I)
    )


def _looks_like_urp_home_page(resp):
    text = _response_text(resp)
    has_frameset = 'menu/top.jsp' in text and 'menu/mainFrame.jsp' in text
    has_panel_signal = any(signal in text for signal in [
        '\u4e2a\u4eba\u7ba1\u7406',
        '\u5b66\u751f\u4e2a\u4eba\u8bfe\u8868',
        '\u7f51\u4e0a\u9009\u8bfe',
        '\u4fe1\u606f\u67e5\u8be2',
        '\u6559\u5b66\u8bc4\u4ef7',
    ])
    return has_frameset or has_panel_signal


def is_vpn_failure_response(resp):
    return _looks_like_vpn_auth_page(resp) or _looks_like_vpn_error_page(resp)


def _html_hint(resp):
    url = getattr(resp, 'url', '') or ''
    content_type = resp.headers.get('Content-Type', '') if hasattr(resp, 'headers') else ''
    text = getattr(resp, 'text', '') or ''
    snippet = ' '.join(text.split())[:180]
    if _looks_like_vpn_auth_page(resp):
        page_type = 'VPN_AUTH_PAGE'
    elif 'loginAction.do' in url or 'validateCodeAction.do' in text:
        page_type = 'URP_LOGIN_PAGE'
    else:
        page_type = 'HTML_PAGE'
    return f'{page_type}; URL={url}; Content-Type={content_type}; Body={snippet}'


def _save_debug_file(filename, content):
    if not SAVE_DEBUG_FILES:
        return False

    now = time.monotonic()
    with _debug_file_lock:
        last_write = _debug_file_times.get(filename)
        if last_write is not None and now - last_write < DEBUG_FILE_THROTTLE_SECONDS:
            return False
        _debug_file_times[filename] = now

    try:
        os.makedirs('data', exist_ok=True)
        path = os.path.join('data', filename)
        if isinstance(content, bytes):
            Path(path).write_bytes(content)
        else:
            Path(path).write_text(content or '', encoding='utf-8')
        return True
    except Exception:
        return False


def _looks_like_image(resp):
    content_type = (resp.headers.get('Content-Type') or '').lower()
    content = resp.content or b''
    if content_type.startswith('image/'):
        return True
    return content.startswith((b'\xff\xd8\xff', b'\x89PNG', b'GIF87a', b'GIF89a', b'BM'))



def _ocr_dependency_diagnostics():
    checks = [
        ('numpy', 'numpy'),
        ('cv2', 'opencv-python-headless'),
        ('onnxruntime', 'onnxruntime'),
        ('PIL', 'Pillow'),
        ('ddddocr', 'ddddocr'),
    ]
    results = []
    for import_name, package_name in checks:
        try:
            module = __import__(import_name)
            version = getattr(module, '__version__', 'unknown')
            results.append(f'{package_name}=OK({version})')
        except Exception as exc:
            results.append(f'{package_name}=FAIL({type(exc).__name__}: {exc})')
    return '; '.join(results)
def vpn_session_alive(session, url=VPN_KEEPALIVE_URL):
    try:
        resp = session.get(
            url,
            headers={'Referer': VPN_PORTAL_PAGE},
            verify=False,
            timeout=8,
        )
    except Exception:
        return False
    if resp.status_code != 200 or is_vpn_failure_response(resp):
        return False
    return _looks_like_urp_login_page(resp) or _looks_like_urp_home_page(resp)


def _vpn_keepalive_loop():
    while True:
        time.sleep(VPN_KEEPALIVE_INTERVAL)
        cookies = load_shared_vpn_cookies()
        if not cookies:
            continue
        session = requests.session()
        session.verify = False
        session.cookies.update(cookies)
        if vpn_session_alive(session):
            save_shared_vpn_cookies(session.cookies.get_dict())
        else:
            clear_shared_vpn_cookies()


def start_vpn_keepalive():
    global _KEEPALIVE_STARTED
    if _KEEPALIVE_STARTED:
        return
    _KEEPALIVE_STARTED = True
    threading.Thread(target=_vpn_keepalive_loop, daemon=True).start()


def _vpn_unavailable_message(detail=''):
    message = (
        'VPN \u901a\u9053\u6682\u4e0d\u53ef\u7528\uff0c'
        '\u5df2\u81ea\u52a8\u91cd\u8fde\u4f46\u672a\u6210\u529f\uff0c'
        '\u8bf7\u7a0d\u540e\u91cd\u8bd5'
    )
    return f'{message}\uff1b{detail}' if detail else message


def recover_vpn_session(session, url=VPN_KEEPALIVE_URL):
    with _VPN_LOCK:
        current = load_shared_vpn_cookies()
        if current:
            session.cookies.update(current)
            if vpn_session_alive(session, url):
                return current

        clear_shared_vpn_cookies()
        helper = URP_login(url, '', '')
        success, message = helper._vpn_password_auth()
        if not success:
            raise VPNUnavailableError(_vpn_unavailable_message(message))

        fresh = load_shared_vpn_cookies()
        if not fresh:
            raise VPNUnavailableError(
                _vpn_unavailable_message(
                    'VPN \u8ba4\u8bc1\u672a\u8fd4\u56de\u6709\u6548\u4f1a\u8bdd'
                )
            )
        session.cookies.update(fresh)
        if not vpn_session_alive(session, url):
            clear_shared_vpn_cookies()
            raise VPNUnavailableError(
                _vpn_unavailable_message(
                    'VPN \u91cd\u8fde\u540e\u4ecd\u65e0\u6cd5'
                    '\u8bbf\u95ee\u6559\u52a1\u7cfb\u7edf'
                )
            )
        return fresh


class URP_login:
    def __init__(self, url, account, password):
        self.url = url.rstrip('/')
        self.account = account
        self.password = password
        self.x = requests.session()
        self.x.verify = False
        self.x.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        })

    def _url(self, path=''):
        return f"{self.url}/{path.lstrip('/')}" if path else f'{self.url}/'

    def _save_cookies(self):
        cookie_dir = f'user_data/{self.account}'
        os.makedirs(cookie_dir, exist_ok=True)
        with open(f'{cookie_dir}/cookie.json', 'w', encoding='utf-8') as f:
            json.dump(self.x.cookies.get_dict(), f, ensure_ascii=False, indent=4)

    def _requires_vpn_auth(self):
        return _is_vpn_url(self.url)

    def _load_shared_vpn_cookies(self):
        cookies = load_shared_vpn_cookies()
        if cookies:
            self.x.cookies.update(cookies)
        return cookies

    def _set_vpn_bootstrap_cookies(self):
        self.x.cookies.set('VSG_VERIFYCODE_CONF', '0-0', domain=VPN_HOST, path='/')
        self.x.cookies.set('VSG_CLIENT_RUNNING', 'false', domain=VPN_HOST, path='/')
        self.x.cookies.set('VSG_LANGUAGE', 'zh_CN', domain=VPN_HOST, path='/')

    def _vpn_password_auth(self):
        vpn_username, vpn_password, auth_body = _load_vpn_credentials(self.account, self.password)
        if not auth_body:
            if not vpn_username or not vpn_password:
                return False, 'VPN auth failed; missing vpn_username/vpn_password'
            username = base64.b64encode(vpn_username.encode('utf-8')).decode('ascii')
            password = base64.b64encode(vpn_password.encode('utf-8')).decode('ascii')
            auth_body = f'username={username}&password={password}&encode=1&rmbpwd_browser=0'
        self._set_vpn_bootstrap_cookies()
        self.x.get(VPN_LOGIN_PAGE, timeout=20)
        resp = self.x.post(
            VPN_AUTH_URL,
            headers={
                'Accept': 'application/xml, text/xml, */*; q=0.01',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
                'Origin': VPN_BASE_URL,
                'Referer': VPN_LOGIN_PAGE,
            },
            data=auth_body,
            timeout=20,
        )
        resp.encoding = 'utf-8'
        _save_debug_file('last_vpn_auth_response.txt', resp.text)
        if resp.status_code != 200 or '0x00000000' not in resp.text:
            return False, f'VPN auth failed; status={resp.status_code}; {_html_hint(resp)}'
        portal = self.x.get(VPN_PORTAL_PAGE, timeout=20)
        _save_debug_file('last_vpn_portal_response.html', portal.text)
        save_shared_vpn_cookies(self.x.cookies.get_dict())
        start_vpn_keepalive()
        return True, 'VPN auth success'

    def _ensure_vpn_session(self):
        if not self._requires_vpn_auth():
            return True, ''
        try:
            recover_vpn_session(self.x, self._url())
            self._save_cookies()
            start_vpn_keepalive()
            return True, 'VPN already online'
        except VPNUnavailableError as exc:
            return False, str(exc)

    def _get_login_page(self):
        headers = {'Referer': VPN_PORTAL_PAGE} if self._requires_vpn_auth() else {}
        resp = self.x.get(self._url(), headers=headers, timeout=20)
        resp.encoding = 'gbk'
        _save_debug_file('last_jiaowu_login.html', resp.text)
        if is_vpn_failure_response(resp):
            raise VPNUnavailableError(
                _vpn_unavailable_message(_html_hint(resp))
            )
        return resp.url, _parse_login_form(resp.text)

    def _read_captcha(self, ocr, allow_vpn_retry=True):
        resp = self.x.get(
            self._url('validateCodeAction.do'),
            params={'random': str(random.random())},
            headers={'Referer': self._url()},
            timeout=20,
        )
        if not _looks_like_image(resp):
            _save_debug_file('last_vpn_captcha_response.html', resp.text)
            if self._requires_vpn_auth() and allow_vpn_retry:
                recover_vpn_session(self.x, self._url())
                self._save_cookies()
                return self._read_captcha(ocr, allow_vpn_retry=False)
            raise RuntimeError(f'captcha response was not an image; status={resp.status_code}; {_html_hint(resp)}')
        _save_debug_file('last_jiaowu_captcha.gif', resp.content)
        return _normalize_captcha(ocr.classification(resp.content))

    def _submit_login(self, form_url, parser, captcha_text):
        login_url = urljoin(form_url, parser.form_action)
        data = dict(parser.inputs)
        data.update({
            'zjh': self.account,
            'mm': self.password,
            'v_yzm': captcha_text,
        })
        resp = self.x.post(
            login_url,
            data=data,
            headers={
                'Origin': VPN_BASE_URL if self._requires_vpn_auth() else self.url,
                'Referer': form_url,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            allow_redirects=True,
            timeout=30,
        )
        resp.encoding = 'gbk'
        _save_debug_file('last_jiaowu_after_login.html', resp.text)
        return resp

    def login(self):
        success, message = self._ensure_vpn_session()
        if not success:
            return False, message, None

        try:
            import ddddocr
            form_url, parser = self._get_login_page()
            ocr = ddddocr.DdddOcr(show_ad=False)
            last_response = None
            for _ in range(MAX_CAPTCHA_ATTEMPTS):
                captcha_text = self._read_captcha(ocr)
                if not captcha_text:
                    continue
                last_response = self._submit_login(form_url, parser, captcha_text)
                if _looks_logged_in(last_response):
                    self._save_cookies()
                    if self._requires_vpn_auth():
                        save_shared_vpn_cookies(self.x.cookies.get_dict())
                    return True, '登录成功', self.x.cookies.get_dict()
                form_url, parser = self._get_login_page()
                time.sleep(0.5)
            if last_response is not None:
                return False, f'登录失败，最后页面: {_html_hint(last_response)}', None
            return False, '登录失败，验证码识别为空', None
        except Exception as e:
            error = str(e)
            if any(key in error.lower() for key in ('numpy', 'ddddocr', 'onnxruntime', 'cv2', 'opencv', 'pil')):
                diagnostics = _ocr_dependency_diagnostics()
                return False, f'OCR依赖加载失败: {error}; 依赖检测: {diagnostics}; 请在服务器重装 OCR 依赖后重启服务', None
            return False, f'登录异常: {error}', None

    def is_logined(self):
        check_url = self._url('menu/top.jsp')
        cookie_file = f'user_data/{self.account}/cookie.json'
        if not os.path.exists(cookie_file):
            return False
        try:
            with open(cookie_file, 'r', encoding='utf-8') as f:
                urp_cookie = json.load(f)
            self.x.cookies.update(urp_cookie)
            if self._requires_vpn_auth():
                shared_vpn_cookies = self._load_shared_vpn_cookies()
                start_vpn_keepalive()
                if not shared_vpn_cookies or not vpn_session_alive(self.x, self._url()):
                    success, _, _ = self.login()
                    return success
        except Exception:
            success, _, _ = self.login()
            return success
        try:
            r = self.x.get(check_url, timeout=5, verify=False).text
        except Exception:
            success, _, _ = self.login()
            return success
        if self.account in r:
            return True
        success, _, _ = self.login()
        return success
~~~~
<!-- SOURCE_END path="urp/login.py" -->

### 18.4 urp/query.py：全部教务查询与 HTML 解析

当前快照行数：679。

<!-- SOURCE_BEGIN path="urp/query.py" -->
~~~~python
import json
import os
import re
import requests
import urllib3
from bs4 import BeautifulSoup
from urllib.parse import urlsplit
from urp.schedule_legacy import schedule_cx_legacy
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
from urp.login import (
    VPNUnavailableError,
    _is_vpn_url,
    is_vpn_failure_response,
    load_shared_vpn_cookies,
    recover_vpn_session,
    start_vpn_keepalive,
)

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
        if _is_vpn_url(self.url):
            shared_vpn_cookies = load_shared_vpn_cookies()
            if shared_vpn_cookies:
                self.x.cookies.update(shared_vpn_cookies)
            start_vpn_keepalive()

    def _request(self, method, url, **kwargs):
        response = self.x.request(method, url, **kwargs)
        if not _is_vpn_url(self.url) or not is_vpn_failure_response(response):
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
            courses.append({'课程名': tds[2].get_text(strip=True), '成绩': tds[7].get_text(strip=True)})
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
        for row in soup.find_all('tr', class_='odd'):
            cols = row.find_all('td')
            if len(cols) >= 8:
                courses.append({'课程名': cols[2].get_text(strip=True), '成绩': cols[7].get_text(strip=True)})
        return courses

    def score_failed(self):
        """查询不及格成绩，分为尚不及格和曾不及格"""
        response = self._request('GET', f'{self.url}gradeLnAllAction.do', params={
            'type': 'ln', 'oper': 'bjg', 'yzxh': self.account
        }, verify=False)
        soup = BeautifulSoup(response.text, 'html.parser')

        def parse_table(table):
            courses = []
            for row in table.find_all('tr', class_='odd'):
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

    def get_exam_sessions(self):
        """获取考试成绩查询页面的所有学期及考试名称列表"""
        response = self._request('GET', f'{self.url}cjSearchAction.do', params={
            'oper': 'getKscjList', 'yzxh': self.account
        }, verify=False)
        html = response.text
        soup = BeautifulSoup(html, 'html.parser')
        semesters = []
        select = soup.find('select', {'name': 'jxzxjh'})
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

    def score_resit(self, jxzxjh, ksbh):
        """查询指定考试的成绩"""
        response = self._request('POST', f'{self.url}cjSearchAction.do', params={'oper': 'tjcx'}, data={
            'jxzxjh': jxzxjh, 'ksbh': ksbh, 'yzxh': self.account
        }, verify=False)
        soup = BeautifulSoup(response.text, 'html.parser')
        courses = []
        for row in soup.find_all('tr', class_='odd'):
            cols = row.find_all('td')
            if len(cols) >= 6:
                courses.append({
                    '课程名': cols[2].get_text(strip=True),
                    '学分':   cols[4].get_text(strip=True),
                    '成绩':   cols[5].get_text(strip=True),
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
        return schedule_cx_legacy(self)

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

        with open(f'user_data/{self.account}/exams.json', 'w', encoding='utf-8') as f:
            json.dump(exams_by_week, f, ensure_ascii=False, indent=2)

        return exams_by_week
~~~~
<!-- SOURCE_END path="urp/query.py" -->

### 18.5 urp/schedule_legacy.py：当前课表解析与缓存

当前快照行数：92。

<!-- SOURCE_BEGIN path="urp/schedule_legacy.py" -->
~~~~python
"""原课表接口的解析实现，保留供回退和对照使用。"""

import json
import os
from collections import defaultdict

from bs4 import BeautifulSoup


def schedule_cx_legacy(query):
    """使用原 ``xkAction.do`` 接口获取并缓存当前课表。"""
    headers = {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
        'Connection': 'keep-alive',
        'Referer': f'{query.url}menu/menu.jsp',
        'Upgrade-Insecure-Requests': '1',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 Edg/145.0.0.0',
    }
    response = query._request(
        'GET',
        f'{query.url}xkAction.do',
        headers=headers,
        params={'actionType': '6', 'yzxh': query.account},
        verify=False,
    )
    soup = BeautifulSoup(response.text, 'html.parser')

    course_table = next(
        (t for t in soup.find_all('table') if t.find('th', class_='sortable')),
        None,
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

            if week_str:
                weeks = query._parse_weeks(week_str)
                location = f"{campus_str}{building_str}{room_str}"
                period_num = query._parse_period(period_str)
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
                        '位置': location,
                    })

    schedule_data = {str(k): v for k, v in schedule_by_week.items()}

    user_dir = os.path.join('user_data', query.account)
    os.makedirs(user_dir, exist_ok=True)
    with open(os.path.join(user_dir, 'schedule.json'), 'w', encoding='utf-8') as f:
        json.dump(schedule_data, f, ensure_ascii=False, indent=2)

    return schedule_data
~~~~
<!-- SOURCE_END path="urp/schedule_legacy.py" -->
### 18.6 services/urp_service.py：业务编排、缓存、自动更新与字段转换

当前快照行数：590。

<!-- SOURCE_BEGIN path="services/urp_service.py" -->
~~~~python
"""
URP 教务系统交互服务
"""
import os
import json
import re
import threading
import time
from datetime import datetime, timedelta
from database import get_db
from services.config_service import get_config, get_current_urp_url

# 登录状态验证缓存：{username: timestamp}，15分钟内只验证一次
_login_cache = {}
LOGIN_CACHE_TTL = 900
_auto_update_state_lock = threading.Lock()
_auto_update_running = set()
_auto_update_context = threading.local()


def urp_login(username, password):
    """
    登录URP教务系统
    返回: (success: bool, message: str, cookies: dict)
    """
    from URP import URP_login
    url = get_current_urp_url()
    try:
        urp = URP_login(url, username, password)
        success, message, cookies = urp.login()
        return success, message, cookies
    except Exception as e:
        return False, f"登录异常: {str(e)}", None


def check_login_status(username, password, cookies):
    """
    检查登录状态，如果未登录则重新登录
    返回: (is_logged_in: bool, cookies: dict)
    """
    now = time.time()
    url = get_current_urp_url()

    from URP import URP_login
    from urp.login import _is_vpn_url

    if not _is_vpn_url(url) and username in _login_cache and now - _login_cache[username] < LOGIN_CACHE_TTL:
        cookie_file = f'user_data/{username}/cookie.json'
        if os.path.exists(cookie_file):
            return True, {}

    urp = URP_login(url, username, password)

    is_logged_in = urp.is_logined()

    if is_logged_in is True:
        _login_cache[username] = now
        current_cookies = urp.x.cookies.get_dict()
        return True, current_cookies
    else:
        _login_cache.pop(username, None)
        cookie_file = f'user_data/{username}/cookie.json'
        if os.path.exists(cookie_file):
            os.remove(cookie_file)

        try:
            success, _, new_cookies = urp.login()
            if success:
                _login_cache[username] = now
                return True, new_cookies or urp.x.cookies.get_dict()
            else:
                return False, {}
        except Exception as e:
            print(f"重新登录失败: {str(e)}")
            return False, {}


def _get_freshman_year():
    """返回当前最新一届新生的入学年份（4位整数）。
    每年 8 月份起换届：
      - 1–7 月：上一学年入学的新生（如 2026-03 → 2025）
      - 8–12 月：当年入学的新生（如 2026-09 → 2026）
    """
    now = datetime.now()
    return now.year if now.month >= 8 else now.year - 1


def _is_freshman(username):
    """判断用户是否属于最新一届新生（使用不同校区作息）。
    学号格式为 YY + 系科代码 + 流水号，前两位即入学年份（如 2415108133 → 24届）。
    """
    year = _get_freshman_year()
    if len(username) >= 2 and username[:2].isdigit():
        return int(username[:2]) == year % 100
    return False


def get_urgent_event(username):
    """获取正在进行的课程和下一个最紧急的事件"""
    schedule_file = os.path.join('user_data', username, 'schedule.json')
    exams_file = os.path.join('user_data', username, 'exams.json')

    config = get_config()
    semester_start_str = config.get('semester_start', '2026-03-02')
    y, m, d = map(int, semester_start_str.split('-'))
    semester_start = datetime(y, m, d)
    now = datetime.now().replace(microsecond=0)

    days_passed = (now - semester_start).days
    current_week = max(1, (days_passed // 7) + 1) if days_passed >= 0 else 0

    # 最新一届新生（另一校区）：45分钟/节，课间10分钟，大课间（2-3、6-7）15分钟
    # 上午 08:00 起，下午 13:30 起，晚上 18:30 起
    if _is_freshman(username):
        period_times = {
            1: ((8,  0),  (8, 45)),  2: ((8, 55),  (9, 40)),
            3: ((9, 55),  (10, 40)), 4: ((10, 50), (11, 35)),
            5: ((13, 30), (14, 15)), 6: ((14, 25), (15, 10)),
            7: ((15, 25), (16, 10)), 8: ((16, 20), (17, 5)),
            9: ((18, 30), (19, 15)), 10: ((19, 25), (20, 10)),
        }
    else:
        period_times = {
            1: ((8, 20), (9, 5)),   2: ((9, 15), (10, 0)),
            3: ((10, 15), (11, 0)), 4: ((11, 10), (11, 55)),
            5: ((14, 10), (14, 55)), 6: ((15, 5), (15, 50)),
            7: ((16, 5), (16, 50)), 8: ((17, 0), (17, 45)),
            9: ((19, 0), (19, 45)), 10: ((19, 55), (20, 40)),
        }

    current_class = None
    next_class = None
    next_class_time = None

    if os.path.exists(schedule_file):
        with open(schedule_file, 'r', encoding='utf-8') as f:
            schedule = json.load(f)

        for week_str in sorted(schedule.keys(), key=int):
            week = int(week_str)
            if week < current_week:
                continue
            if current_class and next_class and week > current_week:
                break

            seen = set()
            for course in schedule[week_str]:
                day = int(course['星期'])
                period = int(course['节次'])
                duration = int(course.get('节数', 1))

                if period not in period_times:
                    continue

                end_period = period + duration - 1
                if end_period not in period_times:
                    end_period = max(p for p in period_times if p <= end_period) if any(p <= end_period for p in period_times) else period

                dedup_key = (week, day, period)
                if dedup_key in seen:
                    continue
                seen.add(dedup_key)

                days_offset = (week - 1) * 7 + (day - 1)
                course_date = semester_start + timedelta(days=days_offset)

                start_h, start_m = period_times[period][0]
                end_h, end_m = period_times[end_period][1]

                course_start = course_date.replace(hour=start_h, minute=start_m, second=0, microsecond=0)
                course_end   = course_date.replace(hour=end_h,   minute=end_m,   second=0, microsecond=0)

                if course_start <= now <= course_end:
                    remaining = int((course_end - now).total_seconds() / 60)
                    if current_class is None or course_start > datetime.fromisoformat(current_class.get('_start', '2000-01-01')):
                        current_class = {
                            'type': 'class',
                            'title': course['课程名'],
                            'location': course['位置'],
                            'time': f"{start_h:02d}:{start_m:02d}-{end_h:02d}:{end_m:02d}",
                            'remaining': remaining,
                            '_start': course_start.isoformat()
                        }
                elif course_start > now:
                    if next_class_time is None or course_start < next_class_time:
                        next_class_time = course_start
                        next_class = {
                            'type': 'class',
                            'title': course['课程名'],
                            'location': course['位置'],
                            'time': course_start.strftime('%Y-%m-%d %H:%M'),
                            'countdown': int((course_start - now).total_seconds() / 60)
                        }

    if current_class:
        current_class.pop('_start', None)

    next_exam = None
    next_exam_time = None

    if os.path.exists(exams_file):
        with open(exams_file, 'r', encoding='utf-8') as f:
            exams = json.load(f)

        for week_str in sorted(exams.keys(), key=int):
            week = int(week_str)
            if week < current_week:
                continue

            for exam in exams[week_str]:
                day = int(exam['考试星期'])
                time_range = exam['考试时间']
                start_str = time_range.split('-')[0]
                hour, minute = map(int, start_str.split(':'))

                days_offset = (week - 1) * 7 + (day - 1)
                exam_date = semester_start + timedelta(days=days_offset)
                exam_time = exam_date.replace(hour=hour, minute=minute, second=0, microsecond=0)

                if exam_time > now:
                    if next_exam_time is None or exam_time < next_exam_time:
                        next_exam_time = exam_time
                        next_exam = {
                            'type': 'exam',
                            'title': exam['课程'],
                            'location': exam['位置'],
                            'time': exam_date.strftime('%Y-%m-%d') + ' ' + time_range,
                            'countdown': int((exam_time - now).total_seconds() / 60),
                            'seat': exam['座位号']
                        }

    next_event = None
    if next_class and next_exam:
        next_event = next_class if next_class_time < next_exam_time else next_exam
    elif next_class:
        next_event = next_class
    elif next_exam:
        next_event = next_exam

    return {
        'current': current_class,
        'next': next_event,
        'is_freshman': _is_freshman(username),
    }


def is_auto_update_running(username):
    """返回指定用户是否已有自动更新任务在执行。"""
    with _auto_update_state_lock:
        return username in _auto_update_running


def _try_start_auto_update(username):
    with _auto_update_state_lock:
        if username in _auto_update_running:
            return False
        _auto_update_running.add(username)
        return True


def _finish_auto_update(username):
    with _auto_update_state_lock:
        _auto_update_running.discard(username)


def start_auto_update(username, password):
    """异步启动每日更新；同一用户已有任务时直接跳过。"""
    if not _try_start_auto_update(username):
        return False

    def worker():
        _auto_update_context.slot_acquired = True
        try:
            check_and_auto_update(username, password)
        finally:
            _auto_update_context.slot_acquired = False
            _finish_auto_update(username)

    try:
        threading.Thread(target=worker, daemon=True).start()
    except Exception:
        _finish_auto_update(username)
        raise
    return True


def check_and_auto_update(username, password):
    """检查是否需要自动更新课表和考试表（每日首次访问）。"""
    slot_acquired = getattr(_auto_update_context, 'slot_acquired', False)
    if not slot_acquired and not _try_start_auto_update(username):
        return False, '更新进行中'

    try:
        return _perform_auto_update(username, password)
    finally:
        if not slot_acquired:
            _finish_auto_update(username)


def _perform_auto_update(username, password):
    """执行一次自动更新；网络请求期间不持有数据库连接。"""
    from datetime import date
    today = date.today().isoformat()

    with get_db() as conn:
        cursor = conn.execute(
            'SELECT last_auto_update FROM users WHERE username = ?',
            (username,)
        )
        row = cursor.fetchone()

        if row is None:
            return False, '用户不存在'

        last_update = row[0]
        if last_update == today:
            return False, '今日已更新'

    try:
        from URP import URP_login, URP_query
        url = get_current_urp_url()

        urp = URP_login(url, username, password)
        if not urp.is_logined():
            urp.login()

        query = URP_query(url, username)
        query.schedule_cx()
        query.exam_cx()

        with get_db() as conn:
            conn.execute(
                'UPDATE users SET last_auto_update = ? WHERE username = ?',
                (today, username)
            )

        return True, '自动更新成功'

    except Exception as e:
        return False, f'自动更新失败: {str(e)}'


def get_schedule(username, week=None):
    """读取课表文件"""
    schedule_file = os.path.join('user_data', username, 'schedule.json')

    if not os.path.exists(schedule_file):
        return {
            'week': week,
            'schedule': {},
            'message': '课表文件不存在，请先生成课表'
        }

    try:
        with open(schedule_file, 'r', encoding='utf-8') as f:
            schedule_data = json.load(f)

        if week is not None:
            week_str = str(week)
            if week_str in schedule_data:
                return {'week': week, 'schedule': {week_str: schedule_data[week_str]}}
            else:
                return {'week': week, 'schedule': {}, 'message': f'第{week}周没有课程'}

        return {
            'week': None,
            'schedule': schedule_data,
            'semester_start': get_config().get('semester_start', '2026-03-02')
        }
    except Exception as e:
        return {'week': week, 'schedule': {}, 'message': f'读取课表失败: {str(e)}'}


def get_exams(username):
    """读取考试安排文件"""
    exams_file = os.path.join('user_data', username, 'exams.json')

    if not os.path.exists(exams_file):
        return []

    try:
        with open(exams_file, 'r', encoding='utf-8') as f:
            exams_data = json.load(f)

        result = []
        if isinstance(exams_data, dict):
            for week, exams in exams_data.items():
                if isinstance(exams, list):
                    for exam in exams:
                        result.append({
                            'exam_name': exam.get('考试名', ''),
                            'course': exam.get('课程', ''),
                            'time': exam.get('考试时间', ''),
                            'week': exam.get('考试周次', ''),
                            'day': exam.get('考试星期', ''),
                            'location': exam.get('位置', ''),
                            'seat': exam.get('座位号', '')
                        })
            return result

        if isinstance(exams_data, list):
            return exams_data

        return []
    except Exception as e:
        print(f"读取考试安排失败: {str(e)}")
        return []


def get_grades(username):
    """获取成绩"""
    from URP import URP_query
    url = get_current_urp_url()
    try:
        urp_query = URP_query(url, username)
        courses = urp_query.score_query()
        return [{'course': c.get('课程名', ''), 'score': c.get('成绩', '')} for c in courses]
    except Exception as e:
        print(f"获取成绩失败: {str(e)}")
        return []


def get_semesters(username):
    """获取所有学期列表"""
    from URP import URP_query
    url = get_current_urp_url()
    try:
        urp_query = URP_query(url, username)
        return urp_query.get_semesters()
    except Exception as e:
        print(f"获取学期列表失败: {str(e)}")
        return []


def get_current_semester_grades(username):
    """获取本学期成绩"""
    from URP import URP_query
    url = get_current_urp_url()
    urp_query = URP_query(url, username)
    courses = urp_query.score_current_semester()
    return [{'course': c.get('课程名', ''), 'score': c.get('成绩', '')} for c in courses]


def get_grades_by_semester(username, semester):
    """获取指定学期的及格成绩"""
    from URP import URP_query
    url = get_current_urp_url()
    try:
        urp_query = URP_query(url, username)
        courses = urp_query.score_by_semester(semester)
        return [{'course': c.get('课程名', ''), 'score': c.get('成绩', '')} for c in courses]
    except Exception as e:
        print(f"获取学期成绩失败: {str(e)}")
        return []


def _format_grade_courses(courses, include_failed_fields=False):
    result = []
    for c in courses:
        item = {
            'course': c.get('\u8bfe\u7a0b\u540d', ''),
            'score': c.get('\u6210\u7ee9', ''),
        }
        if include_failed_fields:
            item.update({
                'credit': c.get('\u5b66\u5206', ''),
                'exam_time': c.get('\u8003\u8bd5\u65f6\u95f4', ''),
            })
        result.append(item)
    return result


def _semester_sort_key(semester, fallback_index):
    text = str(semester or '')
    years = [int(y) for y in re.findall(r'(?:19|20)\d{2}', text)]
    if years:
        year_key = max(years)
    else:
        short_years = [int(y) for y in re.findall(r'(?<!\d)\d{2}(?!\d)', text)]
        year_key = 2000 + max(short_years) if short_years else -1

    term_key = 0
    term_match = re.search(r'第\s*([一二三四五六七八九十\d]+)\s*学期', text)
    if term_match:
        raw = term_match.group(1)
        cn_terms = {'一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10}
        term_key = int(raw) if raw.isdigit() else cn_terms.get(raw, 0)
    elif '下' in text:
        term_key = 2
    elif '上' in text:
        term_key = 1

    return (year_key, term_key, fallback_index)


def get_latest_semester_grade_summary(username):
    from URP import URP_query
    url = get_current_urp_url()
    urp_query = URP_query(url, username)

    semesters = [s for s in urp_query.get_semesters() if s]
    latest_semester = max(
        enumerate(semesters),
        key=lambda item: _semester_sort_key(item[1], item[0])
    )[1] if semesters else ''

    passed = urp_query.score_by_semester(latest_semester) if latest_semester else []
    failed = urp_query.score_failed()
    return {
        'semester': latest_semester,
        'passed': _format_grade_courses(passed),
        'failed': {
            'current': _format_grade_courses(failed.get('current', []), True),
            'past': _format_grade_courses(failed.get('past', []), True),
        }
    }

def get_failed_grades(username):
    """获取不及格成绩，分为尚不及格和曾不及格"""
    from URP import URP_query
    url = get_current_urp_url()
    urp_query = URP_query(url, username)
    result = urp_query.score_failed()
    def fmt(courses):
        return [{'course': c.get('课程名', ''), 'score': c.get('成绩', ''), 'credit': c.get('学分', ''), 'exam_time': c.get('考试时间', '')} for c in courses]
    return {'current': fmt(result.get('current', [])), 'past': fmt(result.get('past', []))}


def get_gpa(username):
    """获取学分绩点和学位绩点"""
    from URP import URP_query
    url = get_current_urp_url()
    try:
        urp_query = URP_query(url, username)
        return urp_query.score_gpa()
    except Exception as e:
        print(f"获取绩点失败: {str(e)}")
        return {}


def get_exam_sessions(username):
    """获取考试成绩查询的所有学期和考试名称列表"""
    from URP import URP_query
    url = get_current_urp_url()
    try:
        urp_query = URP_query(url, username)
        return urp_query.get_exam_sessions()
    except Exception as e:
        print(f"获取考试列表失败: {str(e)}")
        return {'semesters': [], 'exams': []}


def get_exam_scores(username, jxzxjh, ksbh):
    """查询指定考试的成绩"""
    from URP import URP_query
    url = get_current_urp_url()
    try:
        urp_query = URP_query(url, username)
        courses = urp_query.score_resit(jxzxjh, ksbh)
        return [{'course': c.get('课程名', ''), 'credit': c.get('学分', ''), 'score': c.get('成绩', '')} for c in courses]
    except Exception as e:
        print(f"查询考试成绩失败: {str(e)}")
        return []


def get_unevaluated_courses(username):
    """获取未评估的课程列表"""
    try:
        from URP import URP_query
        urp_url = get_current_urp_url()
        query = URP_query(urp_url, username)
        return query.check_evaluation()
    except Exception as e:
        print(f"获取未评估课程失败: {str(e)}")
        return None


def do_evaluation(username, courses_data):
    """执行教务评价"""
    try:
        from URP import URP_query
        urp_url = get_current_urp_url()
        urp = URP_query(urp_url, username)
        success, message = urp.do_evaluation(courses_data)
        if success:
            return True, f"成功评价 {len(courses_data)} 门课程"
        else:
            return False, message
    except Exception as e:
        return False, f"评价失败: {str(e)}"
~~~~
<!-- SOURCE_END path="services/urp_service.py" -->

### 18.7 services/user_service.py：设备识别与绑定

当前快照行数：82。

<!-- SOURCE_BEGIN path="services/user_service.py" -->
~~~~python
"""
用户绑定管理服务
"""
import hashlib
from datetime import datetime
from flask import request
from database import get_db


def get_device_id():
    """获取设备唯一标识"""
    device_id = request.headers.get('X-Device-ID')
    if device_id:
        return device_id
    user_agent = request.headers.get('User-Agent', '')
    ip = request.remote_addr
    device_string = f"{user_agent}_{ip}"
    return hashlib.md5(device_string.encode()).hexdigest()


def get_user_by_device(device_id):
    """根据设备ID获取绑定的用户信息"""
    with get_db() as conn:
        row = conn.execute(
            'SELECT * FROM users WHERE device_id = ?',
            (device_id,)
        ).fetchone()
        if row:
            return {
                'device_id': row['device_id'],
                'username': row['username'],
                'password': row['password'],
                'bind_time': row['bind_time']
            }
        return None


def get_user_by_username(username):
    """根据学号获取最新的绑定记录。"""
    with get_db() as conn:
        row = conn.execute(
            'SELECT * FROM users WHERE username = ? '
            'ORDER BY bind_time DESC LIMIT 1',
            (username,)
        ).fetchone()
        if row:
            return {
                'device_id': row['device_id'],
                'username': row['username'],
                'password': row['password'],
                'bind_time': row['bind_time']
            }
        return None


def bind_user(device_id, username, password, invitation_token=None):
    """绑定用户到设备，并在首次绑定时原子化处理邀请归因。"""
    with get_db() as conn:
        conn.execute('''
            INSERT OR REPLACE INTO users (device_id, username, password, bind_time)
            VALUES (?, ?, ?, ?)
        ''', (device_id, username, password, datetime.now().isoformat()))
        invitation_bound = False
        if invitation_token:
            from services.invitation_service import bind_invitation_by_token
            invitation_bound = bind_invitation_by_token(
                conn, username, invitation_token
            )
            if invitation_bound:
                from services.member_service import ensure_invitation_earnings
                ensure_invitation_earnings(conn, invitee_username=username)
        return invitation_bound


def unbind_user(device_id):
    """解绑用户；解绑设备不影响学号名下的 API 密钥。"""
    with get_db() as conn:
        cursor = conn.execute(
            'DELETE FROM users WHERE device_id = ?',
            (device_id,)
        )
        return cursor.rowcount > 0
~~~~
<!-- SOURCE_END path="services/user_service.py" -->
### 18.8 routes/auth_routes.py：绑定、登录与状态 API

当前快照行数：131。

<!-- SOURCE_BEGIN path="routes/auth_routes.py" -->
~~~~python
"""
用户认证相关路由
"""
from flask import Blueprint, request, jsonify
from database import get_db
from services.user_service import get_device_id, get_user_by_device, bind_user
from services.urp_service import urp_login, check_login_status
from services.config_service import get_current_urp_url

auth_bp = Blueprint('auth', __name__)


@auth_bp.route('/api/check_bind', methods=['GET'])
def check_bind():
    device_id = get_device_id()
    user = get_user_by_device(device_id)

    rebind_notifications = []
    with get_db() as conn:
        rows = conn.execute(
            "SELECT request_id, old_username, new_username, status FROM pending_requests WHERE device_id = ? AND status != 'pending' AND notified = 0",
            (device_id,)
        ).fetchall()
        for row in rows:
            rebind_notifications.append({
                'request_id': row['request_id'],
                'old_username': row['old_username'],
                'new_username': row['new_username'],
                'status': row['status']
            })

    if user:
        resp = {'success': True, 'bound': True, 'username': user['username']}
    else:
        resp = {'success': True, 'bound': False}

    if rebind_notifications:
        resp['rebind_notifications'] = rebind_notifications
    return jsonify(resp)


@auth_bp.route('/api/rebind_notified', methods=['POST'])
def rebind_notified():
    device_id = get_device_id()
    data = request.get_json()
    request_ids = data.get('request_ids', [])

    if not request_ids:
        return jsonify({'success': False, 'message': '缺少 request_ids'})

    with get_db() as conn:
        placeholders = ','.join(['?'] * len(request_ids))
        conn.execute(
            f"UPDATE pending_requests SET notified = 1 WHERE request_id IN ({placeholders}) AND device_id = ?",
            request_ids + [device_id]
        )

    return jsonify({'success': True})


@auth_bp.route('/api/login', methods=['POST'])
def login():
    data = request.get_json() or {}
    username = data.get('username')
    password = data.get('password')
    invitation_token = data.get('invitation_token')

    if not username or not password:
        return jsonify({'success': False, 'message': '用户名和密码不能为空'})

    success, message, _ = urp_login(username, password)

    if success:
        device_id = get_device_id()

        bind_user(device_id, username, password, invitation_token)

        return jsonify({'success': True, 'message': '登录成功', 'username': username})
    else:
        return jsonify({'success': False, 'message': message})


@auth_bp.route('/api/request_rebind', methods=['POST'])
def request_rebind():
    device_id = get_device_id()
    current_user = get_user_by_device(device_id)

    if not current_user:
        return jsonify({'success': False, 'message': '设备未绑定账号'})

    with get_db() as conn:
        conn.execute('DELETE FROM users WHERE device_id = ?', (device_id,))
        conn.execute(
            "DELETE FROM pending_requests WHERE device_id = ? AND status = 'pending'",
            (device_id,)
        )

    return jsonify({
        'success': True,
        'message': '当前设备已解绑，请重新绑定新账号'
    })


@auth_bp.route('/api/check_login_status', methods=['GET'])
def api_check_login_status():
    device_id = get_device_id()
    user = get_user_by_device(device_id)

    if not user:
        return jsonify({'success': True, 'logged_in': False, 'message': '未绑定账号'})

    username = user['username']
    password = user['password']

    from URP import URP_login
    url = get_current_urp_url()

    try:
        urp = URP_login(url, username, password)
        is_logged_in = urp.is_logined()

        if is_logged_in is True:
            return jsonify({'success': True, 'logged_in': True, 'username': username, 'message': '登录状态正常'})
        else:
            success, message, _ = urp.login()
            if success:
                return jsonify({'success': True, 'logged_in': True, 'username': username, 'message': '重新登录成功'})
            else:
                return jsonify({'success': True, 'logged_in': False, 'username': username, 'message': message or '重新登录失败'})
    except Exception as e:
        return jsonify({'success': False, 'logged_in': False, 'message': f'检查登录状态失败: {str(e)}'})
~~~~
<!-- SOURCE_END path="routes/auth_routes.py" -->

### 18.9 routes/data_routes.py：全部教务信息 API

当前快照行数：323。

<!-- SOURCE_BEGIN path="routes/data_routes.py" -->
~~~~python
"""
教务数据相关路由
"""
import os
import json
import random
from flask import Blueprint, request, jsonify
from auth import require_login, require_bindding, require_member, require_grade_login
from database import get_db
from services.config_service import get_config
from services.urp_service import (
    get_urgent_event, get_schedule, get_exams, get_grades,
    get_unevaluated_courses, do_evaluation, start_auto_update,
    check_login_status, get_semesters, get_grades_by_semester,
    get_failed_grades, get_gpa, get_current_semester_grades,
    get_latest_semester_grade_summary,
    get_exam_sessions, get_exam_scores
)
from services.config_service import get_current_urp_url

data_bp = Blueprint('data', __name__)


@data_bp.route('/api/urgent_event', methods=['GET'])
@require_bindding
def api_urgent_event(user):
    try:
        start_auto_update(user['username'], user['password'])

        event = get_urgent_event(user['username'])
        return jsonify({'success': True, 'event': event})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@data_bp.route('/api/schedule', methods=['GET'])
@require_bindding
def api_schedule(user):
    week = request.args.get('week', type=int)
    try:
        schedule = get_schedule(user['username'], week)
        return jsonify({'success': True, 'data': schedule})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@data_bp.route('/api/update_schedule', methods=['POST'])
@require_login
def api_update_schedule(user):
    try:
        from URP import URP_query

        username = user['username']
        password = user['password']

        is_logged_in, _ = check_login_status(username, password, {})
        if not is_logged_in:
            return jsonify({'success': False, 'message': '登录已过期，请重新登录'})

        current_url = get_current_urp_url()
        urp = URP_query(current_url, username)
        schedule_data = urp.schedule_cx()

        return jsonify({'success': True, 'message': '课程表更新成功', 'data': schedule_data})
    except Exception as e:
        return jsonify({'success': False, 'message': f'更新失败: {str(e)}'})


@data_bp.route('/api/historical_schedule', methods=['GET'])
@require_login
def api_historical_schedule(user):
    """查询指定历史学期的完整课表网格，不覆盖当前课表缓存。"""
    try:
        from URP import URP_query

        semester = request.args.get('semester', '').strip()
        current_url = get_current_urp_url()
        urp = URP_query(current_url, user['username'])
        historical_data = urp.historical_schedule_cx(semester)
        return jsonify({'success': True, 'data': historical_data})
    except Exception as e:
        return jsonify({'success': False, 'message': f'历年课表查询失败: {str(e)}'})


@data_bp.route('/api/exams', methods=['GET'])
@require_bindding
def api_exams(user):
    try:
        exams = get_exams(user['username'])
        return jsonify({'success': True, 'exams': exams})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@data_bp.route('/api/update_exams', methods=['POST'])
@require_login
def api_update_exams(user):
    try:
        from URP import URP_query

        username = user['username']
        password = user['password']

        is_logged_in, _ = check_login_status(username, password, {})
        if not is_logged_in:
            return jsonify({'success': False, 'message': '登录已过期，请重新登录'})

        current_url = get_current_urp_url()
        urp = URP_query(current_url, username)
        exams_data = urp.exam_cx()

        return jsonify({'success': True, 'message': '考试安排更新成功', 'data': exams_data})
    except Exception as e:
        return jsonify({'success': False, 'message': f'更新失败: {str(e)}'})


@data_bp.route('/api/grades', methods=['GET'])
@require_grade_login('basic')
def api_grades(user):
    try:
        grades = get_grades(user['username'])
        return jsonify({'success': True, 'grades': grades})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@data_bp.route('/api/grades/current', methods=['GET'])
@require_grade_login('basic')
def api_grades_current(user):
    try:
        grades = get_current_semester_grades(user['username'])
        return jsonify({'success': True, 'grades': grades})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})

@data_bp.route('/api/grades/latest_summary', methods=['GET'])
@require_grade_login('basic')
def api_grades_latest_summary(user):
    try:
        result = get_latest_semester_grade_summary(user['username'])
        return jsonify({'success': True, **result})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})

@data_bp.route('/api/grades/semesters', methods=['GET'])
@require_grade_login('basic')
def api_grade_semesters(user):
    try:
        semesters = get_semesters(user['username'])
        return jsonify({'success': True, 'semesters': semesters})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@data_bp.route('/api/grades/by_semester', methods=['GET'])
@require_grade_login('basic')
def api_grades_by_semester(user):
    semester = request.args.get('semester', '')
    if not semester:
        return jsonify({'success': False, 'message': '请指定学期'})
    try:
        grades = get_grades_by_semester(user['username'], semester)
        return jsonify({'success': True, 'grades': grades, 'semester': semester})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@data_bp.route('/api/grades/failed', methods=['GET'])
@require_grade_login('basic')
def api_grades_failed(user):
    try:
        result = get_failed_grades(user['username'])
        return jsonify({'success': True, 'current': result['current'], 'past': result['past']})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@data_bp.route('/api/grades/gpa', methods=['GET'])
@require_grade_login('basic')
def api_grades_gpa(user):
    try:
        gpa = get_gpa(user['username'])
        return jsonify({'success': True, 'gpa': gpa})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@data_bp.route('/api/grades/exam_sessions', methods=['GET'])
@require_grade_login('basic')
def api_exam_sessions(user):
    try:
        sessions = get_exam_sessions(user['username'])
        return jsonify({'success': True, **sessions})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@data_bp.route('/api/grades/exam_scores', methods=['GET'])
@require_grade_login('basic')
def api_exam_scores(user):
    jxzxjh = request.args.get('jxzxjh', '')
    ksbh = request.args.get('ksbh', '')
    if not jxzxjh or not ksbh:
        return jsonify({'success': False, 'message': '请指定学期和考试名称'})
    try:
        grades = get_exam_scores(user['username'], jxzxjh, ksbh)
        return jsonify({'success': True, 'grades': grades})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@data_bp.route('/api/schedule/other_majors', methods=['GET'])
@require_bindding
def api_other_majors(user):
    """返回其他年级+专业+班级列表，格式：{grade: {major: [class, ...]}，仅含有课表缓存的组合"""
    my_username = user['username']
    with get_db() as conn:
        rows = conn.execute('SELECT DISTINCT username FROM users').fetchall()
    # result: {grade: {major: set(class_num)}}
    result = {}
    for row in rows:
        username = row['username']
        if len(username) < 10 or username == my_username:
            continue
        schedule_file = os.path.join('user_data', username, 'schedule.json')
        if not os.path.exists(schedule_file):
            continue
        grade = username[:2]
        major = username[4:7]
        class_num = username[7]  # 倒数第三位即第8位（0-indexed: index 7）
        result.setdefault(grade, {}).setdefault(major, set()).add(class_num)
    # 转为可序列化格式，排序
    serializable = {
        g: {m: sorted(classes) for m, classes in sorted(majors.items())}
        for g, majors in sorted(result.items())
    }
    return jsonify({'success': True, 'data': serializable})


@data_bp.route('/api/schedule/other_major', methods=['GET'])
@require_bindding
def api_other_major_schedule(user):
    """返回指定年级+专业+班级的脱敏课表，参数：grade（前2位）、major（第5-7位）、class_num（第8位）"""
    grade = request.args.get('grade', '').strip()
    major = request.args.get('major', '').strip()
    class_num = request.args.get('class_num', '').strip()
    if not grade or len(grade) != 2 or not major or len(major) != 3 or not class_num or len(class_num) != 1:
        return jsonify({'success': False, 'message': '请指定有效的年级、专业和班级'})

    with get_db() as conn:
        rows = conn.execute('SELECT username FROM users').fetchall()

    candidates = []
    for row in rows:
        username = row['username']
        if (len(username) >= 10 and username[:2] == grade
                and username[4:7] == major and username[7] == class_num):
            schedule_file = os.path.join('user_data', username, 'schedule.json')
            if os.path.exists(schedule_file):
                candidates.append((username, schedule_file))

    if not candidates:
        return jsonify({'success': False, 'message': f'暂无 {grade}级专业{major} {class_num}班 的课表数据'})

    username, schedule_file = random.choice(candidates)
    with open(schedule_file, 'r', encoding='utf-8') as f:
        raw = json.load(f)

    # 脱敏：只保留课程名、星期、节次、节数
    desensitized = {}
    for week, courses in raw.items():
        desensitized[week] = [
            {
                '课程名': c.get('课程名', ''),
                '星期': c.get('星期', ''),
                '节次': c.get('节次', ''),
                '节数': c.get('节数', ''),
            }
            for c in courses
        ]

    config = get_config()
    return jsonify({
        'success': True,
        'data': {
            'grade': grade,
            'major': major,
            'class_num': class_num,
            'schedule': desensitized,
            'semester_start': config.get('semester_start', ''),
        }
    })


@data_bp.route('/api/unevaluated_courses', methods=['GET'])
@require_member('basic')
def api_unevaluated_courses(user):
    try:
        courses = get_unevaluated_courses(user['username'])
        if not courses:
            return jsonify({
                'success': True,
                'has_courses': False,
                'message': '当前没有需要评估的课程，可能尚未到评估时间或评估已结束',
                'courses': []
            })
        return jsonify({'success': True, 'has_courses': True, 'courses': courses})
    except Exception as e:
        return jsonify({'success': False, 'message': f'查询失败: {str(e)}'})


@data_bp.route('/api/evaluation', methods=['POST'])
@require_member('basic')
def api_evaluation(user):
    try:
        data = request.get_json()
        courses_data = data.get('courses', [])
        if not courses_data:
            return jsonify({'success': False, 'message': '没有课程数据'})
        success, message = do_evaluation(user['username'], courses_data)
        return jsonify({'success': success, 'message': message})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})
~~~~
<!-- SOURCE_END path="routes/data_routes.py" -->

### 18.10 auth.py：绑定、登录、成绩与会员权限链

当前快照行数：207。

<!-- SOURCE_BEGIN path="auth.py" -->
~~~~python
"""
认证装饰器
"""
from functools import wraps
from datetime import datetime
from flask import request, jsonify
from database import get_db
from services.config_service import get_admin_key, get_config
from services.user_service import get_device_id, get_user_by_device
from services.urp_service import check_login_status, _login_cache


def require_admin(f):
    """管理员权限装饰器"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        admin_key = request.headers.get('X-Admin-Key') or request.headers.get('Admin-Key') or request.args.get('admin_key')
        if admin_key != get_admin_key():
            return jsonify({'success': False, 'message': '管理员密钥错误'}), 403
        return f(*args, **kwargs)
    return decorated_function


def require_login(f):
    """用户登录状态检查装饰器"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        device_id = get_device_id()
        user = get_user_by_device(device_id)

        if not user:
            return jsonify({'success': False, 'message': '未绑定账号'})

        username = user['username']
        password = user['password']

        is_logged_in, _ = check_login_status(username, password, {})

        if not is_logged_in:
            return jsonify({'success': False, 'message': '登录已失效，请重新绑定'})

        try:
            return f(user=user, *args, **kwargs)
        except Exception:
            _login_cache.pop(username, None)
            is_logged_in, _ = check_login_status(username, password, {})
            if not is_logged_in:
                return jsonify({'success': False, 'message': '登录已失效，请重新绑定'})
            try:
                return f(user=user, *args, **kwargs)
            except Exception:
                raise

    return decorated_function


def require_bindding(f):
    """账号绑定检查装饰器（不验证URP登录状态）"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        device_id = get_device_id()
        user = get_user_by_device(device_id)

        if not user:
            return jsonify({'success': False, 'message': '请先绑定账号后使用此功能'})

        return f(user=user, *args, **kwargs)

    return decorated_function


def require_member(level='basic'):
    """会员权限装饰器，level: 'basic' 或 'advanced'"""
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            device_id = get_device_id()
            user = get_user_by_device(device_id)
            if not user:
                return jsonify({'success': False, 'message': '请先绑定账号后使用此功能'})
            username = user['username']
            with get_db() as conn:
                row = conn.execute(
                    'SELECT member_type, expire_time FROM memberships WHERE username = ?',
                    (username,)
                ).fetchone()
            if not row:
                level_name = '初级会员' if level == 'basic' else '高级会员'
                return jsonify({'success': False, 'message': f'此功能需要{level_name}，请前往会员购买页面开通', 'require_member': level})
            member_type = row['member_type']
            expire_time = datetime.fromisoformat(row['expire_time'])
            if datetime.now() > expire_time:
                return jsonify({'success': False, 'message': '您的会员已过期，请前往会员购买页面续费', 'require_member': level})
            if level == 'advanced' and member_type != 'advanced':
                return jsonify({'success': False, 'message': '此功能需要高级会员，请前往会员购买页面升级', 'require_member': level})
            return f(user=user, *args, **kwargs)
        return decorated_function
    return decorator


def _check_member_access(username, level):
    with get_db() as conn:
        row = conn.execute(
            'SELECT member_type, expire_time FROM memberships WHERE username = ?',
            (username,)
        ).fetchone()

    if not row:
        level_name = '初级会员' if level == 'basic' else '高级会员'
        return False, {'success': False, 'message': f'此功能需要{level_name}，请前往会员购买页面开通', 'require_member': level}

    member_type = row['member_type']
    expire_time = datetime.fromisoformat(row['expire_time'])
    if datetime.now() > expire_time:
        return False, {'success': False, 'message': '您的会员已过期，请前往会员购买页面续费', 'require_member': level}

    if level == 'advanced' and member_type != 'advanced':
        return False, {'success': False, 'message': '此功能需要高级会员，请前往会员购买页面升级', 'require_member': level}

    return True, None


def require_grade_login(level='basic'):
    """成绩查询权限：可由后台配置是否需要会员，同时始终检查教务登录状态。"""
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            device_id = get_device_id()
            user = get_user_by_device(device_id)
            if not user:
                return jsonify({'success': False, 'message': '请先绑定账号后使用此功能'})

            username = user['username']
            password = user['password']
            config = get_config()
            if config.get('grades_require_member', True):
                ok, error = _check_member_access(username, level)
                if not ok:
                    return jsonify(error)

            is_logged_in, _ = check_login_status(username, password, {})
            if not is_logged_in:
                return jsonify({'success': False, 'message': '登录已失效，请重新绑定'})

            try:
                return f(user=user, *args, **kwargs)
            except Exception:
                _login_cache.pop(username, None)
                is_logged_in, _ = check_login_status(username, password, {})
                if not is_logged_in:
                    return jsonify({'success': False, 'message': '登录已失效，请重新绑定'})
                try:
                    return f(user=user, *args, **kwargs)
                except Exception:
                    raise

        return decorated_function
    return decorator

def require_member_login(level='basic'):
    """会员权限 + URP 登录状态检查装饰器，level: 'basic' 或 'advanced'"""
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            device_id = get_device_id()
            user = get_user_by_device(device_id)
            if not user:
                return jsonify({'success': False, 'message': '请先绑定账号后使用此功能'})

            username = user['username']
            password = user['password']
            with get_db() as conn:
                row = conn.execute(
                    'SELECT member_type, expire_time FROM memberships WHERE username = ?',
                    (username,)
                ).fetchone()

            if not row:
                level_name = '初级会员' if level == 'basic' else '高级会员'
                return jsonify({'success': False, 'message': f'此功能需要{level_name}，请前往会员购买页面开通', 'require_member': level})

            member_type = row['member_type']
            expire_time = datetime.fromisoformat(row['expire_time'])
            if datetime.now() > expire_time:
                return jsonify({'success': False, 'message': '您的会员已过期，请前往会员购买页面续费', 'require_member': level})

            if level == 'advanced' and member_type != 'advanced':
                return jsonify({'success': False, 'message': '此功能需要高级会员，请前往会员购买页面升级', 'require_member': level})

            is_logged_in, _ = check_login_status(username, password, {})
            if not is_logged_in:
                return jsonify({'success': False, 'message': '登录已失效，请重新绑定'})

            try:
                return f(user=user, *args, **kwargs)
            except Exception:
                _login_cache.pop(username, None)
                is_logged_in, _ = check_login_status(username, password, {})
                if not is_logged_in:
                    return jsonify({'success': False, 'message': '登录已失效，请重新绑定'})
                try:
                    return f(user=user, *args, **kwargs)
                except Exception:
                    raise

        return decorated_function
    return decorator
~~~~
<!-- SOURCE_END path="auth.py" -->
### 18.11 services/shortcut_service.py：可选快捷指令查询与输出规范化

当前快照行数：266。

<!-- SOURCE_BEGIN path="services/shortcut_service.py" -->
~~~~python
"""
Apple 快捷指令 API 的密钥管理服务。
"""
import hashlib
import secrets
from datetime import datetime

from database import get_db
from services.config_service import get_current_urp_url
from services.urp_service import get_latest_semester_grade_summary, get_urgent_event


API_KEY_PREFIX = 'urp_'
API_KEY_PREFIX_LENGTH = 12


def hash_api_key(raw_key):
    """返回 API 密钥的 SHA-256 十六进制哈希。"""
    return hashlib.sha256(raw_key.encode('utf-8')).hexdigest()


def issue_api_key(username, now=None):
    """为学号创建或轮换唯一密钥，并只在本次调用中返回明文。"""
    if not isinstance(username, str) or not username.strip():
        raise ValueError('学号不能为空')

    username = username.strip()
    raw_key = f'{API_KEY_PREFIX}{secrets.token_urlsafe(32)}'
    key_hash = hash_api_key(raw_key)
    create_time = (now or datetime.now()).isoformat()
    key_prefix = raw_key[:API_KEY_PREFIX_LENGTH]

    with get_db() as conn:
        exists = conn.execute(
            'SELECT username FROM api_keys WHERE username = ?',
            (username,),
        ).fetchone()
        if exists:
            conn.execute(
                'UPDATE api_keys SET key_hash = ?, key_prefix = ?, create_time = ? '
                'WHERE username = ?',
                (key_hash, key_prefix, create_time, username),
            )
        else:
            conn.execute(
                'INSERT INTO api_keys (username, key_hash, key_prefix, create_time) '
                'VALUES (?, ?, ?, ?)',
                (username, key_hash, key_prefix, create_time),
            )

    return {
        'key': raw_key,
        'key_hash': key_hash,
        'key_prefix': key_prefix,
        'create_time': create_time,
    }


def get_api_key_status(username):
    """返回学号的密钥状态，不返回密钥明文或完整哈希。"""
    with get_db() as conn:
        row = conn.execute(
            'SELECT key_prefix, create_time FROM api_keys WHERE username = ?',
            (username,),
        ).fetchone()

    if not row:
        return {
            'has_key': False,
            'key_prefix': None,
            'create_time': None,
        }

    return {
        'has_key': True,
        'key_prefix': row['key_prefix'],
        'create_time': row['create_time'],
    }


def resolve_api_key(raw_key):
    """将明文密钥解析为学号；密钥不存在时返回 None。"""
    if not isinstance(raw_key, str) or not raw_key.strip():
        return None

    with get_db() as conn:
        row = conn.execute(
            'SELECT username FROM api_keys WHERE key_hash = ?',
            (hash_api_key(raw_key.strip()),),
        ).fetchone()
    return row['username'] if row else None


def revoke_api_key(username):
    """撤销学号当前密钥，返回是否存在并删除了记录。"""
    if not isinstance(username, str) or not username.strip():
        return False
    with get_db() as conn:
        cursor = conn.execute(
            'DELETE FROM api_keys WHERE username = ?',
            (username.strip(),),
        )
        return cursor.rowcount > 0


def _as_text(value):
    return '' if value is None else str(value)


def _as_positive_int(value):
    try:
        number = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def normalize_historical_schedule(student_id, result):
    """把中文课表字段转换为快捷指令易读取的稳定字段。"""
    result = result if isinstance(result, dict) else {}
    semester = _as_text(result.get('semester'))
    semester_name = ''
    for option in result.get('semesters') or []:
        if isinstance(option, dict) and _as_text(option.get('value')) == semester:
            semester_name = _as_text(option.get('label'))
            break

    weekday_names = ['', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日']
    courses = []
    for source in result.get('courses') or []:
        if not isinstance(source, dict):
            continue
        weekday = _as_positive_int(source.get('星期'))
        start_section = _as_positive_int(source.get('节次'))
        section_count = _as_positive_int(source.get('节数'))
        if (
            weekday is None
            or weekday > 7
            or start_section is None
            or section_count is None
        ):
            continue

        end_section = start_section + section_count - 1
        section_name = (
            f'第{start_section}节'
            if section_count == 1
            else f'第{start_section}-{end_section}节'
        )
        courses.append({
            'course_name': _as_text(source.get('课程名')),
            'weekday': weekday,
            'weekday_name': weekday_names[weekday],
            'start_section': start_section,
            'section_count': section_count,
            'section_name': section_name,
            'location': _as_text(source.get('位置')),
            'class_no': _as_text(source.get('课序')),
        })

    return {
        'student_id': _as_text(student_id),
        'semester': semester,
        'semester_name': semester_name,
        'course_count': len(courses),
        'courses': courses,
    }


def _normalize_grade_course(source, include_failed_fields=False):
    source = source if isinstance(source, dict) else {}
    item = {
        'course_name': _as_text(source.get('course')),
        'score': source.get('score', ''),
    }
    if include_failed_fields:
        item.update({
            'credit': source.get('credit', ''),
            'exam_time': source.get('exam_time', ''),
        })
    return item


def normalize_grade_summary(student_id, result):
    """把网页成绩汇总转换为扁平、便于快捷指令处理的字段。"""
    result = result if isinstance(result, dict) else {}
    passed = [
        _normalize_grade_course(course)
        for course in (result.get('passed') or [])
    ]
    failed = result.get('failed') or {}
    failed_current = [
        _normalize_grade_course(course, True)
        for course in (failed.get('current') or [])
    ]
    failed_past = [
        _normalize_grade_course(course, True)
        for course in (failed.get('past') or [])
    ]
    return {
        'student_id': _as_text(student_id),
        'semester': _as_text(result.get('semester')),
        'passed_count': len(passed),
        'failed_current_count': len(failed_current),
        'failed_past_count': len(failed_past),
        'passed': passed,
        'failed_current': failed_current,
        'failed_past': failed_past,
    }


def normalize_urgent_event(student_id, result):
    """把首页的下一事项转换为快捷指令易读取的稳定字段。"""
    result = result if isinstance(result, dict) else {}
    source = result.get('next')
    if not isinstance(source, dict):
        return {
            'student_id': _as_text(student_id),
            'has_event': False,
            'event': None,
        }

    event = {
        'type': _as_text(source.get('type')),
        'title': _as_text(source.get('title')),
        'location': _as_text(source.get('location')),
        'time': _as_text(source.get('time')),
        'countdown': source.get('countdown'),
    }
    if 'seat' in source:
        event['seat'] = _as_text(source.get('seat'))

    return {
        'student_id': _as_text(student_id),
        'has_event': True,
        'event': event,
    }


def query_shortcut_data(student_id, action, params):
    """按快捷指令动作查询并规范化教务数据。"""
    if action not in {'historical_schedule', 'grades', 'urgent_event'}:
        raise ValueError('invalid_action')
    if not isinstance(params, dict):
        raise ValueError('invalid_params')

    if action == 'historical_schedule':
        semester = params.get('semester', '')
        if not isinstance(semester, str):
            raise ValueError('invalid_params')
        from URP import URP_query

        query = URP_query(get_current_urp_url(), student_id)
        result = query.historical_schedule_cx(semester)
        return normalize_historical_schedule(student_id, result)

    if action == 'urgent_event':
        return normalize_urgent_event(
            student_id,
            get_urgent_event(student_id),
        )

    return normalize_grade_summary(
        student_id,
        get_latest_semester_grade_summary(student_id),
    )
~~~~
<!-- SOURCE_END path="services/shortcut_service.py" -->

### 18.12 routes/shortcut_routes.py：可选快捷指令 HTTP API

当前快照行数：126。

<!-- SOURCE_BEGIN path="routes/shortcut_routes.py" -->
~~~~python
"""Apple 快捷指令 API 及会员密钥管理路由。"""
from flask import Blueprint, jsonify, request

from auth import (
    _check_member_access,
    require_bindding,
    require_member,
)
from services.shortcut_service import (
    get_api_key_status,
    issue_api_key,
    query_shortcut_data,
    resolve_api_key,
)
from services.urp_service import check_login_status, start_auto_update
from services.user_service import get_user_by_username


shortcut_bp = Blueprint('shortcut', __name__)


@shortcut_bp.route('/api/member/api-key', methods=['GET'])
@require_bindding
def get_member_api_key(user):
    """查询当前绑定学号的密钥状态，不返回密钥明文。"""
    return jsonify({
        'success': True,
        'data': get_api_key_status(user['username']),
    })


@shortcut_bp.route('/api/member/api-key', methods=['POST'])
@require_member('basic')
def create_member_api_key(user):
    """生成或轮换当前绑定学号的 API 密钥。"""
    issued = issue_api_key(user['username'])
    return jsonify({
        'success': True,
        'data': {
            'key': issued['key'],
            'key_prefix': issued['key_prefix'],
            'create_time': issued['create_time'],
        },
    })


def _shortcut_error(action, error_code, message):
    return jsonify({
        'success': False,
        'action': action,
        'error_code': error_code,
        'message': message,
        'data': None,
    })


@shortcut_bp.route('/api/shortcut/query', methods=['POST'])
def shortcut_query():
    """使用按学号生成的密钥查询快捷指令数据。"""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return _shortcut_error(None, 'invalid_request', '请求体必须是 JSON')

    raw_key = payload.get('key')
    action = payload.get('action')
    params = payload.get('params', {})
    if not isinstance(raw_key, str) or not raw_key.strip():
        return _shortcut_error(
            action if isinstance(action, str) else None,
            'invalid_request',
            '缺少 key',
        )
    if not isinstance(action, str) or not action.strip():
        return _shortcut_error(None, 'invalid_request', '缺少 action')
    action = action.strip()
    if not isinstance(params, dict):
        return _shortcut_error(action, 'invalid_request', 'params 必须是对象')
    if action not in {'historical_schedule', 'grades', 'urgent_event'}:
        return _shortcut_error(action, 'invalid_action', '不支持的查询功能')

    username = resolve_api_key(raw_key.strip())
    if not username:
        return _shortcut_error(action, 'invalid_key', '密钥无效或已失效')

    member_ok, member_error = _check_member_access(username, 'basic')
    if not member_ok:
        return _shortcut_error(
            action,
            'member_required',
            member_error.get('message', '此功能需要初级会员'),
        )

    user = get_user_by_username(username)
    if not user:
        return _shortcut_error(action, 'login_required', '未找到该学号的绑定信息')
    is_logged_in, _ = check_login_status(username, user['password'], {})
    if not is_logged_in:
        return _shortcut_error(
            action,
            'login_required',
            '教务登录已失效，请先在网站重新绑定',
        )

    try:
        if action == 'urgent_event':
            start_auto_update(username, user['password'])
        data = query_shortcut_data(username, action, params)
    except ValueError as exc:
        error_code = str(exc)
        if error_code not in {'invalid_action', 'invalid_params'}:
            error_code = 'query_failed'
        message = (
            '不支持的查询功能'
            if error_code == 'invalid_action'
            else '查询参数无效'
        )
        return _shortcut_error(action, error_code, message)
    except Exception:
        return _shortcut_error(action, 'query_failed', '查询失败，请稍后重试')

    return jsonify({
        'success': True,
        'action': action,
        'message': '查询成功',
        'data': data,
    })
~~~~
<!-- SOURCE_END path="routes/shortcut_routes.py" -->
<!-- 文档结束。接手 AI 应以第 0 至 16 节为规范，以第 18 节源码为兼容性证据。 -->
