# Favicon 与 HTTP 错误处理修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除 `/favicon.ico` 的虚假 500，并让网页与 API 的 HTTP 异常保留正确状态码。

**Architecture:** 在 Flask 入口中增加无内容 favicon 路由，并在现有全局异常处理器最前面区分 Werkzeug `HTTPException` 与普通程序异常。HTTP 异常保留自身状态码，API 路径保持 JSON 响应；现有 API 普通异常仍使用 JSON 500。

**Tech Stack:** Python 3、Flask 3、Werkzeug、Python `unittest`。

## Global Constraints

- `/favicon.ico` 请求不再产生异常日志或 500。
- 不存在的普通网页正确返回 404。
- 不存在的 API 正确返回 JSON 和原始 HTTP 状态码。
- 真正的 API 程序异常继续返回现有 JSON 500 格式。
- 不修改登录、VPN、课表、数据库或其他业务逻辑。
- 不引入新的第三方依赖和图标资源。

---

### Task 1: Favicon 与 HTTP 异常状态修复

**Files:**
- Create: `tests/test_app_error_handling.py`
- Modify: `app.py:5-45`

**Interfaces:**
- Consumes: Flask `request`、`jsonify` 和 Werkzeug `HTTPException`。
- Produces: `GET /favicon.ico -> 204`；网页 HTTP 异常保留原状态；API HTTP 异常返回 JSON 和原状态；API 普通异常返回 JSON 500。

- [ ] **Step 1: 编写真实 Flask 应用失败测试**

创建 `tests/test_app_error_handling.py`：

```python
import unittest

import app as app_module


class AppErrorHandlingTests(unittest.TestCase):
    def setUp(self):
        self.client = app_module.app.test_client()

    def test_favicon_returns_no_content(self):
        response = self.client.get('/favicon.ico')

        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.data, b'')

    def test_missing_web_page_remains_not_found(self):
        response = self.client.get('/definitely-missing-page')

        self.assertEqual(response.status_code, 404)
        self.assertFalse(response.is_json)

    def test_missing_api_returns_json_not_found(self):
        response = self.client.get('/api/definitely-missing')

        self.assertEqual(response.status_code, 404)
        self.assertTrue(response.is_json)
        self.assertEqual(response.get_json()['success'], False)

    def test_api_runtime_error_keeps_existing_json_500_contract(self):
        with app_module.app.test_request_context('/api/test-error'):
            response, status = app_module.handle_api_exception(
                RuntimeError('boom')
            )

        self.assertEqual(status, 500)
        self.assertEqual(
            response.get_json(),
            {
                'success': False,
                'message': '服务器内部错误: boom',
            },
        )

    def test_home_page_still_loads(self):
        response = self.client.get('/')

        self.assertEqual(response.status_code, 200)


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```powershell
D:\app\tool\python\python.exe -m unittest tests.test_app_error_handling -v
```

Expected:

- favicon 和不存在网页测试因旧处理器重新抛出 HTTP 异常而报错。
- 不存在 API 测试收到 500，而不是预期的 JSON 404。
- API 普通异常和首页测试保持通过。

- [ ] **Step 3: 实现 HTTP 异常分类和 favicon 路由**

在 `app.py` 的 Flask 导入后增加：

```python
from werkzeug.exceptions import HTTPException
```

把全局异常处理器替换为：

```python
@app.errorhandler(Exception)
def handle_api_exception(error):
    if isinstance(error, HTTPException):
        if request.path.startswith('/api/'):
            return jsonify({
                'success': False,
                'message': error.description,
            }), error.code or 500
        return error

    if request.path.startswith('/api/'):
        return jsonify({
            'success': False,
            'message': f'服务器内部错误: {str(error)}',
        }), 500
    raise error
```

在首页路由前增加：

```python
@app.route('/favicon.ico')
def favicon():
    return '', 204
```

- [ ] **Step 4: 运行新增测试并确认 GREEN**

Run:

```powershell
D:\app\tool\python\python.exe -m unittest tests.test_app_error_handling -v
```

Expected: 5 个测试全部通过，0 failures，0 errors。

- [ ] **Step 5: 执行回归测试变异检查**

临时把 `isinstance(error, HTTPException)` 改成 `False`，运行新增测试，确认网页 404 和 API 404 测试失败；随后恢复正确实现并重新运行新增测试，确认全部通过。临时变异不提交。

- [ ] **Step 6: 提交修复**

```powershell
git add app.py tests/test_app_error_handling.py
git commit -m "fix: preserve HTTP errors and handle favicon"
```

### Task 2: 完整回归验证

**Files:**
- Verify: `app.py`
- Verify: `tests/test_app_error_handling.py`
- Verify: `tests/test_schedule_weekend_visibility.py`
- Verify: `tests/test_vpn_session_recovery.py`
- Verify: `static/js/main.js`
- Verify: `static/js/schedule-layout.js`

**Interfaces:**
- Consumes: Task 1 的异常处理行为。
- Produces: Python 可编译、Flask 路由完整、课程表和 VPN 修复无回归的验证结果。

- [ ] **Step 1: 运行全部 Python 回归测试**

```powershell
D:\app\tool\python\python.exe -m unittest discover -s tests -p "test_*.py" -v
```

Expected: 新增 5 个测试、课程表模板测试和现有 12 个 VPN 测试全部通过。

- [ ] **Step 2: 运行前端回归与语法检查**

```powershell
node --test tests/test_schedule_weekend_visibility.js
node --check static/js/schedule-layout.js
node --check static/js/main.js
```

Expected: Node 3 个测试通过，两个脚本语法检查退出码均为 0。

- [ ] **Step 3: 编译 Python 并验证关键路由**

```powershell
D:\app\tool\python\python.exe -m py_compile app.py auth.py database.py URP.py urp/login.py urp/query.py services/urp_service.py routes/data_routes.py
D:\app\tool\python\python.exe -c "import app; c=app.app.test_client(); checks={'/':200,'/favicon.ico':204,'/missing':404,'/api/missing':404}; actual={path:c.get(path).status_code for path in checks}; print(actual); raise SystemExit(actual != checks)"
```

Expected: 编译退出码 0；输出与 `checks` 完全一致。

- [ ] **Step 4: 检查提交和工作区范围**

```powershell
git diff --check
git status --short --branch
git show --stat --oneline HEAD
```

Expected: 本任务文件已提交；原有验证码图片和开发辅助文件仍未纳入提交。
