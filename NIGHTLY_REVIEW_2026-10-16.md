# URP 夜间审查与改进 · 2026-10-16

审查时间：北京时间 2026-10-16 凌晨。基线：`origin/main` / `cd1b934ca926803016991cbd9a573d29c9ee16b8`。
交付分支：`codex/nightly-2026-10-16`。本报告与代码、回归测试一起提交，提交哈希以本分支 `git log -1` 为准。

## 已实施：教务请求故障不再被当作空数据

1. **缺省请求超时。** `urp/query.py:47` 的统一请求入口对省略或显式传入 `None` 的 timeout 设置 10 秒。此前不及格成绩、绩点、评教、当前/历史课表、考试等调用未设超时，上游无响应时可能长期占用服务线程。调用方已有的较短超时、连接/读取超时元组保持原样，VPN 重试沿用同一参数。
2. **拒绝 HTTP 错误页。** 原有 VPN 失败判断和恢复之后执行 `raise_for_status()`，初次及恢复后的最终响应均检查。此前 401/403/5xx 可能被 GPA 或评教解析成成功空数据。VPN 返回 403 登录页时仍先恢复，最多两次查询；网络超时不增加重试，避免额外重放提交。
3. **区分评教失败与正常空列表。** `routes/data_routes.py:335` 将服务层的 `None` 失败值返回为 `success=False`，保留正常 `[]` 的原有成功空结果。服务层约定保持，小程序已有的 `None` 失败分支继续兼容。网页使用原有错误展示分支，故障时不会继续将其解释为“没有待评课程”。

生产代码合计新增 **7 行**，仅涉及上述两个文件。没有修改页面、样式、静态资源、权限、会员条件、课程字段或支付逻辑，因此没有外观新增、资源版本调整、DESIGN.md 修改或页面截图。

**实际边界：** requests 的 10 秒是连接/读取等待参数，并非整个业务的 10 秒总时限；VPN 恢复、第二次请求及多课程查询会另有耗时。上游 HTTP 200 的异常内容仍需要各解析器识别；本次没有宣称解决所有异常页面。

## 审查范围与历史去重

- 已读取本地 AGENTS.md、完整 DESIGN.md、CSS/SPA 模块指引及上一轮自动审查记忆。
- 已成功 fetch，并通过远程 HEAD 核实默认分支仍为 main，最新默认分支仍为上述基线。原生隔离 worktree：`/Users/dygzn/.codex/worktrees/nightly-2026-10-16/web`。
- 已核对本地/远程分支与旧 worktree。昨天的 `codex/nightly-2026-10-15` 支付修复仍未合入 main；URL/Cookie 隔离、HTML 清理、小程序等既有 Codex 分支也已比较，未重复实现其改动。
- 主工作区 main 上 `static/css/liquid-glass.css`、`static/css/taste-theme.css`、`static/js/appearance.js` 的未提交修改原样保留；未在 main 改代码。
- 全仓库清单 99 个跟踪文件，约 3.92 万行维护源码（包括部分内嵌第三方代码）；静态盘点覆盖 36 Python、39 JavaScript、5 HTML、10 CSS、JSON、依赖和部署文档。另检查本地被忽略的 tests/、scripts/；仅为验证复制至隔离目录，没有复制 data/、user_data/ 或密钥配置。
- 深入追踪：认证/会员装饰器、设备绑定和临时会话、Cookie 登录/自动更新、教务请求与解析、成绩/课表/考试/评教、SQLite/MySQL 适配与迁移、支付/邀请/提现、后台配置与在线监控、微信与实验服务；前端检查模块生命周期、请求取消、评教错误展示、动态 HTML 输出、焦点及主题分层约定。该范围包括结构和风险点审查，不代表每行大体量 CSS/课表手势代码都已穷尽。
- 第三方库、生成产物与用户运行数据排除。没有真实教务/VPN/OCR 联调、真实支付、真实 MySQL 并发或浏览器视觉全遍历；前端未修改，无视觉验收结论。

## 验证证据

| 检查 | 结果 |
| --- | --- |
| 新增 `tests/test_urp_query_failures.py` | 12 项通过；原始代码先观察到 13 个子例断言失败、0 个测试错误，再修复转绿 |
| 完整 Python unittest 基线 | 131 项：129 通过，2 项快捷指令产物缺失失败 |
| 修改后的完整 Python unittest | 143 项：141 通过，同样的 2 项产物缺失失败，无新增失败 |
| 明确排除上述产物验收后 | 141 项离线用例全部通过 |
| `node --test tests/*.js` | 267 项：259 通过，8 项维护页 Playwright 用例跳过，0 失败 |
| 语法/结构 | 36 个跟踪 Python、22 个本地 Python 测试/脚本 AST；JSON；39 个跟踪 JS、58 个本地 JS/CJS；3 个 Jinja 模板；模板内联 JS 和维护页/景观共 5 个内联脚本；维护页 importmap JSON；更新脚本 bash 语法均通过 |
| 独立只读代码复核 | 无 Critical / Important / Minor 项；另临时补验评教提交超时不重放、全部已评仍成功空列表，均通过 |
| 最终提交检查 | diff 空白检查、逐文件白名单检查；仅代码、合成数据测试和本报告；未加入账号、密码、Cookie、数据库、日志或生产配置 |

缺失产物用例：`test_shortcut_artifact.ShortcutArtifactTests.test_menu_requests_and_import_setup` 与 `test_signed_file_is_available`。原因是本隔离工作区没有生成的快捷指令源/签名文件；未运行生成或签名，不能声称完整测试全绿。测试没有通过 pytest 批量运行旧手动脚本。

新增回归使用真实 requests Session/Response、传输层离线适配器、真实 Flask 与临时 SQLite。外网传输被替换，会员和课程均为合成数据；未访问真实账号、真实支付或生产数据。

## 未解决发现：仅记录，未随本次修复

- `static/js/modules/evaluation.js:42,103` 等将课程、教师直接插入 innerHTML，建议下一轮优先处理 HTML 注入并按前端规范完成实际渲染验证。
- `services/online_service.py:22` 的 touch 只累积设备，清理依赖后台 snapshot；后台长时间无人打开时过期记录可能持续占用内存，需要独立验证清理策略。
- `urp/query.py:249` 的评教解析对 HTTP 200 的登录/未知页面仍可能产生空列表，应增加可靠页面标识和对应夹具；本次只解决传输错误与失败值传播。
- 部分后台配置写入返回未脱敏 config；URL 校验、缓存/登录隔离问题与既有 `codex/urp-url-session-isolation` 分支重叠，应先审核该分支，避免重复修复。
- 教务 SSL 校验仍有关闭点；支付平台下单与本地落单先后、支付链接复用等候选问题尚未完整复现。昨天已交付的支付状态/金额/超时竞态修复继续留在昨天分支审核。
- AGENTS.md 中“密码明文存储/支付密钥硬编码”等 Known Issues 已与现代码不完全一致：现有凭据加密与环境配置及对应测试已检查，本次没有重复修复。

## 审核入口与交付状态

本次不合并、不部署、不强推、不删除旧分支；保留 worktree 便于审核。

- [查看与 main 的差异](https://github.com/dygzn/ZJ_urp_helper_server/compare/main...codex/nightly-2026-10-16)
- [创建 PR 入口](https://github.com/dygzn/ZJ_urp_helper_server/pull/new/codex/nightly-2026-10-16)
- GitHub Connector 搜索开放 PR 返回 422（仓库不可见或无权限），因此开放 PR 的远端元数据无法完整核对。将继续尝试推送与创建草稿 PR，并在自动化交付消息和记忆中准确记录结果。

技能：使用 using-superpowers、using-git-worktrees、systematic-debugging、test-driven-development、writing-plans、executing-plans、verification-before-completion、requesting-code-review 做隔离、定位、测试和复核。用户已持续授权直接提交/推送与草稿 PR，常规选择按该授权自主执行；已有产物验收失败如实保留，不扩散为无关构建任务。
