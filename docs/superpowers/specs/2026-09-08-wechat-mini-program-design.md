# URP Helper 微信小程序设计

日期：2026-09-08
状态：已获用户确认，待文档审阅后进入实施

## 1. 目标与范围

为现有 URP Helper Flask 服务增加一个可直接导入微信开发者工具的原生微信小程序客户端。首版只覆盖学生使用频率最高的核心流程：

- 微信身份登录与教务账号绑定；
- 首页状态与紧急事项；
- 当前周课程表；
- 当前学期成绩；
- 考试安排；
- 我的页面、绑定状态与重新绑定。

评教、会员支付、对分易签到、邀请提现、快捷指令 API 和管理员后台不进入首版小程序，但后端接口继续保持可扩展。

首版采用独立目录和 Git worktree：

```text
E:\URP\web\.worktrees\wechat-mini-program
```

此 worktree 的分支为 `codex/wechat-mini-program`。现有 `main` 工作区的未提交修改不纳入本次实现，也不被覆盖。

## 2. 方案选择

### 2.1 推荐方案：原生小程序 + 复用 Flask API

小程序使用 WXML、WXSS 和原生 JavaScript，不引入 uni-app、Taro 或 npm 构建链。原因是当前项目已有稳定的 JSON API，而小程序首版页面数量有限；原生方案可以减少构建、依赖和发布环节，便于直接在微信开发者工具中运行。

小程序只负责页面展示、微信登录、请求封装和交互状态；教务登录、验证码、课表/成绩/考试抓取、会员数据和数据库仍由 Flask 负责。

### 2.2 未采用的方案

**WebView 包装现有网页**：实现速度最快，但无法获得原生页面体验，且微信身份绑定、网络域名配置和网页登录态仍需额外处理，不适合作为正式客户端。

**uni-app/Taro 重写**：适合后续同时发布 H5、App 和小程序，但会引入新的构建链与组件体系，超出首版必要范围。

## 3. 微信认证与账号绑定

### 3.1 登录流程

小程序启动时调用 `wx.login()` 获取一次性临时 code，并把 code 发送到 Flask。Flask 服务端使用小程序 AppID、AppSecret 和 code 调用微信 `code2Session`，获取 OpenID（以及微信返回时可用的 UnionID），随后生成 URP Helper 自己的随机登录 token。

小程序只保存自定义 token，不保存或展示 AppSecret、OpenID 和 `session_key`。后续请求使用：

```http
Authorization: Bearer <urp-mini-program-token>
```

浏览器网页继续使用现有的 `X-Device-ID`，两种认证方式并存。

### 3.2 绑定流程

1. 微信登录态建立后，调用现有 `/api/check_bind`；
2. 如果 OpenID 尚未关联用户，进入绑定页；
3. 用户输入教务账号和密码，调用 `/api/wechat/bind`；
4. 服务端先复用现有 `urp_login()` 验证教务账号；
5. 如果该学号已有用户记录，则复用该记录的内部 `device_id`，从而共享原网页端的课表、成绩、会员和缓存数据；
6. 如果学号没有记录，则生成新的内部用户记录；
7. 写入 OpenID 到内部 `device_id` 的映射，返回绑定成功。

同一个微信身份只能保留一个当前教务账号。重新绑定沿用现有 `/api/request_rebind` 流程：删除当前用户绑定记录，但保留微信映射使用的内部身份，之后可以重新输入另一个已验证的教务账号。

服务端不接受小程序直接提交的 OpenID 作为身份凭据；所有微信身份必须由服务端使用 code2Session 的结果建立。

### 3.3 新增数据表

保留现有 `users` 表及其以 `device_id` 为主键的业务关系，新增两张表。SQLite 和 MySQL 均通过 `database.py` 的初始化/内联迁移创建。

#### `wechat_bindings`

| 字段 | 说明 |
| --- | --- |
| `openid` | 小程序范围内的微信用户标识，主键 |
| `device_id` | 现有 `users.device_id` 的内部映射，唯一 |
| `unionid` | 微信返回时保存，可为空 |
| `bind_time` | 首次关联时间 |
| `updated_at` | 最近更新绑定时间 |

#### `wechat_sessions`

| 字段 | 说明 |
| --- | --- |
| `token_hash` | 自定义 token 的哈希值，主键；数据库不保存明文 token |
| `openid` | 对应微信身份 |
| `expires_at` | token 失效时间 |
| `created_at` | 创建时间 |
| `last_seen_at` | 最近使用时间 |

`session_key` 不作为前端会话凭据，也不写入业务响应。token 默认有效期 30 天；小程序重新调用 `wx.login()` 时可刷新 token。过期 token 返回统一的未登录结果，由小程序清理本地 token 并重新登录。

### 3.4 新增/兼容接口

新增：

- `POST /api/wechat/session`
  - 请求：`{"code": "..."}`
  - 响应：`success`、`token`、`bound`，已绑定时附带 `username`
- `POST /api/wechat/bind`
  - Header：`Authorization: Bearer ...`
  - 请求：`{"username": "...", "password": "...", "invitation_token": "..."}`
  - 响应：绑定结果与学号

兼容：

- `/api/check_bind`
- `/api/check_login_status`
- `/api/request_rebind`
- `/api/urgent_event`
- `/api/schedule`
- `/api/update_schedule`
- `/api/grades/current`
- `/api/grades/latest_summary`
- `/api/exams`
- `/api/update_exams`

认证层会在解析 `X-Device-ID` 之后解析 `Authorization`；解析到有效的小程序 token 时，内部路由仍然收到同样的 `device_id` 和 `user` 结构，因此不需要复制成绩、课表和考试业务逻辑。

## 4. 小程序页面与交互

### 4.1 页面结构

```text
miniprogram/
├─ app.js
├─ app.json
├─ app.wxss
├─ project.config.json
├─ README.md
├─ utils/
│  ├─ auth.js
│  ├─ config.js
│  ├─ request.js
│  └─ format.js
└─ pages/
   ├─ home/
   ├─ schedule/
   ├─ grades/
   ├─ exams/
   ├─ account/
   └─ bind/
```

### 4.2 TabBar

首版使用五个 tab：

| Tab | 主要内容 |
| --- | --- |
| 首页 | 绑定状态、学号、紧急事项、快速入口 |
| 课表 | 当前周、周切换、课程列表、刷新 |
| 成绩 | 当前学期成绩、成绩概览、刷新 |
| 考试 | 考试时间、地点、座位号、刷新 |
| 我的 | 微信绑定状态、教务账号、重新绑定 |

未绑定用户可以浏览首页的说明，但课表、成绩、考试和账号页显示绑定引导，不发起依赖教务账号的请求。

### 4.3 页面数据流

- 首页：`/api/check_bind`，已绑定后请求 `/api/urgent_event`；
- 课表：计算当前周后请求 `/api/schedule?week=<week>`，下拉刷新调用 `/api/update_schedule` 后重新加载；
- 成绩：请求 `/api/grades/latest_summary` 和 `/api/grades/current`，失败时展示重试；
- 考试：请求 `/api/exams`，下拉刷新调用 `/api/update_exams` 后重新加载；
- 我的：展示 `/api/check_bind` 返回的绑定状态，重新绑定调用 `/api/request_rebind` 并回到绑定页；
- 所有请求统一经过 `utils/request.js`，自动附加 token、解析 `success` 字段和展示网络错误。

### 4.4 视觉与状态

采用清晰的卡片式移动布局，与现有网页的简洁蓝色视觉保持一致。每个页面必须有加载中、空数据、失败重试和未绑定状态；不能用空白页面或只显示控制台错误代替错误反馈。

## 5. 配置与部署

### 5.1 服务端配置

AppSecret 只能配置在服务器环境变量中，不提交到仓库。计划使用：

```text
WECHAT_MINIPROGRAM_APPID=<小程序 AppID>
WECHAT_MINIPROGRAM_SECRET=<小程序 AppSecret>
```

如果任一配置缺失，微信登录接口返回可读的配置错误，小程序显示后端未完成配置。

### 5.2 小程序配置

`miniprogram/utils/config.js` 集中配置 Flask API 基础地址，默认指向当前项目配置中的 HTTPS 服务地址；`project.config.json` 使用可替换的测试 AppID 占位值，README 说明导入后需要替换。

生产发布前，在微信公众平台配置 request 合法域名。小程序 `wx.request` 只访问配置过的 HTTPS 域名，开发者工具可以临时关闭域名校验用于本地联调，但提交审核前必须使用真实 HTTPS 域名。

## 6. 错误处理与安全边界

- 微信 code 无效、重复使用或微信接口失败：返回统一错误，不泄露 AppSecret；
- token 缺失或过期：清理本地 token，重新执行 `wx.login()`；
- 未绑定教务账号：返回 `bound: false` 或现有业务提示，小程序引导绑定；
- 教务登录失败：保留输入表单，显示后端返回的可读消息；
- 业务接口返回 `success: false`：统一显示页面级错误和重试按钮；
- 不在小程序端持久化教务密码；绑定请求只在提交时发送，服务端继续沿用当前项目密码存储方式，但本次不扩大明文凭据暴露面；
- 不允许客户端提交 OpenID、device_id 作为微信身份替代品；
- 自定义 token 只以哈希形式落库，并设置有效期。

## 7. 实施分阶段

1. 服务端认证基础：数据库迁移、微信 code2Session 客户端、token 会话、认证解析；
2. 绑定接口：兼容已有网页用户，补充绑定/换绑测试；
3. 小程序骨架：app 配置、请求封装、登录态恢复、tabBar 和绑定页；
4. MVP 页面：首页、课表、成绩、考试、我的；
5. 联调与文档：README、接口说明、配置说明、错误状态；
6. 验证：Python 单元测试、JavaScript 语法检查、JSON 校验、静态契约检查、`git diff --check`。

## 8. 验收标准

### 自动化

- 新增微信认证服务测试，覆盖 code2Session 成功/失败、token 哈希存储、token 过期和已绑定/未绑定状态；
- 新增绑定兼容测试，覆盖复用现有学号记录和创建新记录；
- 验证小程序 `app.json`、`project.config.json` 和页面 JSON 可解析；
- 对所有小程序 JavaScript 文件运行 `node --check`；
- `git diff --check` 通过。

### 手工联调

- 微信开发者工具可以导入 `miniprogram/`；
- 关闭开发环境域名校验时可以访问开发服务；
- 配置真实 AppID/AppSecret 后，首次 `wx.login` 可以获得自定义 token；
- 老网页账号使用相同教务账号密码绑定后，网页端与小程序端看到同一份课表、成绩和会员状态；
- 重启小程序后能够恢复绑定；
- 断网、后端关闭、登录失效和无数据时页面均有明确反馈。

真实微信登录需要用户提供自己的小程序 AppID/AppSecret 或在微信开发者工具中完成配置；在没有这些外部凭据时，只能完成静态、单元和接口契约验证，不能声称真实微信登录已经联通。

## 9. 非目标与后续扩展

首版不迁移管理员端，不改现有网页 UI，不重写 URP 爬虫，不接入新的支付渠道，也不在小程序端实现对分易 SSE 流式控制。后续可在相同 token/request 基础上加入评教、会员、签到、公告、反馈和邀请中心。
