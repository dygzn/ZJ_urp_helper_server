# “找我做事”页面改版实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有“状态 + 两个账号”页面改为白色主题的校园技术服务介绍页，并把联系方式收敛为一个按钮和按钮上方气泡。

**Architecture:** Jinja模板负责静态服务内容和联系气泡语义结构，现有状态API继续动态填充状态卡。`service-status-ui.js` 增加纯状态转换函数供 Node 测试，`main.js` 将该函数连接到按钮、气泡、剪贴板复制和关闭事件；CSS沿用项目变量构建960px响应式白色卡片布局。

**Tech Stack:** Flask、Jinja2、原生 HTML/CSS/JavaScript、Python `unittest`、BeautifulSoup、Node `node:test`、Playwright CLI

## Global Constraints

- 页面定位为收费课程辅导与技术支持，不出现代写代做、代登录、保证分数或刷课文案。
- 页面只出现一个可见的 `联系我` 主按钮。
- QQ号为 `786171937`，点击QQ选项只复制，不使用 `tencent://`。
- 微信号为 `Dygzn123`，微信选项保留 `weixin://contacts/profile/Dygzn123` 并尝试复制微信号。
- 不展示公开价格、案例、评价、历史任务或完成数量。
- 保持 `/api/service-status`、管理员后台、数据库和 `copyText(text, environment?) -> Promise<boolean>` 不变。
- 使用现有白色主题和 `var(--accent)` 蓝色，不新增图片、外部字体或第三方前端依赖。

---

## File Structure

- `tests/test_service_status_ui.js`：验证联系气泡的纯状态转换和现有剪贴板复制。
- `static/js/service-status-ui.js`：新增 `nextContactPopoverState(isOpen, action) -> boolean`。
- `tests/test_service_status.py`：验证改版后的用户可见内容和联系方式DOM契约。
- `templates/index.html`：提供首屏、状态挂载点、服务卡、流程卡、唯一按钮和联系气泡。
- `static/css/style.css`：提供960px白色卡片布局、气泡、焦点样式和响应式规则。
- `static/js/main.js`：连接气泡状态、关闭事件和复制反馈。

### Task 1: 联系气泡纯状态逻辑

**Files:**
- Modify: `tests/test_service_status_ui.js`
- Modify: `static/js/service-status-ui.js`

**Interfaces:**
- Consumes: `isOpen: boolean` 和 `action: 'toggle' | 'outside-click' | 'escape' | 'select' | string`。
- Produces: `nextContactPopoverState(isOpen, action) -> boolean`，并通过 `ServiceStatusUI` 和 CommonJS 导出。

- [ ] **Step 1: 写入失败测试**

在测试导入中增加 `nextContactPopoverState`，并添加：

```javascript
test('联系按钮可打开并再次点击关闭气泡', () => {
    assert.equal(nextContactPopoverState(false, 'toggle'), true);
    assert.equal(nextContactPopoverState(true, 'toggle'), false);
});

test('点击外部、按 Escape 或选择联系方式都会关闭气泡', () => {
    assert.equal(nextContactPopoverState(true, 'outside-click'), false);
    assert.equal(nextContactPopoverState(true, 'escape'), false);
    assert.equal(nextContactPopoverState(true, 'select'), false);
});

test('未知动作保持联系气泡原状态', () => {
    assert.equal(nextContactPopoverState(true, 'unknown'), true);
    assert.equal(nextContactPopoverState(false, 'unknown'), false);
});
```

- [ ] **Step 2: 运行测试并确认正确失败**

Run:

```powershell
node --test tests/test_service_status_ui.js
```

Expected: FAIL，提示 `nextContactPopoverState is not a function`。

- [ ] **Step 3: 写入最小实现**

在 `service-status-ui.js` 工厂函数中增加：

```javascript
function nextContactPopoverState(isOpen, action) {
    if (action === 'toggle') return !isOpen;
    if (action === 'outside-click' || action === 'escape' || action === 'select') {
        return false;
    }
    return isOpen === true;
}
```

并在返回对象中增加 `nextContactPopoverState`，不得修改现有函数签名。

- [ ] **Step 4: 运行测试并确认通过**

Run:

```powershell
node --test tests/test_service_status_ui.js
```

Expected: 8项测试全部通过（现有5项 + 新增3项）。

- [ ] **Step 5: 提交纯逻辑**

```powershell
git add -- tests/test_service_status_ui.js static/js/service-status-ui.js
git commit -m "feat: add contact popover state logic"
```

### Task 2: 页面内容与联系方式DOM契约

**Files:**
- Modify: `tests/test_service_status.py:136-172`
- Modify: `templates/index.html:132-154`
- Modify: `static/css/style.css:4250-4392`

**Interfaces:**
- Consumes: `#service-status-content` 作为现有 `loadServiceStatus()` 的动态挂载点。
- Produces: `#service-contact-trigger`、`#service-contact-popover`、`.service-contact-option[data-copy-text]`、四张 `.service-offer-card` 和三张 `.service-process-step`。

- [ ] **Step 1: 将模板测试改写为新页面契约**

保留导航和后台编辑器断言，将首页断言改为：

```python
        page = soup.select_one('#page-service-status')
        self.assertEqual(
            page.select_one('.service-hero-title').get_text(' ', strip=True),
            '计算机课程遇到卡点？ 我来陪你解决。',
        )
        self.assertEqual(len(page.select('.service-offer-card')), 4)
        self.assertEqual(
            [card.select_one('h3').get_text(strip=True) for card in page.select('.service-offer-card')],
            ['Python 编程', 'Linux 实验', '云计算项目', 'Excel 数据分析'],
        )
        self.assertEqual(len(page.select('.service-process-step')), 3)

        triggers = page.select('#service-contact-trigger')
        self.assertEqual(len(triggers), 1)
        self.assertEqual(triggers[0].get_text(' ', strip=True), '联系我 →')
        self.assertEqual(triggers[0].get('aria-expanded'), 'false')
        self.assertEqual(triggers[0].get('aria-controls'), 'service-contact-popover')

        popover = page.select_one('#service-contact-popover[hidden]')
        self.assertIsNotNone(popover)
        qq_button = popover.select_one('button[data-contact="qq"]')
        self.assertEqual(qq_button.get('data-copy-text'), '786171937')
        self.assertFalse(qq_button.has_attr('href'))

        wechat_link = popover.select_one('a[data-contact="wechat"]')
        self.assertEqual(wechat_link.get('data-copy-text'), 'Dygzn123')
        self.assertEqual(
            wechat_link.get('href'),
            'weixin://contacts/profile/Dygzn123',
        )
        self.assertEqual(page.select('.service-contact-links'), [])
```

- [ ] **Step 2: 运行目标测试并确认正确失败**

Run:

```powershell
python -m unittest tests.test_service_status.ServiceStatusTemplateTests.test_home_renders_service_status_navigation_and_page -v
```

Expected: FAIL，旧页面没有 `.service-hero-title`、服务卡、流程卡和唯一联系按钮。

- [ ] **Step 3: 写入模板结构和最终文案**

将 `#page-service-status` 内容替换为以下职责清晰的结构：

```html
<div class="service-status-container">
    <div class="service-hero-grid">
        <section class="service-intro-card">
            <span class="service-status-kicker">校园技术搭子</span>
            <h2 class="service-hero-title">计算机课程遇到卡点？<br>我来陪你解决。</h2>
            <p class="service-hero-description">面向本校同学的编程辅导、项目指导与问题排查。把课程名称、具体要求和截止时间发来，我会先帮你免费评估，报价可以沟通。</p>
            <div class="service-contact-control">
                <button id="service-contact-trigger" class="service-contact-trigger" type="button" aria-expanded="false" aria-controls="service-contact-popover">联系我 <span aria-hidden="true">→</span></button>
                <div id="service-contact-popover" class="service-contact-popover" hidden>
                    <a class="service-contact-option" data-contact="wechat" data-copy-text="Dygzn123" href="weixin://contacts/profile/Dygzn123" target="_blank" rel="noopener noreferrer">
                        <span class="service-contact-icon is-wechat" aria-hidden="true">微</span>
                        <span><strong>微信联系</strong><small data-copy-feedback>复制微信号并尝试打开微信</small></span>
                    </a>
                    <button class="service-contact-option" data-contact="qq" data-copy-text="786171937" type="button">
                        <span class="service-contact-icon is-qq" aria-hidden="true">Q</span>
                        <span><strong>复制QQ号</strong><small data-copy-feedback>786171937</small></span>
                    </button>
                </div>
            </div>
        </section>
        <aside id="service-status-content" class="service-status-card"><div class="loading">加载中...</div></aside>
    </div>
    <h2 class="service-section-title">这些问题都可以来问</h2>
    <div class="service-offer-grid">
        <article class="service-offer-card"><span class="service-offer-icon">Py</span><h3>Python 编程</h3><p>基础编程、数据处理、报错定位与代码讲解</p></article>
        <article class="service-offer-card"><span class="service-offer-icon">Lx</span><h3>Linux 实验</h3><p>环境配置、命令使用、实验排错与思路辅导</p></article>
        <article class="service-offer-card"><span class="service-offer-icon">☁</span><h3>云计算项目</h3><p>需求拆解、部署流程、项目结构与问题排查</p></article>
        <article class="service-offer-card"><span class="service-offer-icon">X</span><h3>Excel 数据分析</h3><p>数据清洗、公式分析、图表展示与结果说明</p></article>
    </div>
    <h2 class="service-section-title">合作很简单</h2>
    <div class="service-process-grid">
        <article class="service-process-step"><span>1</span><div><h3>把要求发来</h3><p>附上课程、任务说明、截止时间和当前进度</p></div></article>
        <article class="service-process-step"><span>2</span><div><h3>免费评估</h3><p>确认能否协助、处理方式、预计时间和报价</p></div></article>
        <article class="service-process-step"><span>3</span><div><h3>开始解决</h3><p>按约定进行辅导、调试与成果讲解</p></div></article>
    </div>
    <p class="service-pricing-note">不知道能不能做也没关系，先把要求发来问一下。页面不会公开价格，以实际任务评估为准。</p>
</div>
```

- [ ] **Step 4: 用现有主题变量重写页面CSS**

删除旧 `.service-status-head` 和 `.service-contact-links` 规则，新增以下规则组：

```css
.service-status-container { max-width: 960px; margin: 34px auto 0; }
.service-hero-grid { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(260px, .55fr); gap: 16px; }
.service-intro-card,
.service-status-card,
.service-offer-card,
.service-process-step { background: var(--card-bg); border: 1px solid rgba(0, 122, 255, .12); }
.service-contact-control { position: relative; display: inline-block; margin-top: 22px; }
.service-contact-popover { position: absolute; left: 0; bottom: calc(100% + 12px); z-index: 20; width: min(280px, calc(100vw - 48px)); }
.service-contact-popover[hidden] { display: none; }
.service-offer-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.service-process-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.service-intro-card { padding: 32px; border-radius: 24px; box-shadow: 0 18px 45px rgba(18, 36, 70, .08); }
.service-status-card { min-height: 100%; padding: 28px; border-radius: 24px; box-shadow: 0 18px 45px rgba(18, 36, 70, .08); }
.service-contact-trigger { padding: 13px 18px; border: 0; border-radius: 12px; background: var(--accent); color: #fff; font-weight: 750; }
.service-contact-popover { padding: 10px; border: 1px solid var(--border); border-radius: 16px; background: var(--card-bg); box-shadow: 0 18px 48px rgba(18, 36, 70, .18); }
.service-contact-option { display: flex; width: 100%; align-items: center; gap: 10px; padding: 10px; border: 0; border-radius: 11px; background: transparent; color: var(--text-primary); text-align: left; text-decoration: none; }
.service-contact-option:hover,
.service-contact-option:focus-visible { background: var(--bg-secondary); outline: 2px solid transparent; }
.service-hero-title { margin: 12px 0; color: var(--text-primary); font-size: clamp(30px, 5vw, 46px); line-height: 1.12; }
.service-hero-description { margin: 0; max-width: 620px; color: var(--text-secondary); font-size: 15px; line-height: 1.75; }
.service-contact-icon,
.service-offer-icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; background: rgba(0, 122, 255, .1); color: var(--accent); font-size: 13px; font-weight: 800; }
.service-contact-option strong { display: block; font-size: 14px; }
.service-contact-option small { display: block; margin-top: 3px; color: var(--text-tertiary); font-size: 12px; }
.service-offer-card,
.service-process-step { padding: 18px; border-radius: 16px; }
.service-offer-card h3,
.service-process-step h3 { margin: 12px 0 6px; color: var(--text-primary); font-size: 15px; }
.service-offer-card p,
.service-process-step p { margin: 0; color: var(--text-secondary); font-size: 13px; line-height: 1.6; }
.service-process-step { display: flex; align-items: flex-start; gap: 12px; }
.service-process-step > span { display: grid; place-items: center; flex: 0 0 26px; width: 26px; height: 26px; border-radius: 8px; background: var(--accent); color: #fff; font-size: 12px; font-weight: 800; }
.service-process-step h3 { margin-top: 2px; }
.service-section-title { margin: 30px 0 14px; font-size: 20px; }
.service-pricing-note { margin: 16px 2px 0; color: var(--text-tertiary); font-size: 13px; }
@media (max-width: 760px) {
    .service-hero-grid,
    .service-process-grid { grid-template-columns: 1fr; }
    .service-offer-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 480px) {
    .service-offer-grid { grid-template-columns: 1fr; }
}
```

- [ ] **Step 5: 运行目标模板测试并确认通过**

Run:

```powershell
python -m unittest tests.test_service_status.ServiceStatusTemplateTests.test_home_renders_service_status_navigation_and_page -v
```

Expected: PASS。

- [ ] **Step 6: 提交页面结构和样式**

```powershell
git add -- tests/test_service_status.py templates/index.html static/css/style.css
git commit -m "feat: redesign service introduction page"
```

### Task 3: 联系气泡交互与复制反馈

**Files:**
- Modify: `static/js/main.js:380-404`

**Interfaces:**
- Consumes: `ServiceStatusUI.nextContactPopoverState()`、`ServiceStatusUI.copyText()`、Task 2 的DOM ID和 `data-copy-feedback`。
- Produces: 联系气泡打开/关闭、QQ仅复制、微信不阻止默认跳转、1500ms复制反馈。

- [ ] **Step 1: 用新DOM契约替换旧联系方式事件处理**

新增：

```javascript
function setServiceContactPopoverOpen(isOpen) {
    const trigger = document.getElementById('service-contact-trigger');
    const popover = document.getElementById('service-contact-popover');
    if (!trigger || !popover) return;
    trigger.setAttribute('aria-expanded', String(isOpen));
    popover.hidden = !isOpen;
}
```

委托点击处理器按以下顺序处理：

1. 点击 `#service-contact-trigger`：读取 `aria-expanded`，调用 `nextContactPopoverState(current, 'toggle')`。
2. 点击 `.service-contact-option[data-copy-text]`：不调用 `preventDefault()`；关闭气泡；调用 `copyText()`；成功时将 `[data-copy-feedback]` 暂时改为 `已复制`，1500ms后恢复；失败时只记录警告。
3. 气泡已打开且点击目标不在 `.service-contact-control` 内：调用 `nextContactPopoverState(true, 'outside-click')`。

新增 `keydown` 监听：按下 `Escape` 且气泡打开时关闭气泡并把焦点还给触发按钮。

- [ ] **Step 2: 运行Node测试和语法检查**

Run:

```powershell
node --test tests/test_service_status_ui.js
node --check static/js/main.js
```

Expected: 8项测试通过，语法检查退出码为0。

- [ ] **Step 3: 提交浏览器交互**

```powershell
git add -- static/js/main.js
git commit -m "feat: add service contact chooser"
```

### Task 4: 完整验证与真实浏览器验收

**Files:**
- Verify only: `templates/index.html`
- Verify only: `static/css/style.css`
- Verify only: `static/js/main.js`
- Verify only: `static/js/service-status-ui.js`

**Interfaces:**
- Consumes: Tasks 1–3 的完整页面。
- Produces: 桌面与移动端验收证据；不新增生产接口。

- [ ] **Step 1: 运行完整自动化验证**

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

Expected: Python 27项通过；Node 11项通过（原8项 + 新增3项）；4个JavaScript文件语法检查通过；Git无空白错误。

- [ ] **Step 2: 启动本地服务并进行手机视口验收**

使用 Playwright CLI 打开 `http://127.0.0.1:5000`，切换到“找我做事”，将视口设为 `390 × 844`，验证：

- 页面只有一个可见“联系我”按钮。
- 服务卡和流程卡无横向溢出。
- 点击按钮后气泡位于按钮上方且不超出视口。
- 点击QQ后剪贴板获得 `786171937`，气泡关闭，页面URL不变。
- 按 Escape 和点击外部都能关闭气泡。

- [ ] **Step 3: 进行桌面视口验收**

将视口设为 `1440 × 900`，验证：

- 首屏为介绍卡与状态卡双栏。
- 服务卡四列、流程卡三列。
- 状态数据成功加载。
- 微信选项的实时 `href` 为 `weixin://contacts/profile/Dygzn123`，点击处理器未阻止默认导航。

- [ ] **Step 4: 清理本次生成物与Python缓存**

停止视觉对比服务和测试用Flask服务。仅删除本次生成的 `.playwright-cli/`、`.superpowers/`、`service-page-inspiration.json`，以及仓库内经绝对路径校验的全部 `__pycache__` 和 `.pyc`；确认目标均位于 `E:\URP\web` 后再删除，并确认残留数量为0。

- [ ] **Step 5: 检查最终仓库状态**

Run:

```powershell
git status --short
git log -5 --oneline
```

Expected: 工作区干净，最近提交依次包含气泡逻辑、页面改版和联系选择交互；不推送远程。
