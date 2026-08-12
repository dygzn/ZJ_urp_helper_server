# 无用文件与运行产物清理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除已确认无用的源码遗留、运行时调试产物、Python 缓存和已合并 worktree，并阻止这些产物再次进入 Git。

**Architecture:** 清理分为三层：先修正引用、依赖和忽略规则，再删除 Git 跟踪及本地缓存文件，最后清理已合并 worktree。删除前后均用精确文件清单和完整测试验证，现有业务代码、数据库、用户数据和未合并工作区保持不变。

**Tech Stack:** Git、PowerShell、Python 3、Flask、Node.js、原生 JavaScript

## Global Constraints

- 仅删除设计文档列出的文件和所有 `__pycache__`、`.pyc`。
- 保留 `data/config.json`、`data/urp_helper.db`、`user_data/`。
- 保留 `.worktrees/urp-url-session-isolation` 和 `codex/urp-url-session-isolation`。
- 保留签到 API、历史设计文档、有效测试和代理说明。
- 不改动任何业务接口或页面行为。
- 所有递归删除都在 PowerShell 中解析绝对路径，并验证目标位于 `E:\URP\web` 内。
- Git 跟踪文件可从提交历史恢复；本地缓存和已合并 worktree 不备份。

---

## File Structure

- `.gitignore`：忽略管理员密钥文件、登录调试快照和数据目录日志。
- `constants.py`：删除无用的 `ADMIN_KEY_FILE` 常量。
- `services/config_service.py`：删除无用的 `ADMIN_KEY_FILE` 导入。
- `requirements.txt`：删除未使用的 `python-docx` 依赖。
- `AGENTS.md`、`CLAUDE.md`：删除过期的管理员密钥文件说明。
- 设计文档列出的 12 个 Git 跟踪文件：删除。
- 所有 `__pycache__/`、`.pyc` 和旧 `test/`：删除本地产物。
- `.worktrees/admin-service-status`：移除已合并 worktree，随后删除对应本地分支。

### Task 1: 忽略规则、依赖和死引用

**Files:**
- Modify: `.gitignore`
- Modify: `constants.py`
- Modify: `services/config_service.py`
- Modify: `requirements.txt`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Produces: Git 不再跟踪新生成的 `/data/admin_key.txt`、`/data/last_*`、`/data/*.log`。
- Produces: 运行时代码不再暴露无用的 `ADMIN_KEY_FILE` 常量。
- Produces: 安装依赖不再包含未使用的 `python-docx`。

- [ ] **Step 1: 运行清理前断言并确认候选仍存在**

Run:

```powershell
$checks = @(
  (Select-String -LiteralPath requirements.txt -Pattern '^python-docx=='),
  (Select-String -LiteralPath constants.py -Pattern 'ADMIN_KEY_FILE'),
  (Select-String -LiteralPath services/config_service.py -Pattern 'ADMIN_KEY_FILE')
)
if ($checks.Count -ne 3) { throw '清理前引用状态与设计不一致' }
```

Expected: 退出码 0，三个待清理引用都存在。

- [ ] **Step 2: 使用补丁修改六个文本文件**

`.gitignore` 追加：

```gitignore
/data/admin_key.txt
/data/last_*
/data/*.log
```

`constants.py` 删除：

```python
ADMIN_KEY_FILE = os.path.join(DATA_DIR, 'admin_key.txt')
```

`services/config_service.py` 将导入改为：

```python
from constants import CONFIG_FILE
```

`requirements.txt` 删除：

```text
python-docx==1.1.0
```

`AGENTS.md` 和 `CLAUDE.md` 删除：

```text
- `data/admin_key.txt` — 管理员密钥（首次运行自动生成）
```

- [ ] **Step 3: 验证死引用消失且配置仍可导入**

Run:

```powershell
if (Select-String -Path constants.py,services/config_service.py,requirements.txt -Pattern 'ADMIN_KEY_FILE|python-docx') { throw '仍有死引用' }
python -c "from services.config_service import get_admin_key, get_config; print(bool(get_admin_key()), get_config().get('database', {}).get('type'))"
```

Expected: 输出 `True sqlite`，退出码 0。

### Task 2: 删除无用的 Git 跟踪文件

**Files:**
- Delete: `.htaccess`
- Delete: `.superpowers/sdd/progress.md`
- Delete: `score.py`
- Delete: `static/js/main.js.backup`
- Delete: `static/samples/sample_paper.docx`
- Delete: `data/admin_key.txt`
- Delete: `data/last_jiaowu_after_login.html`
- Delete: `data/last_jiaowu_captcha.gif`
- Delete: `data/last_jiaowu_login.html`
- Delete: `data/last_vpn_auth_response.txt`
- Delete: `data/last_vpn_portal_response.html`
- Delete: `data/pay_notify.log`

**Interfaces:**
- Consumes: Task 1 的忽略规则，保证调试文件重新生成后不进入 Git。
- Produces: 上述 12 个无效或可再生文件不再存在于工作树。

- [ ] **Step 1: 验证精确删除目标均在仓库根目录下**

Run:

```powershell
$root = (Resolve-Path -LiteralPath .).Path
$targets = @('.htaccess','.superpowers/sdd/progress.md','score.py','static/js/main.js.backup','static/samples/sample_paper.docx','data/admin_key.txt','data/last_jiaowu_after_login.html','data/last_jiaowu_captcha.gif','data/last_jiaowu_login.html','data/last_vpn_auth_response.txt','data/last_vpn_portal_response.html','data/pay_notify.log')
foreach ($relative in $targets) {
  $resolved = (Resolve-Path -LiteralPath $relative).Path
  if (-not $resolved.StartsWith($root + [IO.Path]::DirectorySeparatorChar)) { throw "目标越界: $resolved" }
}
```

Expected: 退出码 0，所有目标存在且位于仓库内。

- [ ] **Step 2: 删除精确目标**

Run:

```powershell
git rm -f -- .htaccess .superpowers/sdd/progress.md score.py static/js/main.js.backup static/samples/sample_paper.docx data/admin_key.txt data/last_jiaowu_after_login.html data/last_jiaowu_captcha.gif data/last_jiaowu_login.html data/last_vpn_auth_response.txt data/last_vpn_portal_response.html data/pay_notify.log
```

Expected: Git 将 12 个目标标记为删除；当前修改中的调试快照也被明确删除。

- [ ] **Step 3: 验证删除清单不存在且保留数据存在**

Run:

```powershell
foreach ($relative in $targets) { if (Test-Path -LiteralPath $relative) { throw "删除失败: $relative" } }
foreach ($relative in @('data/config.json','data/urp_helper.db','user_data','routes/sign_routes.py','URP.py')) { if (-not (Test-Path -LiteralPath $relative)) { throw "误删保留项: $relative" } }
```

Expected: 退出码 0。

### Task 3: 删除全部 Python 缓存和旧测试目录

**Files:**
- Delete: every `__pycache__/` below `E:\URP\web`, including both worktrees but excluding Git internal storage。
- Delete: every `.pyc` below `E:\URP\web`, including both worktrees but excluding Git internal storage。
- Delete: `test/test_payment_secrets.py` and empty `test/`。

**Interfaces:**
- Produces: 当前主工作树不包含 Python 字节码缓存或已失效的忽略测试。

- [ ] **Step 1: 枚举并验证缓存删除目标**

Run:

```powershell
$root = (Resolve-Path -LiteralPath .).Path
$gitStorage = Join-Path $root '.git'
$cacheDirs = Get-ChildItem -LiteralPath $root -Directory -Recurse -Force -Filter '__pycache__' | Where-Object { -not $_.FullName.StartsWith($gitStorage + [IO.Path]::DirectorySeparatorChar) }
$pycFiles = Get-ChildItem -LiteralPath $root -File -Recurse -Force -Filter '*.pyc' | Where-Object { -not $_.FullName.StartsWith($gitStorage + [IO.Path]::DirectorySeparatorChar) }
foreach ($target in @($cacheDirs) + @($pycFiles)) {
  if (-not $target.FullName.StartsWith($root + [IO.Path]::DirectorySeparatorChar)) { throw "缓存目标越界: $($target.FullName)" }
}
```

Expected: 退出码 0；枚举仓库及两个 worktree 中的全部 Python 缓存，不包含 `.git` 内部文件。

- [ ] **Step 2: 使用同一 PowerShell 目标集合删除缓存**

Run:

```powershell
foreach ($file in $pycFiles) { Remove-Item -LiteralPath $file.FullName -Force }
foreach ($dir in ($cacheDirs | Sort-Object { $_.FullName.Length } -Descending)) { if (Test-Path -LiteralPath $dir.FullName) { Remove-Item -LiteralPath $dir.FullName -Recurse -Force } }
$oldTest = Join-Path $root 'test'
if (Test-Path -LiteralPath $oldTest) {
  $resolvedOldTest = (Resolve-Path -LiteralPath $oldTest).Path
  if ($resolvedOldTest -ne (Join-Path $root 'test')) { throw '旧测试目录解析异常' }
  Remove-Item -LiteralPath $resolvedOldTest -Recurse -Force
}
```

Expected: 退出码 0。

- [ ] **Step 3: 验证主工作树无缓存，未合并 worktree 仍存在**

Run:

```powershell
$remainingCaches = Get-ChildItem -LiteralPath $root -Recurse -Force | Where-Object { -not $_.FullName.StartsWith($gitStorage + [IO.Path]::DirectorySeparatorChar) -and ($_.Name -eq '__pycache__' -or $_.Extension -eq '.pyc') }
if ($remainingCaches) { throw '仍有 Python 缓存未删除' }
if (-not (Test-Path -LiteralPath (Join-Path $root '.worktrees\urp-url-session-isolation'))) { throw '误删未合并 worktree' }
```

Expected: 退出码 0。

### Task 4: 完整验证、提交与已合并 worktree 清理

**Files:**
- Modify/Delete: Tasks 1–3 listed files only。
- Remove workspace: `.worktrees/admin-service-status`。
- Delete local branch: `codex/admin-service-status`。

**Interfaces:**
- Consumes: Tasks 1–3 的清理结果。
- Produces: 通过测试的清理提交和无冗余已合并 worktree 的本地仓库。

- [ ] **Step 1: 运行完整项目验证**

Run:

```powershell
python -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/test_schedule_weekend_visibility.js tests/test_service_status_ui.js
node --check static/js/main.js
node --check static/js/admin.js
node --check static/js/schedule-layout.js
node --check static/js/service-status-ui.js
python -c "import app; print(len(app.app.url_map._rules))"
git diff --check
```

Expected: Python 27 项和 Node 5 项通过，JavaScript 语法正确，Flask 输出路由数量，Git 无空白错误。

- [ ] **Step 2: 清除验证命令重新生成的 Python 缓存**

重新执行 Task 3 Step 1–3 的缓存枚举、边界验证、删除和残留检查，但不再处理已经删除的 `test/` 目录。

Expected: 完整验证结束后，仓库及两个 worktree 中仍无 `__pycache__/` 或 `.pyc`（`.git` 内部存储除外）。

- [ ] **Step 3: 检查变更范围并提交**

Run:

```powershell
git status --short
git diff --stat
git diff -- .gitignore constants.py services/config_service.py requirements.txt AGENTS.md CLAUDE.md
git add -- .gitignore constants.py services/config_service.py requirements.txt AGENTS.md CLAUDE.md
git commit -m "chore: remove unused project artifacts"
```

Expected: 提交只包含确认的删除和同步清理，不包含数据库、用户数据或未合并分支内容。

- [ ] **Step 4: 验证并移除已合并 worktree**

Run:

```powershell
$root = (Resolve-Path -LiteralPath .).Path
$mergedWorktree = (Resolve-Path -LiteralPath '.worktrees\admin-service-status').Path
$expected = Join-Path $root '.worktrees\admin-service-status'
if ($mergedWorktree -ne $expected) { throw '已合并 worktree 路径异常' }
git merge-base --is-ancestor codex/admin-service-status main
if ($LASTEXITCODE -ne 0) { throw '功能分支尚未合并，停止清理' }
git -C $mergedWorktree status --porcelain
if ($LASTEXITCODE -ne 0) { throw '无法读取 worktree 状态' }
git worktree remove $mergedWorktree
git worktree prune
git branch -d codex/admin-service-status
```

Expected: worktree 干净且被移除，已合并分支被安全删除。

- [ ] **Step 5: 最终状态检查**

Run:

```powershell
git status --short
git worktree list
git branch --list 'codex/admin-service-status' 'codex/urp-url-session-isolation'
```

Expected: 主工作树干净；只保留未合并的 `urp-url-session-isolation` 工作区和分支。
