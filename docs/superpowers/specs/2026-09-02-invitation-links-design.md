# 固定邀请链接归因设计

## 目标

将绑定账号时手工填写邀请人学号的方式，改为“固定邀请链接归因”：已绑定用户生成一个长期有效的固定链接，其他用户通过该链接打开网站并首次绑定学号后，系统自动建立两人的邀请关系，并沿用现有支付佣金、收益和提现链路。

本次实现优先保证 MySQL/MariaDB 部署可用；服务每次重启时自动检查并创建缺失表和索引。SQLite 继续保留，用于本地开发和自动化测试。

## 已确认的业务规则

1. 所有已绑定教务账号的用户都可以生成邀请链接，不要求会员资格。
2. 一个学号只有一个固定邀请链接。链接生成后长期有效，不自动过期、不自动轮换，也不提供普通用户更换链接的功能。
3. “首次绑定”按受邀学号判定：只有 `invitations` 中尚无该 `invitee_username` 记录时才建立关系。之后换设备或重新绑定不改变关系。
4. 已有的历史邀请关系和历史佣金数据保留，不迁移、不删除。
5. 新邀请关系只能由固定链接建立；绑定表单不再出现邀请人学号，旧的 `POST /api/invitation/set` 手工绑定接口停用。
6. 佣金和提现不再要求会员资格。普通用户或未开会员用户按 10% 计佣，有效高级会员按 20% 计佣；现有高级会员比例激励保留。
7. 用户仍必须先绑定教务账号才能生成链接、查看收益或申请提现；余额不足和存在待审核提现时仍不能重复提现。
8. MySQL 配置缺失或连接失败时不自动回退写入 SQLite，沿用现有启动错误提示和数据库配置流程。

## 当前代码约束

- `app.py` 的 `initialize_database()` 在注册 Blueprint 前调用 `init_db()`，这是重启自动建表的入口。
- `database.py` 同时维护 SQLite 和 MySQL 建表语句，并通过 `MySQLConnectionAdapter` 将旧代码中的问号参数和 `INSERT OR IGNORE` 适配到 MySQL。
- `users` 以 `device_id` 为主键，同一学号可能有不同设备记录，因此固定链接不能直接加在 `users` 表上。
- `invitations.invitee_username` 已有唯一约束，是一次性邀请关系的最终防线。
- `ensure_invitation_earnings()` 已经按邀请关系和已支付订单幂等生成佣金，非会员默认返回 10%；本次只移除提现的会员装饰器并修正前端展示，不改变高级会员 20% 规则。

## 数据模型

新增 `invitation_links` 表，每个学号一条记录：

### MySQL/MariaDB

```sql
CREATE TABLE IF NOT EXISTS invitation_links (
    username VARCHAR(64) PRIMARY KEY,
    token VARCHAR(128) NOT NULL UNIQUE,
    create_time VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
```

### SQLite

```sql
CREATE TABLE IF NOT EXISTS invitation_links (
    username TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    create_time TEXT NOT NULL
)
```

`token` 使用 Python `secrets` 生成的随机 URL-safe 字符串。邀请链接只包含 token，不包含邀请人学号。`username` 主键保证同一学号跨设备返回同一链接，`token` 唯一约束防止碰撞和错误归因。

`database.py` 需要同步完成以下工作：

- 在 `_create_schema_mysql()` 和 `_create_schema_sqlite()` 增加表定义。
- 在 `_create_indexes()` 增加 token 唯一索引（若表定义已提供唯一索引，重复创建通过现有 `_exec_ignore()` 保持幂等）。
- 在 `MIGRATION_TABLES` 增加 `invitation_links` 的字段清单，使 SQLite→MySQL 迁移可复制已有固定链接。
- 保持 `init_db()` 的执行顺序：连接当前配置数据库、创建所有表、运行历史迁移、创建索引。重复执行必须成功且不能改变已生成 token。

## 后端组件与接口

新增 `services/invitation_service.py`，只负责固定链接和 token 归因，不负责 HTTP 响应。至少提供以下接口：

```python
def get_invitation_link(conn, username):
    """返回已有链接记录，没有则返回 None。"""

def get_or_create_invitation_link(conn, username, server_url):
    """幂等返回 (invite_url, created)。"""

def bind_invitation_by_token(conn, invitee_username, invitation_token):
    """按一次性规则绑定邀请关系，返回是否新建关系。"""
```

`get_or_create_invitation_link()` 查询已有记录；没有记录时生成 token 并插入，遇到唯一 token 冲突重试；并发请求中若其他请求先插入，则重新查询并返回已存在记录。链接基于配置中的 `server_url` 拼为 `server_url + '/?invite=' + token`，不信任请求 Host。

`bind_invitation_by_token()` 的处理顺序为：空 token 直接跳过；查询 token 对应的邀请人；无记录时跳过；邀请人等于受邀学号时跳过；查询 `invitations` 是否已有该受邀学号，已有时跳过；最后用 `INSERT OR IGNORE`（由 MySQL 适配为 `INSERT IGNORE`）写入关系。唯一约束负责处理并发下的首次绑定竞争。

为了避免“设备绑定成功但邀请关系写入失败”造成半成功状态，`services/user_service.py` 的 `bind_user()` 增加可选的 `invitation_token=None` 参数，在同一个 `get_db()` 事务中完成用户绑定和 `bind_invitation_by_token()`；已有三参数调用保持兼容。无效 token不抛错，因此不影响正常登录；数据库真实异常则回滚本次绑定并返回现有 API 错误。

如果本次调用新建了邀请关系，事务中同时调用 `ensure_invitation_earnings(conn, invitee_username=username)` 做一次历史已支付订单补偿，避免用户在关系建立前已有订单时遗漏佣金；该调用仍保持 `(username, order_no)` 幂等。

### 接口契约

#### `GET /api/invitation/link`

使用 `@require_bindding`。只读取当前学号已有链接，不自动生成：

```json
{
  "success": true,
  "data": {
    "has_link": false,
    "invite_url": null
  }
}
```

有链接时 `has_link` 为 `true` 并返回固定 `invite_url`。

#### `POST /api/invitation/link`

使用 `@require_bindding`。创建或返回当前学号的固定链接，重复请求返回同一 URL：

```json
{
  "success": true,
  "data": {
    "has_link": true,
    "invite_url": "https://example.com/?invite=<token>",
    "created": true
  }
}
```

已有链接时 `created` 为 `false`。响应不返回邀请人学号。

两个链接接口由 `routes/member_routes.py` 提供，均通过 `services.config_service.get_config()` 间接读取 `server_url`，并通过 `services.invitation_service` 操作数据库。

#### `POST /api/login`

请求保留 `username`、`password`，移除 `inviter` 的业务含义，新增可选 `invitation_token`：

```json
{
  "username": "学号",
  "password": "教务密码",
  "invitation_token": "<token>"
}
```

URP 登录成功后调用 `bind_user(..., invitation_token)`。无 token、无效 token、自邀或已有邀请关系都不阻止登录；成功响应保持现有 `{success, message, username}` 结构。

#### `GET /api/invitation/my_inviter`

保留为历史关系只读查询，已有关系继续展示；不再提供设置入口。

#### `POST /api/invitation/set`

删除路由实现。旧客户端请求由 Flask 现有 API 404 错误处理返回 JSON，不再接受学号手工绑定。

#### `POST /api/invitation/withdraw`

把 `@require_member('basic')` 改为 `@require_bindding`，业务校验、响应结构、待审核和余额限制保持不变。

## 前端流程

### 邀请链接进入与首次绑定

1. 邀请链接打开现有首页 `/?invite=<token>`，不新增独立页面或跳转路由。
2. `DOMContentLoaded` 时读取 `invite` 查询参数，做长度/空值过滤后写入 `sessionStorage` 的待绑定 token；不写入 `localStorage`，避免邀请归因永久污染同一浏览器。
3. 未绑定设备显示登录弹窗。绑定表单只保留学号和教务密码，删除邀请人学号输入框。
4. `handleLogin()` 从 `sessionStorage` 读取 token，并在请求中发送 `invitation_token`。登录失败保留 token，登录成功清除 token。
5. 已绑定设备打开邀请链接不会在前端直接改变关系；只有后端实际执行首次学号绑定时才归因。

登录弹窗可展示“已识别邀请链接，绑定成功后自动建立邀请关系”的非敏感提示，但不展示邀请人学号，也不根据 token 在未登录前查询邀请人信息。

### 会员页邀请卡片

在现有“邀请与返佣”卡片中移除手工绑定输入框，增加固定链接区域：

- 未生成：显示“生成邀请链接”按钮，调用 `POST /api/invitation/link`。
- 已生成：显示只读链接文本和“复制链接”按钮，调用剪贴板 API；生成后刷新状态时链接必须保持不变。
- 如果当前用户是历史受邀人，继续只读显示已有邀请人关系。
- 收益区域继续显示团队充值、佣金比例、累计收益、可提现金额和明细。
- 提现按钮只由“有余额”和“没有待审核记录”控制，非会员也可点击。
- 比例展示使用会员状态：有效高级会员显示 20%，其他已绑定用户显示 10%；会员状态接口失败时按 10% 展示，不阻断链接和收益加载。

同步删除 `handleSetInviter()`、`inviter-set-*` DOM/CSS 和相关请求。

## 佣金与结算

- 支付回调仍在订单变为 `paid` 后调用 `ensure_invitation_earnings()`。
- 已建立邀请关系的受邀用户支付成功后，邀请人无论是否会员都产生佣金。
- `calculate_invitation_rate()` 保持现有结果：有效高级会员 0.2，其他用户 0.1。
- `invitation_earnings` 仍按 `(username, order_no)` 唯一生成，重复支付回调、收益查询、管理员补偿查询不会重复记账。
- 取消提现接口的会员装饰器；所有已绑定用户沿用现有余额、待审核和提现资料校验。

## 启动初始化与部署行为

服务启动时 `app.initialize_database()` 调用 `init_db()`，MySQL 配置下自动执行新表创建和索引创建。所有语句必须使用当前 MySQL/MariaDB 兼容写法，并确保：

- 空数据库首次启动能创建 `invitation_links` 以及已有业务表。
- 已有数据库重启不会删除或重置任何 token、邀请关系、佣金或提现记录。
- 只缺少新表时重启能补齐新表。
- SQLite→MySQL 迁移会复制 `invitation_links`，避免历史用户重新生成链接。
- MySQL 连接失败时不会切换到 SQLite 写入，管理员仍可通过现有数据库配置修复连接后重启。

## 错误与安全边界

- token 是 URL 中的 bearer 凭据，使用高熵随机值；接口不把 token 映射的学号返回给未绑定用户。
- 前端 token 只用于提交，后端必须再次查询并校验，不能信任前端传来的邀请人学号。
- 无效 token、自邀和重复归因均降级为“正常绑定但不建立新关系”，避免分享过期/错误链接阻断新用户。
- token 不设置过期是固定链接需求的一部分；本次不实现撤销、轮换、层级邀请或跨账号转移。
- 生成链接使用配置 `server_url`，避免 Host 头注入伪造邀请链接。
- `inviter_username` 和 `invitee_username` 使用现有参数化 SQL；不接受前端直接提交的邀请人学号。

## 测试与验收标准

新增后端测试覆盖：

1. MySQL 建表语句包含 `invitation_links`、`PRIMARY KEY`、`UNIQUE token` 和 InnoDB 配置；SQLite `init_db()` 重复执行后表和字段存在且 token 不被重置。
2. `GET` 无链接返回空状态，`POST` 首次创建链接，重复 `POST` 返回完全相同的 URL。
3. 绑定成功时有效 token 创建邀请关系；无效 token、自邀和已有邀请关系不阻断登录；两个 token 竞争同一受邀学号时只保留一条关系。
4. 登录请求不再读取手工 `inviter` 字段，而是把链接 token传入绑定服务；旧 `/api/invitation/set` 不再可用。
5. 未开会员用户的已支付订单仍产生 10% 佣金；未开会员用户可以在有余额时成功申请提现。
6. SQLite→MySQL 迁移清单包含 `invitation_links`。

新增前端静态测试覆盖：

1. 绑定弹窗不存在邀请人学号输入框。
2. 登录脚本读取 URL token、写入/清理 `sessionStorage`，并发送 `invitation_token`。
3. 会员页包含生成、复制固定链接控件，不包含手工绑定邀请人的控件或旧接口调用。
4. 非会员状态不会再把提现按钮渲染为“开通会员后可提现”。

验收时执行现有 Python 测试集合，并执行与前端静态测试匹配的 Node 测试；若配置了可用 MySQL 测试库，再执行一次空库启动、重启和迁移验证。

## 非目标

- 不改造现有 `users` 身份模型，不新增独立用户表。
- 不改变支付价格、会员有效期、提现审核流程和高级会员比例。
- 不实现多级邀请、邀请链接过期、普通用户撤销/换码或邀请人排行榜。
