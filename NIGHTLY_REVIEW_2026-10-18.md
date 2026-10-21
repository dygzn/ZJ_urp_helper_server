# URP 夜间代码审查 · 2026-10-18

北京时间执行。本轮交付聚焦“动态文本注入防护”：保护用户端评教与管理员提现审核，不改变接口协议、权限、金额或业务操作。

## 基线、隔离与历史去重

- 已成功 fetch，并通过 `git ls-remote --symref origin HEAD` 重新确认默认分支 `main`，最新基线 `aa38ac509222c086862505a8e768f36f513bf5cf`。
- 原生隔离 worktree：`/Users/dygzn/.codex/worktrees/nightly-2026-10-18/web`。
- 本次分支：`codex/nightly-2026-10-18`。原主工作区 `main` 开始时干净，未在其中修改源码。
- 10-17 在线监控和登录提示修复已合入；10-15 支付、10-16 请求故障修复仍待审，本次未重复实现。已核对 URL 会话隔离、HTML 清理、小程序等旧分支，本次输出安全改动没有重复其实现。
- 不合并、不部署、不强推、不删除历史待审分支。提交身份为 Codex。

## 已实施：后台提现存储型注入

证据链：`routes/member_routes.py` 的提现入口接受非空姓名和收款账号并保存；`static/js/admin.js` 原先直接将这些用户字段拼入后台 `innerHTML`。有提现余额的用户可提交 HTML/事件属性，在管理员查看记录时触发脚本，风险高于普通文本显示错误。

修复 `loadAdminWithdrawals()` 的八处输出：申请学号、姓名、收款账号、状态、申请/审核时间及接口/请求错误，复用后台既有 `escapeHtml()`，作为纯文本展示。金额仍按原口径格式化，数据库整数 ID、通过/拒绝按钮、确认提示和管理员请求头保持原样。没有限制合法姓名或收款账号，也没有修改存储内容。

新增四项 Node 回归，原代码四项均因未转义标记而失败；修复后全部通过。真实浏览器确认恶意标记只显示为文字、未生成图片或执行事件；取消不提交，通过和拒绝仍分别向原端点发送 POST。

## 已实施：评教列表、预览与提示注入

`evaluation.js` 原先将上游课程名、教师名和成功/空结果消息直接写入 `innerHTML`。本轮复用 `schedule-layout.js` 已有的共享 `escapeHtml()`，覆盖待评列表、完整评教的提交前预览，以及查询/三条提交路径的动态成功提示。错误分支原有 `textContent` 保留。

- 课程对象和提交 JSON 保留原始内容，转义只发生在显示边界。
- 手机真实渲染发现长成功消息可撑宽 320px 页面，给现有 `.evaluation-result` 补充 `overflow-wrap: anywhere`，不截断文字、不改布局结构。
- `main.js` 的评教模块导入增加独立版本 `v=20261018-safe-text`。入口、后台脚本和共享 CSS 继续使用现有 `static_versioned()` 纳秒修改时间版本，既有缓存会获取修复。
- 新增七项 Node 回归，原代码七项均失败，修复后全部通过；独立复核通过进程内基线替换再次证实红灯有效。

## 设计审计与实际渲染

使用技能：**design-taste-frontend**，来源为本机已安装规范：
`/Users/dygzn/.codex/skills/design-taste-frontend/SKILL.md`。

应用它的先审计、保留信息架构、完整状态、明暗和手机验证方法。该技能主要面向营销页面；此处是教务工具和管理后台，按用户要求与 DESIGN.md 使用现有原生 CSS、组件与 Token。用户端判断 `3 / 2 / 5`，后台 `3 / 1 / 7`。本次没有新增外观或替换设计系统，因此无需安装或在线选择新的外观技能。

`DESIGN.md` 原本被 Git 忽略，本次按“同步设计规范”的要求首次纳入当前完整规范，仅补充两处输出安全/换行说明；其余是用户已有规范，不代表本轮重新实现页面。新测试和已有本地测试辅助器同样通过显式白名单纳入，不提交整批本地测试或脚本。

真实 Chrome 完整模块与模板渲染，全请求拦截，无真实教务或支付访问：

- 评教：5 套现有外观 × 明亮桌面 1440px / 深色手机 320或390px，共10组；初始空白、加载、长课程/教师名、列表、提交前预览、成功、空结果、错误、确认取消/Escape/遮罩、键盘与焦点恢复、三种提交路径、原始载荷、模块版本均通过。
- 提现：5 套现有外观 × 明亮桌面1440px / 深色手机320px，共10组；真实登录界面使用明确的离线假密钥，加载、长账号、错误、空列表、手机字段、取消/通过/拒绝、原管理员请求头均通过。
- 两组均无页面脚本异常、无注入元素或事件执行、无页面横向溢出。检查设置了减少动态效果；没有新增动效。已实际查看桌面/手机截图。
- 共120张截图保存在本 worktree 的 `artifacts/evaluation-text-preview/` 与 `artifacts/withdrawal-text-preview/`，不进入源码提交。可重跑随提交的两个浏览器脚本生成。
- 浏览器脚本需要 Playwright 和本机 Chrome，可用 `PLAYWRIGHT_MODULE` 指向已安装模块。本轮使用 `/Users/dygzn/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright`。

## 验证结果

1. `node --test tests/*.js`：278项，270通过、8跳过、0失败。跳过的是现有维护页 Playwright 用例；本次新增11项均执行通过。
2. `/private/tmp/urp-nightly-2026-10-18-venv/bin/python -m unittest discover -s tests -p 'test_*.py'`：178项，176通过、2失败、0错误。未使用 pytest 批量运行旧手动脚本。
3. 两个既有失败均来自 `test_shortcut_artifact.ShortcutArtifactTests`：`test_menu_requests_and_import_setup` 缺构建源，`test_signed_file_is_available` 缺签名文件。是已知生成产物缺失，本次未修改 Python、生成或提交这些产物。初次 Python 环境缺 OCR 模块导致的错误已在临时环境补齐 requirements 后消除。
4. 全仓初始盘点106个跟踪文件；其中代码/配置98个，约40094行（含景观文件内嵌第三方库）。36个生产Python与3个跟踪Python测试、39个JS、1个CJS、5个HTML、11个CSS均进入清单。另检查本地维护的 tests/scripts。
5. Python AST共61文件、初始100个本地/跟踪 JS-CJS语法，以及本次新增4个JS-CJS文件语法通过；3个Jinja模板、5段内联脚本、importmap/JSON和shell语法通过。
6. 新增测试已独立只读复核，并对原基线复验11项均失败；两轮复核均无Critical/Important阻塞项。
7. 最终diff、静态资源引用、暂存白名单和敏感文件检查通过。未提交账号密码、真实密钥、Cookie、数据库、日志或用户数据；测试中的身份/密钥全部为离线假值。

## 覆盖范围与待处理事项（没有在本轮实施）

覆盖清单包含认证/设备绑定、临时会话及Cookie路径、缓存、个人课表与撤销、SQLite/MySQL迁移、教务爬取、支付/邀请/提现、后台、用户端模块、五套外观、维护页、部署/生成脚本及离线测试。采用全文件盘点与静态扫描，重点链路阅读和现有回归结合历史审查；未逐行穷尽大体量CSS、手势及内嵌第三方库。未做真实学校/VPN/OCR识别、真实MySQL并发、真实支付或生产部署验证；没有浏览器遍历所有业务页面。

后续优先项：

- 先审核已有10-15支付、10-16请求超时/评教查询失败分支；其问题仍在main，但本轮避免重复修复。用户已确认2.99/2.98浮动实付为正常机制，本轮没有改支付规则。
- `urp/query.py:check_evaluation()` 对HTTP200登录页/未知页面可能仍误报正常空列表，需真实结构脱敏夹具和页面识别回归；传输失败处理已经位于10-16待审分支。
- 后台其他显示路径仍有未转义动态消息，公告标题/正文仍直接插入HTML；公告可能依赖富文本，需要先明确内容约定并单独审计，不宣称本轮消除了全站XSS。
- URL与Cookie隔离、配置脱敏先核对既有待审 `codex/urp-url-session-isolation`，避免重做；教务请求仍有 `verify=False`，需评估学校证书及兼容性再收紧。
- 快捷指令生成源/签名文件验收仍失败，需要恢复生成产物。

## 审核入口与交付状态

- 本地：在本worktree查看 `git diff origin/main...codex/nightly-2026-10-18` 和本报告；提交哈希使用 `git log -1` 查看。
- 远程差异：https://github.com/dygzn/ZJ_urp_helper_server/compare/main...codex/nightly-2026-10-18
- 手动草稿PR入口：https://github.com/dygzn/ZJ_urp_helper_server/pull/new/codex/nightly-2026-10-18
- GitHub连接器当前搜索仓库返回422，提示仓库不存在或无访问权限。提交后仍尝试推送并创建草稿PR，最终推送/PR结果会在任务交付消息中明确记录；没有PR时无法attach或添加codex/codex-automation标签。
