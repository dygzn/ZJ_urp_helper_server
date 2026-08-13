# 问卷调查功能移除 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完整移除站内问卷调查的用户界面、管理界面、API、数据库结构和历史数据，同时不影响教务评教及其他现有功能。

**Architecture:** 先用模板、静态脚本和路由回归测试锁定“功能不再存在”的外部表现，再删除前后端实现。数据库初始化保留一个兼容旧部署的 `_drop_removed_tables(conn)` 清理步骤，使 SQLite 和 MySQL 的旧 `surveys` 表在升级后被永久删除。

**Tech Stack:** Python 3、Flask 3、SQLite/MySQL、`unittest`、BeautifulSoup、原生 JavaScript、HTML/CSS

## Global Constraints

- 当前本地 `surveys` 表及其中 1 条数据永久删除，用户已明确确认。
- `/api/surveys`、`/api/admin/surveys` 和 `/api/admin/surveys/<survey_id>` 必须不再注册。
- 保留 `urp/query.py` 中教务评教语境的“您没有可回答的问卷”提示及相关逻辑。
- 不改动“找我做事”、公告、反馈、评教、会员等无关业务。
- 不引入新运行时依赖。

---

## 文件结构

- Create: `tests/test_survey_removal.py` — 集中验证用户界面、管理界面、接口和数据库清理结果。
- Modify: `templates/index.html` — 删除用户端入口和页面。
- Modify: `templates/admin.html` — 删除管理员入口、页面和弹窗。
- Modify: `static/js/main.js` — 删除用户端问卷加载、切换和渲染逻辑。
- Modify: `static/js/admin.js` — 删除管理员端问卷 CRUD 逻辑。
- Modify: `static/css/style.css` — 从共用规则中移除用户端问卷选择器。
- Modify: `static/css/admin.css` — 从共用规则中移除管理员端问卷选择器。
- Modify: `routes/misc_routes.py` — 删除问卷 API，并收窄模块说明。
- Modify: `services/logging_service.py` — 删除问卷接口日志名称映射。
- Modify: `database.py` — 删除问卷建表、索引、迁移映射并清理旧表。
- Modify: `AGENTS.md` — 删除架构与数据表说明中的问卷功能。
- Modify: `CLAUDE.md` — 同步删除架构与数据表说明中的问卷功能。

### Task 1: 移除用户端和管理员端界面

**Files:**
- Create: `tests/test_survey_removal.py`
- Modify: `templates/index.html:23,131`
- Modify: `templates/admin.html:44,107-109,180`
- Modify: `static/js/main.js:305,366-368,2099-2149`
- Modify: `static/js/admin.js:82-83,1156-1330`
- Modify: `static/css/style.css:3699-3705`
- Modify: `static/css/admin.css:2131-2137,2586`

**Interfaces:**
- Consumes: Flask 页面路由 `/`、`/admin` 和仓库中的前端静态文件。
- Produces: 不含问卷导航、页面、弹窗、函数和 API 地址的前端；后续任务通过同一个测试文件追加后端断言。

- [ ] **Step 1: 写出失败的界面回归测试**

```python
import pathlib
import unittest

from bs4 import BeautifulSoup

import app as app_module


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[1]


class SurveyUiRemovalTests(unittest.TestCase):
    def setUp(self):
        self.client = app_module.app.test_client()

    def test_user_page_has_no_survey_feature(self):
        response = self.client.get('/')
        self.assertEqual(response.status_code, 200)
        soup = BeautifulSoup(response.get_data(as_text=True), 'html.parser')
        self.assertIsNone(soup.select_one('[data-page="surveys"]'))
        self.assertIsNone(soup.select_one('#page-surveys'))

    def test_admin_page_has_no_survey_feature(self):
        response = self.client.get('/admin')
        self.assertEqual(response.status_code, 200)
        soup = BeautifulSoup(response.get_data(as_text=True), 'html.parser')
        self.assertIsNone(soup.select_one('#tab-surveys'))
        self.assertIsNone(soup.select_one('#survey-modal'))
        self.assertNotIn("switchTab('surveys')", response.get_data(as_text=True))

    def test_frontend_scripts_have_no_survey_requests_or_handlers(self):
        main_js = (PROJECT_ROOT / 'static/js/main.js').read_text(encoding='utf-8')
        admin_js = (PROJECT_ROOT / 'static/js/admin.js').read_text(encoding='utf-8')
        for removed_text in ('/api/surveys', 'loadSurveysList', 'displaySurveysList'):
            self.assertNotIn(removed_text, main_js)
        for removed_text in (
            '/api/admin/surveys', 'loadSurveys', 'displaySurveys',
            'showCreateSurveyModal', 'showEditSurveyModal',
            'closeSurveyModal', 'handleSurveySubmit', 'deleteSurvey',
        ):
            self.assertNotIn(removed_text, admin_js)
```

- [ ] **Step 2: 运行测试并确认它因现有问卷界面而失败**

Run: `python -m unittest tests.test_survey_removal.SurveyUiRemovalTests -v`

Expected: FAIL，至少报告 `[data-page="surveys"]`、`#tab-surveys` 或问卷脚本函数仍然存在。

- [ ] **Step 3: 删除界面和客户端实现**

在 `templates/index.html` 删除 `data-page="surveys"` 导航链接和完整的 `#page-surveys` 节点；在 `templates/admin.html` 删除问卷标签按钮、`#tab-surveys` 区块和 `#survey-modal`。

在 `static/js/main.js` 删除以下映射、分支和函数块：

```javascript
'surveys': '问卷调查'

case 'surveys':
    loadSurveysList();
    break;
```

同时删除从注释 `// ==================== 问卷调查 ====================` 开始，经过 `async function loadSurveysList()` 和 `function displaySurveysList(surveys)`，直到 `displaySurveysList` 闭合花括号为止的连续区块；后面的反馈功能注释必须保留。

在 `static/js/admin.js` 删除 `switchTab` 的问卷分支，以及从 `let currentSurveyId = null;` 到 `deleteSurvey` 函数结束的完整问卷管理区块。

在 CSS 组合选择器中只删除 `.surveys-container`、`.surveys-list` 和 `#survey-form > label`，保留共享声明块及其他选择器。

- [ ] **Step 4: 运行界面测试确认通过**

Run: `python -m unittest tests.test_survey_removal.SurveyUiRemovalTests -v`

Expected: 3 tests PASS。

- [ ] **Step 5: 提交界面移除**

```bash
git add tests/test_survey_removal.py templates/index.html templates/admin.html static/js/main.js static/js/admin.js static/css/style.css static/css/admin.css
git commit -m "refactor: remove survey interfaces"
```

### Task 2: 移除问卷 API 和日志映射

**Files:**
- Modify: `tests/test_survey_removal.py`
- Modify: `routes/misc_routes.py:1-2,215-289`
- Modify: `services/logging_service.py:63,70`

**Interfaces:**
- Consumes: `app_module.app` 的统一 API 404 处理器。
- Produces: 不再注册任何问卷路由的 Flask 应用；数据库任务不再有运行中的问卷 SQL 调用方。

- [ ] **Step 1: 追加失败的路由与日志测试**

```python
class SurveyApiRemovalTests(unittest.TestCase):
    def setUp(self):
        self.client = app_module.app.test_client()

    def test_survey_api_routes_are_not_registered(self):
        registered_rules = {str(rule) for rule in app_module.app.url_map.iter_rules()}
        self.assertNotIn('/api/surveys', registered_rules)
        self.assertNotIn('/api/admin/surveys', registered_rules)
        self.assertNotIn('/api/admin/surveys/<int:survey_id>', registered_rules)

    def test_removed_survey_api_paths_return_json_404(self):
        requests = (
            ('GET', '/api/surveys'),
            ('GET', '/api/admin/surveys'),
            ('POST', '/api/admin/surveys'),
            ('PUT', '/api/admin/surveys/1'),
            ('DELETE', '/api/admin/surveys/1'),
        )
        for method, path in requests:
            with self.subTest(method=method, path=path):
                response = self.client.open(path, method=method)
                self.assertEqual(response.status_code, 404)
                self.assertTrue(response.is_json)
                self.assertFalse(response.get_json()['success'])

    def test_logging_map_has_no_survey_endpoints(self):
        source = (PROJECT_ROOT / 'services/logging_service.py').read_text(encoding='utf-8')
        self.assertNotIn("'/api/surveys'", source)
        self.assertNotIn("'/api/admin/surveys'", source)
```

- [ ] **Step 2: 运行测试并确认它因路由仍注册而失败**

Run: `python -m unittest tests.test_survey_removal.SurveyApiRemovalTests -v`

Expected: FAIL，路由表仍包含 `/api/surveys` 和 `/api/admin/surveys`。

- [ ] **Step 3: 删除后端实现**

从 `routes/misc_routes.py` 删除 `# ==================== 问卷 ====================` 至用户端 `get_surveys()` 返回语句的完整区块，并将模块说明从“公告、问卷、反馈、主题路由”改为“公告、反馈、主题路由”。

从 `services/logging_service.py` 的 `endpoint_names` 删除：

```python
'/api/surveys': '问卷列表',
'/api/admin/surveys': '管理-问卷',
```

- [ ] **Step 4: 运行路由测试确认通过**

Run: `python -m unittest tests.test_survey_removal.SurveyApiRemovalTests -v`

Expected: 3 tests PASS。

- [ ] **Step 5: 提交后端移除**

```bash
git add tests/test_survey_removal.py routes/misc_routes.py services/logging_service.py
git commit -m "refactor: remove survey api"
```

### Task 3: 删除数据库结构和历史数据

**Files:**
- Modify: `tests/test_survey_removal.py`
- Modify: `database.py:217-227,361-371,471,540,487-522`

**Interfaces:**
- Consumes: `init_db(config_override=None)` 及其 SQLite/MySQL 连接适配器。
- Produces: `_drop_removed_tables(conn) -> None`，由 `init_db` 在建表和字段迁移后、创建索引前调用。

- [ ] **Step 1: 追加失败的数据库清理测试**

```python
import os
import sqlite3
import tempfile

import database


class SurveyDatabaseRemovalTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.sqlite_path = os.path.join(self.temp_dir.name, 'survey-removal.db')
        self.config = {
            'database': {'type': 'sqlite', 'sqlite_path': self.sqlite_path}
        }

    def tearDown(self):
        self.temp_dir.cleanup()

    def survey_table_exists(self):
        with sqlite3.connect(self.sqlite_path) as conn:
            return conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'surveys'"
            ).fetchone() is not None

    def test_fresh_database_does_not_create_surveys_table(self):
        database.init_db(self.config)
        self.assertFalse(self.survey_table_exists())

    def test_init_db_drops_legacy_surveys_table_and_rows(self):
        with sqlite3.connect(self.sqlite_path) as conn:
            conn.execute(
                'CREATE TABLE surveys ('
                'id INTEGER PRIMARY KEY, title TEXT, url TEXT, '
                'create_time TEXT, is_active INTEGER)'
            )
            conn.execute(
                'INSERT INTO surveys VALUES (?, ?, ?, ?, ?)',
                (1, '旧问卷', 'https://example.com', '2026-08-13', 1),
            )
        database.init_db(self.config)
        self.assertFalse(self.survey_table_exists())

    def test_schema_source_keeps_only_legacy_drop_statement(self):
        source = (PROJECT_ROOT / 'database.py').read_text(encoding='utf-8')
        self.assertNotIn('CREATE TABLE IF NOT EXISTS surveys', source)
        self.assertNotIn('idx_survey_active', source)
        self.assertNotIn("'surveys': ['id'", source)
        self.assertIn('DROP TABLE IF EXISTS surveys', source)
```

- [ ] **Step 2: 运行测试并确认现有初始化仍创建问卷表**

Run: `python -m unittest tests.test_survey_removal.SurveyDatabaseRemovalTests -v`

Expected: FAIL，新数据库仍创建 `surveys`，旧数据库也未删除该表。

- [ ] **Step 3: 实现最小数据库清理**

删除 SQLite 和 MySQL 的 `CREATE TABLE IF NOT EXISTS surveys` 语句、`idx_survey_active` 索引条目及 `MIGRATION_TABLES['surveys']`。

在 `_run_migrations` 后定义并调用：

```python
def _drop_removed_tables(conn):
    conn.execute('DROP TABLE IF EXISTS surveys')


def init_db(config_override=None):
    db_config = get_database_config(config_override)
    with get_db(config_override) as conn:
        if db_config['type'] == 'mysql':
            _create_schema_mysql(conn)
        else:
            _create_schema_sqlite(conn)
        _run_migrations(conn, db_config['type'])
        _drop_removed_tables(conn)
        _create_indexes(conn)
```

- [ ] **Step 4: 运行数据库测试确认通过**

Run: `python -m unittest tests.test_survey_removal.SurveyDatabaseRemovalTests -v`

Expected: 3 tests PASS。

- [ ] **Step 5: 对当前数据库执行清理并只读核验**

Run: `python -c "import database; database.init_db(); import sqlite3; c=sqlite3.connect(database.DB_FILE); print(c.execute(\"SELECT COUNT(1) FROM sqlite_master WHERE type='table' AND name='surveys'\").fetchone()[0]); c.close()"`

Expected: 输出 `0`，表示本地旧表及其中 1 条数据已永久删除。

- [ ] **Step 6: 提交数据库清理**

```bash
git add tests/test_survey_removal.py database.py
git commit -m "refactor: drop survey storage"
```

### Task 4: 更新文档并完成全量验证

**Files:**
- Modify: `AGENTS.md:47,96`
- Modify: `CLAUDE.md:47,96`

**Interfaces:**
- Consumes: 前三项任务产出的无问卷代码库。
- Produces: 与实际功能一致的项目说明和完整验证证据。

- [ ] **Step 1: 更新项目说明**

将两个文档中的模块描述：

```text
misc_routes.py    # 公告、反馈、主题等
```

并删除数据库清单中的：

```text
surveys: 问卷调查
```

- [ ] **Step 2: 搜索残留并确认只保留教务评教语境**

Run: `rg -n "surveys|Survey|问卷" templates static routes services database.py AGENTS.md CLAUDE.md urp`

Expected: `templates`、`static`、`routes`、`services`、`database.py`、`AGENTS.md`、`CLAUDE.md` 无输出；`urp/query.py` 仅保留教务评教提示“您没有可回答的问卷”。

- [ ] **Step 3: 运行新增回归测试**

Run: `python -m unittest tests.test_survey_removal -v`

Expected: 9 tests PASS。

- [ ] **Step 4: 运行完整 Python 测试**

Run: `python -m unittest discover -s tests -p "test_*.py" -v`

Expected: 全部测试 PASS；如果仅有与本任务无关、由现有“找我做事”文案手动修改导致的旧断言失败，记录为既有问题，不回退用户文案。

- [ ] **Step 5: 运行现有 JavaScript 测试**

Run: `node --test tests/*.js`

Expected: 全部测试 PASS。

- [ ] **Step 6: 执行语法与差异检查**

Run: `python -m py_compile database.py routes/misc_routes.py services/logging_service.py tests/test_survey_removal.py`

Expected: 无输出，退出码 0。

Run: `git diff --check`

Expected: 无空白错误。

- [ ] **Step 7: 提交文档更新**

```bash
git add AGENTS.md CLAUDE.md
git commit -m "docs: remove survey feature references"
```

- [ ] **Step 8: 最终提交审计**

Run: `git status --short`

Expected: 工作区干净。

Run: `git log -5 --oneline`

Expected: 可见界面、API、数据库和文档四个独立提交，且未混入无关文件。
