# 无用文件与运行产物清理设计

## 目标

删除已经确认不参与项目运行、测试、部署或维护的文件，并阻止运行时调试产物再次进入 Git。清理不得移除现有业务功能、用户数据、数据库或尚未合并的开发工作区。

## 判定标准

文件仅在满足以下条件时删除：

- 没有被 Python、JavaScript、HTML、CSS、测试或部署配置引用；或
- 是可以由程序重新生成的运行时调试快照、日志、缓存；或
- 是已经被正式实现替代的旧备份、空文件、已移除功能的遗留样例；或
- 是已经合并到 `main` 且工作区干净的临时 Git worktree。

历史设计文档、实施计划、代理说明、有效测试、数据库、用户缓存和可能被外部客户端调用的 API 不因缺少当前页面入口而删除。

## 删除清单

### Git 已跟踪文件

- `.htaccess`：仅含占位注释，没有 Apache 规则。
- `.superpowers/sdd/progress.md`：过期的临时开发进度。
- `score.py`：0 字节且无引用。
- `static/js/main.js.backup`：已被当前 `main.js` 替代的旧备份。
- `static/samples/sample_paper.docx`：已移除论文功能的遗留样例。
- `data/admin_key.txt`：空文件，当前管理员密钥不从该文件读取。
- `data/last_jiaowu_after_login.html`
- `data/last_jiaowu_captcha.gif`
- `data/last_jiaowu_login.html`
- `data/last_vpn_auth_response.txt`
- `data/last_vpn_portal_response.html`
- `data/pay_notify.log`

其中 `data/last_*` 和日志是运行产物；删除仓库副本不改变程序生成调试文件的能力。

### Git 已忽略的本地产物

- 根目录、`routes/`、`services/`、`tests/`、`urp/` 下的 `__pycache__/` 和 `.pyc`。
- `test/test_payment_secrets.py` 及删除后为空的 `test/`：该旧测试针对当前不存在的 `get_pay_secret_key()` 接口。
- `.worktrees/admin-service-status`：分支已合并到 `main` 且工作区干净；使用 `git worktree remove` 清理，并删除已合并的本地分支 `codex/admin-service-status`。

## 同步代码和配置清理

- 从 `requirements.txt` 删除没有任何代码导入的 `python-docx`。
- 从 `constants.py` 删除未使用的 `ADMIN_KEY_FILE`。
- 从 `services/config_service.py` 删除对应的无用导入。
- 从 `AGENTS.md` 和 `CLAUDE.md` 删除“管理员密钥存于 `data/admin_key.txt`”的过期说明。
- 在 `.gitignore` 中加入：
  - `/data/admin_key.txt`
  - `/data/last_*`
  - `/data/*.log`

## 明确保留

- `data/config.json`、`data/urp_helper.db` 和 `user_data/`。
- `.worktrees/urp-url-session-isolation` 及其分支，因为它尚未合并。
- `routes/sign_routes.py` 和相关签到代码，因为 API 仍可被外部客户端直接调用。
- `URP.py` 兼容导出文件及所有包 `__init__.py`。
- `docs/superpowers/` 下的历史设计和实施计划。
- `tests/` 下当前可运行的 Python、Node 测试。
- `AGENTS.md`、`CLAUDE.md`、IDE 工作区和本地代理配置。

## 验证

清理后执行：

1. `python -m unittest discover -s tests -p "test_*.py" -v`
2. `node --test tests/test_schedule_weekend_visibility.js tests/test_service_status_ui.js`
3. `node --check static/js/main.js`
4. `node --check static/js/admin.js`
5. `node --check static/js/schedule-layout.js`
6. `node --check static/js/service-status-ui.js`
7. `python -c "import app; print(len(app.app.url_map._rules))"`
8. `git diff --check`

成功标准：全部测试通过、JavaScript 语法检查无错误、Flask 可以导入并注册路由、Git 无空白错误，且删除清单不存在、保留清单仍存在。

## 恢复方式

Git 已跟踪文件在提交前可通过暂存区检查，在提交后可从清理提交的父提交恢复。缓存、旧调试快照和已合并 worktree 不作备份；其中调试快照会在相关流程再次运行时重新生成。
