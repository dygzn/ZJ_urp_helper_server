# URP 教务助手项目代码审计与功能说明报告

> 审计日期：2026-09-03  
> 审计对象：当前工作区 `E:\URP\web`（包含尚未提交的本地修改）  
> 审计方法：逐文件阅读后端、前端、模板、配置、数据库初始化和测试代码；未读取或披露真实用户缓存、数据库记录、VPN 凭据和支付密钥值。  
> 本报告描述的是“当前代码实际行为”，与旧 README、注释或历史设计不一致时，以当前实现为准。

## 1. 项目结论摘要

这是一个 Flask + 原生 JavaScript 的单页教务辅助网站。核心能力是：用设备 ID 绑定学生 URP 账号，通过 VPN/URP 会话和 HTML 爬取获得课表、考试、成绩、绩点与评教数据；用 JSON 文件缓存课表、考试和 Cookie；用 SQLite 或 MySQL 保存用户、会员、订单、邀请、公告、反馈等业务数据。

当前用户端真正可见的页面共有 10 个：首页、课程表、考试安排、成绩查询、教学评估、系统公告、找我做事、反馈建议、快捷指令 API、会员购买。另有广告详情页和管理员后台。

代码中还存在一套“对分易签到”后端代理与前端函数，但当前 `index.html` 没有签到导航、页面或所需 DOM 元素，所以它属于“后端可直接调用、网页前端不可达”的孤立功能。

当前配置文件显示：数据库类型为 SQLite、当前 URP 地址索引为 1、学期第一周为 `2026-03-02`、`grades_require_member` 为 `false`。因此当前运行配置下成绩接口仍要求已绑定并保持 URP 登录，但不要求会员；评教和生成快捷指令密钥仍要求初级会员。

## 2. 技术栈与目录职责

| 层次 | 主要文件 | 职责 |
|---|---|---|
| Flask 入口 | `app.py` | 初始化数据库、注册 7 个 Blueprint、全局 API 异常处理、渲染主页/广告页 |
| 认证层 | `auth.py` | 管理员、绑定、URP 登录、会员、成绩权限组合装饰器 |
| 路由层 | `routes/*.py` | 认证、教务数据、会员、邀请、快捷指令、签到、后台、公告与反馈 API |
| 业务层 | `services/*.py` | 登录缓存、缓存数据读取、自动更新、会员返佣、API 密钥、配置、广告统计、在线状态 |
| 爬虫层 | `urp/login.py`、`urp/query.py`、`urp/schedule_legacy.py` | VPN/URP 登录、Cookie 恢复、HTML 请求与解析、课表/考试缓存落盘 |
| 兼容入口 | `URP.py` | 继续支持 `from URP import URP_login, URP_query` |
| 数据层 | `database.py` | SQLite/MySQL 适配、建表、内联迁移、SQLite→MySQL 数据迁移 |
| 用户前端 | `templates/index.html`、`static/js/main.js` | 原生 SPA、设备 ID、页面切换、调用用户 API、渲染数据 |
| 管理前端 | `templates/admin.html`、`static/js/admin.js` | 管理员登录、统计、配置、公告、反馈、会员与提现管理 |
| 公共前端模块 | `schedule-layout.js`、`service-status-ui.js`、`ui-ux.js` | 历年课表网格、服务状态/复制、页面名与弹窗可访问性工具 |
| 广告页 | `ad_detail.html`、`ad-detail.js` | 活动说明、复制微信/备注、漏斗事件上报 |
| 样式 | `static/css/style.css`、`admin.css` | 用户站与后台响应式样式 |

Python 依赖被固定为 Flask 3.1.2、requests 2.32.5、BeautifulSoup 4.12.2、ddddocr 1.4.11、PyMySQL 1.1.1 等。前端无框架、无构建步骤。

## 3. 网站全部功能

### 3.1 用户端页面

#### 3.1.1 首页

- 显示“正在进行的课程”和“下一个课程或考试”。
- 根据后台配置的学期第一周计算当前周次。
- 根据学号前两位判断是否为最新一届新生，并选择两套作息时间。
- 课程进行中显示距离下课分钟数；当天下一节课显示距离上课分钟数；前端每分钟刷新倒计时。
- 首次加载会异步触发当日自动更新：同一学号每天最多更新一次课表和考试缓存，同一进程内阻止同学号并发更新。
- 页面右上角显示 URP 会话状态 Online/Offline/Error。
- 访客可以进入首页，但只会看到“绑定后查看课程和考试”的提示。

#### 3.1.2 课程表

- 默认读取当前账号 `user_data/{username}/schedule.json` 的全量周课表。
- 根据 `semester_start` 自动定位当前周，并将当前周保存到 `localStorage.current_week`。
- 支持上一周、下一周、周次下拉、课程详情弹窗。
- 周末无课时隐藏周六、周日列；有周末课程时显示完整 7 天。
- 晚间有课时扩展网格高度。
- 缓存不存在时，前端自动调用“更新课程表”，实时爬取后再重新读取。
- 手动“更新课程表”要求有效 URP 登录。
- 支持历年课表：选择 URP 页面列出的学期，展示完整星期×节次网格；结果不覆盖当前课表缓存。
- 代码还支持“其它专业课表”：从所有已绑定用户的缓存中按学号规则提取年级、专业、班级，随机选一份并脱敏。但当前模板没有打开该弹窗的可见按钮，所以普通页面上不可达，只能由已有 JavaScript 函数或直接 API 调用。

#### 3.1.3 考试安排

- 默认读取 `user_data/{username}/exams.json`。
- 缓存为空时自动调用实时更新接口。
- 显示考试名、课程、时间、周次、星期、地点和座位号。
- 手动更新要求有效 URP 登录，爬取后覆盖考试缓存。

#### 3.1.4 成绩查询

页面提供六种入口：

1. 一键查最新学期：合并最新学期及格成绩、尚不及格、曾不及格。
2. 本学期成绩：调用 URP 本学期成绩页。
3. 按学期查询：先取学期列表，再查选择学期的及格成绩。
4. 不及格成绩：分“尚不及格”和“曾不及格”。
5. 学分绩点：显示学分绩点、学位绩点、加权学分学位绩点和学期明细。
6. 考试成绩：先列出考试学期和考试名称，再按 `jxzxjh + ksbh` 查询成绩。

成绩权限由后台 `grades_require_member` 控制：开启时要求初级会员，关闭时不要求会员；无论开关如何，都要求 URP 登录有效。

旧接口 `GET /api/grades` 仍注册，但服务层调用了不存在的 `URP_query.score_query()`。它会捕获异常并返回空数组，当前新版成绩页面也不再调用它。

#### 3.1.5 教学评估

- 查询当前未评课程和教师。
- 支持对全部待评课程一键评教。
- 爬虫先打开每门课程问卷，动态读取数字题目 ID 和选项，自动选择每题分值最高的选项，再提交问卷。
- 权限为初级会员，但装饰器只检查绑定和会员，不预先检查 URP 登录；Cookie 失效时通常会在爬取阶段失败。
- 若学校页面出现“非教学评估时期”或“评估时间已过”，返回空课程列表。

#### 3.1.6 系统公告

- 所有人（包括访客）可读取启用中的公告。
- 每个设备可将公告标记为已读，并设置“永不再显示”。
- 已读状态按 `device_id + announcement_id` 保存。
- 绑定用户启动后会自动弹出尚未读且未设置永久隐藏的公告；公告页可查看全部启用公告。

#### 3.1.7 找我做事

- 静态展示可承接的课程作业、Linux 实验、Office 操作、网课等服务和办理流程。
- 动态读取管理员设置的状态文案、是否接单和更新时间。
- 微信链接会尝试打开微信并复制微信号；QQ 按钮复制 QQ 号。

#### 3.1.8 反馈建议

- 已绑定用户可以提交反馈，选择“公开”或“仅自己可见”。
- 用户列表由“我的全部反馈”与“其他人的公开反馈”组成。
- 用户可以回复自己的反馈，也可回复其他人的公开反馈。
- 每条反馈显示按时间升序排列的回复；管理员回复使用用户名“管理员”。

#### 3.1.9 快捷指令 API

- 已绑定用户可查看是否已有 API 密钥及其前缀、创建时间。
- 初级会员可生成或轮换密钥；明文只在生成响应中出现一次，数据库仅保存 SHA-256 哈希和短前缀。
- API 密钥按学号绑定，不按设备绑定；旧设备解绑不会自动撤销密钥。
- 外部客户端用统一 `POST /api/shortcut/query` 查询历年课表、最新成绩汇总或紧急事项。
- 每次查询都检查密钥、会员、学号绑定记录和 URP 登录。

#### 3.1.10 会员购买、订单、邀请返佣与提现

- 初级会员：3 元/180 天；高级会员：5 元/180 天。
- 高级会员当前不增加额外查询功能，主要作为支持档位。
- 支持支付宝和微信支付。
- 5 分钟内同学号、同套餐的待支付订单会复用支付链接；超时后标记 `failed`。
- 支付成功后在当前未过期到期日基础上再增加 180 天；已有高级或新购高级时最终为高级。
- 页面展示近 20 条订单和仍有效的支付链接。
- 每个学号可生成固定邀请链接；邀请 token 在首次绑定时归因，同学号不能邀请自己，每个被邀请学号只能归属一个邀请人。
- 只有被邀请人第一次有效付费产生一次返佣，续费不重复返佣。
- 阶梯奖励按累计有效邀请数计算：0 人起每人 0.80 元；第 3 人起 1.00 元；第 10 人起 1.10 元；第 20 人起 1.20 元。达到新档位只影响当次及后续邀请，历史不补差。
- 当前还配置了 2026 年 9 月邀请 10 名有效付费用户奖励 3 元的限时任务。
- 用户可查看团队充值额、有效邀请数、收益明细、里程碑奖励、累计收益、已提现和可提现金额。
- 提现一次提取全部可用余额；同一时间最多一笔待审核提现；提交姓名和支付宝账号后由管理员审核。

#### 3.1.11 标题栏广告与广告详情

- 首页标题栏广告记录展示、进入详情、复制、关闭四类漏斗事件。
- “暂时关闭”保存到 `sessionStorage`，本会话可恢复；“本设备永不显示”保存到 `localStorage`。
- `/ad-detail?source=header` 会记录一次点击，并通过 302/前端 `replaceState` 清除来源参数，避免刷新重复计数。
- 广告详情有两个复制入口和移动端粘性按钮；复制微信时会把本地保存的已绑定学号随事件上报，用于统计去重复制用户。

### 3.2 对分易签到：代码存在但网页不可达

后端可以代理以下操作：账号密码登录、微信跳转链接登录、读取课程/运行状态、开始监控、停止监控和 SSE 日志流。开始监控时，白名单学号免费，其他学号要求有效会员。

但是当前 `index.html` 没有 `page-sign`、签到导航或 `sign-*` 元素，`loadPageData()` 也没有 `sign` 分支。因此 `main.js` 末尾的签到函数一旦直接执行，会访问不存在的 DOM；正常用户无法从网页使用。它只能被直接调用 API 的客户端使用，或者需要重新补齐页面后才能恢复网页功能。

### 3.3 管理员后台

管理员页面本身可公开打开，但所有管理 API 需要 `X-Admin-Key`、`Admin-Key` 或 `admin_key` 查询参数。前端把管理员密钥保存在 `sessionStorage.admin_key`。

后台包含：

- 用户统计：去重学号总数、按首次绑定日期的新增/累计趋势、按学号前 7 位聚合的班级分布。
- 广告统计：累计与今日展示/点击/复制/关闭、近 7 日点击、点击率、详情转化率、整体转化率、近 14 日趋势和复制过的学号列表。
- 在线监控：显示最近 5 分钟内发过 API 请求的设备、学号、最后活跃时间和最后接口。数据仅存在当前进程内，不写数据库，多进程之间不共享。
- 换绑审批：读取 `pending_requests` 并批准/拒绝。当前用户换绑接口已经改为立即解绑且不创建申请，因此这一页只对历史遗留或外部写入的申请有效。
- 公告管理：新增、编辑、启停、删除公告。
- 个人服务状态：设置 40 字以内状态和是否接单。
- 反馈管理：查看全部反馈/回复、管理员回复、删除反馈及其回复。
- 会员管理：按学号查询会员和近 5 条订单，手动授权指定类型/天数，撤销会员。
- 提现管理：查看待审核优先的提现列表，批准或拒绝，查看全站佣金与邀请统计。
- 系统配置：选择 SQLite/MySQL、测试并保存连接、SQLite 数据迁移到 MySQL、成绩是否需要会员、两条以上 URP 地址及当前地址、学期第一周星期一。
- 邀请调试接口：按邀请人或被邀请人补齐收益并返回邀请、订单、匹配关系、收益明细；这是运维诊断接口，前端没有入口。

## 4. 认证、会话和权限模型

### 4.1 设备身份

浏览器首次打开时生成 UUID，保存为 `localStorage.device_id`，之后所有用户业务请求使用 `X-Device-ID`。若客户端不发该头，后端回退为 `MD5(User-Agent + "_" + IP)`，这种回退身份会随网络或浏览器变化，也可能让同网络同 UA 用户发生碰撞。

### 4.2 五种权限检查

| 装饰器 | 检查内容 | 典型接口 |
|---|---|---|
| `require_admin` | 管理密钥完全匹配 | 所有 `/api/admin/*` |
| `require_bindding` | 设备已绑定用户，不检查 URP Cookie | 读缓存、会员、反馈、签到代理 |
| `require_login` | 已绑定 + URP 会话有效；失效时自动重登 | 实时更新课表/考试、历年课表 |
| `require_member(level)` | 已绑定 + 会员未过期 + 等级满足；不检查 URP 会话 | 评教、生成 API 密钥 |
| `require_grade_login(level)` | 已绑定 + 按配置决定会员 + URP 会话 | 全部新版成绩查询 |

另有 `require_member_login`，组合会员和 URP 登录，但当前没有路由使用。

`require_login` 与两个组合登录装饰器在被装饰函数抛出任意异常时，会清除 15 分钟登录缓存、重新校验登录并再次执行路由。这对查询类请求通常可接受，但如果以后用于有不可重复副作用的 POST，可能重复执行。

### 4.3 URP Cookie 生命周期

1. 用户提交学号、密码。
2. 若当前 URP 地址是 VPN 地址，先取得/恢复共享 `VSG_*` VPN Cookie。
3. 获取 URP 登录页和动态表单字段。
4. 最多 8 次下载验证码并用 ddddocr 识别。
5. POST 登录表单，识别到 URP 首页特征后判定成功。
6. 将完整 Cookie 保存到 `user_data/{username}/cookie.json`。
7. 非 VPN URL 的登录状态在进程内缓存 900 秒；VPN URL 为提高可恢复性不走这条短路缓存。
8. Cookie 失效时删除用户 Cookie 文件并使用数据库里的明文密码重登。
9. VPN Cookie 另存 `data/vpn_cookie.json`，后台线程每 300 秒探活；失败就清除，下一次请求在全局锁内重建。

## 5. 爬虫接口与返回值详解

### 5.1 爬虫公共行为

所有 URP 数据请求使用 `requests.Session`，从用户 Cookie 文件恢复登录态。HTTPS 证书校验统一关闭。若目标 URL 是内置 VPN 主机且响应被识别为 VPN 登录页、错误页、会话超时或维护页，`URP_query._request()` 会调用 `recover_vpn_session()`；后者在全局锁内恢复 VPN 会话，返回后 `_request()` 再把原请求重试一次；仍失败则抛出 `VPNUnavailableError`。

除实时页面返回外，当前课表和考试安排会写 JSON 文件；成绩、绩点、评教与历年课表不落业务缓存。

### 5.2 登录和 VPN 上游接口

| 阶段 | HTTP 请求 | 请求内容 | 成功判定/返回 |
|---|---|---|---|
| VPN 登录页 | `GET https://223.112.21.198:6443/vpn/theme/auth_home.html` | 设置 `VSG_VERIFYCODE_CONF` 等启动 Cookie | 为密码认证建立初始会话 |
| VPN 密码认证 | `POST .../vpn/user/auth/password` | `username`、`password` 做 Base64，`encode=1`；也支持配置完整 `vpn_auth_body` | HTTP 200 且响应含 `0x00000000` |
| VPN 门户 | `GET .../vpn/theme/portal_home.html` | 使用认证后的 Session | 保存所有 `VSG_*` 到共享 Cookie 文件 |
| VPN 探活 | `GET https://223.112.21.198:6443/7b68f983/` | `Referer` 指向门户 | 200、非 VPN 错误页，且内容像 URP 登录页或首页 |
| URP 登录页 | `GET {urp_base}/` | VPN 模式带门户 Referer | 动态解析 `form[name=loginForm]` action 和表单内全部 input，不限于 hidden 类型 |
| URP 验证码 | `GET {urp_base}/validateCodeAction.do?random={随机数}` | 同 Session | 必须是图片响应；OCR 后仅保留字母数字 |
| URP 登录提交 | `POST {动态 form action}` | 原隐藏字段 + `zjh` 学号 + `mm` 密码 + `v_yzm` 验证码 | 页面含 frameset 或“个人管理/课表/选课/信息查询/教学评价”等首页特征 |
| URP 状态检查 | `GET {urp_base}/menu/top.jsp` | 用户 Cookie | 页面包含当前学号则有效，否则自动重登 |

`URP_login.login()` 的规范返回是三元组：

```json
[true, "登录成功", {"cookie_name": "cookie_value"}]
```

失败时第一项为 `false`、第二项为可读错误、第三项为 `null`。

### 5.3 当前学期课表

- 上游接口：`GET {urp_base}/xkAction.do`
- Query：`actionType=6`、`yzxh={学号}`
- 解析：定位第一个含 `th.sortable` 的表格；利用 `rowspan` 继承课程号、课程名、学分、教师；从每行末 7 列读取周次、星期、开始节次、节数、校区、教学楼、教室。
- 周次解析：支持 `第1-16周`、`1,5-13周` 等区间与逗号组合。
- 落盘：`user_data/{username}/schedule.json`。
- 爬虫返回：以周数字字符串为键的对象。

```json
{
  "1": [
    {
      "课程号": "COURSE001",
      "课程名": "示例课程",
      "学分": "2.0",
      "教师": "张老师",
      "星期": "1",
      "节次": "1",
      "节数": "2",
      "校区": "主校区",
      "教学楼": "教学楼A",
      "教室": "101",
      "位置": "主校区教学楼A101"
    }
  ]
}
```

网站缓存读取接口再包一层：`{"week": null, "schedule": 上述对象, "semester_start": "YYYY-MM-DD"}`。传 `week=N` 时只返回指定周，不返回 `semester_start`。

### 5.4 历年课表

- 上游接口：`POST {urp_base}/lnkbcxAction.do`
- Form：`zxjxjhh={学期值}`；空字符串用于先读取学期列表。
- 未指定学期时：从 option 的值/文字中解析结束年份和上/下学期，选时间上最新的一项，再请求一次该学期。
- 解析：读取 `select[name=zxjxjhh] option`；优先在 `#dayin` 内寻找 9 个 `td.sortable` 表头的星期网格，避免误选课程明细表；把连续相同课程单节合并为多节。
- 不写当前课表缓存。
- 返回：

```json
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
```

历年网格页面只提供“课程名_课序(位置)”一类文本，所以课程号、学分、教师、教学楼、教室字段无法从该页面得到，代码用空字符串占位。

### 5.5 考试安排

- 上游接口：`GET {urp_base}/ksApCxAction.do`
- Query：`oper=getKsapXx`、`yzxh={学号}`
- 解析：寻找表头包含“考试名”的表格，读取 `tr.odd`。
- 落盘：`user_data/{username}/exams.json`。
- 爬虫返回：按考试周次分组。

```json
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
```

缓存读取 API 会把它扁平化为数组，并改为英文键：`exam_name`、`course`、`time`、`week`、`day`、`location`、`seat`。

### 5.6 成绩总览与学期成绩

- 总览上游接口：`GET {urp_base}/gradeLnAllAction.do?type=ln&oper=qbinfo&`
- 学期列表：读取所有带 `name` 且文字含“学年”或“学期”的 `<a>` 锚点，返回字符串数组。
- 指定学期及格成绩：找到 `<a name="{semester}">`，扫描到下一个学期锚点前的 `table.displayTag#user`，每行取第 3 列课程名和第 8 列成绩。
- 爬虫返回：

```json
[
  {"课程名": "高等数学", "成绩": "88"}
]
```

服务层统一转换为 `[{"course":"高等数学","score":"88"}]`。

### 5.7 本学期成绩

- 上游接口：`GET {urp_base}/bxqcjcxAction.do`
- Query：`mytype=bxqcj`、`yzxh={学号}`
- 若页面含 `td.errorTop`，抛出“本学期成绩查询未打开”。
- 读取 `tr.odd` 第 3、8 列。
- 返回结构与上节成绩数组相同。

### 5.8 不及格成绩

- 上游接口：`GET {urp_base}/gradeLnAllAction.do`
- Query：`type=ln`、`oper=bjg`、`yzxh={学号}`
- 第一个 `table.displayTag` 解释为尚不及格，第二个解释为曾不及格。
- 每行返回课程名、成绩、学分、考试时间。

```json
{
  "current": [
    {"课程名": "课程A", "成绩": "50", "学分": "2", "考试时间": "2026-01-10"}
  ],
  "past": []
}
```

服务层把中文键改为 `course`、`score`、`credit`、`exam_time`。

### 5.9 绩点

- 上游接口：`GET {urp_base}/gradeLnAllAction.do?oper=queryXfjd`
- 以 GB18030 解析响应。
- 三个 `style="width: 60px;"` 的 input 依次解释为学分绩点、学位绩点、加权学分学位绩点。
- 再寻找表头严格为“学年学期、学分绩点、学位绩点、加权学分学位绩点”的明细表。
- 返回：

```json
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
```

### 5.10 考试场次与考试成绩

场次列表：

- 上游：`GET {urp_base}/cjSearchAction.do?oper=getKscjList&yzxh={学号}`。
- 学期：读取 `select[name=jxzxjh] option`，返回 `{value,text}`。
- 考试名称：从页面 JavaScript 的 `new Array("名称","ksbh","jxzxjh")` 正则提取。
- 返回：`{"semesters":[...],"exams":[{"name","ksbh","jxzxjh"}]}`。

指定考试成绩：

- 上游：`POST {urp_base}/cjSearchAction.do?oper=tjcx`。
- Form：`jxzxjh`、`ksbh`、`yzxh`。
- 读取 `tr.odd` 第 3、5、6 列。
- 爬虫返回 `[{"课程名","学分","成绩"}]`，服务层改为 `[{"course","credit","score"}]`。

### 5.11 评教

待评课程：

- 上游：代码先构造 `GET {urp_base}/jxpgXsAction.do?oper=listWj&yzxh={学号}`，调用 `_request()` 时又传入同名 `params={oper:listWj,yzxh:学号}`；requests 最终通常会让 URL 中出现两组重复 query 参数。这是当前源码的实际行为，不是报告笔误。
- 找到第 4 列为“否”的行，从该行图片 `name` 属性按 `#@` 切分。
- 返回：

```json
[
  {
    "未评课程": "示例课程",
    "教师": "张老师",
    "wjbm": "问卷编码",
    "bpr": "被评人编码",
    "pgnr": "评估内容编码",
    "oper": "wjShow"
  }
]
```

提交评教：

1. 对每门课程 `POST {urp_base}/jxpgXsAction.do`，Form 为 `wjbm`、`bpr`、`pgnr`、`oper=wjShow`。
2. 扫描问卷内所有数字 name 的 radio/checkbox，以 value 下划线前的数值为分数，选择每题最高分选项。
3. 加入固定字段 `xumanyzg=zg`、`wjbz=''`、`zgpj=''`。
4. `POST {urp_base}/jxpgXsAction.do?oper=wjpg` 提交。
5. 每份响应都含“评估成功”才返回 `[true,"评价成功"]`，否则立即返回失败。

### 5.12 紧急事项不是实时爬虫

`get_urgent_event()` 不访问学校系统，而是读取课表和考试 JSON 缓存，结合当前时间计算：

```json
{
  "current": {
    "type": "class",
    "title": "课程名",
    "location": "地点",
    "time": "08:20-10:00",
    "remaining": 35
  },
  "next": {
    "type": "class 或 exam",
    "title": "课程/考试名",
    "location": "地点",
    "time": "YYYY-MM-DD HH:mm 或 YYYY-MM-DD HH:mm-HH:mm",
    "countdown": 120,
    "seat": "考试时可有"
  },
  "is_freshman": false
}
```

接口响应再包装为 `{"success":true,"event":上述对象}`。读取之前会后台尝试启动每日自动爬取，但当前请求不会等待该后台任务完成；后台任务也可能因登录、Cookie、网络或学校页面结构问题失败，失败结果不会反馈给这次紧急事项请求。因此本次响应可能仍展示旧缓存或空数据，不能理解为“每日首次访问必定更新成功”。

## 6. 面向前端和外部客户端的 API 清单

约定：`绑定`表示需要 `X-Device-ID` 对应用户；`登录`表示还要 URP Cookie 可用；`会员`表示有效 basic 或 advanced；`管理员`表示管理密钥。多数业务校验失败仍返回 HTTP 200，只靠 JSON 的 `success=false` 判断；显式参数错误、管理员拒绝或代理失败才较常使用 400/403/502。

### 6.1 页面、认证与广告

| 方法与路径 | 权限 | 请求 | 成功返回 |
|---|---|---|---|
| `GET /` | 无 | 只允许 `page`、`invite` 查询参数 | 用户 SPA HTML；未知参数会 302 清理 |
| `GET /ad-detail` | 无 | `source=header` 可选 | 广告详情 HTML，并记录点击 |
| `GET /admin` | 无 | 无 | 管理后台 HTML |
| `GET /favicon.ico` | 无 | 无 | 204 |
| `POST /api/ad/event` | 无 | JSON `event=impression/click/copy/dismiss`；copy 可带 `username` | 204；无效事件 400 |
| `GET /api/check_bind` | 设备 | Header | `bound`、可选 `username`、可选 `rebind_notifications` |
| `POST /api/login` | 设备 | JSON `username,password,invitation_token?` | `success,message,username`；登录成功即绑定 |
| `POST /api/request_rebind` | 已绑定 | 空 JSON | 立即删除当前设备绑定 |
| `GET /api/check_login_status` | 设备 | Header | `logged_in,username?,message`，必要时重登 |
| `POST /api/rebind_notified` | 设备 | JSON `request_ids[]` | 标记历史换绑通知已读 |

### 6.2 教务数据

| 方法与路径 | 权限 | 请求 | 成功返回 |
|---|---|---|---|
| `GET /api/urgent_event` | 绑定 | 无 | `event={current,next,is_freshman}` |
| `GET /api/schedule` | 绑定 | Query `week?` | `data={week,schedule,message?,semester_start?}` |
| `POST /api/update_schedule` | 登录 | 无 | `message`、`data={周:[课程]}` |
| `GET /api/historical_schedule` | 登录 | Query `semester?` | `data={semester,semesters,courses}` |
| `GET /api/exams` | 绑定 | 无 | `exams=[扁平考试]` |
| `POST /api/update_exams` | 登录 | 无 | `message`、`data={周:[考试]}` |
| `GET /api/grades` | 成绩权限 | 无 | 旧接口；当前实际总是返回 `grades=[]` |
| `GET /api/grades/current` | 成绩权限 | 无 | `grades=[{course,score}]` |
| `GET /api/grades/latest_summary` | 成绩权限 | 无 | `semester,passed,failed.current,failed.past` |
| `GET /api/grades/semesters` | 成绩权限 | 无 | `semesters=[字符串]` |
| `GET /api/grades/by_semester` | 成绩权限 | Query `semester` | `grades`、`semester` |
| `GET /api/grades/failed` | 成绩权限 | 无 | `current`、`past` |
| `GET /api/grades/gpa` | 成绩权限 | 无 | `gpa={中文绩点字段}` |
| `GET /api/grades/exam_sessions` | 成绩权限 | 无 | 顶层 `semesters`、`exams` |
| `GET /api/grades/exam_scores` | 成绩权限 | Query `jxzxjh,ksbh` | `grades=[{course,credit,score}]` |
| `GET /api/schedule/other_majors` | 绑定 | 无 | `data={年级:{专业:[班级]}}` |
| `GET /api/schedule/other_major` | 绑定 | Query `grade,major,class_num` | `data={grade,major,class_num,schedule,semester_start}` |
| `GET /api/unevaluated_courses` | 会员 | 无 | `has_courses,courses,message?` |
| `POST /api/evaluation` | 会员 | JSON `courses[]` | `success,message` |

### 6.3 快捷指令 API

| 方法与路径 | 权限 | 请求 | 成功返回 |
|---|---|---|---|
| `GET /api/member/api-key` | 绑定 | Header | `data={has_key,key_prefix,create_time}` |
| `POST /api/member/api-key` | 会员 | Header | `data={key,key_prefix,create_time}`，明文 key 仅此次返回 |
| `POST /api/shortcut/query` | API key + 会员 + 登录 | JSON `key,action,params` | `success,action,message,data` |

快捷指令支持的 action：

- `historical_schedule`：`params.semester` 可选；返回 `student_id,semester,semester_name,course_count,courses[]`，课程使用 `course_name,weekday,weekday_name,start_section,section_count,section_name,location,class_no`。
- `grades`：返回 `student_id,semester,passed_count,failed_current_count,failed_past_count,passed,failed_current,failed_past`。
- `urgent_event`：返回 `student_id,has_event,event`；这里只选择服务层结果的 `next`，不会返回正在进行课程。

失败结构固定为：

```json
{
  "success": false,
  "action": "grades",
  "error_code": "invalid_request | invalid_action | invalid_key | member_required | login_required | invalid_params | query_failed",
  "message": "说明",
  "data": null
}
```

### 6.4 公告、服务状态与反馈

| 方法与路径 | 权限 | 请求 | 成功返回 |
|---|---|---|---|
| `GET /api/service-status` | 无 | 无 | `data={status_text,accepting_orders,updated_at}` |
| `GET /api/announcements` | 设备 | 无 | `announcements=[{id,title,content,create_time,is_read,never_show}]` |
| `POST /api/announcements/{id}/read` | 设备 | JSON `never_show?` | 已读确认 |
| `GET /api/feedback` | 绑定 | 无 | `my_feedbacks`、`public_feedbacks`，每条含 `replies` |
| `POST /api/feedback` | 绑定 | JSON `content,visibility=self/public` | 提交确认 |
| `POST /api/feedback/{id}/reply` | 绑定 | JSON `content` | 回复确认 |

### 6.5 会员、支付、邀请和提现

| 方法与路径 | 权限 | 请求 | 成功返回 |
|---|---|---|---|
| `GET /api/member/status` | 绑定 | 无 | `data={is_member,member_type,expire_time,is_expired?}` |
| `POST /api/member/create_order` | 绑定 | JSON `member_type=basic/advanced,pay_type=alipay/wechat` | `data={order_no,pay_url,existing?}` |
| `GET/POST /api/member/pay_notify` | 支付平台签名 | query/form `state,orderNo,amount,sign` | 文本 `success` 或 `fail` |
| `GET/POST /api/member/pay_return` | 无 | 无 | 关闭窗口并发送 `pay_done` 的 HTML script |
| `GET /api/member/orders` | 绑定 | 无 | 近 20 条订单；有效待支付项附 `active_pay_url,expire_seconds` |
| `GET /api/invitation/my_inviter` | 绑定 | 无 | `data.inviter` 或 `null` |
| `GET /api/invitation/link` | 绑定 | 无 | `data={has_link,invite_url,created?}` |
| `POST /api/invitation/link` | 绑定 | 无 | 创建或复用固定链接 |
| `GET /api/invitation/earnings` | 绑定 | 无 | 邀请进度、阶梯、任务、收益、余额和明细 |
| `POST /api/invitation/withdraw` | 绑定 | JSON `real_name,alipay_account` | 提交全额提现 |
| `GET /api/invitation/withdrawals` | 绑定 | 无 | `data=[{amount,status,create_time,review_time}]` |

支付平台上游调用是 `POST https://zfapi.nnt.ltd/api/startOrder`，表单含商户号、订单号、金额、异步通知 URL、返回 URL、支付类型和 MD5 签名；期望 JSON 的 `success=true` 且 `data.payUrl` 存在。

### 6.6 对分易签到代理

所有请求代理到配置常量 `DUIFENE_BASE_URL`；上游响应 JSON 和状态码基本原样返回，错误时用 HTTP 502 和 `{"success":false,"msg":"..."}`。

| 本站接口 | 上游接口 | 本站注入/转发 | 权限 |
|---|---|---|---|
| `POST /api/sign/login` | `POST /login` | 原 JSON + `urp_username=绑定学号` | 绑定 |
| `POST /api/sign/login_link` | `POST /login_link` | 原 JSON | 绑定 |
| `GET /api/sign/status` | `GET /api/user_status` | Query `username=绑定学号` | 绑定 |
| `POST /api/sign/start` | `POST /api/user_start` | 原 JSON + `username=绑定学号` | 白名单或会员 |
| `POST /api/sign/stop` | `POST /api/user_stop` | JSON `username` | 绑定 |
| `GET /api/sign/stream` | `GET /api/user_stream` | Query `username`，流式转发 | 绑定 |

前端预期登录/状态响应含 `success`、`classes[]`、可选 `running`；每个 class 至少含 `CourseID,TClassID,CourseName,ClassName`。开始监控请求包含 `course_id,class_id,seconds,duration,notify_email`。SSE 每行格式是 `data: {"msg":"日志"}`。

### 6.7 管理 API

下列接口全部需要管理员密钥：

| 方法与路径 | 请求 | 主要返回/效果 |
|---|---|---|
| `GET /api/admin/users` | 无 | `total,classes[],daily[]` |
| `GET /api/admin/ad_stats` | 无 | 广告漏斗累计、今日、比率、日趋势和复制学号 |
| `GET /api/admin/monitor/online` | 无 | `data={online_count,users[]}` |
| `GET /api/admin/pending_requests` | 无 | 待审批换绑 `requests[]` |
| `POST /api/admin/approve_rebind` | `request_id,approved` | 更新申请状态；批准时解绑设备 |
| `GET /api/admin/invitation_debug` | Query `invitee` 或 `inviter` | 邀请归因、订单、收益诊断数据 |
| `GET /api/admin/config` | 无 | 完整运行配置 |
| `POST /api/admin/config/database` | SQLite 或 MySQL 配置 | 测试、初始化并保存配置 |
| `POST /api/admin/config/database/migrate_sqlite` | `sqlite_path?` | 逐表导入数量/错误 |
| `POST /api/admin/config/grades_member` | `grades_require_member` | 保存成绩会员开关 |
| `POST /api/admin/config/url` | `urls[]` 或 `url_index` | 保存 URL 列表或切换当前项 |
| `POST /api/admin/semester` | `semester_start=YYYY-MM-DD` | 必须为星期一，保存学期第一周 |
| `GET /api/admin/members` | Query `username` | 用户存在性、会员、近 5 条订单 |
| `POST /api/admin/members/grant` | `username,member_type,days` | 覆盖写入新的会员到期日 |
| `POST /api/admin/members/revoke` | `username` | 删除会员 |
| `GET /api/admin/withdrawals` | 无 | 提现列表及每人收益/占用/余额 |
| `POST /api/admin/withdrawals/{id}/approve` | 无 | 状态改为 approved |
| `POST /api/admin/withdrawals/{id}/reject` | 无 | 状态改为 rejected |
| `GET /api/admin/commission_stats` | 无 | 全站邀请人统计和汇总 |
| `GET /api/admin/service-status` | 无 | 当前个人服务状态 |
| `PUT /api/admin/service-status` | `status_text,accepting_orders` | 保存状态 |
| `GET /api/admin/announcements` | 无 | 全部公告含停用项 |
| `POST /api/admin/announcements` | `title,content` | 新建启用公告 |
| `PUT /api/admin/announcements/{id}` | `title,content,is_active` | 修改公告 |
| `DELETE /api/admin/announcements/{id}` | 无 | 删除公告 |
| `GET /api/admin/feedback` | 无 | 全部反馈及回复 |
| `POST /api/admin/feedback/{id}/reply` | `content` | 管理员回复 |
| `DELETE /api/admin/feedback/{id}` | 无 | 删除反馈和回复 |

## 7. 前后端交互逻辑

### 7.1 首次打开与绑定恢复

```text
浏览器打开 /
  → 生成/读取 localStorage.device_id
  → 初始化广告并上报 impression
  → 保存 URL 中的 invite token 到 sessionStorage
  → 清理支付平台添加的未知查询参数
  → GET /api/check_bind + X-Device-ID
      ├─ 已绑定：保存 currentUsername → 同步自己的邀请链接到 URL
      │          → 恢复 URL page 或 localStorage.current_page
      │          → 加载页面数据 + 未读公告
      └─ 未绑定：打开不可通过遮罩关闭的登录弹窗
                 ├─ 提交学号/密码/token → POST /api/login
                 └─ 访客跳过 → 仅开放非教务页面
```

绑定成功后后端保存设备、学号、明文密码和绑定时间；如果 token 合法，则同一数据库事务中建立邀请关系并补算可能已经存在的首付返佣。

### 7.2 页面导航与访客门禁

点击侧边栏项只切换 DOM 中 `.page.active`，不会整页跳转；页面名保存到 `localStorage.current_page`。教务类页面 `schedule/exams/grades/evaluation/shortcut-api` 在访客模式下显示绑定门禁，不清空页面主体。公告、找我做事和会员页可被访客打开，但其中需要绑定的 API 会返回错误；反馈必须绑定。

每个页面首次或再次切换时调用对应加载函数，而不是使用统一数据层：

| 页面 | 前端加载函数 | 主要 API |
|---|---|---|
| 首页 | `loadUrgentEvent` | `/api/urgent_event`、后台 `/api/check_login_status` |
| 课表 | `loadSchedule` | `/api/schedule`；无缓存自动 `/api/update_schedule` |
| 考试 | `loadExams` | `/api/exams`；无缓存自动 `/api/update_exams` |
| 成绩 | `loadGrades` | 只重置菜单；用户选择后调用具体 `/api/grades/*` |
| 评教 | 无自动查询 | 按钮调用 `/api/unevaluated_courses`、`/api/evaluation` |
| 公告 | `loadAnnouncementsList` | `/api/announcements` |
| 找我做事 | `loadServiceStatus` | `/api/service-status` |
| 反馈 | `loadFeedbackPage` | `/api/feedback` |
| 快捷指令 | `loadShortcutApiPage` | `/api/member/status`、`/api/member/api-key` |
| 会员 | `loadMemberPage` | 会员状态、邀请链接/收益、订单 |

### 7.3 课表和考试的“缓存优先、缺失再爬取”

课表前端先 GET 缓存；只要返回的 `schedule` 非空，就存在浏览器变量 `cachedSchedule` 中，切周不再访问后端。缓存为空时自动 POST 更新，再递归 GET 一次。手动更新成功会清浏览器缓存并重新加载。

考试也先读缓存；空数组时自动 POST 更新一次。两者的实时更新都经过 `require_login`，必要时会自动重登。

首页不同：先立即读取现有缓存计算紧急事项，同时只启动后台线程更新，不等待。因此它偏向低延迟和最终一致，而不是保证本次就是最新数据。

### 7.4 成绩交互

成绩页进入时不自动爬取。点击功能卡后才请求对应接口。所有接口的权限装饰器先按当前配置检查会员，再检查/恢复 URP 登录。按学期和考试成绩是两步交互：先取选择项，再带选中 ID 发第二个 GET。HTML 由前端拼接并对成绩数据做转义。

### 7.5 评教交互

“刷新查询”只取得课程列表并保存到前端变量；“一键评教”会先查询，再弹确认框，然后把服务端返回的完整课程元数据原样 POST 回 `/api/evaluation`。后端据此逐门打开并提交问卷。成功后前端再次刷新待评列表。

### 7.6 支付闭环

```text
选择套餐和支付方式
  → POST /api/member/create_order
  → 后端签名请求第三方 startOrder
  → 订单 pending 写数据库，返回 pay_url
  → 浏览器跳转第三方支付
  → 第三方 GET/POST /api/member/pay_notify
  → 后端验签、订单 paid、会员新增/续期、邀请收益幂等补齐
  → returnUrl 回到 /?page=member
  → 首页只保留 page/invite 参数，会员页重新拉取状态和订单
```

`pay_return` 还支持弹窗模式的 `postMessage("pay_done")`，但当前前端实际使用 `window.location.href=payUrl` 整页跳转。

### 7.7 邀请链接闭环

邀请人进入已绑定页面后，前端 POST 获取/创建自己的固定邀请链接并把 token 写入当前 URL。被邀请人打开链接时，token 暂存于 `sessionStorage.pending_invitation_token`；首次成功绑定时随 `/api/login` 发送。登录成功后清除待归因 token，再把当前账号自己的 token 写回 URL，避免把自己的链接误用于下一次绑定。

### 7.8 管理后台交互

后台打开后先显示密钥登录框；前端以试请求 `/api/admin/pending_requests` 验证密钥。成功后把密钥放入本标签页的 sessionStorage。切换标签页时按需请求相应 API；在线监控标签启动定时刷新，离开后停止。配置更新、公告、反馈、会员、提现均直接调用 REST 风格 API 并在前端显示 Toast。

### 7.9 全局响应与异常

- 普通 API 主要使用 `{"success":bool,"message":str,...}`；签到代理主要使用上游的 `msg`。
- Flask 捕获 `/api/*` 的未处理异常并 JSON 化；HTTPException 保留状态码，普通异常返回 500。
- 非 API 未处理异常会继续抛出，由 Flask 调试/生产错误页处理。
- `after_request` 对带设备头的非监控 API 更新在线状态；不写 `request_logs`。

## 8. 数据库与文件数据

### 8.1 数据库表

| 表 | 用途 | 关键约束 |
|---|---|---|
| `users` | 设备绑定和 URP 凭据 | `device_id` 主键；同学号可有多个设备记录 |
| `pending_requests` | 历史换绑审批 | `request_id` 主键；当前正常流程不再写入 |
| `announcements` | 公告 | 自增 ID、启停标记 |
| `user_read_announcements` | 每设备公告已读 | `(device_id,announcement_id)` 联合主键 |
| `feedbacks` | 反馈主题 | 可见性 self/public |
| `feedback_replies` | 用户/管理员回复 | 通过 `feedback_id` 关联，但无数据库外键 |
| `request_logs` | 历史请求日志 | 当前运行时不写 |
| `ad_click_stats` | 每日广告漏斗聚合 | `(ad_key,click_date)` 主键 |
| `ad_copy_users` | 复制广告联系方式的去重学号 | `(ad_key,username)` 主键 |
| `memberships` | 会员 | `username` 主键 |
| `orders` | 支付订单 | `order_no` 主键 |
| `invitation_links` | 每学号固定 token | `username` 主键，token 唯一 |
| `invitations` | 邀请归因 | `invitee_username` 唯一 |
| `invitation_reward_claims` | 每被邀请人一次性领奖占位 | `(username,invitee_username)` 唯一 |
| `invitation_earnings` | 首次付费返佣明细 | `(username,order_no)` 唯一索引 |
| `invitation_milestone_rewards` | 限时任务奖励 | `(username,milestone_id)` 唯一 |
| `withdrawals` | 提现申请 | pending/approved/rejected |
| `api_keys` | 快捷指令密钥 | 学号主键，完整哈希唯一 |
| `admin_service_status` | 管理员个人状态 | 固定 ID=1 |

SQLite 和 MySQL/MariaDB 使用等价表结构。`MySQLConnectionAdapter` 将 `?` 占位符替换为 `%s`，将 SQLite 的 `INSERT OR REPLACE/IGNORE` 改为 MySQL 语法。初始化会容错执行新增列迁移，并删除已经下线的 `surveys` 表。

SQLite→MySQL 迁移按固定白名单表与目标字段逐表 `REPLACE`，返回每表导入行数或失败文字；不会删除 SQLite 源数据。

### 8.2 文件存储

| 路径 | 内容 |
|---|---|
| `data/config.json` | URP 地址、当前索引、学期日期、服务 URL、VPN 认证体、成绩会员开关、数据库配置 |
| `data/vpn_cookie.json` | 共享 `VSG_*` VPN Cookie 和更新时间 |
| `user_data/{username}/cookie.json` | 用户 URP/VPN Cookie |
| `user_data/{username}/schedule.json` | 当前课表，按周分组 |
| `user_data/{username}/exams.json` | 考试安排，按考试周次分组 |
| `data/pay_notify_errors.log` | 支付通知异常堆栈 |

## 9. 已确认的问题与风险

以下是阅读当前实现后能直接确认的问题，按影响排序。

### 9.1 高风险安全问题

1. `constants.py` 硬编码支付商户号和支付密钥，`config_service.py` 硬编码管理员密钥，`app.py` 硬编码 Flask secret。代码泄露即凭据泄露。
2. `users.password` 明文保存 URP 密码；Cookie 与 VPN 认证体也以明文 JSON 保存。
3. 所有学校/VPN爬取请求关闭 TLS 证书验证，容易受到中间人攻击。
4. `app.run(debug=True, ...)` 把 `debug` 固定为真；即使 `FLASK_DEBUG` 为假，也仍启动 Flask 调试模式，只是 reloader 开关不同。
5. 管理员配置 GET 返回完整配置，可能包含 MySQL 密码和 VPN 认证体；一旦硬编码管理员密钥泄露，敏感配置也会泄露。
6. 签到代理使用全局单一 `requests.Session` 服务所有用户，上游登录 Cookie 可能在不同用户之间串号。注释所说“按 device_id 维护 Session 池”与当前实现不符。

### 9.2 明确的功能缺陷或失联代码

1. `get_grades()` 调用不存在的 `URP_query.score_query()`，旧 `/api/grades` 实际只返回空数组。
2. 签到前端函数仍在，但模板和导航已经移除，网页无法使用。
3. 其它专业课表弹窗和函数存在，但当前课程表页面没有可见入口。
4. 用户换绑已改成即时解绑，不会创建 `pending_requests`；管理员审批功能与通知功能成为历史遗留路径。
5. `request_logs` 表和索引仍存在，但运行时日志服务只维护内存在线状态。
6. 当前配置关闭成绩会员限制，而页面套餐文案仍把成绩查询作为初级会员示例，产品展示可能与实际权限不一致。

### 9.3 一致性和可靠性问题

1. API 失败状态码不统一：大量业务失败返回 HTTP 200，签到代理又用 502；客户端必须同时检查 HTTP 和 `success`。
2. `message` 与 `msg` 两套错误字段并存。
3. 部分服务层捕获爬取异常后返回空数组/空对象，路由仍返回 `success=true`，会把“学校接口失败”和“确实没有数据”混为一谈。明确受影响的入口包括旧 `/api/grades`、学期列表、按学期成绩、绩点、考试场次、指定考试成绩；`get_unevaluated_courses()` 还会把异常变成 `None`，路由再将其表现为 `success=true,has_courses=false`。本学期成绩、不及格和最新学期汇总通常会把异常交给路由包装为 `success=false`。
4. 支付回调按回调里的 `amount` 参与验签，但没有显式比较它是否等于数据库订单金额。
5. 提现批准/拒绝不检查记录是否存在、是否仍为 pending，重复操作也返回成功。
6. 管理员手动授权的 `days` 未限制范围，非整数会落入全局 500。
7. 评教权限不检查 URP 登录，Cookie 过期时用户得到的是爬虫层失败，而不是明确重新登录提示。
8. 用户名直接参与 `user_data/{username}` 路径拼接，没有应用层路径字符校验；当前依赖学校认证隐式保证学号格式。
9. 内存登录缓存、自动更新锁和在线状态只在单进程内有效；多 worker 或多服务器部署不共享。
10. 数据库表没有声明外键，删除主记录不会由数据库自动清理关联数据。
11. `Host`、`Origin`、`Referer` 的部分评教请求头直接使用完整 URL，`Host` 按 HTTP 规范应是主机名；学校服务器宽容时能工作，但兼容性较弱。
12. 模板初始作息与 JavaScript/后端默认作息有几分钟差异；紧急事项成功加载后 JS 会覆盖，但加载前短暂显示可能不一致。
13. URL 拼接方式不统一：登录和历年课表会主动处理末尾 `/`，多数其它查询使用 `f'{self.url}xxxAction.do'`，隐含要求配置的 URP URL 自带末尾斜杠；缺少斜杠时可能拼成无效地址。

## 10. 测试与当前验证结果

本次没有修改业务代码，只对当前工作树运行现有测试。

- Python：发现并运行 140 个 `unittest` 测试，138 通过，1 失败，1 错误。
  - 错误：课表模板测试精确查找 `/static/js/main.js`，而模板当前使用带缓存版本参数的 `/static/js/main.js?v=11`。
  - 失败：服务状态页面文案断言出现编码不一致，测试期望值与当前模板提取结果均显示乱码但内容不同。
- JavaScript：逐个运行 8 个 `.js` 测试文件，共 39 个测试全部通过。

这说明邀请链接、快捷指令、广告统计、数据库初始化、VPN 恢复、历史课表、移动端交互等主要新增逻辑已有较多回归测试；但爬虫真实学校页面依赖外部网络和 HTML 结构，测试主要是模拟/契约验证，不能证明真实学校接口此刻可用。

## 11. 建议的整改优先级

### P0：上线前必须处理

- 把管理员密钥、Flask secret、支付密钥、VPN 凭据迁移到环境变量或专用密钥存储，并立即轮换已经写入仓库的值。
- 关闭生产调试模式。
- 加密或避免长期保存 URP 明文密码；至少严格限制数据目录权限。
- 修复签到代理的跨用户 Session 隔离，或在修复前禁用相关 API。
- 恢复 TLS 校验；若学校确实使用私有证书，配置受信 CA，而不是全局 `verify=False`。

### P1：影响功能正确性

- 删除或修复旧 `/api/grades`，避免“成功但空数据”。
- 决定是否正式恢复签到和其它专业课表入口；若不恢复，删除孤立前端代码和接口，减少误用面。
- 清理换绑审批遗留，或恢复真正的申请→审批流程，避免后台展示不存在的业务。
- 统一爬取失败和空数据的语义、HTTP 状态码及 `message` 字段。
- 校验支付回调订单号、金额、状态与签名的完整一致性。

### P2：可维护性

- 将 3700 多行 `main.js` 和 1700 多行 `admin.js` 按页面/业务模块拆分。
- 为所有公共 API 建立 OpenAPI 文档和响应 schema。
- 为 URP HTML 解析器保存脱敏 fixture，补足课表、考试、成绩、绩点、评教的结构回归测试。
- 将登录缓存、自动更新任务和在线状态迁到 Redis 等共享存储，以支持多进程/多服务器一致性。
- 删除 `request_logs`、`pending_requests` 等确认不再使用的结构，或恢复其业务写入方。

## 12. 总体评价

项目已经形成较完整的教务辅助产品：用户绑定、缓存优先的数据展示、实时爬取、成绩细分查询、自动评教、会员支付、邀请返佣、快捷指令和后台运营能力都已经连成业务闭环。近期代码对 VPN 会话恢复、历年课表、邀请幂等、数据库切换、移动端体验和广告漏斗做了明显增强。

目前最大的短板不是功能数量，而是安全边界和历史代码收口：硬编码密钥、明文凭据、关闭证书校验、生产 debug、全局签到 Session 都属于高优先级风险；签到/换绑/旧成绩接口的“代码存在但当前流程失联”也会显著增加维护误判。建议先完成 P0 与 P1，再继续扩展新功能。


## 13. 爬虫完整源码附录

本节把“从浏览器 API 入口到 URP/VPN 请求、HTML 解析、缓存与返回值转换”的代码按当前工作树原样收录。每段附带 SHA-256，后续源码变化时可以判断报告是否过期。

收录范围共有 11 个文件、2,983 行：

| 顺序 | 文件 | 在爬虫链路中的角色 |
|---|---|---|
| 1 | `URP.py` | 兼容导出入口 |
| 2 | `urp/login.py` | VPN 与 URP 登录、验证码、Cookie 恢复 |
| 3 | `urp/query.py` | 成绩、评教、历年课表与考试爬虫 |
| 4 | `urp/schedule_legacy.py` | 当前课表爬虫与缓存 |
| 5 | `services/urp_service.py` | 爬虫业务编排、缓存读取、自动更新与返回值转换 |
| 6 | `routes/auth_routes.py` | 登录与会话 HTTP 入口 |
| 7 | `routes/data_routes.py` | 教务数据 HTTP 入口 |
| 8 | `services/shortcut_service.py` | 快捷指令的直接爬取与返回值规范化 |
| 9 | `routes/shortcut_routes.py` | 快捷指令 HTTP 入口、鉴权与错误结构 |
| 10 | `auth.py` | 调用爬虫前的绑定、会员和 URP 登录权限链 |
| 11 | `urp/__init__.py` | `urp` 包级兼容导出入口 |

范围说明：

- “爬虫代码”定义为直接登录 VPN/URP、请求和解析学校页面，或负责调用、鉴权、缓存、规范化与返回这些数据的代码。
- `services/config_service.py` 仅负责通用配置读取，且含硬编码管理员凭据，因此不复制到报告；本报告只说明其 `get_current_urp_url()` 依赖，不再次扩散密钥。
- `routes/sign_routes.py` 是对第三方签到服务的透明代理，不解析学校 HTML，不属于这套 URP 信息爬虫；其所有接口已在第 6.6 节展示。
- `routes/member_routes.py` 的支付 HTTP 请求属于支付集成，不是信息爬虫。
- 以下代码来自本地源文件，不包含 `data/config.json`、用户 Cookie、账号密码、数据库记录或运行时环境变量值。

### 13.1 完整调用链

```text
浏览器 / Apple 快捷指令
  → routes/auth_routes.py / routes/data_routes.py / routes/shortcut_routes.py
  → auth.py 权限装饰器
  → services/urp_service.py / services/shortcut_service.py
  → URP.py / urp/__init__.py 兼容导出
  → urp/login.py 建立和恢复 VPN + URP Session
  → urp/query.py 发起数据请求并解析 HTML
      └─ 当前课表委托 urp/schedule_legacy.py
  → user_data/{username}/*.json（Cookie、当前课表、考试）
  → Flask jsonify 返回前端
```

### 13.2 `URP.py`：兼容导出入口

- 当前快照 SHA-256：`726e7cc8ad1d3e161b01aec207d2bf3362d2e7e4e6e6c9c766ff67d632edb0e9`
- 下列内容为该文件完整源码。

```python
# 兼容入口：保持 `from URP import URP_login, URP_query` 不变
from urp.login import URP_login
from urp.query import URP_query

__all__ = ["URP_login", "URP_query"]
```

### 13.3 `urp/login.py`：VPN 与 URP 登录、验证码、Cookie 恢复

- 当前快照 SHA-256：`f91d771d986715534621977db28f772c149b9850145f747c9b5fc9b65251df02`
- 下列内容为该文件完整源码。

```python
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
```

### 13.4 `urp/query.py`：成绩、评教、历年课表与考试爬虫

- 当前快照 SHA-256：`629fe87a408cc2d1119e71688843618ad167c281c362da4106cd8d23ac9b1cef`
- 下列内容为该文件完整源码。

```python
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
```

### 13.5 `urp/schedule_legacy.py`：当前课表爬虫与缓存

- 当前快照 SHA-256：`ad21b60963a98450db6c9cecf302d3a2e16bd9c08a339387aebc9d297ae0be01`
- 下列内容为该文件完整源码。

```python
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
```

### 13.6 `services/urp_service.py`：爬虫业务编排、缓存读取、自动更新与返回值转换

- 当前快照 SHA-256：`9a83fe8a76af4eb62e41d5213adefe3b182d180d496586dbe2bc673153f07155`
- 下列内容为该文件完整源码。

```python
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
```

### 13.7 `routes/auth_routes.py`：登录与会话 HTTP 入口

- 当前快照 SHA-256：`cc193beea660fe7433e05489dd680968694cd1795ca1d7f02147d3688e62ab7f`
- 下列内容为该文件完整源码。

```python
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
```

### 13.8 `routes/data_routes.py`：教务数据 HTTP 入口

- 当前快照 SHA-256：`8b2cc672079dcd62c3bcdb3c109ac18e5ec72dccc195c6f3205cba67659e0e29`
- 下列内容为该文件完整源码。

```python
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
```

### 13.9 `services/shortcut_service.py`：快捷指令的直接爬取与返回值规范化

- 当前快照 SHA-256：`b75cb930e2079ff6e5b7d1935f11c275c027a0fe5b2e2a9439293783d85e4dda`
- 下列内容为该文件完整源码。

```python
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
```

### 13.10 `routes/shortcut_routes.py`：快捷指令 HTTP 入口、鉴权与错误结构

- 当前快照 SHA-256：`3318b9d8efa3cd5af22ce6f472529a39f9c911c8ae0303b0dca5f396d120d0ce`
- 下列内容为该文件完整源码。

```python
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
```

### 13.11 `auth.py`：调用爬虫前的绑定、会员和 URP 登录权限链

- 当前快照 SHA-256：`60c6ff91600e0341fb703c76e4baa7dfbe2b64b34f8d1e8cb2f0fa0eddd8a3ab`
- 下列内容为该文件完整源码。

```python
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
```

### 13.12 `urp/__init__.py`：包级兼容导出入口

- 当前快照 SHA-256：`135a4e1c921eb8bff39634bd098c33934c97475056ddfc7711354285a5400444`
- 下列内容为该文件完整源码。

```python
from urp.login import URP_login
from urp.query import URP_query

__all__ = ['URP_login', 'URP_query']
```

### 13.13 源码附录阅读索引

| 想追踪的功能 | 建议阅读顺序 |
|---|---|
| 登录为什么成功/失败 | `routes/auth_routes.py` → `services/urp_service.py:urp_login` → `urp/login.py:URP_login.login` |
| Cookie 为什么会重登 | `auth.py:require_login` → `services/urp_service.py:check_login_status` → `urp/login.py:URP_login.is_logined` |
| 当前课表字段从哪里来 | `routes/data_routes.py:api_update_schedule` → `urp/query.py:schedule_cx` → `urp/schedule_legacy.py:schedule_cx_legacy` |
| 历年课表如何选最新学期 | `routes/data_routes.py:api_historical_schedule` → `historical_schedule_cx` → `_select_latest_historical_semester` |
| 考试安排如何缓存 | `api_update_exams` → `URP_query.exam_cx` → `user_data/{username}/exams.json` |
| 成绩各入口如何解析 | `routes/data_routes.py` 的 `/api/grades/*` → `services/urp_service.py` → `urp/query.py` 各 `score_*` 方法 |
| 一键评教如何选择答案 | `api_evaluation` → `do_evaluation` → `URP_query.do_evaluation` |
| 快捷指令返回如何变成英文键 | `routes/shortcut_routes.py` → `services/shortcut_service.py` 的三个 `normalize_*` 函数 |

### 13.14 爬虫测试覆盖与真实性边界

| 测试文件 | 覆盖的爬虫链路 | 能证明什么 | 不能证明什么 |
|---|---|---|---|
| `tests/test_vpn_session_recovery.py` | VPN 页面识别、共享 Cookie、重连、查询重放、探活 | 恢复控制流和 Cookie 过滤符合代码契约 | 真实 VPN 账号当前可登录 |
| `tests/test_schedule_request.py` | 当前课表请求和 `schedule_cx_legacy` 解析 | 模拟 HTML 可转换为按周缓存 | 学校当前页面列顺序未改变 |
| `tests/test_historical_schedule_latest.py` | 历年课表最新学期选择 | 年份、上下学期排序规则 | 学校 option 值永远符合这些格式 |
| `tests/test_historical_schedule_ui.py`、`test_historical_schedule_grid.js` | 历年课表 API/前端网格 | 返回结构可被前端放入周×节次网格 | 真实页面一定存在 `#dayin` 网格 |
| `tests/test_disk_io_optimizations.py` | 登录缓存、自动更新互斥、在线状态 | 进程内缓存与去重行为 | 多进程或多服务器的一致性 |
| `tests/test_shortcut_api.py` | API key、三类 action、规范化、错误结构 | 外部快捷指令契约稳定 | URP 上游实时可用 |

现有测试大量使用 mock 或保存的 HTML fixture，不会拿真实学号、密码去访问学校系统。这使回归测试安全、可重复，但无法验证以下实时外部状态：VPN 认证策略、验证码模型准确率、学校是否临时关闭查询、HTML 是否改版、真实 Cookie 有效期、学校网络延迟。上线前若要验证这些事项，应使用专用测试账号和脱敏环境，且不得把凭据、Cookie 或验证码调试文件提交到仓库。

### 13.15 源码快照复核方法

这份附录是代码快照，不会随源文件自动更新。判断是否过期时，应同时检查：

1. 表格中的文件行数是否与当前文件一致。
2. 每个文件的 SHA-256 是否与标题下的值一致。
3. 源文件全文是否仍能在本报告对应 `python` 代码块中逐字找到。
4. `rg "URP_login|URP_query|schedule_cx_legacy"` 出现的新调用方是否已经加入范围说明。
5. 报告内是否意外出现 `data/config.json`、`data/vpn_cookie.json`、`user_data/**` 的真实内容。

只要任一项不一致，就应重新生成源码附录并重新复核第 5、6、7 节的接口和交互说明。
