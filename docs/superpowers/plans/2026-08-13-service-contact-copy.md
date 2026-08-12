# “找我做事”联系方式点击复制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 点击 QQ 或微信联系方式时复制对应账号、给出短暂成功反馈，并继续打开原有外部链接。

**Architecture:** `service-status-ui.js` 提供可注入浏览器环境、可由 Node 测试的异步复制函数；`main.js` 只负责事件委托和界面反馈。模板用 `data-copy-text` 声明账号，不使用内联事件；现有用户手动缩短的“QQ/微信”文案作为新基线保留。

**Tech Stack:** 原生 JavaScript、Clipboard API、`document.execCommand('copy')` 兼容方案、Node test runner、Flask/Jinja2、Python `unittest`

## Global Constraints

- 点击链接不得调用 `preventDefault()`；原有 `target="_blank"` 跳转继续生效。
- QQ 复制值必须为 `786171937`，微信复制值必须为 `Dygzn123`。
- 优先使用 `navigator.clipboard.writeText`，不可用或失败时使用临时 `textarea` 和 `document.execCommand('copy')`。
- 复制成功时账号文字短暂显示“已复制”，随后恢复；失败时不显示成功反馈且不阻止跳转。
- 保留用户未提交的入口文字“QQ”和“微信”，不恢复“QQ 联系我/微信联系我”。
- 不修改 API、数据库、管理员后台、二维码图片或外部跳转地址。

---

## File Structure

- `templates/index.html`：保留简短入口文字，并为两个链接声明 `data-copy-text`。
- `tests/test_service_status.py`：锁定简短文字和两个精确复制值。
- `static/js/service-status-ui.js`：实现独立、可测试的 `copyText(text, environment)`。
- `tests/test_service_status_ui.js`：验证 Clipboard API、兼容回退和失败结果。
- `static/js/main.js`：通过事件委托触发复制并更新账号文字反馈，不干预链接跳转。

### Task 1: 将用户手动缩短的入口文字设为测试基线

**Files:**
- Modify: `templates/index.html:144-151`（用户已有未提交修改）
- Modify: `tests/test_service_status.py:149-158`

**Interfaces:**
- Consumes: 用户已将入口文字改为“QQ”和“微信”的工作区状态。
- Produces: 首页模板测试与当前入口文字一致的绿色基线。

- [ ] **Step 1: 更新模板测试的可见文字期望**

将两处期望改为：

```python
        self.assertEqual(qq_link.get_text(' ', strip=True), 'QQ 786171937')
        self.assertEqual(wechat_link.get_text(' ', strip=True), '微信 Dygzn123')
```

- [ ] **Step 2: 验证当前用户文案通过模板测试**

Run:

```powershell
python -m unittest tests.test_service_status.ServiceStatusTemplateTests.test_home_renders_service_status_navigation_and_page -v
```

Expected: PASS，证明只是文案契约同步，没有改变链接行为。

- [ ] **Step 3: 提交用户文案与测试基线**

Run:

```powershell
git add -- templates/index.html tests/test_service_status.py
git commit -m "style: shorten service contact labels"
```

Expected: 只提交用户已有的两处文字调整和对应测试期望。

### Task 2: 用 TDD 实现跨环境复制函数

**Files:**
- Modify: `tests/test_service_status_ui.js`
- Modify: `static/js/service-status-ui.js`

**Interfaces:**
- Produces: `ServiceStatusUI.copyText(text: string, environment?: object): Promise<boolean>`。
- Return: 成功复制返回 `true`；所有可预期失败返回 `false`。
- Environment injection: 可选 `{ navigator, document }`，省略时读取浏览器全局对象。

- [ ] **Step 1: 写入复制函数的失败测试**

在 Node 测试中从模块导入 `copyText`，增加：

```javascript
test('优先使用 Clipboard API 复制联系账号', async () => {
    const writes = [];
    const copied = await copyText('786171937', {
        navigator: {
            clipboard: {
                writeText: async value => writes.push(value),
            },
        },
        document: null,
    });

    assert.equal(copied, true);
    assert.deepEqual(writes, ['786171937']);
});

test('Clipboard API 失败时使用 textarea 兼容复制', async () => {
    const lifecycle = [];
    const textarea = {
        value: '',
        style: {},
        setAttribute() {},
        select() { lifecycle.push('select'); },
        setSelectionRange() {},
    };
    const document = {
        createElement(tagName) {
            assert.equal(tagName, 'textarea');
            return textarea;
        },
        body: {
            appendChild(node) { lifecycle.push(['append', node.value]); },
            removeChild() { lifecycle.push('remove'); },
        },
        execCommand(command) {
            lifecycle.push(command);
            return true;
        },
    };

    const copied = await copyText('Dygzn123', {
        navigator: { clipboard: { writeText: async () => { throw new Error('blocked'); } } },
        document,
    });

    assert.equal(copied, true);
    assert.deepEqual(lifecycle, [
        ['append', 'Dygzn123'],
        'select',
        'copy',
        'remove',
    ]);
});

test('没有可用复制能力时返回失败', async () => {
    assert.equal(await copyText('Dygzn123', { navigator: null, document: null }), false);
});
```

- [ ] **Step 2: 运行 Node 测试并确认缺少导出而失败**

Run:

```powershell
node --test tests/test_service_status_ui.js
```

Expected: FAIL，指出 `copyText` 不是函数。

- [ ] **Step 3: 实现最小复制函数并导出**

在 `service-status-ui.js` 中加入：

```javascript
    async function copyText(text, environment) {
        const value = typeof text === 'string' ? text : '';
        if (!value) return false;

        const scope = environment && typeof environment === 'object' ? environment : {};
        const navigatorObject = Object.prototype.hasOwnProperty.call(scope, 'navigator')
            ? scope.navigator
            : (typeof navigator !== 'undefined' ? navigator : null);
        const documentObject = Object.prototype.hasOwnProperty.call(scope, 'document')
            ? scope.document
            : (typeof document !== 'undefined' ? document : null);

        if (navigatorObject?.clipboard?.writeText) {
            try {
                await navigatorObject.clipboard.writeText(value);
                return true;
            } catch (error) {
                // 继续使用兼容复制方案。
            }
        }

        if (!documentObject?.body
            || typeof documentObject.createElement !== 'function'
            || typeof documentObject.execCommand !== 'function') {
            return false;
        }

        const textarea = documentObject.createElement('textarea');
        textarea.value = value;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';

        try {
            documentObject.body.appendChild(textarea);
            textarea.select();
            textarea.setSelectionRange(0, value.length);
            return documentObject.execCommand('copy') === true;
        } catch (error) {
            return false;
        } finally {
            try {
                documentObject.body.removeChild(textarea);
            } catch (error) {
                // 元素没有成功挂载时无需继续清理。
            }
        }
    }
```

并在模块返回对象中加入 `copyText`。

- [ ] **Step 4: 运行 Node 测试并确认通过**

Run: `node --test tests/test_service_status_ui.js`

Expected: 原有 2 项和新增 3 项全部通过。

- [ ] **Step 5: 提交复制能力**

Run:

```powershell
git add -- static/js/service-status-ui.js tests/test_service_status_ui.js
git commit -m "feat: add contact text copying"
```

### Task 3: 将复制能力接入联系方式链接

**Files:**
- Modify: `tests/test_service_status.py:146-166`
- Modify: `templates/index.html:143-152`
- Modify: `static/js/main.js:382-425`

**Interfaces:**
- Consumes: `ServiceStatusUI.copyText(text): Promise<boolean>`。
- Produces: 链接上的 `data-copy-text`，以及不拦截默认跳转的委托点击处理器。

- [ ] **Step 1: 写入失败的模板属性断言**

在 QQ 和微信链接断言中分别加入：

```python
        self.assertEqual(qq_link.get('data-copy-text'), '786171937')
        self.assertEqual(wechat_link.get('data-copy-text'), 'Dygzn123')
```

- [ ] **Step 2: 运行模板测试并确认属性缺失而失败**

Run:

```powershell
python -m unittest tests.test_service_status.ServiceStatusTemplateTests.test_home_renders_service_status_navigation_and_page -v
```

Expected: FAIL，实际 `data-copy-text` 为 `None`。

- [ ] **Step 3: 为模板链接增加复制值**

将链接开始标签改为：

```html
<a class="service-contact-link" data-contact="qq" data-copy-text="786171937" href="https://qm.qq.com/q/c9BOvFT6tc" target="_blank" rel="noopener noreferrer">
<a class="service-contact-link" data-contact="wechat" data-copy-text="Dygzn123" href="https://u.wechat.com/MMwBClCfxTYX-Z1rWS3_esc?s=2" target="_blank" rel="noopener noreferrer">
```

- [ ] **Step 4: 在主脚本中绑定委托点击处理器**

在“找我做事”代码段加入：

```javascript
document.addEventListener('click', async function(event) {
    const element = event.target instanceof Element ? event.target : null;
    const link = element?.closest('.service-contact-link[data-copy-text]');
    if (!link) return;

    const account = link.querySelector('strong');
    const originalText = account?.textContent || '';
    const copied = await ServiceStatusUI.copyText(link.dataset.copyText);

    if (!copied) {
        console.warn('联系账号复制失败');
        return;
    }

    if (account) {
        account.textContent = '已复制';
        window.setTimeout(() => {
            if (account.isConnected) account.textContent = originalText;
        }, 1500);
    }
});
```

该处理器不调用 `preventDefault()`。

- [ ] **Step 5: 运行目标测试和语法检查**

Run:

```powershell
python -m unittest tests.test_service_status.ServiceStatusTemplateTests.test_home_renders_service_status_navigation_and_page -v
node --test tests/test_service_status_ui.js
node --check static/js/main.js
```

Expected: 全部通过。

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

Expected: Python 27 项通过；Node 原有 5 项加新增 3 项，共 8 项通过；4 个 JavaScript 文件语法检查通过；Git 无空白错误。

- [ ] **Step 7: 清除测试生成的 Python 缓存并提交接入代码**

安全枚举并删除仓库内（排除 `.git`）所有 `__pycache__` 和 `.pyc`，确认残留为 0，然后运行：

```powershell
git add -- templates/index.html tests/test_service_status.py static/js/main.js
git commit -m "feat: copy account when opening contact links"
```

Expected: 最终实现提交仅包含模板属性、模板测试和点击处理器。
