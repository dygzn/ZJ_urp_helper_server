# 固定邀请链接归因 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将绑定时手填邀请人改为按固定邀请链接自动归因，并让所有已绑定用户无需会员即可获得佣金和申请提现。

**Architecture:** 新增按学号唯一的 `invitation_links` 表和独立 `services/invitation_service.py`，使用随机 URL-safe token 生成长期固定的 `/?invite=<token>` 链接。登录时在 `bind_user()` 的同一数据库事务内校验 token、首次写入 `invitations`，并补偿已存在的已支付订单；会员页负责生成/复制链接，服务端负责最终归因和佣金安全边界。

**Tech Stack:** Flask 3.1、MySQL/MariaDB 优先的 SQLite/MySQL 双数据库适配、Python `secrets`、现有 `ensure_invitation_earnings()`、原生 JavaScript、Python `unittest`、Node.js `node:test`。

**Spec:** `docs/superpowers/specs/2026-09-02-invitation-links-design.md`

## Global Constraints

- MySQL/MariaDB 是本次实现的优先部署目标；服务启动必须通过现有 `initialize_database()` 幂等创建缺失表和索引。
- 一个学号最多一条固定邀请链接；token 使用随机 URL-safe 字符串，不暴露邀请人学号，不设置过期或自动轮换。
- “首次绑定”按受邀学号判定；`invitations.invitee_username` 唯一约束是并发下的最终防线，历史关系不修改。
- 新关系只能通过 `invitation_token` 建立；删除登录表单邀请人字段和 `POST /api/invitation/set` 手工绑定能力。
- 普通/未开会员用户按 10% 计佣，有效高级会员按 20% 计佣；计佣和提现都不检查会员资格。
- 只有已绑定账号的用户可以生成邀请链接、查看邀请收益和申请提现；余额不足或存在待审核提现时仍禁止提现。
- 生产代码必须遵循“先写失败测试、确认失败、写最小实现、确认通过、再重构”的 TDD 顺序；不引入 pytest。
- 新增文案使用中文，API 字段名使用稳定的英文 `snake_case`；不改变已有支付、订单、佣金记录和提现审核响应结构。

---

### Task 1: 添加 MySQL/SQLite 邀请链接表和 token 服务

**Files:**
- Create: `tests/test_invitation_links.py`
- Create: `services/invitation_service.py`
- Modify: `database.py:199-505,554-568`（SQLite/MySQL 建表、索引、迁移清单）

**Interfaces:**
- Produces `services.invitation_service.get_invitation_link(conn, username) -> dict | None`，存在时返回 `username`、`token`、`create_time`。
- Produces `services.invitation_service.build_invitation_url(server_url, token) -> str`，返回 `server_url/?invite=<token>`。
- Produces `services.invitation_service.get_or_create_invitation_link(conn, username, server_url) -> tuple[str, bool]`，返回固定 URL 和本次是否新建。
- Produces `services.invitation_service.bind_invitation_by_token(conn, invitee_username, invitation_token) -> bool`，返回是否新建邀请关系。

- [ ] **Step 1: Write the failing schema and service tests**

在 `tests/test_invitation_links.py` 中先创建以下测试夹具和行为测试。测试数据库只能使用临时 SQLite，不能写入 `data/urp_helper.db`；MySQL 只通过录制建表 SQL 验证语句兼容性。

```python
import os
import tempfile
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlsplit

import database
import services.invitation_service as invitation_service


class RecordingConnection:
    def __init__(self):
        self.statements = []

    def execute(self, sql, params=None):
        self.statements.append(sql)
        return mock.Mock(rowcount=1)


class InvitationSchemaTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.config = {
            'database': {
                'type': 'sqlite',
                'sqlite_path': os.path.join(self.temp_dir.name, 'invitation.db'),
            }
        }

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_sqlite_initialization_is_idempotent_and_preserves_token(self):
        database.init_db(self.config)
        with database.get_db(self.config) as conn:
            conn.execute(
                'INSERT INTO invitation_links (username, token, create_time) VALUES (?, ?, ?)',
                ('inviter', 'fixed-token', '2026-09-02T12:00:00'),
            )

        database.init_db(self.config)

        with database.get_db(self.config) as conn:
            table = conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'invitation_links'"
            ).fetchone()
            columns = {
                row['name']
                for row in conn.execute('PRAGMA table_info(invitation_links)').fetchall()
            }
            row = conn.execute(
                'SELECT username, token FROM invitation_links WHERE username = ?',
                ('inviter',),
            ).fetchone()

        self.assertIsNotNone(table)
        self.assertEqual(columns, {'username', 'token', 'create_time'})
        self.assertEqual(dict(row), {'username': 'inviter', 'token': 'fixed-token'})

    def test_mysql_schema_declares_invitation_links(self):
        connection = RecordingConnection()

        database._create_schema_mysql(connection)

        table_sql = next(
            sql for sql in connection.statements
            if 'CREATE TABLE IF NOT EXISTS invitation_links' in sql
        )
        self.assertIn('username VARCHAR(64) PRIMARY KEY', table_sql)
        self.assertIn('token VARCHAR(128) NOT NULL UNIQUE', table_sql)
        self.assertIn('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4', table_sql)

    def test_migration_table_list_contains_invitation_links(self):
        self.assertEqual(
            database.MIGRATION_TABLES['invitation_links'],
            ['username', 'token', 'create_time'],
        )


class InvitationServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.config = {
            'database': {
                'type': 'sqlite',
                'sqlite_path': os.path.join(self.temp_dir.name, 'service.db'),
            }
        }
        database.init_db(self.config)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_post_creation_is_fixed_and_builds_query_link(self):
        with database.get_db(self.config) as conn:
            first_url, first_created = invitation_service.get_or_create_invitation_link(
                conn, 'inviter', 'https://urp.example.com/'
            )
            second_url, second_created = invitation_service.get_or_create_invitation_link(
                conn, 'inviter', 'https://urp.example.com/'
            )

        self.assertTrue(first_created)
        self.assertFalse(second_created)
        self.assertEqual(first_url, second_url)
        query = parse_qs(urlsplit(first_url).query)
        self.assertEqual(set(query), {'invite'})
        self.assertEqual(len(query['invite'][0]), 32)

    def test_valid_token_creates_one_invitation_relation(self):
        with database.get_db(self.config) as conn:
            invite_url, _ = invitation_service.get_or_create_invitation_link(
                conn, 'inviter', 'https://urp.example.com'
            )
            token = parse_qs(urlsplit(invite_url).query)['invite'][0]
            self.assertTrue(
                invitation_service.bind_invitation_by_token(conn, 'invitee', token)
            )
            self.assertFalse(
                invitation_service.bind_invitation_by_token(conn, 'invitee', token)
            )
            row = conn.execute(
                'SELECT inviter_username, invitee_username FROM invitations'
            ).fetchone()

        self.assertEqual(dict(row), {
            'inviter_username': 'inviter',
            'invitee_username': 'invitee',
        })

    def test_invalid_and_self_tokens_are_non_blocking(self):
        with database.get_db(self.config) as conn:
            self.assertFalse(
                invitation_service.bind_invitation_by_token(conn, 'invitee', 'invalid')
            )
            invite_url, _ = invitation_service.get_or_create_invitation_link(
                conn, 'invitee', 'https://urp.example.com'
            )
            token = parse_qs(urlsplit(invite_url).query)['invite'][0]
            self.assertFalse(
                invitation_service.bind_invitation_by_token(conn, 'invitee', token)
            )

    def test_token_collision_retries_until_unique(self):
        with mock.patch.object(
            invitation_service.secrets,
            'token_urlsafe',
            side_effect=['duplicate-token', 'unique-token'],
        ):
            with database.get_db(self.config) as conn:
                conn.execute(
                    'INSERT INTO invitation_links (username, token, create_time) VALUES (?, ?, ?)',
                    ('existing', 'duplicate-token', '2026-09-02T12:00:00'),
                )
                url, created = invitation_service.get_or_create_invitation_link(
                    conn, 'new-user', 'https://urp.example.com'
                )

        self.assertTrue(created)
        self.assertTrue(url.endswith('?invite=unique-token'))


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `python -m unittest tests.test_invitation_links -v`

Expected: FAIL during import because `services.invitation_service` and/or `invitation_links` are not implemented. If the failure is a test typo, correct only the test setup until the failure points to the missing schema/service behavior.

- [ ] **Step 3: Add the idempotent MySQL/SQLite schema**

在 `database.py` 中，在两个 schema 函数的 `memberships`/`invitations` 附近增加：

```python
# _create_schema_sqlite()
conn.execute('''
    CREATE TABLE IF NOT EXISTS invitation_links (
        username TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        create_time TEXT NOT NULL
    )
''')

# _create_schema_mysql()
conn.execute('''
    CREATE TABLE IF NOT EXISTS invitation_links (
        username VARCHAR(64) PRIMARY KEY,
        token VARCHAR(128) NOT NULL UNIQUE,
        create_time VARCHAR(32) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
''')
```

在 `_create_indexes()` 增加：

```python
'CREATE UNIQUE INDEX idx_invitation_links_token ON invitation_links(token)',
```

在 `MIGRATION_TABLES` 增加：

```python
'invitation_links': ['username', 'token', 'create_time'],
```

使用现有 `_exec_ignore()` 处理重复索引；不要改变 `init_db()` 的启动顺序或把 MySQL 连接失败降级到 SQLite。

- [ ] **Step 4: Implement the minimal token/link service**

创建 `services/invitation_service.py`，使用以下实现边界：

```python
import secrets
from datetime import datetime
from urllib.parse import urlencode


MAX_INVITATION_TOKEN_LENGTH = 128
TOKEN_BYTES = 24
MAX_CREATE_ATTEMPTS = 10


def get_invitation_link(conn, username):
    row = conn.execute(
        'SELECT username, token, create_time FROM invitation_links WHERE username = ?',
        (username,),
    ).fetchone()
    return dict(row) if row else None


def build_invitation_url(server_url, token):
    base_url = (server_url or 'http://localhost:5000').rstrip('/')
    return f"{base_url}/?{urlencode({'invite': token})}"


def get_or_create_invitation_link(conn, username, server_url):
    existing = get_invitation_link(conn, username)
    if existing:
        return build_invitation_url(server_url, existing['token']), False

    for _ in range(MAX_CREATE_ATTEMPTS):
        token = secrets.token_urlsafe(TOKEN_BYTES)
        cursor = conn.execute(
            'INSERT OR IGNORE INTO invitation_links (username, token, create_time) VALUES (?, ?, ?)',
            (username, token, datetime.now().isoformat()),
        )
        saved = get_invitation_link(conn, username)
        if saved:
            return build_invitation_url(server_url, saved['token']), cursor.rowcount == 1

    raise RuntimeError('生成邀请链接失败，请稍后重试')


def bind_invitation_by_token(conn, invitee_username, invitation_token):
    token = str(invitation_token or '').strip()
    if not token or len(token) > MAX_INVITATION_TOKEN_LENGTH:
        return False

    link = conn.execute(
        'SELECT username FROM invitation_links WHERE token = ?',
        (token,),
    ).fetchone()
    if not link or link['username'] == invitee_username:
        return False

    already = conn.execute(
        'SELECT id FROM invitations WHERE invitee_username = ?',
        (invitee_username,),
    ).fetchone()
    if already:
        return False

    cursor = conn.execute(
        'INSERT OR IGNORE INTO invitations (inviter_username, invitee_username, create_time) VALUES (?, ?, ?)',
        (link['username'], invitee_username, datetime.now().isoformat()),
    )
    return cursor.rowcount == 1
```

`INSERT OR IGNORE` 必须继续通过 `MySQLConnectionAdapter` 适配为 `INSERT IGNORE`；不要把 token 明文写入日志，也不要在服务层查询并返回邀请人给未绑定访问者。

- [ ] **Step 5: Run the focused tests to verify they pass**

Run: `python -m unittest tests.test_invitation_links -v`

Expected: PASS，包含 schema、固定 URL、token 归因、自邀/无效 token 和 token 碰撞重试测试。

- [ ] **Step 6: Refactor only after green and commit**

确认测试保持全绿后，删除重复 SQL 字符串或补充私有命名，但不增加未被测试要求的轮换、过期或撤销能力。运行：

```powershell
git diff --check
git add -- database.py services/invitation_service.py tests/test_invitation_links.py
git commit -m "feat: add persistent invitation link service"
```

Expected: `git diff --check` 无输出，提交只包含本任务的三个文件。

### Task 2: 将 token 接入原子绑定和登录接口

**Files:**
- Create: `tests/test_invitation_binding.py`
- Modify: `services/user_service.py:56-64`
- Modify: `routes/auth_routes.py:1-100`

**Interfaces:**
- Changes `services.user_service.bind_user(device_id, username, password, invitation_token=None) -> bool`；返回本次是否新建邀请关系，三参数调用仍然有效。
- `routes.auth_routes.login()` 接收 `invitation_token`，忽略旧的 `inviter` 字段，不改变成功响应结构。

- [ ] **Step 1: Write the failing atomic-binding and login-forwarding tests**

创建 `tests/test_invitation_binding.py`：

```python
import os
import tempfile
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlsplit

from flask import Flask

import database
import services.user_service as user_service
from routes import auth_routes
from services.invitation_service import get_or_create_invitation_link


class InvitationBindingTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.config = {
            'database': {
                'type': 'sqlite',
                'sqlite_path': os.path.join(self.temp_dir.name, 'binding.db'),
            }
        }
        database.init_db(self.config)
        self.db_patcher = mock.patch.object(
            user_service,
            'get_db',
            side_effect=lambda: database.get_db(self.config),
        )
        self.db_patcher.start()

    def tearDown(self):
        self.db_patcher.stop()
        self.temp_dir.cleanup()

    def create_link(self, username='inviter'):
        with database.get_db(self.config) as conn:
            url, _ = get_or_create_invitation_link(
                conn, username, 'https://urp.example.com'
            )
        return parse_qs(urlsplit(url).query)['invite'][0]

    def test_bind_user_commits_device_and_first_invitation_together(self):
        token = self.create_link()

        result = user_service.bind_user(
            'device-2', 'invitee', 'password', token
        )

        with database.get_db(self.config) as conn:
            user = conn.execute(
                'SELECT username FROM users WHERE device_id = ?', ('device-2',)
            ).fetchone()
            invitation = conn.execute(
                'SELECT inviter_username, invitee_username FROM invitations'
            ).fetchone()

        self.assertTrue(result)
        self.assertEqual(user['username'], 'invitee')
        self.assertEqual(dict(invitation), {
            'inviter_username': 'inviter',
            'invitee_username': 'invitee',
        })

    def test_existing_invitation_wins_over_a_later_token(self):
        old_token = self.create_link('old-inviter')
        new_token = self.create_link('new-inviter')
        user_service.bind_user('device-1', 'invitee', 'password', old_token)

        result = user_service.bind_user(
            'device-2', 'invitee', 'password', new_token
        )

        with database.get_db(self.config) as conn:
            row = conn.execute(
                'SELECT inviter_username FROM invitations WHERE invitee_username = ?',
                ('invitee',),
            ).fetchone()
        self.assertFalse(result)
        self.assertEqual(row['inviter_username'], 'old-inviter')

    def test_invalid_token_still_binds_the_account(self):
        self.assertFalse(
            user_service.bind_user('device-1', 'invitee', 'password', 'bad-token')
        )
        with database.get_db(self.config) as conn:
            self.assertIsNotNone(
                conn.execute(
                    'SELECT username FROM users WHERE device_id = ?',
                    ('device-1',),
                ).fetchone()
            )

    def test_new_invitation_reconciles_preexisting_paid_orders(self):
        token = self.create_link()
        with database.get_db(self.config) as conn:
            conn.execute(
                'INSERT INTO orders '
                '(order_no, device_id, username, member_type, amount, status, create_time, pay_time) '
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                ('order-1', 'old-device', 'invitee', 'basic', '3.00', 'paid',
                 '2026-09-02T12:00:00', '2026-09-02T12:01:00'),
            )

        user_service.bind_user('device-1', 'invitee', 'password', token)

        with database.get_db(self.config) as conn:
            earning = conn.execute(
                'SELECT username, amount, rate FROM invitation_earnings'
            ).fetchone()
        self.assertEqual(dict(earning), {
            'username': 'inviter', 'amount': '0.3', 'rate': '10%',
        })


class LoginInvitationTokenTests(unittest.TestCase):
    def test_login_forwards_token_and_ignores_manual_inviter(self):
        app = Flask(__name__)
        app.config['TESTING'] = True
        app.register_blueprint(auth_routes.auth_bp)
        client = app.test_client()

        with (
            mock.patch.object(auth_routes, 'urp_login', return_value=(True, 'ok', {})),
            mock.patch.object(auth_routes, 'get_device_id', return_value='device-1'),
            mock.patch.object(auth_routes, 'bind_user') as bind_user,
        ):
            response = client.post('/api/login', json={
                'username': 'invitee',
                'password': 'password',
                'inviter': 'manual-attacker',
                'invitation_token': 'link-token',
            })

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()['success'])
        bind_user.assert_called_once_with(
            'device-1', 'invitee', 'password', 'link-token'
        )


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `python -m unittest tests.test_invitation_binding -v`

Expected: FAIL because `bind_user()` has no token parameter and `login()` still handles the old manual inviter field.

- [ ] **Step 3: Implement one-transaction binding**

在 `services/user_service.py` 中保留已有三参数兼容性，把 `bind_user` 改为：

```python
def bind_user(device_id, username, password, invitation_token=None):
    invitation_bound = False
    with get_db() as conn:
        conn.execute('''
            INSERT OR REPLACE INTO users (device_id, username, password, bind_time)
            VALUES (?, ?, ?, ?)
        ''', (device_id, username, password, datetime.now().isoformat()))

        if invitation_token:
            from services.invitation_service import bind_invitation_by_token
            invitation_bound = bind_invitation_by_token(
                conn, username, invitation_token
            )
            if invitation_bound:
                from services.member_service import ensure_invitation_earnings
                ensure_invitation_earnings(conn, invitee_username=username)

    return invitation_bound
```

动态导入佣金函数是为了避免把会员服务耦合到模块导入顺序；`bind_invitation_by_token` 返回 `False` 时不做补偿，数据库异常由 `get_db()` 回滚用户绑定和邀请关系。

- [ ] **Step 4: Replace login parsing and call the new signature**

在 `routes/auth_routes.py` 的 `login()` 中删除 `inviter` 解析和整段手工邀请逻辑，改为：

```python
data = request.get_json() or {}
username = data.get('username')
password = data.get('password')
invitation_token = (data.get('invitation_token') or '').strip()

if not username or not password:
    return jsonify({'success': False, 'message': '用户名和密码不能为空'})

success, message, _ = urp_login(username, password)

if success:
    device_id = get_device_id()
    bind_user(device_id, username, password, invitation_token)
    return jsonify({'success': True, 'message': '登录成功', 'username': username})

return jsonify({'success': False, 'message': message})
```

删除不再使用的 `datetime` 和 `ensure_invitation_earnings` 导入，但保留 `get_db`，因为同文件的绑定检查和换绑接口仍使用数据库。

- [ ] **Step 5: Run focused tests and the existing binding tests**

Run:

```powershell
python -m unittest tests.test_invitation_links tests.test_invitation_binding -v
python -m unittest tests.test_shortcut_api -v
```

Expected: 新增测试和快捷指令已有绑定/解绑测试全部 PASS；旧三参数 `bind_user()` 调用仍通过。

- [ ] **Step 6: Commit the atomic login integration**

```powershell
git diff --check
git add -- services/user_service.py routes/auth_routes.py tests/test_invitation_binding.py
git commit -m "feat: attribute invitations during account binding"
```

Expected: 只提交原子绑定、登录解析和对应测试变更。

### Task 3: 增加链接 API、停用手工接口并开放非会员提现

**Files:**
- Create: `tests/test_invitation_api.py`
- Modify: `routes/member_routes.py:8-240,301-304`

**Interfaces:**
- Produces `GET /api/invitation/link` with `@require_bindding`，无链接返回 `has_link: false, invite_url: null`。
- Produces idempotent `POST /api/invitation/link` with `@require_bindding`，返回 `invite_url` 和 `created`。
- Removes `POST /api/invitation/set` route。
- Changes `POST /api/invitation/withdraw` to `@require_bindding`，不改变余额、提现资料和响应校验。

- [ ] **Step 1: Write failing API and non-member commission tests**

创建 `tests/test_invitation_api.py`，使用真实临时 SQLite、真实 `member_bp` 路由和仅针对外部身份/配置的 mock：

```python
import os
import tempfile
import unittest
from unittest import mock

from flask import Flask

import auth
import database
from routes import member_routes
from services.member_service import ensure_invitation_earnings


class InvitationApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.config = {
            'database': {
                'type': 'sqlite',
                'sqlite_path': os.path.join(self.temp_dir.name, 'api.db'),
            }
        }
        database.init_db(self.config)
        app = Flask(__name__)
        app.config['TESTING'] = True
        app.register_blueprint(member_routes.member_bp)
        self.client = app.test_client()
        self.db_patcher = mock.patch.object(
            member_routes,
            'get_db',
            side_effect=lambda: database.get_db(self.config),
        )
        self.device_patcher = mock.patch.object(
            auth, 'get_device_id', return_value='device-1'
        )
        self.user_patcher = mock.patch.object(
            auth,
            'get_user_by_device',
            return_value={
                'device_id': 'device-1',
                'username': 'inviter',
                'password': 'password',
                'bind_time': '2026-09-02T12:00:00',
            },
        )
        self.server_patcher = mock.patch.object(
            member_routes,
            '_get_server_url',
            return_value='https://urp.example.com',
        )
        for patcher in (
            self.db_patcher, self.device_patcher,
            self.user_patcher, self.server_patcher,
        ):
            patcher.start()

    def tearDown(self):
        for patcher in (
            self.server_patcher, self.user_patcher,
            self.device_patcher, self.db_patcher,
        ):
            patcher.stop()
        self.temp_dir.cleanup()

    def test_get_without_link_returns_empty_state_and_post_is_fixed(self):
        empty = self.client.get('/api/invitation/link')
        self.assertEqual(empty.get_json(), {
            'success': True,
            'data': {'has_link': False, 'invite_url': None},
        })

        first = self.client.post('/api/invitation/link')
        second = self.client.post('/api/invitation/link')
        self.assertTrue(first.get_json()['data']['created'])
        self.assertFalse(second.get_json()['data']['created'])
        self.assertEqual(
            first.get_json()['data']['invite_url'],
            second.get_json()['data']['invite_url'],
        )

    def test_manual_inviter_route_is_removed(self):
        response = self.client.post(
            '/api/invitation/set', json={'inviter': 'manual'}
        )
        self.assertEqual(response.status_code, 404)
        self.assertTrue(response.is_json)
        self.assertFalse(response.get_json()['success'])

    def test_user_without_membership_can_withdraw_available_earnings(self):
        with database.get_db(self.config) as conn:
            conn.execute(
                'INSERT INTO invitation_earnings '
                '(username, order_no, invitee_username, amount, rate, create_time) '
                'VALUES (?, ?, ?, ?, ?, ?)',
                ('inviter', 'order-1', 'invitee', '0.30', '10%', '2026-09-02T12:00:00'),
            )

        response = self.client.post('/api/invitation/withdraw', json={
            'real_name': '测试用户',
            'alipay_account': 'alipay@example.com',
        })

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()['success'])
        with database.get_db(self.config) as conn:
            row = conn.execute(
                'SELECT username, amount, status FROM withdrawals'
            ).fetchone()
        self.assertEqual(dict(row), {
            'username': 'inviter', 'amount': '0.3', 'status': 'pending',
        })

    def test_paid_order_creates_commission_without_membership(self):
        with database.get_db(self.config) as conn:
            conn.execute(
                'INSERT INTO invitations (inviter_username, invitee_username, create_time) '
                'VALUES (?, ?, ?)',
                ('inviter', 'invitee', '2026-09-02T12:00:00'),
            )
            conn.execute(
                'INSERT INTO orders '
                '(order_no, device_id, username, member_type, amount, status, create_time, pay_time) '
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                ('order-1', 'device-2', 'invitee', 'basic', '3.00', 'paid',
                 '2026-09-02T12:00:00', '2026-09-02T12:01:00'),
            )
            created = ensure_invitation_earnings(conn, inviter_username='inviter')
            row = conn.execute(
                'SELECT username, amount, rate FROM invitation_earnings'
            ).fetchone()

        self.assertEqual(created, 1)
        self.assertEqual(dict(row), {
            'username': 'inviter', 'amount': '0.3', 'rate': '10%',
        })


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 2: Run the focused API tests to verify they fail**

Run: `python -m unittest tests.test_invitation_api -v`

Expected: FAIL because `/api/invitation/link` is not registered, `/api/invitation/set` still exists, and a non-member is rejected by `@require_member('basic')` before the withdrawal body runs.

- [ ] **Step 3: Add the link query/create routes**

在 `routes/member_routes.py` 中导入 `get_invitation_link`、`get_or_create_invitation_link` 和 `build_invitation_url`，并在 `my_inviter()` 后添加：

```python
@member_bp.route('/api/invitation/link', methods=['GET'])
@require_bindding
def invitation_link(user):
    with get_db() as conn:
        row = get_invitation_link(conn, user['username'])
    invite_url = (
        build_invitation_url(_get_server_url(), row['token'])
        if row else None
    )
    return jsonify({
        'success': True,
        'data': {'has_link': row is not None, 'invite_url': invite_url},
    })


@member_bp.route('/api/invitation/link', methods=['POST'])
@require_bindding
def create_invitation_link(user):
    with get_db() as conn:
        invite_url, created = get_or_create_invitation_link(
            conn, user['username'], _get_server_url()
        )
    return jsonify({
        'success': True,
        'data': {'has_link': True, 'invite_url': invite_url, 'created': created},
    })
```

保留 `my_inviter()` 只读接口；删除 `set_inviter()` 的整个路由函数和 `member_routes.py` 中不再需要的 `require_member` 导入。不要删除历史 `invitations` 数据或管理员统计查询。

- [ ] **Step 4: Remove the membership gate from withdrawal**

把提现路由装饰器从：

```python
@require_member('basic')
def invitation_withdraw(user):
```

改为：

```python
@require_bindding
def invitation_withdraw(user):
```

保持 `ensure_invitation_earnings()`、可用金额计算、待审核判断、姓名/支付宝账号校验和成功响应不变；`calculate_invitation_rate()` 不改动，因为它已经为无会员用户返回 0.1。

- [ ] **Step 5: Run focused API and service tests to verify they pass**

Run:

```powershell
python -m unittest tests.test_invitation_links tests.test_invitation_binding tests.test_invitation_api -v
```

Expected: PASS；链接 API 返回固定 URL，旧手工接口是 JSON 404，无会员用户可以提现，已支付订单产生 10% 佣金。

- [ ] **Step 6: Commit the API and withdrawal changes**

```powershell
git diff --check
git add -- routes/member_routes.py tests/test_invitation_api.py
git commit -m "feat: expose invitation links and open withdrawals"
```

Expected: 只提交链接 API、手工接口停用、提现权限和测试变更。

### Task 4: 改造邀请链接前端流程与会员页

**Files:**
- Create: `tests/test_invitation_links_ui.py`
- Modify: `templates/index.html:317-350`
- Modify: `static/js/main.js:1-180,2427-2735,2853-2880`
- Modify: `static/css/style.css:3187-3250`

**Interfaces:**
- Produces browser helpers `capturePendingInvitationToken()`, `getPendingInvitationToken()`, `clearPendingInvitationToken()`。
- `handleLogin()` sends `{username, password, invitation_token}` and no longer reads `#inviter`。
- Produces `generateInvitationLink()` and `copyInvitationLink()` for the member page。

- [ ] **Step 1: Write failing static UI tests**

创建 `tests/test_invitation_links_ui.py`，先验证 HTML、JavaScript 和 CSS 的外部行为约束：

```python
from pathlib import Path
import unittest

from bs4 import BeautifulSoup


ROOT = Path(__file__).resolve().parents[1]


class InvitationLinksUiTests(unittest.TestCase):
    def setUp(self):
        self.html = (ROOT / 'templates/index.html').read_text(encoding='utf-8')
        self.script = (ROOT / 'static/js/main.js').read_text(encoding='utf-8')
        self.css = (ROOT / 'static/css/style.css').read_text(encoding='utf-8')
        self.soup = BeautifulSoup(self.html, 'html.parser')

    def test_login_form_has_no_manual_inviter_field(self):
        self.assertIsNone(self.soup.select_one('#inviter'))
        self.assertNotIn('邀请人学号', self.html)

    def test_member_card_contains_link_controls(self):
        card = self.soup.select_one('#invitation-card')
        self.assertIsNotNone(card)
        self.assertIsNotNone(card.select_one('#invitation-link-content'))
        self.assertIn('generateInvitationLink()', self.html + self.script)
        self.assertIn('copyInvitationLink()', self.html + self.script)

    def test_login_script_uses_session_token_and_new_request_field(self):
        self.assertIn('sessionStorage', self.script)
        self.assertIn('pending_invitation_token', self.script)
        self.assertIn('invitation_token', self.script)
        self.assertIn("get('invite')", self.script)
        self.assertNotIn('/api/invitation/set', self.script)
        self.assertNotIn('handleSetInviter', self.script)

    def test_non_member_copy_does_not_keep_membership_withdrawal_gate(self):
        self.assertNotIn('开通会员后可提现', self.script)
        self.assertNotIn('\\u5f00\\u901a\\u4f1a\\u5458\\u540e\\u53ef\\u63d0\\u73b0', self.script)
        self.assertIn('/api/invitation/link', self.script)
        self.assertIn('.invitation-link', self.css)
        self.assertNotIn('.inviter-set-form', self.css)


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 2: Run the UI tests to verify they fail**

Run: `python -m unittest tests.test_invitation_links_ui -v`

Expected: FAIL because the login form still contains `#inviter`, the member card has no link region, and the script still calls `/api/invitation/set`.

- [ ] **Step 3: Capture and clear the referral token in the browser**

在 `static/js/main.js` 顶部增加以下 helper，并在第一个 `DOMContentLoaded` 回调中先调用 `capturePendingInvitationToken()` 再调用 `checkBindStatus()`：

```javascript
const pendingInvitationTokenKey = 'pending_invitation_token';

function capturePendingInvitationToken() {
    const token = (new URLSearchParams(window.location.search).get('invite') || '').trim();
    if (token && token.length <= 128) {
        sessionStorage.setItem(pendingInvitationTokenKey, token);
    }
}

function getPendingInvitationToken() {
    const token = (sessionStorage.getItem(pendingInvitationTokenKey) || '').trim();
    return token.length > 0 && token.length <= 128 ? token : '';
}

function clearPendingInvitationToken() {
    sessionStorage.removeItem(pendingInvitationTokenKey);
}
```

只使用 `sessionStorage`，不把邀请 token 写入 `localStorage`、URL 之外的永久账户设置或日志；读取 token 失败时返回空字符串，不阻断普通登录。

- [ ] **Step 4: Change the login payload and modal markup**

在 `handleLogin()` 中删除 `inviterInput` 和 `inviter`，改成：

```javascript
const invitationToken = getPendingInvitationToken();

body: JSON.stringify({
    username,
    password,
    invitation_token: invitationToken,
})
```

成功分支在隐藏登录弹窗前或后调用 `clearPendingInvitationToken()`；失败分支不清除 token。保留 `currentUsername`、访客状态和页面跳转行为。

在 `templates/index.html` 删除 `#inviter` 所在的整个 `.form-group-wide`，在 `#invitation-earnings-content` 前加入：

```html
<div id="invitation-link-content" class="invitation-link-content">
    <div class="loading">加载中...</div>
</div>
```

不要在静态 HTML 中写入真实 token 或邀请人学号。

- [ ] **Step 5: Render generation/copy controls and update withdrawal copy**

在 `static/js/main.js` 中加入：

```javascript
function renderInvitationLink(data) {
    const container = document.getElementById('invitation-link-content');
    if (!container) return;
    if (!data || data.has_link !== true || !data.invite_url) {
        container.innerHTML = `
            <div class="invitation-link-empty">
                <span>生成固定邀请链接，分享给新用户即可自动绑定邀请关系。</span>
                <button class="btn-secondary" type="button" onclick="generateInvitationLink()">生成邀请链接</button>
            </div>`;
        return;
    }
    const safeUrl = escapeGradeHtml(data.invite_url);
    container.innerHTML = `
        <div class="invitation-link-label">我的固定邀请链接</div>
        <div class="invitation-link-row">
            <input id="invitation-link-input" class="invitation-link-input" type="text" readonly value="${safeUrl}">
            <button id="invitation-link-copy" class="btn-secondary" type="button" onclick="copyInvitationLink()">复制链接</button>
        </div>`;
}

async function generateInvitationLink() {
    const container = document.getElementById('invitation-link-content');
    if (container) container.innerHTML = '<div class="loading">正在生成...</div>';
    try {
        const response = await fetch('/api/invitation/link', {
            method: 'POST',
            headers: { 'X-Device-ID': getDeviceId() },
        });
        const data = await response.json();
        if (!data.success || !data.data) throw new Error(data.message || '生成邀请链接失败');
        renderInvitationLink(data.data);
    } catch (error) {
        if (container) container.innerHTML = `<div class="error-message">${escapeGradeHtml(error.message || '生成失败，请重试')}</div>`;
    }
}

async function copyInvitationLink() {
    const input = document.getElementById('invitation-link-input');
    const button = document.getElementById('invitation-link-copy');
    if (!input || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        if (button) button.textContent = '复制失败，请手动复制';
        return;
    }
    try {
        await navigator.clipboard.writeText(input.value);
        if (button) {
            button.textContent = '已复制';
            window.setTimeout(() => {
                if (button.isConnected) button.textContent = '复制链接';
            }, 1500);
        }
    } catch (error) {
        if (button) button.textContent = '复制失败，请手动复制';
    }
}
```

在 `loadInvitationEarnings()` 的 `Promise.all()` 中加入 `fetchJson('/api/invitation/link')`，无论链接接口成功或失败都继续渲染收益；链接成功时调用 `renderInvitationLink(linkData.data)`，失败时在链接区域显示错误和可重试的生成按钮。删除旧的 `handleSetInviter()` 函数及其 `inviter-set-*` 字符串。

将收益渲染中的比例和提现判断改为：

```javascript
const isMember = memberData.success && memberData.data && memberData.data.is_member;
const memberType = isMember ? memberData.data.member_type : null;
const rateText = memberType === 'advanced' ? '20%' : '10%';

if (hasPending) {
    btnText = '审核中';
    btnDisabled = true;
    btnOpacity = '0.5';
} else if (available <= 0) {
    btnText = '暂无可提现';
    btnDisabled = true;
    btnOpacity = '0.5';
} else {
    btnText = '提现';
    btnDisabled = false;
    btnOpacity = '1';
}
```

把非会员提示改为“所有已绑定用户均可获得 10% 起的邀请收益并申请提现”；会员状态请求失败时保留后端收益数据，不显示会员门槛。

- [ ] **Step 6: Add focused styles without changing existing member plans**

在 `static/css/style.css` 的邀请收益区域删除 `.inviter-set-form`、`.inviter-set-input`、`.inviter-set-btn`、`.inviter-set-error` 规则，增加：

```css
.invitation-link-content {
    padding: 10px 0 12px;
    border-bottom: 1px solid var(--divider);
}

.invitation-link-label {
    margin-bottom: 8px;
    color: var(--text-secondary);
    font-size: 13px;
    font-weight: 600;
}

.invitation-link-row,
.invitation-link-empty {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}

.invitation-link-input {
    flex: 1;
    min-width: 180px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-secondary);
    color: var(--text-secondary);
    font-size: 12px;
}

.invitation-link-empty {
    justify-content: space-between;
    color: var(--text-secondary);
    font-size: 13px;
    line-height: 1.5;
}
```

在现有移动端 media query 中确保 `.invitation-link-empty` 在窄屏上保持单列可读，不修改 `.member-plan-card` 的已有样式。

- [ ] **Step 7: Run UI tests and all focused backend tests**

Run:

```powershell
python -m unittest tests.test_invitation_links_ui -v
python -m unittest tests.test_invitation_links tests.test_invitation_binding tests.test_invitation_api -v
```

Expected: UI 测试确认无手工学号输入、存在生成/复制控件、使用 `sessionStorage` 和 `invitation_token`，且无旧手工接口/会员提现文案；后端测试继续全部 PASS。

- [ ] **Step 8: Commit the frontend flow**

```powershell
git diff --check
git add -- templates/index.html static/js/main.js static/css/style.css tests/test_invitation_links_ui.py
git commit -m "feat: add fixed invitation link user flow"
```

Expected: 只提交登录 token 传递、会员页控件、样式和前端测试变更。

### Task 5: 完整回归、MySQL 启动验收与交付检查

**Files:**
- Verify: `app.py`, `database.py`, `services/invitation_service.py`, `services/user_service.py`, `routes/auth_routes.py`, `routes/member_routes.py`
- Verify: `tests/test_invitation_links.py`, `tests/test_invitation_binding.py`, `tests/test_invitation_api.py`, `tests/test_invitation_links_ui.py`
- Verify: `docs/superpowers/specs/2026-09-02-invitation-links-design.md`

**Interfaces:**
- Consumes all interfaces produced by Tasks 1–4。
- Produces a clean, evidence-backed verification result；不新增业务行为。

- [ ] **Step 1: Run Python syntax and focused tests**

Run:

```powershell
python -m compileall -q app.py auth.py database.py services routes
python -m unittest tests.test_invitation_links tests.test_invitation_binding tests.test_invitation_api tests.test_invitation_links_ui -v
```

Expected: 编译命令退出码为 0；四个新增测试模块全部 PASS，无 traceback 或 warning 导致的失败。

- [ ] **Step 2: Run the full existing Python test suite**

Run: `python -m unittest discover -s tests -p "test_*.py" -v`

Expected: 现有测试和新增测试全部 PASS；若失败，先定位是本功能回归还是既有环境问题，不修改测试来掩盖失败。

- [ ] **Step 3: Run every existing Node test**

Run:

```powershell
node --test tests/test_historical_schedule_grid.js tests/test_schedule_weekend_visibility.js tests/test_service_status_ui.js tests/test_main_page_navigation.js
```

Expected: 所有 `node:test` 用例 PASS；前端脚本可以在现有 VM 测试夹具中加载。

- [ ] **Step 4: Verify MySQL schema and restart behavior**

在不连接真实生产库的情况下，执行已有录制连接测试确认 MySQL SQL 含 `invitation_links`、`UNIQUE token` 和 `ENGINE=InnoDB`。如果环境提供专用 MySQL 测试配置，再依次执行：

```powershell
python -c "import database; database.init_db({'database': {'type': 'mysql', 'mysql': {'host': '127.0.0.1', 'port': 3306, 'database': 'urp_helper_test', 'user': 'test', 'password': 'test'}}}); database.init_db({'database': {'type': 'mysql', 'mysql': {'host': '127.0.0.1', 'port': 3306, 'database': 'urp_helper_test', 'user': 'test', 'password': 'test'}}}); print('mysql init twice ok')"
```

Expected: 空库首次启动创建所有表，第二次初始化成功且已有 token 保持不变；没有测试库时以录制 SQL 测试作为证据，不触碰生产数据库。

- [ ] **Step 5: Verify requirement coverage and working tree**

逐项检查：

```powershell
rg -n "inviter|invitation_token|invitation_links|/api/invitation/link|/api/invitation/set|require_member\('basic'\)" routes services database.py templates/index.html static/js/main.js static/css/style.css tests
git diff --check
git status --short --branch
```

Expected：

- 绑定表单和前端脚本不再出现手工邀请输入及旧 `/api/invitation/set` 请求。
- `routes/auth_routes.py` 使用 `invitation_token`，`member_routes.py` 注册链接 GET/POST，提现使用 `@require_bindding`。
- `database.py` 的 SQLite/MySQL schema、索引和 `MIGRATION_TABLES` 都包含 `invitation_links`。
- 工作区只保留本功能已提交的变更和用户原有未跟踪文件，不误改 `docs/shortcut-api-usage.md`。

- [ ] **Step 6: Report verified evidence and hand off**

交付时只报告实际执行过的命令和结果，明确说明：

1. 固定链接按学号幂等保存，MySQL 重启自动建表。
2. 首次绑定按 token 自动归因，旧手工接口停用，历史关系保留。
3. 普通/未开会员用户按 10% 计佣并可提现，高级会员仍按 20%。
4. 全部测试结果、MySQL 实测或录制 SQL 验证结果，以及任何未能执行的真实 MySQL 环境验收。
