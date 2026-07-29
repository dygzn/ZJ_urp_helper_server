# 课程表周末列动态显示实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让课程表按当前周课程自动显示五天或七天，并在切换到无周末课程或空周时清除旧的周末显示状态。

**Architecture:** 保留现有课程分组和 CSS 五列/七列布局，将 DOM 状态切换提取到一个可独立测试的浏览器脚本。`main.js` 继续负责从课程数据计算 `hasWeekend`，新脚本只负责同步表头和课程网格的 `no-weekend` 类；空状态复用同一同步入口。

**Tech Stack:** Flask/Jinja2、原生 JavaScript、CSS Grid、Node.js `node:test`、Python `unittest`、BeautifulSoup。

## Global Constraints

- 当前显示周次的周六、周日都没有课时，只显示周一至周五。
- 周六或周日任一天有课时，同时显示周六、周日两列。
- 切换周次、查看其他班级课表和显示空周次时，均依据当前数据重新计算。
- 不修改后端课表接口、缓存格式或课程解析逻辑。
- 不引入新的第三方依赖。

---

### Task 1: 周末列状态的回归测试与实现

**Files:**
- Create: `static/js/schedule-layout.js`
- Create: `tests/test_schedule_weekend_visibility.js`
- Create: `tests/test_schedule_weekend_visibility.py`
- Modify: `templates/index.html:54,268`
- Modify: `static/js/main.js:788-995`

**Interfaces:**
- Consumes: `displaySchedule()` 计算出的 `hasWeekend: boolean`、`.schedule-grid` 元素和 `.schedule-header` 元素。
- Produces: `setScheduleWeekendVisibility(hasWeekend, scheduleGrid, scheduleHeader) -> void`，同时维护两个容器的 `no-weekend` 类。

- [ ] **Step 1: 编写 JavaScript 状态切换失败测试**

创建 `tests/test_schedule_weekend_visibility.js`：

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');

const {
    setScheduleWeekendVisibility,
} = require('../static/js/schedule-layout.js');

function makeElement(initialClasses = []) {
    const classes = new Set(initialClasses);
    return {
        classList: {
            toggle(name, force) {
                if (force) classes.add(name);
                else classes.delete(name);
            },
            contains(name) {
                return classes.has(name);
            },
        },
    };
}

test('工作日课表同时隐藏表头和内容的周末列', () => {
    const grid = makeElement();
    const header = makeElement();

    setScheduleWeekendVisibility(false, grid, header);

    assert.equal(grid.classList.contains('no-weekend'), true);
    assert.equal(header.classList.contains('no-weekend'), true);
});

test('周六或周日有课时同时显示两个周末列', () => {
    const grid = makeElement(['no-weekend']);
    const header = makeElement(['no-weekend']);

    setScheduleWeekendVisibility(true, grid, header);

    assert.equal(grid.classList.contains('no-weekend'), false);
    assert.equal(header.classList.contains('no-weekend'), false);
});

test('从有周末课程切换到空周时不会保留七列状态', () => {
    const grid = makeElement();
    const header = makeElement();

    setScheduleWeekendVisibility(true, grid, header);
    setScheduleWeekendVisibility(false, grid, header);

    assert.equal(grid.classList.contains('no-weekend'), true);
    assert.equal(header.classList.contains('no-weekend'), true);
});
```

- [ ] **Step 2: 编写渲染后模板契约失败测试**

创建 `tests/test_schedule_weekend_visibility.py`：

```python
import unittest

from bs4 import BeautifulSoup

import app as app_module


class ScheduleTemplateContractTests(unittest.TestCase):
    def test_rendered_schedule_marks_weekend_headers_and_loads_layout_script_first(self):
        client = app_module.app.test_client()

        response = client.get('/')

        self.assertEqual(response.status_code, 200)
        soup = BeautifulSoup(response.get_data(as_text=True), 'html.parser')
        weekend_headers = soup.select(
            '.schedule-header .schedule-header-day.schedule-header-weekend'
        )
        self.assertEqual(
            [header.get_text(strip=True) for header in weekend_headers],
            ['周六', '周日'],
        )

        script_sources = [
            script.get('src')
            for script in soup.select('script[src]')
        ]
        self.assertLess(
            script_sources.index('/static/js/schedule-layout.js'),
            script_sources.index('/static/js/main.js'),
        )


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 3: 运行新增测试并确认 RED**

Run:

```powershell
node --test tests/test_schedule_weekend_visibility.js
D:\app\tool\python\python.exe -m unittest tests.test_schedule_weekend_visibility -v
```

Expected:

- Node 测试因 `static/js/schedule-layout.js` 不存在而失败。
- Python 测试因周六、周日表头缺少 `schedule-header-weekend`，且布局脚本尚未加载而失败。

- [ ] **Step 4: 实现可测试的周末状态同步函数**

创建 `static/js/schedule-layout.js`：

```javascript
function setScheduleWeekendVisibility(hasWeekend, scheduleGrid, scheduleHeader) {
    const hideWeekend = !hasWeekend;
    scheduleGrid.classList.toggle('no-weekend', hideWeekend);
    scheduleHeader.classList.toggle('no-weekend', hideWeekend);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { setScheduleWeekendVisibility };
}
```

- [ ] **Step 5: 标记周末表头并按依赖顺序加载脚本**

在 `templates/index.html` 中：

1. 给“周六”和“周日”两个 `.schedule-header-day` 增加 `schedule-header-weekend` 类。
2. 在 `/static/js/main.js` 之前加入：

```html
<script src="/static/js/schedule-layout.js"></script>
```

- [ ] **Step 6: 让正常渲染和空状态使用同一显示规则**

在 `loadSchedule()` 前增加：

```javascript
function resetScheduleDisplay() {
    const scheduleDays = document.getElementById('schedule-days');
    const scheduleGrid = document.querySelector('.schedule-grid');
    const scheduleHeader = document.querySelector('.schedule-header');

    scheduleDays.innerHTML = '';
    scheduleGrid.classList.remove('has-evening');
    setScheduleWeekendVisibility(false, scheduleGrid, scheduleHeader);
}
```

把 `loadSchedule()` 内用于空周、空数据和错误分支的 `scheduleDays.innerHTML = '';` 替换为：

```javascript
resetScheduleDisplay();
```

在 `displaySchedule()` 末尾，把直接对两个元素切换 `no-weekend` 的代码替换为：

```javascript
setScheduleWeekendVisibility(
    hasWeekend,
    scheduleGrid,
    document.querySelector('.schedule-header'),
);
```

保留现有 `hasWeekend = daysCourses[6].length > 0 || daysCourses[7].length > 0`，因此周六或周日任一天有课都会展示完整七列。

- [ ] **Step 7: 运行新增测试并确认 GREEN**

Run:

```powershell
node --test tests/test_schedule_weekend_visibility.js
D:\app\tool\python\python.exe -m unittest tests.test_schedule_weekend_visibility -v
```

Expected: JavaScript 3 个测试与 Python 1 个测试全部通过。

- [ ] **Step 8: 执行变异检查**

临时把 `schedule-layout.js` 中的 `const hideWeekend = !hasWeekend;` 改为 `const hideWeekend = false;`，运行 Node 测试，确认“工作日课表”和“切换到空周”至少两个测试失败；随后恢复正确实现并重新运行 Node 测试，确认全部通过。临时变异不提交。

- [ ] **Step 9: 提交功能**

```powershell
git add static/js/schedule-layout.js static/js/main.js templates/index.html tests/test_schedule_weekend_visibility.js tests/test_schedule_weekend_visibility.py
git commit -m "fix: hide empty weekend schedule columns"
```

### Task 2: 完整回归验证

**Files:**
- Verify: `static/js/schedule-layout.js`
- Verify: `static/js/main.js`
- Verify: `templates/index.html`
- Verify: `tests/test_schedule_weekend_visibility.js`
- Verify: `tests/test_schedule_weekend_visibility.py`
- Verify: `tests/test_vpn_session_recovery.py`

**Interfaces:**
- Consumes: Task 1 的课程表周末显示实现。
- Produces: 前端脚本可解析、Flask 应用可导入、VPN 修复未回归的验证结果。

- [ ] **Step 1: 检查 JavaScript 语法**

```powershell
node --check static/js/schedule-layout.js
node --check static/js/main.js
```

Expected: 两条命令均退出码 0，无输出。

- [ ] **Step 2: 运行全部自动化回归测试**

```powershell
node --test tests/test_schedule_weekend_visibility.js
D:\app\tool\python\python.exe -m unittest discover -s tests -p "test_*.py" -v
```

Expected: Node 3 个测试通过；Python 课程表模板测试和现有 12 个 VPN 测试全部通过。

- [ ] **Step 3: 验证 Flask 应用与关键路由**

```powershell
D:\app\tool\python\python.exe -m py_compile app.py auth.py database.py URP.py urp/login.py urp/query.py services/urp_service.py routes/data_routes.py
D:\app\tool\python\python.exe -c "import app; rules={r.rule for r in app.app.url_map.iter_rules()}; required={'/','/api/login','/api/grades','/api/schedule','/api/exams'}; missing=required-rules; print('routes', len(rules), 'missing', sorted(missing)); raise SystemExit(bool(missing))"
```

Expected: 编译退出码 0；路由检查输出 `missing []`。

- [ ] **Step 4: 检查提交与工作区范围**

```powershell
git diff --check
git status --short --branch
git show --stat --oneline HEAD
```

Expected: `git diff --check` 退出码 0；本任务文件均已提交；原有运行时文件和开发文档状态未被修改。
