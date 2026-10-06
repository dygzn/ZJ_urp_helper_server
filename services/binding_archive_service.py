"""旧服务器绑定归档。只由管理员显式执行，不在启动/登录时搬运数据。"""
import hashlib
import json
import sqlite3
import uuid
from datetime import datetime

from database import get_db, get_database_config
from services.credential_service import CredentialCipher


PROTOCOL_VERSION = 2


SOURCES = {
    'users': 'device_id',
    'pending_requests': 'request_id',
    'wechat_bindings': 'openid',
    'wechat_sessions': 'token_hash',
}
LEGACY = {
    # 早期精简实现误用了复数表名；只读作迁移源，不再作为凭据来源。
    'user_accounts': 'username',
    'user_account_archive': 'batch_id, device_id',
    'binding_record_archive': 'batch_id, source_table, record_key',
}
ACCOUNT_TABLES = {'user_account', 'user_accounts'}
ACCOUNT_FIELDS = ('username', 'password', 'registered_at', 'last_bind_time', 'archived_at')


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def _table_names(conn):
    if isinstance(conn, sqlite3.Connection):
        return {row['name'] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    return {row['name'] for row in conn.execute(
        'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()'
    ).fetchall()}


def snapshot(conn, lock=False):
    # SERIALIZABLE + 全主键范围 FOR UPDATE 锁住记录和插入间隙。
    tables = dict(SOURCES)
    existing = _table_names(conn)
    tables.update({table: order for table, order in LEGACY.items() if table in existing})
    tables['user_account'] = 'username'
    return {table: [dict(row) for row in conn.execute(
        f'SELECT * FROM {table} ORDER BY {order}' + (' FOR UPDATE' if lock else '')
    ).fetchall()] for table, order in tables.items()}


def _target(config):
    mysql = config.get('mysql') or {}
    return {'type': config['type'], 'host': mysql.get('host', ''),
            'port': mysql.get('port', 3306), 'database': mysql.get('database', '')}


def _fingerprint(data, target):
    return hashlib.sha256(_json([PROTOCOL_VERSION, target, data]).encode('utf-8')).hexdigest()


def historical_users(conn):
    sources = ['SELECT username, bind_time FROM users',
               'SELECT username, registered_at AS bind_time FROM user_account']
    if 'user_account_archive' in _table_names(conn):
        sources.append('SELECT username, bind_time FROM user_account_archive')
    if 'user_accounts' in _table_names(conn):
        sources.append('SELECT username, registered_at AS bind_time FROM user_accounts')
    return conn.execute('SELECT username, MIN(bind_time) AS first_bind_time FROM (' +
                        ' UNION ALL '.join(sources) + ') AS history GROUP BY username').fetchall()


def _counts(data):
    return {table: len(rows) for table, rows in data.items() if table not in ACCOUNT_TABLES}


def _merge_accounts(data, archived_at):
    accounts = {row['username']: dict(row) for row in data['user_account']}
    # 复数表只是旧版本副本；已有单数主表时绝不让它覆盖主表资料。
    for row in data.get('user_accounts', []):
        if row['username'] not in accounts:
            bound_at = row.get('last_bind_time') or row.get('registered_at')
            accounts[row['username']] = {
                'username': row['username'], 'password': row['password'],
                'registered_at': row.get('registered_at') or bound_at,
                'last_bind_time': bound_at, 'archived_at': archived_at,
            }
    # 时间相同时优先当前绑定；同来源同时间按快照稳定顺序取最后一条。
    for source in ('user_account_archive', 'users'):
        for row in data.get(source, []):
            username = row['username']
            bound_at = row.get('bind_time') or row.get('last_bind_time') or row.get('registered_at')
            existing = accounts.get(username)
            if existing is None:
                accounts[username] = {'username': username, 'password': row['password'],
                                      'registered_at': bound_at, 'last_bind_time': bound_at,
                                      'archived_at': archived_at}
            else:
                if bound_at < existing['registered_at']:
                    existing['registered_at'] = bound_at
                if bound_at >= existing['last_bind_time']:
                    # 新版 users.password 只是兼容空占位，绝不能覆盖主表凭据。
                    if row.get('password'):
                        existing['password'] = row['password']
                    existing['last_bind_time'] = bound_at
                existing['archived_at'] = archived_at
    if archived_at:
        # 执行批次时所有保留下来的账号都应记录本次归档时间；预览传入
        # 空值，因此不会改动用于计算指纹的现有资料。
        for account in accounts.values():
            account['archived_at'] = archived_at
    return accounts


def preview_archive():
    config = get_database_config()
    target = _target(config)
    with get_db({'database': config}) as conn:
        data = snapshot(conn)
    return {'protocol_version': PROTOCOL_VERSION,
            'target': target, 'enabled': config['type'] == 'mysql',
            'counts': _counts(data), 'unique_users': len(_merge_accounts(data, '')),
            'archived_records': len(data['user_account']),
            'legacy_compact_records': len(data.get('user_accounts', [])),
            'fingerprint': _fingerprint(data, target)}


def archive_snapshot(conn, data, batch_id):
    """调用者持有源表锁及事务，校验精简资料后删除设备明细。"""
    archived_at = datetime.now().isoformat()
    accounts = _merge_accounts(data, archived_at)
    for row in accounts.values():
        row['password'] = CredentialCipher().ensure_encrypted(row['password'])
        conn.execute(
            'INSERT OR REPLACE INTO user_account '
            '(username, password, registered_at, last_bind_time, archived_at) '
            'VALUES (?, ?, ?, ?, ?)', tuple(row[field] for field in ACCOUNT_FIELDS))
    saved = {row['username']: dict(row) for row in conn.execute('SELECT * FROM user_account').fetchall()}
    if saved != accounts:
        raise RuntimeError('用户资料校验失败，已取消清理')
    for table, count in reversed(list(_counts(data).items())):
        if conn.execute(f'DELETE FROM {table}').rowcount != count:
            raise RuntimeError('绑定数量发生变化，已取消清理')
    legacy_count = len(data.get('user_accounts', []))
    if legacy_count and conn.execute('DELETE FROM user_accounts').rowcount != legacy_count:
        raise RuntimeError('旧版账号表清理数量发生变化，已取消清理')
    result = {'protocol_version': PROTOCOL_VERSION,
              'batch_id': batch_id, 'archived_at': archived_at,
              'counts': _counts(data), 'account_count': len(accounts),
              'legacy_compact_records': legacy_count}
    conn.execute('INSERT INTO binding_archive_batches VALUES (?, ?, ?)',
                 (batch_id, archived_at, _json(result)))
    return result


def execute_archive(fingerprint, batch_id):
    config = get_database_config()
    if config['type'] != 'mysql':
        raise ValueError('仅允许清理当前配置的 MySQL；本地 SQLite 不会被清理')
    try:
        if str(uuid.UUID(batch_id)) != batch_id:
            raise ValueError('non-canonical UUID')
    except (ValueError, TypeError, AttributeError):
        raise ValueError('归档批次无效，请重新预览') from None
    with get_db({'database': config}) as conn:
        # 事务内禁止 DDL。归档表由正常部署初始化创建。
        conn.execute('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')
        conn.execute('START TRANSACTION')
        engines = conn.execute('''SELECT TABLE_NAME AS table_name, ENGINE AS engine
            FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()''').fetchall()
        engines = {row['table_name']: row['engine'] for row in engines}
        required = (*SOURCES, 'user_account', 'binding_archive_batches',
                    *(table for table in LEGACY if table in engines))
        if any((engines.get(table) or '').lower() != 'innodb' for table in required):
            raise ValueError('所有绑定表及归档表必须存在且使用 InnoDB，请先完成部署初始化')
        data = snapshot(conn, lock=True)
        return archive_checked(conn, data, _target(config), fingerprint, batch_id)


def archive_checked(conn, data, target, fingerprint, batch_id):
    """在持有源表锁的事务中验证预览；重试已提交批次不触碰新绑定。"""
    previous = conn.execute('SELECT result_json FROM binding_archive_batches WHERE batch_id = ?',
                            (batch_id,)).fetchone()
    if previous:
        result = json.loads(previous['result_json'])
        if not isinstance(result, dict) or type(result.get('account_count')) is not int:
            raise ValueError('这是旧版明细归档批次，未确认精简成功。请完整更新并重启服务，重新预览后使用新批次合并旧归档')
        if len(data['user_account']) < result['account_count']:
            raise ValueError('精简用户表数量少于已完成批次记录，请先核对数据库，不要继续清理')
        return {**result, 'protocol_version': PROTOCOL_VERSION}
    if _fingerprint(data, target) != fingerprint:
        raise ValueError('目标数据库或绑定记录已变化，请重新预览后执行')
    return archive_snapshot(conn, data, batch_id)
