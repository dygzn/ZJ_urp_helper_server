# MySQL 精简用户资料与旧绑定清理

## 出现“精简用户 undefined”时

这表示执行结果缺少精简版的 `account_count` 字段，不能据此认定写入 `user_accounts` 成功。如果预览同时显示当前绑定为 0、“已有精简用户”却有大量记录，可能是新页面搭配旧服务：旧服务的 `archived_records` 统计的是 `user_account_archive` 明细数，新页面误将其当成精简用户数。旧服务也不返回旧归档数量字段，页面原先补出的 0 不代表旧归档为空。

先暂停清理。在应用配置指向的同一个 MySQL 库只读查询：

```sql
SELECT DATABASE();
SELECT COUNT(*) AS compact_users FROM user_accounts;
SELECT COUNT(*) AS legacy_records, COUNT(DISTINCT username) AS legacy_users
FROM user_account_archive;
```

不要删除旧表。完整更新以下 5 个文件后，重启所有应用进程/容器，再强制刷新后台：

- `database.py`
- `services/binding_archive_service.py`
- `routes/admin_routes.py`
- `static/js/admin.js`
- `templates/admin.html`

在服务器项目目录，用应用使用的 Python 环境执行以下只读检查，确认文件路径和版本为 2（这只能检查新启动的 Python，现有网站进程仍必须重启）：

```sh
python -c "import services.binding_archive_service as s; print(s.__file__); print(getattr(s, 'PROTOCOL_VERSION', 'old'))"
```

刷新后的预览应分别显示 `user_accounts` 数量及旧版归档数量。确认旧数据仍在且处理后用户数合理，再备份、暂停写入并发起新批次，把旧归档按学号合并；不重用旧版执行的批次号。成功后只读查询 `user_accounts` 行数核对结果。新代码在接口格式不一致时会拒绝操作，不再把缺失的精简用户数显示成成功。

每个用户只保留一条记录，学号就是账号。新表为 `user_accounts`：

| 字段 | 含义 |
| --- | --- |
| `username` | 学号/账号，主键，唯一 |
| `password` | 最近一次绑定记录中的密码 |
| `registered_at` | 首次登记时间，取所有已知记录中最早的绑定时间 |
| `last_bind_time` | 最近一次绑定时间，用于后续合并时选择密码 |
| `archived_at` | 资料归档时间 |

不保存设备 ID、微信身份、会话令牌、完整 JSON 快照或同学号的多条历史密码。现有数据没有独立注册时间字段，因此首次登记时间以最早已知绑定时间为准，不能保证等于真实首次注册时间。

合并当前 `users`、已有 `user_accounts` 和可能存在的旧版 `user_account_archive`。密码取绑定时间最新的记录；时间相同优先当前绑定，同来源同时间按稳定主键顺序取最后一条。再次执行只更新同学号资料，不产生重复用户。不同学号的会员、订单和反馈等业务记录不改动。

## 使用

1. 上传代码并重启应用，启动只创建 `user_accounts` 和批次记录表，不自动搬运或清理数据。
2. 备份服务器完整 MySQL 数据库；暂停用户入口、后台任务和其他连接同库的应用实例，等待在途请求结束。
3. 后台 → 系统配置 → 服务器迁移：归档旧绑定，点击预览，核对主机、库名、合并后的用户数和待清理数量。
4. 勾选准备完成，点击“保存精简用户资料并清理旧数据”。
5. 完成后保存批次号，重启所有服务进程，再开放入口。用户需要重新登录绑定。

如果已经执行过旧版归档，即使 `users` 已经为空，也可以按相同步骤执行：先把旧归档账号按学号合并到 `user_accounts`，校验后清空旧 `user_account_archive` 和 `binding_record_archive` 中的明细。为避免 MySQL DDL 隐式提交破坏事务，只清空这些旧表的数据，保留空表结构。新部署不创建这两张旧表。

## 事务与统计

仅支持管理员手动操作当前配置的 MySQL/MariaDB，不清理 SQLite。参与操作的表必须是 InnoDB。锁定源数据及精简资料表后，写入、逐字段核对、清理和记录批次共用一个事务；失败回滚。预览涵盖当前绑定、已有资料和旧版归档，预览后数据或目标发生变化须重新预览。

清理范围为 `users`、`pending_requests`、`wechat_bindings`、`wechat_sessions`，以及存在的两张旧版归档表。换绑请求、设备明细和微信会话直接清理，不复制到新归档。`binding_archive_batches` 只记录批次、时间和数量，用于防止重复提交，不含账号、密码、设备或会话。

网络中断时，在原页面再次执行会使用同一批次重试，已完成批次不会清除新增绑定。刷新页面后应先核对实际结果再操作。

用户仪表盘合并当前绑定与精简资料，按学号去重，使用最早登记时间；旧版归档在尚未精简前也参与统计。归档密码不返回前端、不作为自动登录来源。内存缓存通过服务重启清理。

## 恢复与验证

本次有意不保留设备明细和历史密码，恢复旧绑定必须使用执行前的完整备份；建议先恢复到隔离库，避免覆盖执行后新增业务。旧备份不受本操作影响。

验证命令：

- `python -m unittest discover -s tests -p test_binding_archive.py`
- `node --test tests/test_binding_archive_ui.js tests/test_admin_ux.js`

测试只使用临时 SQLite 和前端交互环境；真实 MySQL 的事务锁、并发和回滚仍需隔离测试库验证。
