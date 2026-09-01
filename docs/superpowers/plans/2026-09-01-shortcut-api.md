# 快捷指令公共查询 API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为初级会员及以上用户增加按学号唯一的快捷指令 API 密钥，并通过一个 POST 接口查询最新历年课表和网页“一键查本学期成绩”结果。

**Architecture:** 使用独立的 `shortcut` 路由和服务层隔离外部密钥认证与现有设备认证。`api_keys` 表按学号保存 SHA-256 哈希；公共查询验证密钥、会员状态和 URP 登录状态后，调用现有 URP 查询函数并把结果规范化为快捷指令友好的英文 JSON 字段。

**Tech Stack:** Flask 3.1、SQLite/MySQL 双数据库适配、现有 URP `BeautifulSoup` 查询器、原生 JavaScript、Python `unittest`、Node.js `node:test`。

**Spec:** `docs/superpowers/specs/2026-09-01-shortcut-api-design.md`

## Global Constraints

- 第一版只开放 `historical_schedule` 和 `grades` 两个公共动作。
- 密钥按学号归属，同一学号只有一个有效密钥；重新生成立即使旧密钥失效。
- 数据库只保存密钥哈希、脱敏前缀和生成时间；明文只在生成响应中返回一次。
- 生成密钥和公共查询都要求有效的 `basic` 或 `advanced` 会员资格。
- 公共接口请求体使用 `{key, action, params}`；密钥不放在 URL 中。
- `historical_schedule` 未传 `params.semester` 时选择 URP 返回的最新学期；显式学期查询保持原有行为。
- `grades` 必须复用 `get_latest_semester_grade_summary()`，保持网页“一键查本学期成绩”的数据口径。
- 公共业务成功和失败都返回可解析 JSON，失败响应包含稳定的 `error_code` 和 `data: null`。
- 遵循现有 `unittest` 手动测试风格，不引入 pytest；不改变现有网页接口响应格式。
- 所有新增代码和用户界面文案使用中文；公共 JSON 字段名使用稳定的英文 snake_case。

---

### Task 1: 添加 API 密钥表和密钥服务

**Files:**
- Create: `tests/test_shortcut_api.py`
- Create: `services/shortcut_service.py`
- Modify: `database.py:177-510`（SQLite/MySQL schema、索引、迁移清单）

**Interfaces:**
- Produces `services.shortcut_service.issue_api_key(username, now=None) -> dict`，返回 `key`、`key_prefix`、`create_time`。
- Produces `services.shortcut_service.get_api_key_status(username) -> dict`，固定返回 `has_key`、`key_prefix`、`create_time`。
- Produces `services.shortcut_service.resolve_api_key(raw_key) -> str | None`，成功返回学号，失败返回 `None`。
- Produces `services.shortcut_service.hash_api_key(raw_key) -> str`，返回 SHA-256 十六进制字符串。

- [x] **Step 1: Write the failing tests**

在 `tests/test_shortcut_api.py` 中先写以下最小测试和测试数据库夹具；夹具必须使用临时 SQLite，不能触碰 `data/urp_helper.db`：

```python
import os
import tempfile
import unittest
from datetime import datetime
from unittest import mock

import database
import services.shortcut_service as shortcut_service


class ShortcutApiKeyServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_config = {
            'database': {
                'type': 'sqlite',
                'sqlite_path': os.path.join(self.temp_dir.name, 'shortcut.db'),
            }
        }
        database.init_db(self.database_config)
        self.get_db_patcher = mock.patch.object(
            shortcut_service,
            'get_db',
            side_effect=lambda: database.get_db(self.database_config),
        )
        self.get_db_patcher.start()

    def tearDown(self):
        self.get_db_patcher.stop()
        self.temp_dir.cleanup()

    def test_api_keys_table_is_created(self):
        with database.get_db(self.database_config) as conn:
            row = conn.execute(
                "SELECT name FROM sqlite_master "
                "WHERE type = 'table' AND name = 'api_keys'"
            ).fetchone()
        self.assertIsNotNone(row)

    def test_issue_api_key_stores_hash_and_can_be_resolved(self):
        issued = shortcut_service.issue_api_key('2415108133', datetime(2026, 9, 1, 12, 0, 0))

        self.assertTrue(issued['key'].startswith('urp_'))
        self.assertNotEqual(issued['key'], issued['key_hash'] if 'key_hash' in issued else '')
        self.assertEqual(shortcut_service.resolve_api_key(issued['key']), '2415108133')

        with database.get_db(self.database_config) as conn:
            row = conn.execute(
                'SELECT key_hash, key_prefix, create_time FROM api_keys WHERE username = ?',
                ('2415108133',),
            ).fetchone()
        self.assertEqual(row['key_hash'], shortcut_service.hash_api_key(issued['key']))
        self.assertNotEqual(row['key_hash'], issued['key'])
        self.assertEqual(row['key_prefix'], issued['key'][:12])

    def test_reissuing_for_same_username_invalidates_old_key(self):
        first = shortcut_service.issue_api_key('2415108133', datetime(2026, 9, 1, 12, 0, 0))
        second = shortcut_service.issue_api_key('2415108133', datetime(2026, 9, 1, 12, 1, 0))

        self.assertIsNone(shortcut_service.resolve_api_key(first['key']))
        self.assertEqual(shortcut_service.resolve_api_key(second['key']), '2415108133')
        with database.get_db(self.database_config) as conn:
            count = conn.execute(
                'SELECT COUNT(*) AS count FROM api_keys WHERE username = ?',
                ('2415108133',),
            ).fetchone()['count']
        self.assertEqual(count, 1)

    def test_status_never_returns_plaintext_key(self):
        issued = shortcut_service.issue_api_key('2415108133')
        status = shortcut_service.get_api_key_status('2415108133')

        self.assertEqual(status['has_key'], True)
        self.assertEqual(status['key_prefix'], issued['key'][:12])
        self.assertNotIn('key', status)

    def test_unknown_username_has_empty_status(self):
        self.assertEqual(
            shortcut_service.get_api_key_status('not-found'),
            {'has_key': False, 'key_prefix': None, 'create_time': None},
        )


if __name__ == '__main__':
    unittest.main()
```

实现时 `issue_api_key` 的返回值必须包含 `key_hash` 以便测试和后续路由验证；该字段只在后端内部返回，不得放入 HTTP 响应。若希望公开返回值与内部对象分离，则在路由层显式挑选 `key`、`key_prefix`、`create_time`。

- [x] **Step 2: Run the focused tests to verify they fail**

Run: `python -m unittest tests.test_shortcut_api -v`

Expected: FAIL because `services.shortcut_service` and/or `api_keys` do not exist yet. If the test file has an import error unrelated to the missing feature, fix only the test setup until the failure is caused by the missing service/schema.

- [x] **Step 3: Add the database schema and minimal key service**

在 `database.py` 中：

1. 在 `_create_schema_sqlite()` 增加：

```sql
CREATE TABLE IF NOT EXISTS api_keys (
    username TEXT PRIMARY KEY,
    key_hash TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    create_time TEXT NOT NULL
)
```

2. 在 `_create_schema_mysql()` 增加对应的 `VARCHAR(64)`、`VARCHAR(24)`、`VARCHAR(32)` 字段和 `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`。
3. 在 `_create_indexes()` 增加 `CREATE UNIQUE INDEX idx_api_keys_hash ON api_keys(key_hash)`。
4. 在 `MIGRATION_TABLES` 增加：

```python
'api_keys': ['username', 'key_hash', 'key_prefix', 'create_time'],
```

在 `services/shortcut_service.py` 中使用 `secrets.token_urlsafe(32)` 和 `hashlib.sha256`：

```python
import hashlib
import secrets
from datetime import datetime
from database import get_db


def hash_api_key(raw_key):
    return hashlib.sha256(raw_key.encode('utf-8')).hexdigest()


def issue_api_key(username, now=None):
    raw_key = f"urp_{secrets.token_urlsafe(32)}"
    key_hash = hash_api_key(raw_key)
    create_time = (now or datetime.now()).isoformat()
    key_prefix = raw_key[:12]
    with get_db() as conn:
        exists = conn.execute(
            'SELECT username FROM api_keys WHERE username = ?',
            (username,),
        ).fetchone()
        if exists:
            conn.execute(
                'UPDATE api_keys SET key_hash = ?, key_prefix = ?, create_time = ? WHERE username = ?',
                (key_hash, key_prefix, create_time, username),
            )
        else:
            conn.execute(
                'INSERT INTO api_keys (username, key_hash, key_prefix, create_time) VALUES (?, ?, ?, ?)',
                (username, key_hash, key_prefix, create_time),
            )
    return {
        'key': raw_key,
        'key_hash': key_hash,
        'key_prefix': key_prefix,
        'create_time': create_time,
    }
```

`get_api_key_status` 只读取 `key_prefix` 和 `create_time`；`resolve_api_key` 只用哈希查询 `username`，对空值和非字符串直接返回 `None`。不要把密钥明文写入数据库、日志或状态响应。

- [x] **Step 4: Run the focused tests to verify they pass**

Run: `python -m unittest tests.test_shortcut_api.ShortcutApiKeyServiceTests -v`

Expected: PASS for table creation, hashing, rotation, status脱敏 and unknown-user behavior.

- [x] **Step 5: Run the existing database-related tests**

Run: `python -m unittest discover -s tests -p 'test_*.py' -v`

Expected: all currently runnable existing tests remain PASS; no production exception from adding the table or unique index.

### Task 2: 增加会员页密钥管理后端接口和按学号读取用户

**Files:**
- Modify: `tests/test_shortcut_api.py`
- Modify: `services/user_service.py`
- Create: `routes/shortcut_routes.py`
- Modify: `app.py`

**Interfaces:**
- Produces `services.user_service.get_user_by_username(username) -> dict | None` with the same keys as `get_user_by_device` and the newest `bind_time` row when a username has multiple device bindings.
- Produces `GET /api/member/api-key` with `@require_bindding`.
- Produces `POST /api/member/api-key` with `@require_member('basic')`.
- Both management endpoints return `{'success': bool, 'data': ...}` using the existing website response convention.

- [x] **Step 1: Write the failing route and user lookup tests**

Append the following cases to `tests/test_shortcut_api.py`. The route tests must register `shortcut_bp` on a fresh Flask app and patch module-level database/auth dependencies so they never use the production database:

```python
from flask import Flask

import auth
import services.user_service as user_service
from routes import shortcut_routes


class ShortcutApiKeyRouteTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.config['TESTING'] = True
        self.app.register_blueprint(shortcut_routes.shortcut_bp)
        self.client = self.app.test_client()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_config = {
            'database': {
                'type': 'sqlite',
                'sqlite_path': os.path.join(self.temp_dir.name, 'route.db'),
            }
        }
        database.init_db(self.database_config)
        with database.get_db(self.database_config) as conn:
            conn.execute(
                'INSERT INTO memberships (username, member_type, expire_time, create_time) VALUES (?, ?, ?, ?)',
                ('2415108133', 'basic', '2026-12-31T23:59:59', '2026-09-01T12:00:00'),
            )
        self.bind_patcher = mock.patch.object(
            auth,
            'get_user_by_device',
            return_value={
                'device_id': 'device-1',
                'username': '2415108133',
                'password': 'password',
                'bind_time': '2026-09-01T12:00:00',
            },
        )
        self.auth_db_patcher = mock.patch.object(
            auth,
            'get_db',
            side_effect=lambda: database.get_db(self.database_config),
        )
        self.bind_patcher.start()
        self.auth_db_patcher.start()

    def tearDown(self):
        self.auth_db_patcher.stop()
        self.bind_patcher.stop()
        self.temp_dir.cleanup()

    def test_get_api_key_status_hides_plaintext(self):
        with mock.patch.object(
            shortcut_routes,
            'get_api_key_status',
            return_value={
                'has_key': True,
                'key_prefix': 'urp_abcdef12',
                'create_time': '2026-09-01T12:00:00',
            },
        ):
            response = self.client.get(
                '/api/member/api-key',
                headers={'X-Device-ID': 'device-1'},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {
            'success': True,
            'data': {
                'has_key': True,
                'key_prefix': 'urp_abcdef12',
                'create_time': '2026-09-01T12:00:00',
            },
        })
        self.assertNotIn('key', response.get_json()['data'])

    def test_post_api_key_returns_plaintext_only_when_issued(self):
        issued = {
            'key': 'urp_new-secret',
            'key_prefix': 'urp_new-secr',
            'create_time': '2026-09-01T12:00:00',
        }
        with mock.patch.object(shortcut_routes, 'issue_api_key', return_value=issued):
            response = self.client.post(
                '/api/member/api-key',
                headers={'X-Device-ID': 'device-1'},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {'success': True, 'data': issued})

    def test_non_member_cannot_issue_api_key(self):
        with database.get_db(self.database_config) as conn:
            conn.execute('DELETE FROM memberships WHERE username = ?', ('2415108133',))

        with mock.patch.object(shortcut_routes, 'issue_api_key') as issue:
            response = self.client.post(
                '/api/member/api-key',
                headers={'X-Device-ID': 'device-1'},
            )

        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.get_json()['success'])
        issue.assert_not_called()


class UserLookupTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_config = {
            'database': {
                'type': 'sqlite',
                'sqlite_path': os.path.join(self.temp_dir.name, 'lookup.db'),
            }
        }
        database.init_db(self.database_config)
        with database.get_db(self.database_config) as conn:
            conn.executemany(
                'INSERT INTO users (device_id, username, password, bind_time) VALUES (?, ?, ?, ?)',
                [
                    ('device-old', '2415108133', 'old-password', '2026-09-01T12:00:00'),
                    ('device-new', '2415108133', 'new-password', '2026-09-02T12:00:00'),
                ],
            )
        self.get_db_patcher = mock.patch.object(
            user_service,
            'get_db',
            side_effect=lambda: database.get_db(self.database_config),
        )
        self.get_db_patcher.start()

    def tearDown(self):
        self.get_db_patcher.stop()
        self.temp_dir.cleanup()

    def test_user_lookup_returns_newest_binding(self):
        user = user_service.get_user_by_username('2415108133')

        self.assertEqual(user['device_id'], 'device-new')
        self.assertEqual(user['password'], 'new-password')
```

`UserLookupTests` uses a temporary database and two rows with the same username to assert the newest `bind_time` is returned. The route tests should first fail because the blueprint and functions do not exist.

- [x] **Step 2: Run the focused route tests to verify they fail**

Run: `python -m unittest tests.test_shortcut_api.ShortcutApiKeyRouteTests -v`

Expected: FAIL with missing `shortcut_routes`/route behavior, not with a production-database access error.

- [x] **Step 3: Implement user lookup and the management blueprint**

In `services/user_service.py`, add:

```python
def get_user_by_username(username):
    with get_db() as conn:
        row = conn.execute(
            'SELECT * FROM users WHERE username = ? ORDER BY bind_time DESC LIMIT 1',
            (username,),
        ).fetchone()
    if not row:
        return None
    return {
        'device_id': row['device_id'],
        'username': row['username'],
        'password': row['password'],
        'bind_time': row['bind_time'],
    }
```

In `routes/shortcut_routes.py`, import `Blueprint`, `jsonify`, the existing `require_bindding`, `require_member`, `_check_member_access`, `get_user_by_device`, `get_api_key_status`, and `issue_api_key`. Implement:

```python
shortcut_bp = Blueprint('shortcut', __name__)


@shortcut_bp.route('/api/member/api-key', methods=['GET'])
@require_bindding
def get_member_api_key(user):
    return jsonify({'success': True, 'data': get_api_key_status(user['username'])})


@shortcut_bp.route('/api/member/api-key', methods=['POST'])
@require_member('basic')
def create_member_api_key(user):
    issued = issue_api_key(user['username'])
    return jsonify({
        'success': True,
        'data': {
            'key': issued['key'],
            'key_prefix': issued['key_prefix'],
            'create_time': issued['create_time'],
        },
    })
```

Register `shortcut_bp` in `app.py` after the existing member/data blueprints. Do not change the existing decorators or their response shapes. For a denied POST, let `require_member('basic')` produce the existing JSON response.

- [x] **Step 4: Run route and existing tests to verify they pass**

Run: `python -m unittest tests.test_shortcut_api.ShortcutApiKeyRouteTests -v`

Expected: PASS for status redaction, issue response, and member denial.

Run: `python -m unittest discover -s tests -p 'test_*.py' -v`

Expected: all existing tests and the new route tests PASS.

- [x] **Step 5: Commit the independently testable backend management slice**

Run:

```text
git add tests/test_shortcut_api.py services/shortcut_service.py services/user_service.py database.py routes/shortcut_routes.py app.py
git commit -m "feat: add member shortcut API key management"
```

### Task 3: 实现最新历年课表选择和两个查询结果适配器

**Files:**
- Modify: `tests/test_shortcut_api.py`
- Create: `tests/test_historical_schedule_latest.py`
- Modify: `urp/query.py:361-410`
- Modify: `services/shortcut_service.py`

**Interfaces:**
- Produces `URP_query.historical_schedule_cx(semester=None) -> dict` where an empty semester selects the latest option returned by URP.
- Produces `services.shortcut_service.normalize_historical_schedule(student_id, result) -> dict`.
- Produces `services.shortcut_service.normalize_grade_summary(student_id, result) -> dict`.
- Produces `services.shortcut_service.query_shortcut_data(student_id, action, params) -> dict` and supports exactly `historical_schedule` and `grades`.

- [x] **Step 1: Write the failing tests for latest-semester selection and field mapping**

Add a test for the `URP_query` method that proves an omitted semester uses the latest option rather than a hardcoded value:

```python
from urp.query import URP_query


class HistoricalScheduleLatestTests(unittest.TestCase):
    def test_empty_semester_fetches_latest_semester_after_reading_options(self):
        query = object.__new__(URP_query)
        first = {
            'semester': '',
            'semesters': [
                {'value': '2024-2025-2-1', 'label': '2024-2025学年春(两学期)'},
                {'value': '2025-2026-1-1', 'label': '2025-2026学年秋(两学期)'},
                {'value': '2025-2026-2-1', 'label': '2025-2026学年春(两学期)'},
            ],
            'courses': [],
        }
        latest = dict(first, semester='2025-2026-2-1', courses=[{'课程名': '最新课程'}])
        with mock.patch.object(
            query,
            '_fetch_historical_schedule',
            side_effect=[first, latest],
        ) as fetch:
            result = query.historical_schedule_cx()

        self.assertEqual(result['semester'], '2025-2026-2-1')
        self.assertEqual(result['courses'], [{'课程名': '最新课程'}])
        self.assertEqual(fetch.call_args_list, [mock.call(''), mock.call('2025-2026-2-1')])

    def test_explicit_semester_does_not_make_probe_request(self):
        query = object.__new__(URP_query)
        expected = {'semester': '2024-2025-2-1', 'semesters': [], 'courses': []}
        with mock.patch.object(query, '_fetch_historical_schedule', return_value=expected) as fetch:
            result = query.historical_schedule_cx('2024-2025-2-1')

        self.assertEqual(result, expected)
        fetch.assert_called_once_with('2024-2025-2-1')
```

Add normalization tests with real dictionaries, not mocks of the functions under test:

```python
class ShortcutDataNormalizationTests(unittest.TestCase):
    def test_historical_schedule_is_shortcut_friendly(self):
        result = shortcut_service.normalize_historical_schedule(
            '2415108133',
            {
                'semester': '2025-2026-2-1',
                'semesters': [{'value': '2025-2026-2-1', 'label': '2025-2026学年春(两学期)'}],
                'courses': [{
                    '课程名': '软件工程导论', '星期': '3', '节次': '1', '节数': '2',
                    '位置': '仙林校区实C-501', '课序': '01',
                }],
            },
        )

        self.assertEqual(result, {
            'student_id': '2415108133',
            'semester': '2025-2026-2-1',
            'semester_name': '2025-2026学年春(两学期)',
            'course_count': 1,
            'courses': [{
                'course_name': '软件工程导论',
                'weekday': 3,
                'weekday_name': '星期三',
                'start_section': 1,
                'section_count': 2,
                'section_name': '第1-2节',
                'location': '仙林校区实C-501',
                'class_no': '01',
            }],
        })

    def test_grade_summary_is_flat_and_contains_counts(self):
        result = shortcut_service.normalize_grade_summary(
            '2415108133',
            {
                'semester': '2025-2026学年春',
                'passed': [{'course': '软件工程导论', 'score': '92'}],
                'failed': {
                    'current': [],
                    'past': [{'course': '高等数学', 'score': '58', 'credit': '4', 'exam_time': '20250101'}],
                },
            },
        )

        self.assertEqual(result, {
            'student_id': '2415108133',
            'semester': '2025-2026学年春',
            'passed_count': 1,
            'failed_current_count': 0,
            'failed_past_count': 1,
            'passed': [{'course_name': '软件工程导论', 'score': '92'}],
            'failed_current': [],
            'failed_past': [{
                'course_name': '高等数学', 'score': '58', 'credit': '4', 'exam_time': '20250101',
            }],
        })
```

Also add a dispatch test that patches `URP.URP_query` and `get_latest_semester_grade_summary` and confirms `query_shortcut_data` rejects `exams` with exactly `ValueError('invalid_action')`, which the route converts to `invalid_action`.

- [x] **Step 2: Run the focused tests to verify they fail**

Run: `python -m unittest tests.test_historical_schedule_latest tests.test_shortcut_api.ShortcutDataNormalizationTests -v`

Expected: FAIL because the latest-selection helper, normalization functions, and `query_shortcut_data` do not exist; existing explicit-semester tests must remain runnable.

- [x] **Step 3: Refactor historical schedule querying to select the latest option**

In `urp/query.py`, keep the current explicit request/parser behavior in a private `_fetch_historical_schedule(semester)` helper. Implement:

```python
def historical_schedule_cx(self, semester=None):
    requested = (semester or '').strip()
    if requested:
        return self._fetch_historical_schedule(requested)

    initial = self._fetch_historical_schedule('')
    latest = self._select_latest_historical_semester(initial.get('semesters', []))
    if not latest:
        return initial
    if initial.get('semester') == latest['value']:
        initial['semester'] = latest['value']
        return initial
    return self._fetch_historical_schedule(latest['value'])
```

Add `_select_latest_historical_semester(semesters)` as a static method. Parse the first two four-digit years from each option value or label; use the later year as the primary key and recognize `-1-`/`上` as term 1 and `-2-`/`下` as term 2. Ignore malformed options and return the complete option dictionary with the largest `(end_year, term, original_index)` key. This preserves original server order as a deterministic tie breaker and avoids a hardcoded academic year.

- [x] **Step 4: Implement the two public data adapters**

In `services/shortcut_service.py`:

1. `normalize_historical_schedule` maps `课程名`→`course_name`, `星期`→integer `weekday`, `节次`→integer `start_section`, `节数`→integer `section_count`, `位置`→`location`, `课序`→`class_no`; it adds `weekday_name`, `section_name`, `semester_name`, `course_count`, and always returns a `courses` list. Invalid numeric values should be skipped rather than causing a malformed response.
2. `normalize_grade_summary` maps `passed` and `failed.current/past` to `passed`, `failed_current`, and `failed_past`; each course uses `course_name`, `score`, and failed rows additionally preserve `credit` and `exam_time`; all three counts are derived from the resulting lists.
3. `query_shortcut_data(student_id, action, params)` validates the action, calls `URP_query(get_current_urp_url(), student_id).historical_schedule_cx(params.get('semester', ''))` for `historical_schedule`, and calls `get_latest_semester_grade_summary(student_id)` for `grades`. It must not call the current-semester-only `score_current_semester` function.

Use exact service-level exceptions or result values that the route can distinguish: unsupported action raises `ValueError('invalid_action')`; invalid `params` raises `ValueError('invalid_params')`; upstream exceptions are allowed to bubble to the route as `query_failed`.

- [x] **Step 5: Run the focused and regression tests to verify they pass**

Run: `python -m unittest tests.test_historical_schedule_latest tests.test_schedule_request tests.test_shortcut_api -v`

Expected: PASS, including the existing explicit historical schedule fixture and the new latest/default and normalization tests.

- [x] **Step 6: Commit the query and adapter slice**

Run:

```text
git add tests/test_shortcut_api.py tests/test_historical_schedule_latest.py tests/test_schedule_request.py urp/query.py services/shortcut_service.py
git commit -m "feat: adapt shortcut schedule and grade queries"
```

### Task 4: 增加公共查询路由、会员校验和错误契约

**Files:**
- Modify: `tests/test_shortcut_api.py`
- Modify: `routes/shortcut_routes.py`
- Modify: `services/shortcut_service.py`
- Modify: `services/logging_service.py`

**Interfaces:**
- Produces `POST /api/shortcut/query` without `X-Device-ID`.
- Accepts JSON `{key, action, params}` and supports only `historical_schedule` and `grades`.
- Returns `{'success': True, 'action': action, 'message': '查询成功', 'data': normalized_data}` on success.
- Returns HTTP 200 JSON `{'success': False, 'action': action or None, 'error_code': ..., 'message': ..., 'data': None}` for all expected business failures.

- [x] **Step 1: Write failing public-query route tests**

Add the following tests to `tests/test_shortcut_api.py`. Patch `routes.shortcut_routes` imports directly so the tests exercise request parsing, key resolution, membership and login gates, and action dispatch without making network calls:

```python
class ShortcutPublicQueryRouteTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.config['TESTING'] = True
        self.app.register_blueprint(shortcut_routes.shortcut_bp)
        self.client = self.app.test_client()
        self.resolve_patcher = mock.patch.object(
            shortcut_routes, 'resolve_api_key', return_value='2415108133'
        )
        self.user_patcher = mock.patch.object(
            shortcut_routes, 'get_user_by_username', return_value={
                'username': '2415108133', 'password': 'password',
                'device_id': 'device-1', 'bind_time': '2026-09-01T12:00:00',
            }
        )
        self.member_patcher = mock.patch.object(
            shortcut_routes, '_check_member_access', return_value=(True, None)
        )
        self.login_patcher = mock.patch.object(
            shortcut_routes, 'check_login_status', return_value=(True, {})
        )
        self.login_mock = self.login_patcher.start()
        for patcher in (
            self.resolve_patcher, self.user_patcher,
            self.member_patcher,
        ):
            patcher.start()

    def tearDown(self):
        for patcher in (
            self.resolve_patcher, self.user_patcher,
            self.member_patcher,
        ):
            patcher.stop()
        self.login_patcher.stop()

    def test_invalid_request_is_json_and_http_200(self):
        response = self.client.post('/api/shortcut/query', json={'key': 'x'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {
            'success': False,
            'action': None,
            'error_code': 'invalid_request',
            'message': '缺少 action',
            'data': None,
        })

    def test_invalid_key_is_not_queried(self):
        self.resolve_patcher.stop()
        self.resolve_patcher = mock.patch.object(
            shortcut_routes, 'resolve_api_key', return_value=None
        )
        self.resolve_patcher.start()
        response = self.client.post(
            '/api/shortcut/query',
            json={'key': 'urp_invalid', 'action': 'grades', 'params': {}},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['error_code'], 'invalid_key')
        self.login_mock.assert_not_called()

    def test_expired_member_is_rejected_before_login(self):
        self.member_patcher.stop()
        self.member_patcher = mock.patch.object(
            shortcut_routes, '_check_member_access', return_value=(False, {
                'success': False, 'message': '您的会员已过期', 'require_member': 'basic',
            })
        )
        self.member_patcher.start()
        response = self.client.post(
            '/api/shortcut/query',
            json={'key': 'urp_valid', 'action': 'grades', 'params': {}},
        )
        self.assertEqual(response.get_json()['error_code'], 'member_required')

    def test_unknown_action_is_rejected(self):
        response = self.client.post(
            '/api/shortcut/query',
            json={'key': 'urp_valid', 'action': 'exams', 'params': {}},
        )
        self.assertEqual(response.get_json(), {
            'success': False,
            'action': 'exams',
            'error_code': 'invalid_action',
            'message': '不支持的查询功能',
            'data': None,
        })

    def test_grades_returns_normalized_data(self):
        expected = {
            'student_id': '2415108133',
            'semester': '2025-2026学年春',
            'passed_count': 1,
            'failed_current_count': 0,
            'failed_past_count': 0,
            'passed': [{'course_name': '软件工程导论', 'score': '92'}],
            'failed_current': [], 'failed_past': [],
        }
        with mock.patch.object(shortcut_routes, 'query_shortcut_data', return_value=expected) as query:
            response = self.client.post(
                '/api/shortcut/query',
                json={'key': 'urp_valid', 'action': 'grades', 'params': {}},
            )
        self.assertEqual(response.get_json(), {
            'success': True,
            'action': 'grades',
            'message': '查询成功',
            'data': expected,
        })
        query.assert_called_once_with('2415108133', 'grades', {})

    def test_query_failure_has_stable_error_code(self):
        with mock.patch.object(
            shortcut_routes,
            'query_shortcut_data',
            side_effect=RuntimeError('URP 暂时不可用'),
        ):
            response = self.client.post(
                '/api/shortcut/query',
                json={'key': 'urp_valid', 'action': 'grades', 'params': {}},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['error_code'], 'query_failed')
        self.assertIsNone(response.get_json()['data'])
```

- [x] **Step 2: Run the public-route tests to verify they fail**

Run: `python -m unittest tests.test_shortcut_api.ShortcutPublicQueryRouteTests -v`

Expected: FAIL because `/api/shortcut/query` and its error envelope do not exist.

- [x] **Step 3: Implement request validation and the public authentication flow**

In `routes/shortcut_routes.py`, add a private response helper and route logic:

```python
def _shortcut_error(action, error_code, message):
    return jsonify({
        'success': False,
        'action': action,
        'error_code': error_code,
        'message': message,
        'data': None,
    })


@shortcut_bp.route('/api/shortcut/query', methods=['POST'])
def shortcut_query():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return _shortcut_error(None, 'invalid_request', '请求体必须是 JSON')

    raw_key = payload.get('key')
    action = payload.get('action')
    params = payload.get('params', {})
    if not isinstance(raw_key, str) or not raw_key.strip():
        return _shortcut_error(action if isinstance(action, str) else None, 'invalid_request', '缺少 key')
    if not isinstance(action, str) or not action.strip():
        return _shortcut_error(None, 'invalid_request', '缺少 action')
    action = action.strip()
    if not isinstance(params, dict):
        return _shortcut_error(action, 'invalid_request', 'params 必须是对象')
    if action not in {'historical_schedule', 'grades'}:
        return _shortcut_error(action, 'invalid_action', '不支持的查询功能')

    username = resolve_api_key(raw_key.strip())
    if not username:
        return _shortcut_error(action, 'invalid_key', '密钥无效或已失效')

    member_ok, member_error = _check_member_access(username, 'basic')
    if not member_ok:
        return _shortcut_error(action, 'member_required', member_error.get('message', '此功能需要初级会员'))

    user = get_user_by_username(username)
    if not user:
        return _shortcut_error(action, 'login_required', '未找到该学号的绑定信息')
    is_logged_in, _ = check_login_status(username, user['password'], {})
    if not is_logged_in:
        return _shortcut_error(action, 'login_required', '教务登录已失效，请先在网站重新绑定')

    try:
        data = query_shortcut_data(username, action, params)
    except ValueError as exc:
        error_code = str(exc)
        if error_code not in {'invalid_action', 'invalid_params'}:
            error_code = 'query_failed'
        message = '不支持的查询功能' if error_code == 'invalid_action' else '查询参数无效'
        return _shortcut_error(action, error_code, message)
    except Exception as exc:
        return _shortcut_error(action, 'query_failed', f'查询失败: {exc}')

    return jsonify({
        'success': True,
        'action': action,
        'message': '查询成功',
        'data': data,
    })
```

Do not put `X-Device-ID` in this route. It must derive the student only from the API key. Keep all expected business failures at HTTP 200; Flask's method-level 405 remains outside this route contract.

- [x] **Step 4: Add request logging names without logging secrets**

In `services/logging_service.py`, add these entries to `endpoint_names`:

```python
'/api/member/api-key': '快捷指令密钥',
'/api/shortcut/query': '快捷指令查询',
```

Leave the existing logger unchanged otherwise; it must continue logging only device ID, username, path label, method, status and timestamp, never `request.get_json()`.

- [x] **Step 5: Run all focused and regression tests**

Run: `python -m unittest tests.test_shortcut_api -v`

Expected: PASS for key management, request validation, invalid key, member denial, action allowlist, normalized success and query failure JSON.

Run: `python -m unittest discover -s tests -p 'test_*.py' -v`

Expected: all existing Python tests PASS.

- [x] **Step 6: Commit the public API slice**

Run:

```text
git add tests/test_shortcut_api.py routes/shortcut_routes.py services/shortcut_service.py services/logging_service.py
git commit -m "feat: add shortcut public query API"
```

### Task 5: 在会员页面增加生成、复制和使用说明

**Files:**
- Create: `tests/test_shortcut_api_ui.py`
- Modify: `templates/index.html:228-283`
- Modify: `static/js/main.js:2385-2535`
- Modify: `static/css/style.css`（快捷指令 API 卡片样式）

**Interfaces:**
- Produces HTML elements `#shortcut-api-card`, `#shortcut-api-status`, `#shortcut-api-key`, `#shortcut-api-copy`, and `#shortcut-api-endpoint`.
- Produces JavaScript functions `loadShortcutApiKey()`, `renderShortcutApiKeyStatus(data)`, `generateShortcutApiKey()`, and `copyShortcutApiKey()`.
- `loadMemberPage()` invokes `loadShortcutApiKey()` alongside existing member page loaders.

- [x] **Step 1: Write the failing UI tests**

Create `tests/test_shortcut_api_ui.py` in the existing BeautifulSoup/unittest style:

```python
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ShortcutApiTemplateTests(unittest.TestCase):
    def test_member_page_contains_shortcut_api_card_controls(self):
        html = (ROOT / 'templates' / 'index.html').read_text(encoding='utf-8')
        self.assertIn('id="shortcut-api-card"', html)
        self.assertIn('id="shortcut-api-status"', html)
        self.assertIn('generateShortcutApiKey()', html)
        self.assertIn('copyShortcutApiKey()', html)
        self.assertIn('id="shortcut-api-endpoint"', html)

    def test_main_script_loads_status_and_uses_member_api_key_endpoints(self):
        script = (ROOT / 'static' / 'js' / 'main.js').read_text(encoding='utf-8')
        self.assertIn('function loadShortcutApiKey()', script)
        self.assertIn("/api/member/api-key", script)
        self.assertIn('function generateShortcutApiKey()', script)
        self.assertIn('function copyShortcutApiKey()', script)


if __name__ == '__main__':
    unittest.main()
```

- [x] **Step 2: Run the UI tests to verify they fail**

Run: `python -m unittest tests.test_shortcut_api_ui -v`

Expected: FAIL because the member page and script do not contain the new controls/functions.

- [x] **Step 3: Add the member-page card markup**

In `templates/index.html`, place the card after `#member-status-card` and before the member plan cards:

```html
<section id="shortcut-api-card" class="shortcut-api-card" aria-labelledby="shortcut-api-title">
    <div class="shortcut-api-card-head">
        <div>
            <span class="member-plan-kicker">快捷指令</span>
            <h3 id="shortcut-api-title">教务查询 API</h3>
            <p>给 Apple 快捷指令使用，支持最新历年课表和一键查本学期成绩。</p>
        </div>
        <span class="shortcut-api-badge">初级会员以上</span>
    </div>
    <div id="shortcut-api-status" class="shortcut-api-status">
        <div class="loading">加载中...</div>
    </div>
    <div id="shortcut-api-key" class="shortcut-api-key" hidden></div>
    <div class="shortcut-api-help">
        <div><span>接口地址</span><code id="shortcut-api-endpoint"></code></div>
        <p>请求体使用 <code>{"key":"你的密钥","action":"grades","params":{}}</code>。密钥只显示一次，请立即复制保存。</p>
    </div>
</section>
```

Use existing CSS variables and escape-safe static text. Do not place an actual secret in the template.

- [x] **Step 4: Add JavaScript state loading, one-time display and clipboard behavior**

In `static/js/main.js`, add module-level state:

```javascript
let shortcutApiPlainKey = '';
```

Add `let currentMemberStatus = null;` at module scope. In `loadMemberStatus()`, assign the successful `data.data` object to `currentMemberStatus` and assign `null` on an error. Change `loadMemberPage()` to await `loadMemberStatus()` first, then load orders, invitations, and the API key in parallel so the API card can reuse the membership result without making a duplicate status request. Add `loadShortcutApiKey()` to fetch `GET /api/member/api-key` with `X-Device-ID`, set `#shortcut-api-endpoint` to `${window.location.origin}/api/shortcut/query`, and call `renderShortcutApiKeyStatus(data.data)` on success. Render these states:

- `currentMemberStatus.is_member !== true`: show “此功能需要初级会员以上” and no generation button.
- `has_key === false` for an active member: message “暂未生成快捷指令密钥” and a button calling `generateShortcutApiKey()`。
- `has_key === true`: show only `key_prefix + '...'`, `create_time`, and a button calling `generateShortcutApiKey()` with text “重新生成”。
- `currentMemberStatus` is `null` because the status request failed: show “会员状态加载失败，请刷新页面” and no generation button.
- request failure: show the returned message without breaking other member page loaders.

`generateShortcutApiKey()` must confirm before rotating an existing key, POST `/api/member/api-key` with JSON headers, set `shortcutApiPlainKey` from `data.data.key`, reveal `#shortcut-api-key` with the full key and a copy button, then call `loadShortcutApiKey()` to refresh the masked status. The full key must not be placed in `localStorage`, `sessionStorage`, URL, or `console.log`.

`copyShortcutApiKey()` should call `navigator.clipboard.writeText(shortcutApiPlainKey)` when available, show “已复制” for a short period, and otherwise show “复制失败，请手动复制”。Do not treat an empty key as a successful copy.

Update `loadMemberPage()` from:

```javascript
await Promise.all([loadMemberStatus(), loadMemberOrders(), loadInvitationEarnings()]);
```

to:

```javascript
await loadMemberStatus();
await Promise.all([
    loadMemberOrders(),
    loadInvitationEarnings(),
    loadShortcutApiKey(),
]);
```

- [x] **Step 5: Add focused CSS and run UI tests**

Add only the styles needed for the new card: border/card background, header alignment, badge, monospace secret display, endpoint wrapping, and mobile single-column layout. Reuse `--card-bg`, `--divider`, `--text-secondary`, `--text-primary`, `--card-radius` and existing `.btn-primary`/`.btn-secondary`; do not alter existing member plan styles.

Run: `python -m unittest tests.test_shortcut_api_ui -v`

Expected: PASS.

- [x] **Step 6: Run the complete test suite and inspect the rendered HTML**

Run:

```text
python -m unittest discover -s tests -p 'test_*.py' -v
```

Expected: all Python tests PASS.

Use the existing browser/manual flow or start the app with `python app.py`, open the member page, and verify:

1. A non-member sees the restriction and cannot issue a key.
2. A member sees “生成快捷指令密钥”。
3. After generation, the full secret is shown once, the status shows only its prefix, and copy works.
4. Refreshing the page never reconstructs the full secret.
5. Regeneration asks for confirmation and the previous key no longer works.

- [x] **Step 7: Commit the UI slice**

Run:

```text
git add tests/test_shortcut_api_ui.py templates/index.html static/js/main.js static/css/style.css
git commit -m "feat: add shortcut API controls to member page"
```

### Task 6: 最终验证、接口样例和交付检查

**Files:**
- Modify: `docs/superpowers/specs/2026-09-01-shortcut-api-design.md` only if implementation reveals a confirmed contract correction.
- Modify: `docs/superpowers/plans/2026-09-01-shortcut-api.md` to check off completed steps during execution.
- Test: `tests/test_shortcut_api.py`, `tests/test_historical_schedule_latest.py`, `tests/test_shortcut_api_ui.py`.

**Interfaces:**
- No new runtime interface; this task verifies the interfaces produced by Tasks 1–5.

- [x] **Step 1: Run Python and JavaScript test commands**

Run:

```text
python -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/test_historical_schedule_grid.js tests/test_schedule_weekend_visibility.js
```

The new UI is covered by `tests/test_shortcut_api_ui.py`; do not invoke pytest.

Expected: every runnable test passes without warnings or tracebacks.

- [x] **Step 2: Verify the public JSON contract with Flask’s test client**

Use a temporary SQLite database and patched URP results to verify these exact shapes:

```python
{
    'success': True,
    'action': 'historical_schedule',
    'message': '查询成功',
    'data': {
        'student_id': '2415108133',
        'semester': '2025-2026-2-1',
        'semester_name': '2025-2026学年春(两学期)',
        'course_count': 0,
        'courses': [],
    },
}
```

and:

```python
{
    'success': False,
    'action': 'grades',
    'error_code': 'invalid_key',
    'message': '密钥无效或已失效',
    'data': None,
}
```

- [x] **Step 3: Inspect the diff and repository status**

Run:

```text
git diff --check HEAD~5..HEAD
git status --short
git log -8 --oneline
```

Expected: no whitespace errors; only intended source, test, and documentation files are changed; no database file, cookie file, secret, or runtime log is staged.

- [x] **Step 4: Verify no secret leakage in source and tests**

Run:

```text
rg -n "request\.get_json\(|console\.log\(.*shortcut|localStorage.*shortcut|sessionStorage.*shortcut|key_hash.*jsonify|password.*jsonify|cookie.*jsonify" routes services static templates tests
```

Expected: no new code logs or persists the plaintext shortcut key, password, or Cookie. References in tests to `key_hash` are allowed only for database assertions and must not appear in HTTP response assertions.

- [x] **Step 5: Prepare delivery summary**

Report the implemented endpoints, the two action names and their defaults, the one-time key display rule, test commands and results, and the exact commit IDs. Include a clickable link to the API design and plan files. Do not claim live URP success unless a real configured URP account was available for an end-to-end test.
