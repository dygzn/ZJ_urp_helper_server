# HTML-first 项目清理与静态内容迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 审核并收敛 URP Helper Server 的实际功能边界，删除前端无法到达且没有保留价值的代码路径，修复模板/静态资源修改不生效的问题，并让所有前端固定文案都能直接在对应 HTML 文件中修改。

**Architecture:** 保留现有 Flask Blueprint 和原生 JavaScript SPA；以 HTML 作为页面结构与固定文案的唯一来源，JavaScript 只负责事件、状态、数据请求和动态数据渲染。公共固定文案通过每个 HTML 页面内的隐藏 `data-ui-copy`/`data-ui-template` 节点提供，新增一个无文案的 `ui-copy.js` 读取这些节点。后端只移除明确无调用方的路由和实现，不删除数据库历史表或迁移。

**Tech Stack:** Flask、Jinja2、SQLite、原生 JavaScript、CSS、Python `unittest`、Node.js 内置 `assert`/`vm`。

**Spec:** `docs/superpowers/specs/2026-09-07-html-first-project-cleanup-design.md`

## Global Constraints

- [ ] 全部实现与验证在 `E:\URP\web\.worktrees\html-first-cleanup` 完成，不在主工作区执行清理或重置。
- [ ] 保留当前工作区已有用户修改；每次提交只显式列出本任务涉及的文件，不使用 `git add -A`，不使用 `git reset --hard`、`git checkout --` 或删除整个目录。
- [ ] 不删除 `data/urp_helper.db` 中的历史表、历史记录、`database.py` 的迁移逻辑；`pending_requests`、`request_logs` 只保留数据库兼容性，不再因为本次清理而批量删除数据。
- [ ] 不删除仍属于外部契约的快捷 API、支付回调、邀请/提现接口、现有公开页面和有效管理员功能；只删除设计文档中已确认的不可达或废弃路径。
- [ ] 每个新行为先增加能证明旧行为不满足要求的测试，再改生产代码使测试通过；每个小任务完成后运行该任务的最小验证并提交。
- [ ] 前端 JavaScript 源码中不得保留面向用户的固定中文文案，也不得使用中文 fallback；注释可以保留中文，来自 API/URP 的动态数据不属于静态文案。固定文案必须存在于 `templates/index.html`、`templates/admin.html` 或 `templates/ad_detail.html` 的可编辑 HTML 节点中。
- [ ] 动态数据写入 DOM 时继续使用 `textContent`、安全 DOM 节点或已有转义函数；不得为了迁移文案而把不可信 API 数据拼入 `innerHTML`。
- [ ] 不以“关闭 debug”解决模板刷新问题；开发和非 debug 运行都必须能重新读取 HTML，浏览器也不能复用旧页面/静态资源缓存。

## Task 1: 建立清理、缓存与 HTML-first 契约的失败测试

**Files:** 新建 `tests/test_html_first_contract.py`、`tests/test_ui_copy_contract.js`；必要时仅更新已有测试中与资源 query string 解析有关的断言。

- [ ] 在 Python 测试中导入 Flask 应用并增加以下断言：`TEMPLATES_AUTO_RELOAD` 为真、`app.jinja_env.auto_reload` 为真；`/`、`/admin`、`/ad-detail` 和 `/static/js/main.js` 的响应包含 `Cache-Control: no-store`、`Pragma: no-cache`、`Expires: 0`。
- [ ] 在同一 Python 测试中读取应用路由表，断言以下路径不存在：`/api/grades`、`/api/schedule/other_majors`、`/api/schedule/other_major`、`/api/rebind_notified`、`/api/admin/invitation_debug`、`/api/admin/pending_requests`、`/api/admin/approve_rebind`、`/api/sign/login`、`/api/sign/login_link`、`/api/sign/status`、`/api/sign/start`、`/api/sign/stop`、`/api/sign/stream`。断言仍保留 `/api/login`、`/api/request_rebind`、`/api/member/notify`、`/api/shortcut/*` 和所有九个有效管理员页签所需接口。
- [ ] 读取三个模板源码并断言分别存在 `user-ui-copy`、`admin-ui-copy`、`ad-ui-copy` 根节点，以及至少一个 `data-ui-copy` 节点和一个 `data-ui-template` 节点；断言固定版本 query string（如 `main.js?v=11`、`style.css?v=11`）不再是模板资源引用的契约。
- [ ] 在 Node 测试中实现一个不依赖第三方包的轻量 fake root，覆盖 `data-ui-copy` 的读取、`{{name}}` 占位符格式化、`data-ui-template` 克隆和 slot 填充；测试要求 slot 文本通过 `textContent` 写入，不执行 HTML。
- [ ] 增加静态源扫描测试：剥离 JS 注释后，`static/js/main.js`、`static/js/admin.js`、`static/js/ad-detail.js`、`static/js/ui-ux.js` 和 `static/js/service-status-ui.js` 不得包含中文字符串字面量；同时断言这些脚本不再引用本任务拟删除的 API 路径。
- [ ] 运行 `python -m unittest tests.test_html_first_contract -v` 和 `node tests/test_ui_copy_contract.js`，记录它们在未修改生产代码时因缓存、缺少 HTML copy 根节点和死路由仍存在而失败；不要为了让测试暂时通过而放宽断言。
- [ ] 只提交本任务新增的测试文件，提交信息为 `test: add html-first cleanup contracts`；若已有测试只因带 query 的资源 URL 而误报，先在本任务范围内把它改为用 `urllib.parse.urlsplit` 比较路径，再一并提交。

## Task 2: 修复模板和静态资源缓存导致的页面不更新

**Files:** 修改 `app.py`；修改 `templates/index.html`、`templates/admin.html`、`templates/ad_detail.html` 的资源引用。

- [ ] 先根据 Task 1 的失败输出确认失败来自应用配置/响应头，而不是测试路径错误。
- [ ] 在创建 Flask 应用后设置 `TEMPLATES_AUTO_RELOAD=True` 和 `SEND_FILE_MAX_AGE_DEFAULT=0`；确保配置发生在模板和静态资源请求处理前。
- [ ] 在 `app.py` 增加 `after_request` 钩子，只对 `/`、`/admin`、`/ad-detail` 和 `/static/` 响应设置 `Cache-Control: no-store, no-cache, must-revalidate, max-age=0`、`Pragma: no-cache`、`Expires: 0`。不要改变 API 响应或支付回调的缓存语义。
- [ ] 保留 `FLASK_DEBUG` 对调试日志和 reloader 的控制，但让 `app.run` 使用现有的 `debug` 变量；不要以 `debug=True` 作为模板刷新依赖。
- [ ] 删除三个模板里所有手工维护的 `?v=数字` 资源版本参数，让响应头策略成为唯一缓存控制；确认所有本地 CSS/JS 引用仍然指向真实文件。
- [ ] 重新运行 Task 1 的 Python 契约测试；再用 Flask test client 输出四个响应的状态码和缓存头，确认 HTML 内容在修改模板后由 Jinja 重新读取。
- [ ] 运行 `git diff --check`，提交修改的 `app.py` 与三个模板，提交信息为 `fix: disable stale template and asset caching`。

## Task 3: 增加 HTML 文案读取器并验证其安全边界

**Files:** 新建 `static/js/ui-copy.js`、`tests/test_ui_copy.js`；更新 `tests/test_ui_copy_contract.js`。

- [ ] 先补充行为测试：在 fake root 中放置普通 copy 节点和 template 节点，验证 `URPCopy.get(key)` 返回 HTML 中的文字、`URPCopy.format(key, values)` 只替换显式 `{{token}}`、缺失 key 返回空字符串、`URPCopy.clone`/`mount` 能生成节点并将 slot 当纯文本填充；用包含 `<img onerror=...>` 的 slot 值证明不会执行或解释为 HTML。
- [ ] 实现 `static/js/ui-copy.js` 的最小 API：`get(key, root)`、`format(key, values, root)`、`clone(key, root)`、`mount(container, key, values, root)`；默认 root 为 `document`，浏览器暴露 `window.URPCopy`，Node 环境通过 `module.exports` 暴露同一对象。
- [ ] 读取节点时按 `dataset.uiCopy`/`dataset.uiTemplate` 过滤，而不是把未经转义的 key 直接拼接为 CSS selector；这样 copy key 即使包含点号、方括号或引号也不会改变选择器语义。
- [ ] `format` 只处理 `[A-Za-z0-9_.-]+` token，缺失值替换为空字符串；`mount` 对 `[data-ui-slot]` 逐一设置 `textContent`，并使用 `replaceChildren` 或等价安全操作挂载克隆节点。
- [ ] 不在 `ui-copy.js` 中写任何中文或英文面向用户 fallback；找不到 key 时返回空内容，让 HTML 契约测试及时暴露遗漏。
- [ ] 运行 `node tests/test_ui_copy.js`、`node --check static/js/ui-copy.js` 和 Python 契约测试，确认读取器单元测试与静态扫描全部通过。
- [ ] 提交 `static/js/ui-copy.js`、对应 Node 测试和契约测试，提交信息为 `feat: add html-owned ui copy reader`。

## Task 4: 迁移用户页面为 HTML-first，并清理用户端不可达代码

**Files:** 修改 `templates/index.html`、`templates/ad_detail.html`、`static/js/main.js`、`static/js/ad-detail.js`、`static/js/ui-ux.js`、`static/js/service-status-ui.js`；删除用户端已确认无入口的 DOM/逻辑；更新 `tests/test_ui_ux.js`、`tests/test_main_page_navigation.js`、必要的用户端 Node 测试。

### 4.1 先锁定用户文案与访问门禁结构

- [ ] 先在 `tests/test_user_html_first.js` 增加失败断言：用户模板加载 `ui-copy.js` 后再加载业务脚本；每个导航页有静态标题；所有需要绑定账号/会员才能访问的页面预置 `data-page-access-gate`、标题、说明和绑定按钮；JS 不再包含页面标题对象或访问门禁 `innerHTML` 文案。
- [ ] 在 `templates/index.html` 建立 `#user-ui-copy[hidden]`，集中放置公共状态、按钮、导航、登录/绑定、课表/考试/成绩/评教/公告/服务/反馈/会员/邀请/提现/支付和访问门禁所需的固定 copy；日期星期、成绩类型、服务状态、订单/提现状态等枚举也放在 HTML copy 节点中。
- [ ] 为加载中、失败、空数据、重试、复制成功/失败、确认/取消、登录/绑定失败、无权限、分页和表单校验等会由 JS 显示的状态提供 `data-ui-template` 或 `data-ui-copy`；每个可见文案都使用明确 key，不能依赖 JS 默认值。
- [ ] 在 `ad_detail.html` 增加 `#ad-ui-copy[hidden]`，在 `index.html` 已有文案不足以覆盖广告详情时只放广告详情页面使用的 copy；保留广告正文/标题这类服务端或 API 动态数据为动态值。
- [ ] 将 `ui-copy.js` 作为 `main.js`、`ad-detail.js` 和 `ui-ux.js` 之前的依赖加载；脚本引用不再带固定版本参数。

### 4.2 迁移导航、门禁和状态渲染

- [ ] 在 `main.js` 增加无文案的 `uiText`/`renderUiState` 适配器，所有取值都来自 `URPCopy`；适配器缺失 copy 时只返回空字符串或不渲染节点，不能内置中文 fallback。
- [ ] 重写 `switchPage()` 的标题来源：从当前导航项或目标页的 HTML 标题节点读取，不再维护 JS `titles` 映射；切页仍保留现有激活态、URL/hash 和数据加载行为。
- [ ] 将 `setPageAccessLock()` 改为只切换预置门禁节点的 `hidden`/ARIA 状态、按钮事件和页面内容，不再通过 `innerHTML` 创建固定门禁文案；更新 `ui-ux.js` 的 `getGuestAccessCopy` 为从传入 root/`URPCopy` 读取 copy 的逻辑函数。
- [ ] 更新 `tests/test_ui_ux.js`，用 fake copy provider/HTML root 验证不同页面 key 映射与空 key 行为，不再把中文文案写进 JS 测试期望；更新导航测试验证 HTML 标题变化能够反映到 `#page-title`。

### 4.3 迁移用户端固定文案

- [ ] 按功能块逐组替换 `main.js` 中的固定字符串：认证与绑定、首页/公告、课表、考试、成绩、评教、服务状态、反馈、会员支付、邀请返佣、订单和提现；按钮/提示/表头使用 `uiText` 或 HTML template，账号、课程、分数、金额、日期等仍使用动态数据。
- [ ] 将星期数组、成绩类型名称、课程状态和支付/提现状态标签改为 HTML copy key；不要把枚举重新写成 JS 中文数组。
- [ ] 将 `innerHTML` 中的固定标签拆成 HTML template 的静态节点和 `data-ui-slot` 动态节点；动态值全部通过 `textContent` 或现有安全转义函数填入。
- [ ] 将 `ad-detail.js` 中复制成功/失败、返回、加载失败等固定文案改为 `URPCopy` 读取；不改变广告数据获取和分享/复制行为。
- [ ] 扫描 `static/js` 业务脚本，剥除注释后确认没有中文字符串字面量；确认所有固定 copy key 在 `index.html` 或 `ad_detail.html` 中存在且唯一。

### 4.4 删除用户端没有前端入口的代码

- [ ] 删除 `main.js` 中“其他专业课表”的 modal、按钮绑定、请求函数和渲染分支；从 `index.html` 删除 `other-major-modal` 及相关不可达控件；删除对应无用 CSS。
- [ ] 删除 `main.js` 末尾的对分易签到代理相关函数、按钮绑定和 `/api/sign/*` 请求；确认用户模板没有签到导航、DOM ID 或隐藏入口。
- [ ] 删除前端的换绑通知轮询/弹窗与 `/api/rebind_notified` 调用，但保留实际可用的 `/api/request_rebind` 提交流程和绑定表单；更新 `checkBindStatus` 的响应处理以兼容去掉通知字段。
- [ ] 运行 `node --check` 检查全部用户脚本，运行 `node tests/test_main_page_navigation.js`、`node tests/test_ui_ux.js`、广告详情、服务状态、课表和邀请 URL 测试；确保删除不可达功能没有破坏十个保留用户页面。
- [ ] 提交用户模板/脚本/CSS/测试修改，提交信息为 `refactor: make user UI content editable in html`。

## Task 5: 迁移管理员页面为 HTML-first，并移除旧审批页签

**Files:** 修改 `templates/admin.html`、`static/js/admin.js`、`static/js/ui-ux.js`（若共用适配器）、`static/css/admin.css`；更新 `tests/test_admin_ux.js` 和新增 `tests/test_admin_html_first.js`。

- [ ] 先在管理员契约测试中增加失败断言：管理员模板加载 `ui-copy.js`；只存在九个有效页签（用户、广告统计、在线监控、公告、服务状态、反馈、会员、提现、配置）；不存在 pending 页签或审批 modal；管理员登录探测使用 `/api/admin/users` 而不是旧 pending 接口。
- [ ] 在 `admin.html` 增加 `#admin-ui-copy[hidden]`，放入登录、九个页签、表头、按钮、空/加载/失败/确认/删除/保存/审核结果和表单提示等固定 copy；把动态用户/公告/反馈/会员/提现数据留给 slot。
- [ ] 将 `admin.js` 的登录验证请求改为 `/api/admin/users`，保留 `X-Admin-Key` 头和登录态；错误提示通过 `URPCopy` 获取，不在脚本内内置文案。
- [ ] 从 `admin.js` 删除 `currentRequestId`、待审批加载、批准/拒绝函数、审批 modal 渲染和 pending 页签分支；从 `admin.html` 删除 pending tab、待审批容器、approve modal 及其事件钩子。
- [ ] 将管理员动态表格、弹窗和 toast 中的固定 HTML 结构改为模板/`adminText`/slot；动态值一律以文本节点填入，尤其是用户反馈、公告和提现信息。
- [ ] 从 `admin.css` 删除仅服务于审批页签/modal 的规则；先用 `rg` 对照 `admin.html` 和 `admin.js` 的 class/id，保留仍被九个有效页签使用的样式。
- [ ] 更新管理员 UX 测试以覆盖九个页签、登录探测和 HTML copy root；运行 `node tests/test_admin_html_first.js`、`node tests/test_admin_ux.js`、`node --check static/js/admin.js`。
- [ ] 提交管理员模板/脚本/CSS/测试修改，提交信息为 `refactor: make admin UI content editable in html`。

## Task 6: 删除后端确认不可达路由和实现，保留外部契约及历史数据

**Files:** 修改 `app.py`、`routes/data_routes.py`、`routes/auth_routes.py`、`routes/admin_routes.py`、`services/urp_service.py`、`services/logging_service.py`、`constants.py`；删除 `routes/sign_routes.py`；更新后端单元测试。

- [ ] 先新增/补充 Python 删除契约测试，使用应用路由表和 `rg` 范围扫描验证：删除清单中的路径、Blueprint 注册、旧函数名和前端调用字符串在 `app.py`、`routes/`、`services/`、`static/`、`templates/` 中均不存在；文档中的审计记录不计入代码扫描。
- [ ] 从 `app.py` 删除 `sign_routes` 的导入和 Blueprint 注册；删除 `routes/sign_routes.py`。同时从 `constants.py` 删除只为签到代理服务的 `DUIFENE_BASE_URL`/签到白名单等常量；先用 `rg` 确认没有保留代码引用。
- [ ] 从 `routes/data_routes.py` 删除旧 `/api/grades` 路由、相关 `get_grades` 导入以及“其他专业课表”两个路由和仅供它们使用的导入；保留 `/api/grades/current`、`latest_summary`、`semesters`、`by_semester`、`failed`、`gpa`、`exam_sessions`、`exam_scores` 等现行成绩接口。
- [ ] 从 `services/urp_service.py` 删除只被旧 `/api/grades` 使用且调用不存在 `score_query()` 的 `get_grades`；确认其他成绩服务没有依赖它。
- [ ] 从 `routes/admin_routes.py` 删除 `/api/admin/invitation_debug` 及仅被该调试接口使用的导入/局部逻辑；保留真实邀请、会员、提现和佣金统计业务。
- [ ] 从 `routes/auth_routes.py` 删除 `/api/rebind_notified` 及换绑通知查询逻辑；保留 `/api/check_bind`、`/api/login`、`/api/request_rebind` 和设备绑定校验。`request_rebind` 的现有立即解除绑定语义不在本任务内改变。
- [ ] 从 `admin_routes.py`、`auth_routes.py`、`data_routes.py`、`logging_service.py` 清理已删除路径的日志映射、导入和死分支；用 `rg` 确认没有为了兼容而留下可调用别名。
- [ ] 不改 `database.py` 的 `pending_requests`、`request_logs` 建表/迁移，也不删除已有数据；在代码注释或审计文档中说明它们属于历史兼容表。
- [ ] 更新受影响的后端测试 fixture/断言，运行 `python -m unittest tests -v` 前先运行删除契约测试；确认保留的支付回调、快捷 API、邀请/提现、绑定和管理员有效接口仍能被测试调用。
- [ ] 提交后端删除修改，提交信息为 `refactor: remove unreachable legacy endpoints`。

## Task 7: 更新功能清单、审计结论和维护说明

**Files:** 修改 `docs/PROJECT_CODE_AUDIT_REPORT.md`；必要时新增 `docs/PROJECT_FUNCTION_INVENTORY.md`，但不重复维护两份相互矛盾的清单。

- [ ] 依据清理后的路由表重新生成“保留功能清单”：公共页面/用户十项功能、会员/邀请/提现闭环、广告详情、快捷 API、管理员九个页签、支付回调和认证边界；每项写明前端入口、主要 API/服务和访问权限。
- [ ] 增加“已删除功能清单”：签到代理、其他专业课表、旧 `/api/grades`、邀请调试接口、旧换绑通知/审批链；标明删除原因是无前端入口、重复、已失效或已被当前流程替代。
- [ ] 增加“为什么修改 HTML 不生效”结论：生产配置没有启用 Jinja 自动重载，模板/静态响应没有 no-store，资源 query string 固定且业务 JS 会覆盖页面标题/门禁等节点；记录修复后的缓存策略和 HTML-first 文案规则。
- [ ] 增加维护规则：新增固定文案先写入对应模板的 `data-ui-copy`/`data-ui-template`，JS 只读 key；新增路由必须有前端入口、测试和认证装饰器；历史数据库表不得因代码清理而删除。
- [ ] 运行路由清单脚本，把实际有效路径与文档清单逐项对照；不得把测试专用路径、数据库兼容表或文档提到的已删除路径误列为现行功能。
- [ ] 提交文档修改，提交信息为 `docs: refresh post-cleanup function inventory`。

## Task 8: 全量验证与交付前审查

**Files:** 不新增生产代码；根据验证结果只修复对应测试或文档。

- [ ] 运行全部 Python 手动测试：`python -m unittest discover -s tests -p "test_*.py" -v`；不能使用 `pytest` 代替项目约定的测试入口。
- [ ] 用 PowerShell 循环运行全部 Node 测试文件 `tests/test_*.js`，每个测试单独执行并记录失败文件；随后对 `static/js` 全部脚本运行 `node --check`。
- [ ] 运行 `git diff --check`；运行 `rg` 检查删除清单路径、`sign_routes`、`get_grades`、`other_major`、`currentRequestId`、旧审批 DOM ID 和业务脚本中文字符串是否残留。扫描结果允许出现在设计/审计文档和历史测试说明中，但不得出现在可执行代码或模板脚本引用中。
- [ ] 使用 Flask test client 验证 `/`、`/admin`、`/ad-detail` 返回 200，缓存头完整；修改一个临时 HTML 文案后再次请求并恢复该文案，确认响应内容随模板改变，且不留下临时文件或临时配置。
- [ ] 输出最终路由数量、删除路径、保留功能数量和测试统计；检查 `git status --short`，确保没有意外生成数据库、缓存、截图或大文件。
- [ ] 在完成声明前重新读取关键 diff，确认未删除支付回调、快捷 API、会员/邀请/提现和历史数据库 schema；完成 `verification-before-completion` 要求的证据核验后再交付。
- [ ] 若所有验证通过，提交最终整体验证记录（仅提交测试/文档变更，不提交生成物），提交信息为 `test: verify html-first cleanup`；若某项失败，保留失败输出并继续修复，不以“已有基线失败”代替验证。

## 完成标准

- [ ] 用户、管理员和广告详情页面的固定文字均可在对应 HTML 的 copy/template 节点中修改，业务脚本不再覆盖页面静态标题或门禁文案。
- [ ] 关闭 debug 或直接运行 Flask 时，HTML 和本地静态资源修改都能在下一次请求中看到，浏览器不再使用旧缓存。
- [ ] 所有确认无前端入口的签到、其他专业课表、旧成绩、旧审批/换绑通知和调试接口已从可执行代码中移除，历史数据库表仍完整保留。
- [ ] 保留功能的前端入口、API、认证边界和现有手动测试全部可验证，Python/Node 语法、契约、全量测试和 `git diff --check` 均通过。
- [ ] 审计文档与实际路由表一致，能够让后续维护者知道哪些是现行功能、哪些是历史兼容数据、哪些路径已被永久清理。
