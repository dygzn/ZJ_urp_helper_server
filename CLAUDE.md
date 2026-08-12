# CLAUDE.md

说中文

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

URP Helper Server — 基于 Flask 的大学教务系统（URP）辅助工具。功能包括：设备绑定认证、教务数据爬取（成绩、评教、考试、课表）、AI 论文生成、会员系统、管理员后台。

## Development Commands

```bash
# 激活虚拟环境（Windows）
.venv\Scripts\activate

# 运行 Flask 服务器（http://0.0.0.0:5000）
python app.py

# 安装依赖
pip install -r requirements.txt
```

无自动化测试。`test/` 目录包含手动测试脚本，不可通过 `pytest` 等框架运行。

## Architecture

代码库已从单文件重构为模块化结构：

### 核心文件

- **[app.py](app.py)** — Flask 入口，注册所有 Blueprint，初始化数据库和日志
- **[auth.py](auth.py)** — 认证装饰器（见下节）
- **[database.py](database.py)** — SQLite 连接管理 + `init_db()`（含内联迁移）
- **[constants.py](constants.py)** — 全局常量：路径、支付配置、外部服务 URL（`DUIFENE_BASE_URL`）
- **[URP.py](URP.py)** — URP 系统交互：`URP_login`（登录/验证码）、`URP_query`（HTML 爬取）

### 模块目录

```
routes/          # Flask Blueprint 路由层
  auth_routes.py    # 登录/绑定/换绑
  data_routes.py    # 教务数据查询（成绩、课表、考试等）
  admin_routes.py   # 管理员后台接口
  member_routes.py  # 会员购买与状态
  sign_routes.py    # 对分易签到代理（Blueprint 名仍为 paper）
  misc_routes.py    # 公告、反馈、调查等

services/        # 业务逻辑层
  urp_service.py    # URP 登录状态管理、数据查询封装（含15分钟登录缓存 _login_cache）
  user_service.py   # 用户/设备相关查询
  config_service.py # config.json 读写、admin_key 管理、URP URL 故障切换
  member_service.py # 会员支付签名逻辑
  logging_service.py # 请求日志钩子

urp/             # URP 底层模块（从 URP.py 拆分）
  login.py
  query.py
```

### 认证装饰器（关键）

`auth.py` 中有四个装饰器，添加新端点时必须选择正确的：

- `@require_admin` — 验证管理员密钥（`X-Admin-Key` header 或 `admin_key` query param）
- `@require_login` — 验证设备绑定 + URP 登录状态，自动重新登录过期 cookie，向路由函数注入 `user` 参数
- `@require_bindding` — 仅验证设备绑定，不检查 URP 登录，注入 `user` 参数
- `@require_member(level)` — 验证设备绑定 + 会员资格，`level` 为 `'basic'` 或 `'advanced'`

所有装饰器通过 `X-Device-ID` header 识别用户。

### 设备绑定机制

前端在 localStorage 生成 UUID 作为 `device_id`，通过 `X-Device-ID` header 传递。一个设备只能绑定一个 URP 账号，换绑需管理员审批（`pending_requests` 表）。

### Cookie 生命周期

1. `vpncookie_get()` 从外部服务获取 VPN cookie
2. `URP_login.login()` 用 VPN cookie + 账号密码登录 URP，ddddocr 识别验证码（最多重试 3 次）
3. 登录成功后 cookie 保存到 `user_data/{account}/cookie.json`
4. `urp_service.check_login_status()` 带 15 分钟内存缓存（`_login_cache`），减少重复验证
5. Cookie 失效时自动用存储的密码重新登录

### 数据流

1. **用户绑定**: `/api/login` → `urp_service.urp_login()` → SQLite 存凭据 + cookie 存文件
2. **数据查询**: API → `@require_bindding` 或 `@require_login` → `urp_service` → `URP_query` 爬取 HTML → JSON
3. **对分易签到**: `/api/sign/*` → `@require_bindding` → `paper_routes` 代理至 `buxiangshangke.icu`；`/api/sign/stream` 用 `fetch` 流式转发 SSE
4. **会员支付**: `/api/member/pay` → 第三方支付 API → 回调 `/api/member/notify`

### Database Schema (SQLite: `data/urp_helper.db`)

- **users**: `device_id` (PK), `username`, `password`, `bind_time`, `last_auto_update`
- **pending_requests**: 换绑请求，含 `notified` 字段
- **announcements** + **user_read_announcements**: 公告与已读状态
- **surveys**: 问卷调查
- **feedbacks** + **feedback_replies**: 用户反馈与管理员回复
- **request_logs**: 所有请求日志（`logging_service` 通过 Flask after_request 钩子写入）
- **memberships**: `username` (PK), `member_type` (`basic`/`advanced`), `expire_time`
- **orders**: 支付订单，`status` 为 `pending`/`paid`/`failed`

新增字段通过 `database.py` 底部的内联 `try/except ALTER TABLE` 迁移。

### 文件存储

- `user_data/{username}/cookie.json` — URP 登录 cookie
- `user_data/{username}/schedule.json` — 缓存的课程表
- `user_data/{username}/exams.json` — 缓存的考试安排
- `data/config.json` — URP URL 列表、当前索引、主题

### 外部依赖

- VPN Cookie 服务：`http://101.35.254.245/vpn`，URP 登录的前置条件
- URP 系统地址：配置在 `data/config.json` 的 `urp_urls` 数组中，支持故障切换
- 对分易签到服务：`DUIFENE_BASE_URL`（见 `constants.py`），代理至 `buxiangshangke.icu`；按 device_id 维护 requests.Session 池（`paper_routes._duifene_sessions`）
- 会员支付：`PAY_API_URL`，需要 `MERCHANT_NUM` 和 `PAY_SECRET_KEY`（见 `constants.py`）

### 前端

原生 JavaScript SPA（无框架），位于 `templates/` + `static/`：
- `templates/index.html` + `static/js/main.js` — 用户界面
- `templates/admin.html` + `static/js/admin.js` — 管理员后台
- 设备 ID 存 localStorage，通过 `X-Device-ID` header 传递

## API Response Convention

```python
{'success': bool, 'message': str, 'data': ...}  # 或特定字段如 'grades', 'event' 等
```

## Common Development Patterns

### 添加新 URP 数据端点

1. 在 `services/urp_service.py` 中添加业务函数（调用 `URP.py` 中的 `URP_query`）
2. 在 `routes/data_routes.py` 中添加路由，选择合适的装饰器（通常 `@require_bindding` 即可）
3. 返回 `{'success': bool, 'data': ...}`

### 数据库操作

```python
with get_db() as conn:
    conn.execute('SELECT ...')
```

新增表字段：在 `database.py` 的 `init_db()` 末尾添加 `try/except ALTER TABLE`。

## Known Issues

- 课表更新、实验系统等端点返回模拟数据（未实现）
- SSL 验证已禁用（`verify=False`）
- 密码明文存储在 SQLite 中
- `constants.py` 中硬编码了支付密钥和商户号
