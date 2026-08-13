# 联系方式客户端协议跳转 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将“找我做事”页面的 QQ、微信联系入口替换为用户指定的客户端 URL Scheme。

**Architecture:** 仅修改模板中的两个 `href` 及模板测试的精确期望。现有自动复制、成功反馈、显示文字、账号、`target` 和 `rel` 属性全部保持不变。

**Tech Stack:** Flask/Jinja2、HTML、Python `unittest`、BeautifulSoup

## Global Constraints

- QQ 链接必须为 `tencent://AddContact/?fromId=45&fromSubId=1&subcmd=all&uin=786171937`。
- 微信链接必须为 `weixin://dl/business/?t=Dygzn123`。
- 保留 `data-copy-text="786171937"` 和 `data-copy-text="Dygzn123"`。
- 不修改 JavaScript、CSS、API、数据库、管理员后台或其他页面。
- 不添加 HTTPS 回退或设备判断。

---

## File Structure

- `tests/test_service_status.py`：锁定两个客户端协议的精确链接。
- `templates/index.html`：提供用户指定的 QQ、微信 Scheme。

### Task 1: 用 TDD 替换联系入口协议

**Files:**
- Modify: `tests/test_service_status.py:149-165`
- Modify: `templates/index.html:143-151`

**Interfaces:**
- Consumes: 现有 `.service-contact-link`、`data-contact` 和 `data-copy-text`。
- Produces: 两个指定客户端 Scheme；其他链接属性和复制行为保持不变。

- [ ] **Step 1: 将模板测试改为用户指定协议**

```python
        self.assertEqual(
            qq_link.get('href'),
            'tencent://AddContact/?fromId=45&fromSubId=1&subcmd=all&uin=786171937',
        )
```

```python
        self.assertEqual(
            wechat_link.get('href'),
            'weixin://dl/business/?t=Dygzn123',
        )
```

- [ ] **Step 2: 运行目标测试并确认因旧 HTTPS 地址而失败**

Run:

```powershell
python -m unittest tests.test_service_status.ServiceStatusTemplateTests.test_home_renders_service_status_navigation_and_page -v
```

Expected: FAIL，QQ 实际值仍为 `https://qm.qq.com/q/c9BOvFT6tc`。

- [ ] **Step 3: 替换模板中的两个 href**

QQ 标签使用 HTML 转义后的查询参数：

```html
href="tencent://AddContact/?fromId=45&amp;fromSubId=1&amp;subcmd=all&amp;uin=786171937"
```

微信标签使用：

```html
href="weixin://dl/business/?t=Dygzn123"
```

- [ ] **Step 4: 运行目标测试并确认通过**

Run:

```powershell
python -m unittest tests.test_service_status.ServiceStatusTemplateTests.test_home_renders_service_status_navigation_and_page -v
```

Expected: PASS。

- [ ] **Step 5: 运行完整回归验证**

Run:

```powershell
python -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/test_schedule_weekend_visibility.js tests/test_service_status_ui.js
node --check static/js/main.js
node --check static/js/admin.js
node --check static/js/schedule-layout.js
node --check static/js/service-status-ui.js
git diff --check
```

Expected: Python 27 项、Node 8 项全部通过，4 个 JavaScript 文件语法检查通过，Git 无空白错误。

- [ ] **Step 6: 清除 Python 缓存并提交**

安全删除仓库内（排除 `.git`）全部 `__pycache__` 和 `.pyc`，确认残留为 0，然后运行：

```powershell
git add -- templates/index.html tests/test_service_status.py
git commit -m "feat: use client schemes for contact links"
```

Expected: 实现提交只包含模板与模板测试。
