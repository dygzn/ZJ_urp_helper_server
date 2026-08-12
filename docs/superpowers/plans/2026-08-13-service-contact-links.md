# “找我做事”联系方式超链接 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在“找我做事”页面增加 QQ 和微信两个普通 HTTPS 联系超链接，供用户测试外部平台的实际跳转效果。

**Architecture:** 联系入口直接写入现有首页模板，放在动态服务状态卡下方；样式追加到现有页面样式文件。功能不依赖 JavaScript、API、数据库或管理员后台，模板测试负责锁定链接、文字和安全属性。

**Tech Stack:** Flask/Jinja2、原生 HTML/CSS、Python `unittest`、BeautifulSoup

## Global Constraints

- QQ 链接必须为 `https://qm.qq.com/q/c9BOvFT6tc`。
- 微信链接必须为 `https://u.wechat.com/MMwBClCfxTYX-Z1rWS3_esc?s=2`。
- 两个链接均使用 `target="_blank"` 和 `rel="noopener noreferrer"`。
- 不增加 JavaScript、自定义 URL Scheme、二维码弹窗、复制功能、图片资源、API、数据库字段或后台配置。
- 服务状态卡的加载、可接单标识和更新时间展示保持不变。

---

## File Structure

- `templates/index.html`：在服务状态卡之后提供两个静态联系方式链接。
- `static/css/style.css`：负责联系方式链接的双列布局、按钮外观、悬停反馈和窄屏单列布局。
- `tests/test_service_status.py`：验证首页输出的联系区域、账号文字、精确链接和安全属性。

### Task 1: 添加并验证联系方式超链接

**Files:**
- Modify: `tests/test_service_status.py:134-145`
- Modify: `templates/index.html:133-144`
- Modify: `static/css/style.css:4241-4348`

**Interfaces:**
- Consumes: 现有 `#page-service-status` 页面和 `#service-status-content` 动态状态容器。
- Produces: `.service-contact-links` 联系区域，以及 `a[data-contact="qq"]`、`a[data-contact="wechat"]` 两个标准超链接。

- [ ] **Step 1: 写入失败的模板测试**

在 `test_home_renders_service_status_navigation_and_page` 末尾加入：

```python
        contacts = soup.select_one('#page-service-status .service-contact-links')
        self.assertIsNotNone(contacts)

        qq_link = contacts.select_one('a[data-contact="qq"]')
        self.assertIsNotNone(qq_link)
        self.assertEqual(qq_link.get_text(' ', strip=True), 'QQ 联系我 786171937')
        self.assertEqual(qq_link.get('href'), 'https://qm.qq.com/q/c9BOvFT6tc')
        self.assertEqual(qq_link.get('target'), '_blank')
        self.assertEqual(set(qq_link.get('rel', [])), {'noopener', 'noreferrer'})

        wechat_link = contacts.select_one('a[data-contact="wechat"]')
        self.assertIsNotNone(wechat_link)
        self.assertEqual(wechat_link.get_text(' ', strip=True), '微信联系我 Dygzn123')
        self.assertEqual(
            wechat_link.get('href'),
            'https://u.wechat.com/MMwBClCfxTYX-Z1rWS3_esc?s=2',
        )
        self.assertEqual(wechat_link.get('target'), '_blank')
        self.assertEqual(set(wechat_link.get('rel', [])), {'noopener', 'noreferrer'})
```

- [ ] **Step 2: 运行测试并确认因联系区域不存在而失败**

Run:

```powershell
python -m unittest tests.test_service_status.ServiceStatusTemplateTests.test_home_renders_service_status_navigation_and_page -v
```

Expected: FAIL，失败点为 `contacts` 是 `None`。

- [ ] **Step 3: 在模板中加入最小 HTML**

在 `#service-status-content` 结束标签后、`.service-status-container` 结束标签前加入：

```html
                    <div class="service-contact-links" aria-label="联系方式">
                        <a class="service-contact-link" data-contact="qq" href="https://qm.qq.com/q/c9BOvFT6tc" target="_blank" rel="noopener noreferrer">
                            <span>QQ 联系我</span>
                            <strong>786171937</strong>
                        </a>
                        <a class="service-contact-link" data-contact="wechat" href="https://u.wechat.com/MMwBClCfxTYX-Z1rWS3_esc?s=2" target="_blank" rel="noopener noreferrer">
                            <span>微信联系我</span>
                            <strong>Dygzn123</strong>
                        </a>
                    </div>
```

- [ ] **Step 4: 为链接加入与状态卡协调的响应式样式**

在 `.service-status-error` 之后加入：

```css
.service-contact-links {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    margin-top: 16px;
}

.service-contact-link {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-width: 0;
    padding: 16px 18px;
    border: 1px solid rgba(0, 122, 255, 0.12);
    border-radius: 16px;
    background: var(--card-bg);
    color: var(--text-primary);
    text-decoration: none;
    transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
}

.service-contact-link:hover {
    transform: translateY(-2px);
    border-color: rgba(0, 122, 255, 0.32);
    box-shadow: 0 12px 28px rgba(18, 36, 70, 0.08);
}

.service-contact-link span {
    color: var(--text-secondary);
    font-size: 14px;
}

.service-contact-link strong {
    overflow-wrap: anywhere;
    color: var(--accent);
    font-size: 15px;
}
```

在现有 `@media (max-width: 560px)` 中加入：

```css
    .service-contact-links {
        grid-template-columns: 1fr;
    }
```

- [ ] **Step 5: 运行目标测试并确认通过**

Run:

```powershell
python -m unittest tests.test_service_status.ServiceStatusTemplateTests.test_home_renders_service_status_navigation_and_page -v
```

Expected: PASS。

- [ ] **Step 6: 运行完整回归验证**

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

Expected: Python 27 项在新增断言后全部通过，Node 5 项全部通过，4 个 JavaScript 文件语法检查通过，Git 无空白错误。

- [ ] **Step 7: 检查变更并提交**

Run:

```powershell
git status --short
git diff -- tests/test_service_status.py templates/index.html static/css/style.css
git add -- tests/test_service_status.py templates/index.html static/css/style.css
git commit -m "feat: add service contact links"
```

Expected: 提交仅包含模板、页面样式和模板测试，不包含二维码图片或其他文件。
