# URP Helper 微信小程序 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在独立 `miniprogram/` 目录中交付可导入微信开发者工具的原生小程序，并让 Flask 后端通过微信 OpenID 和自定义 token 支持账号绑定及核心教务查询。

**Architecture:** 后端新增微信 code2Session、token 会话和 OpenID 到现有 `device_id` 的映射；现有成绩、课表、考试业务路由继续通过认证层拿到同样的 `user` 对象。小程序使用原生 WXML/WXSS/JavaScript、五个 Tab 页面和统一 request/auth 工具，不引入 npm 构建链。

**Tech Stack:** Flask 3.1、SQLite/MySQL 兼容 SQL、Python `requests`、微信小程序原生 WXML/WXSS/JavaScript、Node `--check`、Python `unittest`。

**Spec:** `docs/superpowers/specs/2026-09-08-wechat-mini-program-design.md`

## Global Constraints

- 小程序目录固定为 `miniprogram/`，并位于 `E:\URP\web\.worktrees\wechat-mini-program` worktree 内。
- 网页端继续使用 `X-Device-ID`；小程序使用 `Authorization: Bearer <token>`，两种认证必须并存。
- AppSecret、OpenID、`session_key` 不得写入小程序源码、接口响应或提交到 Git。
- 首版只实现首页、课表、成绩、考试、我的，以及微信登录和教务账号绑定；不实现支付、评教、签到、邀请、快捷指令和管理员端。
- 已有网页端学号绑定记录必须可被小程序通过相同教务账号密码复用。
- 服务端配置使用环境变量 `WECHAT_MINIPROGRAM_APPID` 和 `WECHAT_MINIPROGRAM_SECRET`；缺失配置必须返回可读错误。
- 每个页面必须覆盖加载中、空数据、错误重试、未绑定四种状态中的适用状态。
- 所有代码改动都在 `codex/wechat-mini-program` 分支；不要覆盖 `main` 工作区已有的未提交修改。
- 每个任务完成后运行该任务列出的测试，并使用独立的 Conventional Commit。

## File Map

### Backend

- Create: `services/wechat_auth_service.py` — 微信 code2Session、随机 token、token 哈希、会话解析和 OpenID 绑定。
- Create: `routes/wechat_routes.py` — `/api/wechat/session` 与 `/api/wechat/bind`。
- Modify: `database.py` — SQLite/MySQL 的 `wechat_bindings`、`wechat_sessions` 表及索引迁移。
- Modify: `services/user_service.py` — 在不影响网页端的前提下，从 Bearer token 解析小程序内部 `device_id`。
- Modify: `auth.py` — 新增只校验微信自定义会话、允许未绑定用户进入绑定接口的装饰器。
- Modify: `app.py` — 注册微信认证 Blueprint。

### Tests

- Create: `tests/test_wechat_auth.py` — 服务层的 code2Session、token、过期和绑定映射测试。
- Create: `tests/test_wechat_routes.py` — Flask 接口、Bearer 认证、已有用户复用和未绑定状态测试。
- Create: `tests/test_miniprogram_contract.py` — 小程序目录、JSON 配置、页面清单和接口路径契约测试。
- Create: `tests/test_miniprogram_utils.js` — 与微信运行时无关的周次和数据格式化函数测试。

### Mini Program

- Create: `miniprogram/app.js`, `miniprogram/app.json`, `miniprogram/app.wxss`, `miniprogram/project.config.json` — 小程序入口、TabBar、全局样式和开发者工具配置。
- Create: `miniprogram/README.md` — 导入、环境变量、HTTPS 域名和开发者工具联调说明。
- Create: `miniprogram/utils/config.js` — API 基础地址与请求超时配置。
- Create: `miniprogram/utils/auth.js` — `wx.login()`、自定义 token 保存/清理和登录态恢复。
- Create: `miniprogram/utils/request.js` — 统一 `wx.request` 封装、Authorization、错误归一化。
- Create: `miniprogram/utils/format.js` — 当前周计算、课表分组、分数/考试展示格式化；保持为可被 Node 加载的纯 JS 模块。
- Create: `miniprogram/pages/home/*` — 首页状态、紧急事项和核心入口。
- Create: `miniprogram/pages/schedule/*` — 当前周课表、周切换、更新。
- Create: `miniprogram/pages/grades/*` — 当前学期成绩和成绩概览。
- Create: `miniprogram/pages/exams/*` — 考试安排和更新。
- Create: `miniprogram/pages/account/*` — 微信绑定信息、学号和重新绑定。
- Create: `miniprogram/pages/bind/*` — 教务账号绑定表单。

---

### Task 1: Lock backend contracts with failing tests

**Files:**
- Create: `tests/test_wechat_auth.py`
- Create: `tests/test_wechat_routes.py`

**Interfaces:**
- Consumes: existing `database.init_db(config)`, `database.get_database_config()`, `services.user_service.bind_user()` and `app.app.test_client()`.
- Produces: executable tests that define `code_to_session(code)`, `create_session(openid, unionid=None)`, `resolve_session_token(token)`, `get_binding(openid)`, `/api/wechat/session`, and `/api/wechat/bind` behavior for later tasks.

- [ ] **Step 1: Create a temporary-database test fixture.**

  In both test modules, use `tempfile.TemporaryDirectory()` and a config of the form below. Patch `database.get_database_config` for each test so existing `get_db()` callers use the temporary SQLite file and do not touch `data/urp_helper.db`.

  ```python
  self.db_config = {
      'type': 'sqlite',
      'sqlite_path': os.path.join(self.temp_dir.name, 'wechat.db'),
      'mysql': {},
  }
  self.init_config = {'database': self.db_config}
  self.config_patch = mock.patch(
      'database.get_database_config',
      return_value=self.db_config,
  )
  self.config_patch.start()
  database.init_db(self.init_config)
  ```

- [ ] **Step 2: Write service tests that must initially fail.**

  Add tests for: successful `requests.get` parsing of `openid` and `unionid`; a non-zero WeChat `errcode` raising the service's public auth error; the issued token being different from OpenID and `session_key`; the database storing only `sha256(token)`; a valid session resolving before expiry; an expired session resolving to `None`; and a binding lookup returning `None` before association.

  Patch `services.wechat_auth_service.requests.get` in the HTTP test and return:

  ```python
  mock_get.return_value.json.return_value = {
      'openid': 'openid-test-1',
      'session_key': 'server-only-secret',
      'unionid': 'unionid-test-1',
  }
  ```

- [ ] **Step 3: Write route tests that must initially fail.**

  Add Flask test-client cases for:

  ```python
  response = client.post('/api/wechat/session', json={'code': 'code-1'})
  assert response.get_json() == {
      'success': True,
      'token': mock.ANY,
      'bound': False,
  }
  ```

  Also cover missing code, invalid code, `/api/wechat/bind` without Bearer token, binding a new username after patching `routes.wechat_routes.urp_login` to return `(True, '登录成功', None)`, and binding an existing `users` row while asserting the existing `device_id` is reused. Store the session token from the first response and send it as `Authorization: Bearer <token>` on the bind request.

- [ ] **Step 4: Run the new tests and record the expected failure.**

  Run:

  ```powershell
  python -m unittest tests.test_wechat_auth tests.test_wechat_routes
  ```

  Expected: collection fails because the new service/routes do not exist yet. Do not make production changes in this task.

- [ ] **Step 5: Commit the contract tests.**

  ```powershell
  git add tests/test_wechat_auth.py tests/test_wechat_routes.py
  git commit -m "test: define WeChat authentication contracts"
  ```

### Task 2: Implement database schema and WeChat auth service

**Files:**
- Modify: `database.py` near the existing `users` schema and migration section
- Create: `services/wechat_auth_service.py`
- Test: `tests/test_wechat_auth.py`

**Interfaces:**
- Consumes: Task 1 service tests and existing `get_db()` connection adapter.
- Produces: `WechatAuthError`, `code_to_session(code) -> dict`, `create_session(openid, unionid=None) -> str`, `resolve_session_token(token) -> dict | None`, `get_binding(openid) -> dict | None`, `get_unbound_device_id(openid) -> str`, and `bind_openid_to_device(openid, device_id, unionid=None) -> None`.

- [ ] **Step 1: Add the SQLite and MySQL schema definitions.**

  Add `wechat_bindings` with `openid` primary key, `device_id` unique, nullable `unionid`, `bind_time`, and `updated_at`. Add `wechat_sessions` with `token_hash` primary key, `openid`, `expires_at`, `created_at`, and `last_seen_at`. Add indexes on `wechat_bindings(device_id)`, `wechat_sessions(openid)`, and `wechat_sessions(expires_at)` in both database dialect schema blocks. Keep existing table definitions unchanged.

- [ ] **Step 2: Add inline migration guards.**

  Extend the existing `init_db()` migration list with `CREATE TABLE IF NOT EXISTS`/index statements or dialect-specific schema calls so a database created before this feature gains both tables without deleting data. Run `database.init_db(temp_config)` twice in the tests to confirm idempotence.

- [ ] **Step 3: Implement configuration and code2Session.**

  In `services/wechat_auth_service.py`, read only `WECHAT_MINIPROGRAM_APPID` and `WECHAT_MINIPROGRAM_SECRET` from `os.environ`. Implement:

  ```python
  def code_to_session(code: str) -> dict:
      """Return {'openid': str, 'unionid': str | None}; never return session_key."""
  ```

  Validate that `code` is a non-empty string and both environment variables exist. Call `requests.get('https://api.weixin.qq.com/sns/jscode2session', params={...}, timeout=10)` with `grant_type=authorization_code`. Raise `WechatAuthError` with a user-safe Chinese message for missing config, request failures, malformed JSON, missing OpenID, or a non-zero `errcode`.

- [ ] **Step 4: Implement hashed token sessions.**

  Generate the client token with `secrets.token_urlsafe(32)`, store only `hashlib.sha256(token.encode()).hexdigest()`, and set a 30-day expiry. `resolve_session_token()` must reject empty tokens, missing rows and expired rows; for a valid row update `last_seen_at` and return `{'openid': ..., 'device_id': get_binding(...).get('device_id') if bound else None}`. Remove expired sessions for the same OpenID before inserting a fresh session.

- [ ] **Step 5: Implement binding lookup helpers.**

  `get_binding(openid)` returns a plain dict with `openid`, `device_id`, `unionid`, `bind_time`, and `updated_at`, or `None`. `get_unbound_device_id(openid)` returns `wx_` plus the first 32 hex characters of `sha256(openid)`, so an unbound request has a stable internal ID without exposing raw OpenID. `bind_openid_to_device()` uses an insert/update that works through the repository's SQLite/MySQL adapter.

- [ ] **Step 6: Run service tests and commit.**

  Run:

  ```powershell
  python -m unittest tests.test_wechat_auth
  ```

  Expected: all service tests pass, including the assertion that `code_to_session()` returns only the server-side `openid`/`unionid` mapping and never `session_key`, that the HTTP route does not expose OpenID, and that the database contains only the token hash. Then commit:

  ```powershell
  git add database.py services/wechat_auth_service.py tests/test_wechat_auth.py
  git commit -m "feat: add WeChat session storage"
  ```

### Task 3: Integrate Bearer auth and binding routes without changing web auth

**Files:**
- Modify: `services/user_service.py`
- Modify: `auth.py`
- Create: `routes/wechat_routes.py`
- Modify: `app.py`
- Test: `tests/test_wechat_routes.py`

**Interfaces:**
- Consumes: Task 2 service functions and existing `users` table/business functions.
- Produces: `get_bearer_token() -> str | None`, `get_wechat_request_session() -> dict | None`, `@require_wechat_session`, `POST /api/wechat/session`, `POST /api/wechat/bind`, and Bearer-token support for existing routes through `get_device_id()`.

- [ ] **Step 1: Add request-session parsing helpers.**

  In `services/wechat_auth_service.py`, parse only the exact `Authorization: Bearer <non-empty-token>` form. Add `get_wechat_request_session()` that calls `resolve_session_token()` and returns its context. Do not use the token as a device ID and do not accept OpenID from any request body or header.

- [ ] **Step 2: Extend `get_device_id()` with a strict precedence order.**

  Preserve the current behavior for web requests. The resulting order must be:

  1. non-empty `X-Device-ID`;
  2. valid Bearer session's bound `device_id`;
  3. valid Bearer session's deterministic `get_unbound_device_id(openid)`;
  4. existing User-Agent/IP fallback for legacy requests.

  Use a local import inside `get_device_id()` to avoid a module-import cycle between `user_service` and `wechat_auth_service`.

- [ ] **Step 3: Add the `require_wechat_session` decorator.**

  In `auth.py`, add a decorator that returns HTTP 401 with `{'success': False, 'message': '微信登录已失效，请重新登录', 'code': 'WECHAT_SESSION_REQUIRED'}` when no valid Bearer session exists, and otherwise calls the route with `wechat_session=<context>`.

- [ ] **Step 4: Implement `POST /api/wechat/session`.**

  In `routes/wechat_routes.py`, validate JSON `code`, call `code_to_session()`, call `create_session()`, then look up the OpenID binding. Return:

  ```python
  {
      'success': True,
      'token': token,
      'bound': bool(binding and get_user_by_device(binding['device_id'])),
      # include username only when bound
  }
  ```

  Convert `WechatAuthError` to the project response convention without including AppSecret or WeChat `session_key` details.

- [ ] **Step 5: Implement `POST /api/wechat/bind`.**

  Require `wechat_session`. Validate non-empty `username` and `password`, call existing `urp_login(username, password)`, and return its message on failure. On success:

  - read an existing user with `get_user_by_username(username)`;
  - if its `device_id` is already linked to a different OpenID, return `success: false` and explain that the account is linked to another WeChat identity;
  - otherwise reuse the existing `device_id`, or use `get_unbound_device_id(openid)` for a new user;
  - call `bind_user(device_id, username, password, invitation_token)`;
  - call `bind_openid_to_device(openid, device_id, unionid)`;
  - return `success: true`, `bound: true`, and `username`.

  Keep all writes inside the existing database context boundaries; do not add a second copy of URP login logic.

- [ ] **Step 6: Register the Blueprint.**

  Import `wechat_bp` in `app.py` and call `app.register_blueprint(wechat_bp)` alongside the existing route blueprints. Do not move or rename existing routes.

- [ ] **Step 7: Run route tests and commit.**

  Run:

  ```powershell
  python -m unittest tests.test_wechat_auth tests.test_wechat_routes
  ```

  Expected: all new route tests pass; existing web requests with `X-Device-ID` still use the old path. Commit:

  ```powershell
  git add services/wechat_auth_service.py services/user_service.py auth.py routes/wechat_routes.py app.py tests/test_wechat_routes.py
  git commit -m "feat: add WeChat account binding routes"
  ```

### Task 4: Scaffold the mini program and make authentication usable

**Files:**
- Create: `miniprogram/app.js`
- Create: `miniprogram/app.json`
- Create: `miniprogram/app.wxss`
- Create: `miniprogram/project.config.json`
- Create: `miniprogram/utils/config.js`
- Create: `miniprogram/utils/auth.js`
- Create: `miniprogram/utils/request.js`
- Create: `miniprogram/utils/format.js`
- Create: `tests/test_miniprogram_contract.py`
- Test: `tests/test_miniprogram_utils.js`

**Interfaces:**
- Consumes: `/api/wechat/session`, `/api/check_bind`, and the token contract from Task 3.
- Produces: `auth.login() -> Promise<sessionData>`, `auth.ensureSession() -> Promise<sessionData>`, `auth.getToken() -> string`, `auth.clearSession() -> void`, `request(options) -> Promise<responseData>`, and pure formatters `getCurrentWeek(semesterStart, now)`, `groupSchedule(schedule)`, `formatScore(score)`, `formatExam(exam)`.

- [ ] **Step 1: Add the failing static contract test.**

  Assert that `miniprogram/app.json`, `project.config.json`, and all five tab page directories exist; `app.json` lists the six page paths `pages/home/index`, `pages/schedule/index`, `pages/grades/index`, `pages/exams/index`, `pages/account/index`, and `pages/bind/index`, while its `tabBar.list` contains exactly the first five; and `utils/request.js`, `utils/auth.js`, and `utils/format.js` exist. Run it before creating the directory and confirm it fails with a missing-file assertion.

- [ ] **Step 2: Create the app configuration.**

  Use `miniprogram/` as the `miniprogramRoot`, set `compileType` to `miniprogram`, keep the AppID as the literal development placeholder `touristappid`, and set the tab bar to the five pages above. Set `window.navigationBarTitleText` to `URP 助手`, `navigationBarBackgroundColor` to `#f7f8fa`, `navigationBarTextStyle` to `black`, and `backgroundColor` to `#f7f8fa`.

- [ ] **Step 3: Implement `utils/config.js` and `utils/request.js`.**

  Set the default API base URL to `https://www.meizhenxin.cn` and timeout to 15000 ms. `request({path, method='GET', data={}, header={}})` must call `wx.request`, merge `Content-Type: application/json`, add `Authorization` only when a token exists, resolve JSON data when `statusCode` is 2xx and `data.success !== false`, and reject with `{statusCode, message, data}` otherwise. For HTTP 401 or `data.code === 'WECHAT_SESSION_REQUIRED'`, clear the token but do not automatically recurse into another request.

- [ ] **Step 4: Implement `utils/auth.js`.**

  `login()` calls `wx.login`, then makes a raw `wx.request` to `/api/wechat/session` with `{code}` and stores only the returned `token` using `wx.setStorageSync('urp_mini_token', token)`. `ensureSession()` returns the stored-token state when present; otherwise it calls `login()`. `clearSession()` removes the same storage key. If `wx.login` or the server response lacks a token, reject with a Chinese error message that the pages can display.

- [ ] **Step 5: Implement pure format utilities and their tests.**

  `getCurrentWeek()` must return `1` when `semesterStart` is invalid or the date is before the semester start, otherwise `floor((localDate - startDate) / 7 days) + 1`. `groupSchedule()` must accept the backend's `{week: [course, ...]}` shape and return sorted day groups without mutating the input. `formatScore()` must preserve strings such as `优秀` and return `--` for empty values; `formatExam()` must create stable `time`, `location`, and `seat` display fields from the existing API keys.

  Run:

  ```powershell
  node --test tests/test_miniprogram_utils.js
  python -m unittest tests.test_miniprogram_contract
  ```

- [ ] **Step 6: Add global style primitives and commit the scaffold.**

  Create `app.wxss` with page background `#f7f8fa`, 16px page padding, card radius 16px, blue primary button, muted text, loading/error/empty styles, and 44px minimum touch targets. Then run `git diff --check`, stage the scaffold and tests, and commit:

  ```powershell
  git add miniprogram tests/test_miniprogram_contract.py tests/test_miniprogram_utils.js
  git commit -m "feat: scaffold WeChat mini program client"
  ```

### Task 5: Build login, binding and account state flows

**Files:**
- Create: `miniprogram/pages/bind/index.json`
- Create: `miniprogram/pages/bind/index.wxml`
- Create: `miniprogram/pages/bind/index.wxss`
- Create: `miniprogram/pages/bind/index.js`
- Create: `miniprogram/pages/account/index.json`
- Create: `miniprogram/pages/account/index.wxml`
- Create: `miniprogram/pages/account/index.wxss`
- Create: `miniprogram/pages/account/index.js`
- Modify: `miniprogram/app.js`
- Modify: `miniprogram/utils/auth.js`
- Test: `tests/test_miniprogram_contract.py`

**Interfaces:**
- Consumes: `auth.ensureSession()`, `request()`, `/api/check_bind`, `/api/wechat/bind`, `/api/request_rebind`.
- Produces: first-run routing to `pages/bind/index`, a form that calls `/api/wechat/bind`, and an account page that can display/rebind the current account.

- [ ] **Step 1: Extend the contract test with bind-page controls.**

  Assert that `bind/index.wxml` contains `username`, `password`, a submit button, and an error/status node; `account/index.wxml` contains the current username and a rebind button; and `app.js` references `auth.ensureSession()` and `wx.switchTab`/`wx.navigateTo` for first-run routing.

- [ ] **Step 2: Implement app startup state restoration.**

  In `app.js`, call `auth.ensureSession()` in `onLaunch`, then request `/api/check_bind`. Store `{bound, username}` in `globalData`. If the response is unbound, defer navigation until the current page can open `pages/bind/index`; do not force a tab switch before the page stack exists. If the session fails, clear it and show the same bind/login path.

- [ ] **Step 3: Implement the binding page.**

  Use two inputs with `bindinput`, a submit button disabled while submitting, and a status text. On submit validate both values locally, call `request({path:'/api/wechat/bind', method:'POST', data:{username,password}})`, clear the password field after either result, and on success set global bound state then `wx.switchTab({url:'/pages/home/index'})`. Keep the username value after failure and show the returned message.

- [ ] **Step 4: Implement the account page and rebind flow.**

  Load `/api/check_bind` on `onShow`. Display “已绑定/未绑定”、username and a “重新绑定” button. On confirmation, call `/api/request_rebind`; on success clear global bound state and navigate to bind page. On failure keep the page state unchanged and display the message. Do not expose OpenID, token or password in WXML.

- [ ] **Step 5: Run page contract and syntax checks.**

  Run:

  ```powershell
  python -m unittest tests.test_miniprogram_contract
  node --check miniprogram/app.js
  node --check miniprogram/utils/auth.js
  node --check miniprogram/utils/request.js
  ```

- [ ] **Step 6: Commit the authentication UI.**

  ```powershell
  git add miniprogram/app.js miniprogram/pages/bind miniprogram/pages/account miniprogram/utils/auth.js tests/test_miniprogram_contract.py
  git commit -m "feat: add mini program binding flow"
  ```

### Task 6: Build the five MVP pages against existing APIs

**Files:**
- Create/modify: `miniprogram/pages/home/*`
- Create/modify: `miniprogram/pages/schedule/*`
- Create/modify: `miniprogram/pages/grades/*`
- Create/modify: `miniprogram/pages/exams/*`
- Modify: `miniprogram/pages/account/*`
- Modify: `miniprogram/utils/format.js`
- Test: `tests/test_miniprogram_contract.py`, `tests/test_miniprogram_utils.js`

**Interfaces:**
- Consumes: `request()`, `auth.clearSession()`, `format.js`, and the existing API response keys defined in the design spec.
- Produces: working loading/empty/error/bound states for each tab and refresh handlers that call the existing update endpoints.

- [ ] **Step 1: Add page contract assertions before page implementation.**

  Extend the Python contract test to assert each page contains `onPullDownRefresh`, a loading/error/empty state marker, and the exact endpoint strings it owns: home has `/api/check_bind` and `/api/urgent_event`; schedule has `/api/schedule` and `/api/update_schedule`; grades has `/api/grades/latest_summary` and `/api/grades/current`; exams has `/api/exams` and `/api/update_exams`; account has `/api/request_rebind`.

- [ ] **Step 2: Implement the home page.**

  On `onShow`, call `/api/check_bind`, render the username when bound, and call `/api/urgent_event` only when bound. Provide four quick-entry buttons to switch to schedule, grades, exams, and account. For unbound users show a bind CTA that navigates to `/pages/bind/index`; for an urgent-event failure show retry without hiding the bound card.

- [ ] **Step 3: Implement schedule data loading and display.**

  On the first load call `/api/schedule` without a week so the response supplies `data.semester_start` and the full cached schedule; save that semester start, compute `getCurrentWeek(semesterStart)`, and render the matching week from the returned schedule. For subsequent week changes call `/api/schedule?week=<week>`, store the week and normalized day groups, and render each course's `课程名`, `节次`, `节数`, and `上课地点`/`地点` when present. Add previous/next week buttons with a minimum of 1, a current-week label, and pull-to-refresh that calls `/api/update_schedule` followed by the same initial-load GET. Do not mutate the backend response.

- [ ] **Step 4: Implement grades loading and display.**

  Request `/api/grades/latest_summary` and `/api/grades/current` in parallel with `Promise.all`, render the latest semester name, passed course list, failed current/past counts, and current course scores. Treat an empty array as a valid empty state; show a retry button for either request failure.

- [ ] **Step 5: Implement exams loading and display.**

  Request `/api/exams`, render course/exam name, time, location and seat, and show a clear empty state when the backend returns no exams. On pull-to-refresh call `/api/update_exams`, then reload `/api/exams`. Disable the refresh action while the update is running.

- [ ] **Step 6: Add shared page state helpers and visual consistency.**

  Use the same `loading`, `errorMessage`, `empty`, and `bound` state fields in each page. Every failed request must call `wx.showToast({icon:'none', title: message.slice(0, 20)})` and preserve a visible retry button. Every primary button and input must have `min-height: 44px` in global or page WXSS.

- [ ] **Step 7: Run page checks and commit.**

  Run:

  ```powershell
  python -m unittest tests.test_miniprogram_contract
  node --test tests/test_miniprogram_utils.js
  Get-ChildItem miniprogram -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
  ```

  Expected: all JavaScript files parse and all endpoint/page contracts pass. Commit:

  ```powershell
  git add miniprogram/pages miniprogram/utils/format.js tests/test_miniprogram_contract.py tests/test_miniprogram_utils.js
  git commit -m "feat: add core mini program pages"
  ```

### Task 7: Add import/deployment documentation and run the full verification suite

**Files:**
- Create: `miniprogram/README.md`
- Create: `docs/wechat-mini-program-api.md`
- Modify: `tests/test_miniprogram_contract.py` only if a documented contract needs a matching assertion

**Interfaces:**
- Consumes: all completed backend and mini-program files from Tasks 1–6.
- Produces: self-contained instructions for another developer to configure, import, run, and publish the mini program without exposing secrets.

- [ ] **Step 1: Document local import and configuration.**

  In `miniprogram/README.md`, state the exact import directory `E:\URP\web\.worktrees\wechat-mini-program\miniprogram`, replace `touristappid` in `project.config.json`, set `utils/config.js` API base URL, and use the developer-tool option “不校验合法域名、TLS 版本及 HTTPS 证书” only for local development. Explain that production must configure the HTTPS request domain in the WeChat platform.

- [ ] **Step 2: Document backend setup and routes.**

  In `docs/wechat-mini-program-api.md`, document environment variables, request/response examples for `/api/wechat/session` and `/api/wechat/bind`, the `Authorization` header, token expiry behavior, and the existing core endpoints. Explicitly state that AppSecret and session_key never belong in the mini program.

- [ ] **Step 3: Run the full backend and mini-program test suite.**

  Run:

  ```powershell
  python -m unittest discover -s tests -p 'test_*.py'
  node --test tests/test_miniprogram_utils.js
  Get-ChildItem miniprogram -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
  git diff --check
  git status --short --branch
  ```

  The existing baseline has one known template-script-order error and one Chinese-rendering assertion failure on the pre-feature HEAD; report them separately if they remain. New WeChat tests, contract tests and JavaScript checks must pass with zero new failures.

- [ ] **Step 4: Perform static security review.**

  Run:

  ```powershell
  rg -n "WECHAT_MINIPROGRAM_SECRET|session_key|openid|AppSecret|password" miniprogram routes services
  ```

  Confirm there is no AppSecret or session_key literal in `miniprogram/`, no OpenID accepted from request input, and no password written to mini-program storage. Redact any real credentials before final delivery.

- [ ] **Step 5: Commit docs and final verification.**

  ```powershell
  git add miniprogram/README.md docs/wechat-mini-program-api.md
  git commit -m "docs: add mini program setup and API guide"
  git status --short --branch
  ```

## Plan Self-Review

### Spec coverage

- Authentication and server-side code2Session: Tasks 1–3.
- Existing-user reuse and rebind behavior: Task 3 and Task 5.
- Two new database tables and migrations: Task 2.
- Native mini-program scaffold and five tabs: Tasks 4–6.
- Loading/empty/error/unbound states: Tasks 5–6.
- HTTPS/domain/AppID/AppSecret deployment: Task 7.
- Automated tests and manual limitations: Tasks 1, 4, 6 and 7.
- Separate worktree and documentation: plan header, Task 7, and the committed design/spec files.

### Consistency checks

- `request()` never calls `auth.login()` recursively on a 401; pages can explicitly recover by clearing the session and navigating to bind.
- The backend resolves Bearer tokens to existing internal `device_id` values, so existing route decorators and data services remain the single source of business behavior.
- `format.js` is deliberately pure/CommonJS so it can be unit-tested by Node while still being imported by mini-program page scripts.
- All interface names used by later tasks are defined in earlier task interfaces or in this file's File Map.
