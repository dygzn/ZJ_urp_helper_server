# 登录失败提示修复

## 问题来源

用户反馈：各种原因登录不成功时，前端总显示“登录失败，最后页面……”而不是可理解的原因。

已确认的链路是 `urp/login.py:login()` 在重试结束后把 `_html_hint(last_response)` 拼入返回消息；该摘要包含页面类型、完整 URL、Content-Type 和部分 HTML。`services/urp_service.py:urp_login()` 把消息返回给 `/api/login`，`static/js/modules/auth.js:handleLogin()` 直接以 textContent 显示 message。前端没有切到所谓“最后页面”，它展示的是后端拼出的调试信息。

另有两个相关问题：VPN 初始化在 login 的异常捕获范围之外；OCR 和普通异常会把依赖详情或原始异常直接返回。明确的密码拒绝和验证码失败此前也没有区分，可能重复提交同一组错误凭据。

## 已实施

- 对明确错误容器、直接执行的 alert、HTTP 状态识别账号密码错误、账号受限、验证码错误、维护和服务不可用。
- 排除明确 hidden、aria-hidden、display:none、visibility:hidden 的节点及祖先、template/noscript、非执行脚本和外链脚本的内联正文；不把未执行的校验函数或隐藏模板当作本次错误。
- 明确账号密码/受限等拒绝后停止重复提交，保留验证码重试及重试后成功的路径。未知错误保留“暂时无法确定原因”的语义，不一概归咎于密码。
- 网络超时、连接失败、验证码图片不可用、识别服务异常、登录页异常和 VPN 异常各给出固定中文提示，不回传上游 HTML、完整 URL、票据或原始异常。
- VPN 初始化纳入异常捕获；服务层构造等兜底异常也给出安全提示。新增日志只记阶段、原因分类及 HTTP 状态；原有显式开启的调试文件机制未修改。
- 保留 `(success, message, cookies)` 返回约定、认证权限、持久/临时登录、成功后的页面行为及支付代码。前端继续使用现有带 role=alert 的错误区域，没有修改 JavaScript、CSS、模板或静态资源，因此无需静态资源版本更新。

## 验证

- 新增 `tests/test_login_failure_messages.py`：19 项通过，覆盖明确拒绝、验证码重试成功、未知页面、网络、VPN、OCR、API 失败不落盘及服务兜底；原始18项先复现16失败和1个未捕获超时，已有成功重试用例保持通过。
- 独立复核指出隐藏错误模板会误判并阻止验证码重试；补充8种相关子例，先复现4项失败，过滤后全部通过。
- Python 完整测试150项：148通过，2项因未生成快捷指令源/签名文件而失败，与原有基线一致。显式排除这2项产物验收后148项全部通过。
- `node --test tests/*.js`：259通过、8项跳过、0失败；修改Python、新增浏览器脚本语法及diff空白检查通过。
- 新增 `tests/browser_login_errors.cjs`，使用真实本地 Chrome 和项目页面/资源，所有API均拦截。1440桌面明亮、320手机深色、390玻璃明亮/深色共4组合通过：空提示、请求等待、5种失败、重试清理旧错误、键盘提交、焦点/原有关闭约定、文本横向边界及无页面脚本异常。
- 实际查看桌面与手机截图；最长未知原因提示完整换行，错误与登录按钮均可见。截图在本worktree `artifacts/login-errors-preview/`，不进入代码提交。
- 使用合成账号、临时目录和离线响应；没有真实账号或真实教务联调。修复的是错误识别与反馈，外部教务/VPN真实不可用不会因此自行恢复；未识别的新页面会保留通用提示。

原有产物失败为 `test_shortcut_artifact.ShortcutArtifactTests.test_menu_requests_and_import_setup` 与 `test_signed_file_is_available`。

## 页面审计与设计判断

按项目要求应用 [design-taste-frontend skill](/Users/dygzn/.codex/skills/design-taste-frontend/SKILL.md)，读取 DESIGN.md 和模块指引。判断为面向学生的现有登录反馈修复，沿用当前字体、语义颜色、控件和明暗模板，参考参数3/1/5。审计覆盖学号/密码、免责声明、持久/临时模式、访客入口、行内错误和成功/失败分支；仅改错误内容来源，不引入新视觉系统或营销页布局。截图使用origin/main已有外观，不包含用户尚未提交的外观修改。

## 审核位置

- 分支：`codex/fix-login-errors`；基线：`cd1b934ca926803016991cbd9a573d29c9ee16b8`。
- worktree：`/Users/dygzn/.codex/worktrees/fix-login-errors/web`。
- [与main比较](https://github.com/dygzn/ZJ_urp_helper_server/compare/main...codex/fix-login-errors)
- 主工作区原有3个外观文件未提交修改保持原样。此次没有合并、部署或修改此前待审支付/夜间分支。
