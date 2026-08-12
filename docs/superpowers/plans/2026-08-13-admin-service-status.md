# “找我做事”管理员接单状态 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增“找我做事”用户页和后台个人状态编辑功能，让访客看到管理员当前状态、接单开关与最后更新时间。

**Architecture:** 使用 `admin_service_status` 单行表保存全局状态，在现有 `misc_bp` 中提供公开读取和管理员读写 API。用户端与后台都沿用现有 SPA 切页模式，只在进入相应页面或标签时加载数据。

**Tech Stack:** Python 3、Flask、SQLite/MySQL、原生 JavaScript、HTML、CSS、`unittest`

## Global Constraints

- 用户导航名称固定为“找我做事”。
- 状态文字与“是否接单”必须独立保存，不做自动推断。
- 状态文字去除首尾空白后不能为空，最大 40 个字符。
- 默认值为“暂未设置状态 / 暂不接单 / 尚未更新”。
- 本次不得加入广告词、联系方式或历史任务。
- 不引入新的运行时依赖，同时支持 SQLite 与 MySQL。
- 保留用户已有的 `data/config.json` 和 `data/last_jiaowu_captcha.gif` 改动。

---

## File Structure

- `database.py`：创建状态表，并把表加入 SQLite→MySQL 数据迁移清单。
- `routes/misc_routes.py`：实现状态默认值、序列化和三个 API。
- `templates/index.html`：增加“找我做事”导航和用户状态页静态结构。
- `static/js/main.js`：接入 SPA 页面标题、按需加载和状态渲染。
- `static/css/style.css`：用户状态卡片与移动端样式。
- `templates/admin.html`：增加“个人状态”后台标签和表单。
- `static/js/admin.js`：读取、选择快捷状态、保存和错误提示。
- `static/css/admin.css`：后台快捷按钮和状态编辑区样式。
- `static/js/service-status-ui.js`：把状态数据转换成安全、可测试的展示模型。
- `tests/test_service_status.py`：后端 API、数据表和服务端渲染页面测试。
- `tests/test_service_status_ui.js`：用户状态展示模型的 Node 行为测试。

### Task 1: 状态数据表与后端 API

**Files:**
- Create: `tests/test_service_status.py`
- Modify: `database.py`
- Modify: `routes/misc_routes.py`

**Interfaces:**
- Produces: `GET /api/service-status -> {success: bool, data: ServiceStatus}`
- Produces: `GET /api/admin/service-status -> {success: bool, data: ServiceStatus}`
- Produces: `PUT /api/admin/service-status`，请求体为 `{status_text: str, accepting_orders: bool}`
- Produces: `ServiceStatus = {status_text: str, accepting_orders: bool, updated_at: str | null}`

- [ ] **Step 1: 写默认读取和表结构失败测试**

```python
def test_default_public_status_is_not_accepting_orders(self):
    response = self.client.get('/api/service-status')
    self.assertEqual(response.status_code, 200)
    self.assertEqual(response.get_json()['data'], {
        'status_text': '暂未设置状态',
        'accepting_orders': False,
        'updated_at': None,
    })

def test_status_table_is_created(self):
    with self.get_db() as conn:
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='admin_service_status'"
        ).fetchone()
    self.assertIsNotNone(row)
```

- [ ] **Step 2: 运行测试并确认因接口或表不存在而失败**

Run: `python -m unittest tests.test_service_status.ServiceStatusApiTests.test_default_public_status_is_not_accepting_orders tests.test_service_status.ServiceStatusApiTests.test_status_table_is_created -v`

Expected: FAIL，公开接口返回 404 或数据库中找不到 `admin_service_status`。

- [ ] **Step 3: 最小实现 SQLite/MySQL 状态表和公开读取**

在两个建表函数中创建固定主键、状态文字、接单布尔值、更新时间字段；在 `MIGRATION_TABLES` 中加入：

```python
'admin_service_status': ['id', 'status_text', 'accepting_orders', 'updated_at'],
```

在 `routes/misc_routes.py` 中加入读取辅助函数和公开路由：

```python
DEFAULT_SERVICE_STATUS = {
    'status_text': '暂未设置状态',
    'accepting_orders': False,
    'updated_at': None,
}

def _get_service_status():
    with get_db() as conn:
        row = conn.execute(
            'SELECT status_text, accepting_orders, updated_at '
            'FROM admin_service_status WHERE id = 1'
        ).fetchone()
    if not row:
        return dict(DEFAULT_SERVICE_STATUS)
    return {
        'status_text': row['status_text'],
        'accepting_orders': bool(row['accepting_orders']),
        'updated_at': row['updated_at'],
    }

@misc_bp.route('/api/service-status', methods=['GET'])
def get_service_status():
    return jsonify({'success': True, 'data': _get_service_status()})
```

- [ ] **Step 4: 运行默认读取和表结构测试并确认通过**

Run: `python -m unittest tests.test_service_status.ServiceStatusApiTests.test_default_public_status_is_not_accepting_orders tests.test_service_status.ServiceStatusApiTests.test_status_table_is_created -v`

Expected: PASS。

- [ ] **Step 5: 写管理员鉴权、输入校验和更新可见性失败测试**

```python
def test_admin_status_requires_key(self):
    self.assertEqual(self.client.get('/api/admin/service-status').status_code, 403)

def test_update_rejects_invalid_payload(self):
    headers = {'X-Admin-Key': 'test-admin-key'}
    self.assertFalse(self.client.put('/api/admin/service-status', json={
        'status_text': ' ', 'accepting_orders': True,
    }, headers=headers).get_json()['success'])
    self.assertFalse(self.client.put('/api/admin/service-status', json={
        'status_text': '空闲', 'accepting_orders': 'yes',
    }, headers=headers).get_json()['success'])

def test_admin_update_is_visible_to_public(self):
    response = self.client.put('/api/admin/service-status', json={
        'status_text': ' 上课 ', 'accepting_orders': True,
    }, headers={'X-Admin-Key': 'test-admin-key'})
    self.assertTrue(response.get_json()['success'])
    data = self.client.get('/api/service-status').get_json()['data']
    self.assertEqual(data['status_text'], '上课')
    self.assertTrue(data['accepting_orders'])
    self.assertIsNotNone(data['updated_at'])
```

- [ ] **Step 6: 运行测试并确认因管理员 API 不存在而失败**

Run: `python -m unittest tests.test_service_status.ServiceStatusApiTests.test_admin_status_requires_key tests.test_service_status.ServiceStatusApiTests.test_update_rejects_invalid_payload tests.test_service_status.ServiceStatusApiTests.test_admin_update_is_visible_to_public -v`

Expected: FAIL，管理员接口返回 404 或无法更新。

- [ ] **Step 7: 最小实现管理员读取和更新 API**

```python
@misc_bp.route('/api/admin/service-status', methods=['GET'])
@require_admin
def admin_get_service_status():
    return jsonify({'success': True, 'data': _get_service_status()})

@misc_bp.route('/api/admin/service-status', methods=['PUT'])
@require_admin
def admin_update_service_status():
    data = request.get_json(silent=True) or {}
    status_text = data.get('status_text')
    accepting_orders = data.get('accepting_orders')
    if not isinstance(status_text, str) or not status_text.strip():
        return jsonify({'success': False, 'message': '状态文字不能为空'}), 400
    status_text = status_text.strip()
    if len(status_text) > 40:
        return jsonify({'success': False, 'message': '状态文字不能超过40个字符'}), 400
    if not isinstance(accepting_orders, bool):
        return jsonify({'success': False, 'message': '接单状态格式错误'}), 400
    updated_at = datetime.now().isoformat(timespec='seconds')
    with get_db() as conn:
        conn.execute(
            'INSERT OR REPLACE INTO admin_service_status '
            '(id, status_text, accepting_orders, updated_at) VALUES (1, ?, ?, ?)',
            (status_text, 1 if accepting_orders else 0, updated_at),
        )
    return jsonify({'success': True, 'message': '状态已更新', 'data': {
        'status_text': status_text,
        'accepting_orders': accepting_orders,
        'updated_at': updated_at,
    }})
```

- [ ] **Step 8: 运行后端测试并提交**

Run: `python -m unittest tests.test_service_status -v`

Expected: 全部 PASS。

```bash
git add database.py routes/misc_routes.py tests/test_service_status.py
git commit -m "feat: add admin service status API"
```

### Task 2: 用户侧“找我做事”页面

**Files:**
- Modify: `tests/test_service_status.py`
- Create: `tests/test_service_status_ui.js`
- Create: `static/js/service-status-ui.js`
- Modify: `templates/index.html`
- Modify: `static/js/main.js`
- Modify: `static/css/style.css`

**Interfaces:**
- Consumes: `GET /api/service-status` 与 Task 1 的 `ServiceStatus`。
- Produces: `buildServiceStatusViewModel(data)`，返回安全的展示字段。
- Produces: `loadServiceStatus()`，在 `#service-status-content` 中安全渲染状态。

- [ ] **Step 1: 写用户端渲染与展示模型失败测试**

```python
def test_home_renders_service_status_navigation_and_page(self):
    response = self.full_app_client.get('/')
    soup = BeautifulSoup(response.get_data(as_text=True), 'html.parser')
    navigation = soup.select_one('[data-page="service-status"]')
    self.assertEqual(navigation.get_text(strip=True), '找我做事')
    self.assertIsNotNone(soup.select_one('#page-service-status #service-status-content'))
```

```javascript
test('未设置状态形成不可接单展示模型', () => {
    assert.deepEqual(buildServiceStatusViewModel({}), {
        statusText: '暂未设置状态',
        acceptingOrders: false,
        availabilityText: '暂不接单',
        updatedText: '尚未更新',
    });
});

test('已设置状态保留文字并形成可接单展示模型', () => {
    const view = buildServiceStatusViewModel({
        status_text: '上课',
        accepting_orders: true,
        updated_at: '2026-08-13T12:00:00',
    });
    assert.equal(view.statusText, '上课');
    assert.equal(view.availabilityText, '当前可接单');
    assert.notEqual(view.updatedText, '尚未更新');
});
```

- [ ] **Step 2: 运行测试并确认因导航和页面未接入而失败**

Run: `python -m unittest tests.test_service_status.ServiceStatusTemplateTests.test_home_renders_service_status_navigation_and_page -v`

Run: `node --test tests/test_service_status_ui.js`

Expected: FAIL，缺少 `service-status` 页面标记。

- [ ] **Step 3: 实现用户端 HTML 和 SPA 接线**

在侧边栏加入 `data-page="service-status"` 的“找我做事”入口；页面使用静态容器：

```html
<div id="page-service-status" class="page">
  <div class="service-status-container">
    <div class="service-status-head">
      <span class="service-status-kicker">SERVICE STATUS</span>
      <h2>找我做事</h2>
      <p class="page-section-desc">查看我现在是否方便接单。</p>
    </div>
    <div id="service-status-content" class="service-status-card">
      <div class="loading">加载中...</div>
    </div>
  </div>
</div>
```

新增 CommonJS/浏览器双环境可用的 `service-status-ui.js`，实现并导出 `buildServiceStatusViewModel(data)`。模板先加载该文件，再加载 `main.js`。给 `titles` 和 `loadPageData` 增加 `service-status` 分支，并实现 `loadServiceStatus()`；动态状态文字通过 `textContent` 写入，失败时显示调用 `loadServiceStatus()` 的重试按钮。

- [ ] **Step 4: 添加用户状态卡片样式**

样式覆盖页面最大宽度、状态大字、绿/灰接单徽章、更新时间和窄屏间距；不得写入广告正文或联系方式。

- [ ] **Step 5: 运行用户端契约和 JavaScript 语法检查并提交**

Run: `python -m unittest tests.test_service_status.ServiceStatusTemplateTests.test_home_renders_service_status_navigation_and_page -v`

Run: `node --test tests/test_service_status_ui.js`

Run: `node --check static/js/main.js`

Expected: 全部 PASS，Node 无输出且退出码为 0。

```bash
git add templates/index.html static/js/service-status-ui.js static/js/main.js static/css/style.css tests/test_service_status.py tests/test_service_status_ui.js
git commit -m "feat: add service status user page"
```

### Task 3: 后台个人状态编辑页与整体验证

**Files:**
- Modify: `tests/test_service_status.py`
- Modify: `templates/admin.html`
- Modify: `static/js/admin.js`
- Modify: `static/css/admin.css`

**Interfaces:**
- Consumes: `GET /api/admin/service-status` 和 `PUT /api/admin/service-status`。
- Produces: `loadAdminServiceStatus()`、`selectServiceStatus(text)`、`saveAdminServiceStatus(event)`。

- [ ] **Step 1: 写后台渲染失败测试**

```python
def test_admin_renders_service_status_editor(self):
    response = self.full_app_client.get('/admin')
    soup = BeautifulSoup(response.get_data(as_text=True), 'html.parser')
    self.assertEqual(
        soup.select_one('[data-admin-tab="service-status"]').get_text(strip=True),
        '个人状态',
    )
    self.assertIsNotNone(soup.select_one('#tab-service-status'))
    self.assertIsNotNone(soup.select_one('#admin-service-status-text[maxlength="40"]'))
    self.assertIsNotNone(soup.select_one('#admin-accepting-orders'))
```

- [ ] **Step 2: 运行测试并确认因后台标签未接入而失败**

Run: `python -m unittest tests.test_service_status.ServiceStatusTemplateTests.test_admin_renders_service_status_editor -v`

Expected: FAIL，缺少后台状态表单。

- [ ] **Step 3: 实现后台标签和表单**

增加“个人状态”标签页，包含四个快捷按钮、最大长度 40 的文本输入、接单开关、更新时间、保存按钮和结果提示。表单提交调用 `saveAdminServiceStatus(event)`。

- [ ] **Step 4: 实现后台读取、快捷选择和保存逻辑**

`switchTab` 进入 `service-status` 时调用 `loadAdminServiceStatus()`。读取成功后回填三个字段；快捷按钮仅填写文本；保存时发送 JSON 和 `Admin-Key`，失败时不清除输入并展示服务端消息。

- [ ] **Step 5: 添加后台响应式样式**

快捷按钮使用可换行布局，状态表单沿用 `.config-section` 和 `.admin-toggle-row`；窄屏下按钮占满可用宽度。

- [ ] **Step 6: 运行完整自动验证**

Run: `python -m unittest discover -s tests -p "test_*.py" -v`

Run: `node --check static/js/main.js`

Run: `node --check static/js/admin.js`

Run: `git diff --check`

Expected: 所有单元测试通过、两个 JavaScript 文件语法正确、Git 无空白错误。

- [ ] **Step 7: 启动应用并进行页面验证**

Run: `python app.py`

验证：访客可进入“找我做事”；默认状态正确；后台无密钥无法读写；管理员保存“上课 + 可接单”后用户页刷新可见；切换为“睡觉 + 暂不接单”后颜色和文字同时更新；窄屏无横向溢出。

- [ ] **Step 8: 提交后台和最终验证改动**

```bash
git add templates/admin.html static/js/admin.js static/css/admin.css tests/test_service_status.py
git commit -m "feat: manage service status in admin"
```

