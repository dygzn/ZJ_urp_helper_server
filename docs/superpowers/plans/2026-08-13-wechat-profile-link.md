# 微信个人资料协议链接实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将“找我做事”页面的微信入口改为 `weixin://contacts/profile/Dygzn123`，同时保留复制微信号和其他现有行为。

**Architecture:** 只修改模板中微信超链接的 `href`，并用现有 Flask 模板测试锁定精确地址。现有 JavaScript 继续根据 `data-copy-text` 复制账号，不新增跳转函数、回退逻辑或设备判断。

**Tech Stack:** Flask、Jinja2、HTML、Python `unittest`、BeautifulSoup

## Global Constraints

- 微信链接必须为 `weixin://contacts/profile/Dygzn123`。
- 保留 `data-copy-text="Dygzn123"`、现有显示文字、`target` 和 `rel`。
- QQ链接必须保持 `tencent://AddContact/?fromId=45&fromSubId=1&subcmd=all&uin=786171937`。
- 不修改 JavaScript、CSS、API、数据库或管理员后台。
- 不增加 HTTP 回退、设备识别或浏览器提示。

---

## File Structure

- `tests/test_service_status.py`：精确断言微信联系入口的新协议地址以及其他链接属性。
- `templates/index.html`：提供用户指定的微信个人资料协议地址。

### Task 1: 用 TDD 替换微信协议地址

**Files:**
- Modify: `tests/test_service_status.py:161-167`
- Modify: `templates/index.html:148-151`

**Interfaces:**
- Consumes: 现有 `a[data-contact="wechat"]` 和 `data-copy-text="Dygzn123"`。
- Produces: 微信入口 `href="weixin://contacts/profile/Dygzn123"`；其他属性及复制行为保持不变。

- [ ] **Step 1: 写入失败测试**

将微信链接断言改为：

```python
        self.assertEqual(
            wechat_link.get('href'),
            'weixin://contacts/profile/Dygzn123',
        )
```

- [ ] **Step 2: 运行目标测试并确认正确失败**

Run:

```powershell
python -m unittest tests.test_service_status.ServiceStatusTemplateTests.test_home_renders_service_status_navigation_and_page -v
```

Expected: FAIL，实际值仍为 `weixin://dl/business/?t=Dygzn123`。

- [ ] **Step 3: 写入最小实现**

将模板中的微信链接改为：

```html
href="weixin://contacts/profile/Dygzn123"
```

不改动同一标签的其他属性或内容。

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

- [ ] **Step 6: 提交实现**

```powershell
git add -- tests/test_service_status.py templates/index.html
git commit -m "feat: use WeChat profile link"
```

Expected: 实现提交只包含模板及其测试。
