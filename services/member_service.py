"""
会员支付与邀请返佣辅助函数。

邀请返佣采用“首次有效付费 + 累计人数阶梯”的规则：
同一个被邀请用户只产生一笔邀请收益，续费订单不会再次返佣。
"""
from collections import defaultdict
from datetime import datetime
from decimal import Decimal, InvalidOperation
import hashlib

from constants import REFERRAL_LEVELS as _CONFIG_REFERRAL_LEVELS
from constants import REFERRAL_MILESTONES as _CONFIG_REFERRAL_MILESTONES
from services.config_service import get_config


# 暴露为服务层变量，便于业务测试和后续运行时配置替换。
REFERRAL_LEVELS = _CONFIG_REFERRAL_LEVELS
REFERRAL_MILESTONES = _CONFIG_REFERRAL_MILESTONES
MONEY_QUANT = Decimal('0.01')


def _generate_md5(s):
    hl = hashlib.md5()
    hl.update(s.encode('utf-8'))
    return hl.hexdigest()


def _get_server_url():
    config = get_config()
    return config.get('server_url', 'http://localhost:5050').rstrip('/')


def _money(value):
    """把数据库金额安全转换为两位小数，避免二进制浮点误差。"""
    try:
        return Decimal(str(value if value is not None else '0')).quantize(MONEY_QUANT)
    except (InvalidOperation, TypeError, ValueError):
        return Decimal('0.00')


def _money_string(value):
    return format(_money(value), 'f')


def _parse_datetime(value):
    if isinstance(value, datetime):
        return value.replace(tzinfo=None)
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        # 当前项目保存的是本地 ISO 时间；对带时区的外部值去掉时区后再比较，
        # 避免同一批历史数据出现 aware/naive 比较异常。
        return parsed.replace(tzinfo=None)
    except (TypeError, ValueError):
        return None


def _row_value(row, key, default=None):
    try:
        value = row[key]
    except (KeyError, IndexError, TypeError):
        return default
    return default if value is None else value


def _level_items():
    levels = []
    for item in REFERRAL_LEVELS or []:
        try:
            min_count = int(item.get('min_count', 0))
        except (TypeError, ValueError):
            continue
        levels.append({
            'min_count': min_count,
            'reward': _money_string(item.get('reward', '0')),
        })
    levels.sort(key=lambda level: level['min_count'])
    return levels or [{'min_count': 0, 'reward': '0.00'}]


def get_referral_level_for_count(effective_invite_count):
    """返回指定有效邀请人数对应的返佣档位。"""
    try:
        count = max(int(effective_invite_count), 0)
    except (TypeError, ValueError):
        count = 0

    levels = _level_items()
    current = levels[0]
    for level in levels:
        if level['min_count'] <= count:
            current = level
        else:
            break
    return dict(current)


def _sort_paid_row(row):
    paid_at = _row_value(row, 'paid_at')
    parsed = _parse_datetime(paid_at) or datetime.max
    return (
        parsed,
        str(paid_at or ''),
        str(_row_value(row, 'create_time', '') or ''),
        str(_row_value(row, 'order_no', '') or ''),
    )


def _fetch_first_paid_rows(conn, inviter_username=None):
    """读取每个邀请关系中最早的一笔有效已支付订单。"""
    where = ["o.status = 'paid'"]
    params = []
    if inviter_username:
        where.append('i.inviter_username = ?')
        params.append(inviter_username)

    rows = conn.execute(
        """
        SELECT i.inviter_username, i.invitee_username, o.order_no, o.amount,
               o.create_time, o.pay_time,
               COALESCE(o.pay_time, o.create_time) AS paid_at
        FROM invitations i
        INNER JOIN orders o ON o.username = i.invitee_username
        WHERE {where_clause}
        ORDER BY COALESCE(o.pay_time, o.create_time) ASC,
                 o.create_time ASC, o.order_no ASC
        """.format(where_clause=' AND '.join(where)),
        tuple(params),
    ).fetchall()

    first_rows = {}
    for row in rows:
        amount = _money(_row_value(row, 'amount'))
        if amount <= 0:
            continue
        key = (
            _row_value(row, 'inviter_username'),
            _row_value(row, 'invitee_username'),
        )
        if key not in first_rows:
            first_rows[key] = row

    result = list(first_rows.values())
    result.sort(key=_sort_paid_row)
    return result


def _group_paid_rows(rows):
    grouped = defaultdict(list)
    for row in rows:
        grouped[_row_value(row, 'inviter_username')].append(row)
    for inviter_rows in grouped.values():
        inviter_rows.sort(key=_sort_paid_row)
    return grouped


def _resolve_scope_inviters(conn, invitee_username=None, order_no=None):
    if invitee_username:
        rows = conn.execute(
            'SELECT DISTINCT inviter_username FROM invitations WHERE invitee_username = ?',
            (invitee_username,),
        ).fetchall()
        return [_row_value(row, 'inviter_username') for row in rows if _row_value(row, 'inviter_username')]
    if order_no:
        rows = conn.execute(
            """
            SELECT DISTINCT i.inviter_username
            FROM invitations i
            INNER JOIN orders o ON o.username = i.invitee_username
            WHERE o.order_no = ?
            """,
            (order_no,),
        ).fetchall()
        return [_row_value(row, 'inviter_username') for row in rows if _row_value(row, 'inviter_username')]
    return []


def _insert_was_created(result):
    rowcount = getattr(result, 'rowcount', None)
    return rowcount is None or rowcount > 0


def ensure_invitation_milestone_rewards(conn, inviter_username=None):
    """按活动配置补发已达成的里程碑奖励，且每人每任务只发一次。"""
    if inviter_username:
        grouped = _group_paid_rows(_fetch_first_paid_rows(conn, inviter_username))
    else:
        grouped = _group_paid_rows(_fetch_first_paid_rows(conn))

    if inviter_username:
        reward_rows = conn.execute(
            'SELECT milestone_id FROM invitation_milestone_rewards WHERE username = ?',
            (inviter_username,),
        ).fetchall()
        rewarded = {
            (inviter_username, _row_value(row, 'milestone_id'))
            for row in reward_rows
        }
    else:
        reward_rows = conn.execute(
            'SELECT username, milestone_id FROM invitation_milestone_rewards'
        ).fetchall()
        rewarded = {
            (_row_value(row, 'username'), _row_value(row, 'milestone_id'))
            for row in reward_rows
        }

    created = 0
    now = datetime.now().isoformat()
    for milestone in REFERRAL_MILESTONES or []:
        milestone_id = str(milestone.get('id') or '').strip()
        if not milestone_id:
            continue
        start_at = _parse_datetime(milestone.get('start_at'))
        end_at = _parse_datetime(milestone.get('end_at'))
        try:
            target_count = max(int(milestone.get('target_count', 0)), 0)
        except (TypeError, ValueError):
            target_count = 0
        if not start_at or not end_at or target_count <= 0:
            continue

        for inviter, rows in grouped.items():
            if not inviter:
                continue
            count = 0
            for row in rows:
                paid_at = _parse_datetime(_row_value(row, 'paid_at'))
                if paid_at and start_at <= paid_at <= end_at:
                    count += 1
            if count < target_count:
                continue

            if (inviter, milestone_id) in rewarded:
                continue

            result = conn.execute(
                """
                INSERT OR IGNORE INTO invitation_milestone_rewards
                    (username, milestone_id, amount, create_time)
                VALUES (?, ?, ?, ?)
                """,
                (inviter, milestone_id, _money_string(milestone.get('bonus', '0')), now),
            )
            if _insert_was_created(result):
                created += 1
                rewarded.add((inviter, milestone_id))
    return created


def ensure_invitation_earnings(conn, inviter_username=None, invitee_username=None, order_no=None):
    """补齐首次有效付费返佣并同步限时任务，重复调用安全幂等。"""
    scope_inviters = []
    if inviter_username:
        scope_inviters = [inviter_username]
    else:
        scope_inviters = _resolve_scope_inviters(conn, invitee_username, order_no)

    if len(scope_inviters) == 1:
        rows = _fetch_first_paid_rows(conn, scope_inviters[0])
    else:
        rows = _fetch_first_paid_rows(conn)
    grouped = _group_paid_rows(rows)

    if inviter_username:
        earning_rows = conn.execute(
            'SELECT invitee_username FROM invitation_earnings WHERE username = ?',
            (inviter_username,),
        ).fetchall()
        existing_earnings = {
            (inviter_username, _row_value(row, 'invitee_username'))
            for row in earning_rows
        }
    else:
        earning_rows = conn.execute(
            'SELECT username, invitee_username FROM invitation_earnings'
        ).fetchall()
        existing_earnings = {
            (_row_value(row, 'username'), _row_value(row, 'invitee_username'))
            for row in earning_rows
        }

    if inviter_username:
        claim_rows = conn.execute(
            'SELECT invitee_username FROM invitation_reward_claims WHERE username = ?',
            (inviter_username,),
        ).fetchall()
        reward_claims = {
            (inviter_username, _row_value(row, 'invitee_username'))
            for row in claim_rows
        }
    else:
        claim_rows = conn.execute(
            'SELECT username, invitee_username FROM invitation_reward_claims'
        ).fetchall()
        reward_claims = {
            (_row_value(row, 'username'), _row_value(row, 'invitee_username'))
            for row in claim_rows
        }

    created = 0
    for inviter, inviter_rows in grouped.items():
        if not inviter:
            continue
        for effective_count, row in enumerate(inviter_rows, start=1):
            row_invitee = _row_value(row, 'invitee_username')
            row_order = _row_value(row, 'order_no')
            if inviter_username and inviter != inviter_username:
                continue
            if invitee_username and row_invitee != invitee_username:
                continue
            if order_no and row_order != order_no:
                continue

            # 一个被邀请用户只有第一笔有效付费产生收益；保留历史数据，
            # 但不再为同一用户的续费订单创建新收益。
            earning_key = (inviter, row_invitee)
            if earning_key in existing_earnings or earning_key in reward_claims:
                continue

            level = get_referral_level_for_count(effective_count)
            claim_result = conn.execute(
                """
                INSERT OR IGNORE INTO invitation_reward_claims
                    (username, invitee_username, order_no, amount, rate, create_time)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    inviter,
                    row_invitee,
                    row_order,
                    level['reward'],
                    f"{level['reward']}元",
                    _row_value(row, 'paid_at') or datetime.now().isoformat(),
                ),
            )
            if not _insert_was_created(claim_result):
                reward_claims.add(earning_key)
                continue
            reward_claims.add(earning_key)

            result = conn.execute(
                """
                INSERT OR IGNORE INTO invitation_earnings
                    (username, order_no, invitee_username, amount, rate, create_time)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    inviter,
                    row_order,
                    row_invitee,
                    level['reward'],
                    f"{level['reward']}元",
                    _row_value(row, 'paid_at') or datetime.now().isoformat(),
                ),
            )
            if _insert_was_created(result):
                created += 1
                existing_earnings.add(earning_key)
            else:
                # 只有在收益表已经被并发请求写入时才会走到这里；保留 claim
                # 可以继续保证同一被邀请用户不会再次领取。
                existing_earnings.add(earning_key)

    # 里程碑奖励独立记账，不混入邀请订单明细，便于管理员审计。
    if inviter_username:
        ensure_invitation_milestone_rewards(conn, inviter_username=inviter_username)
    elif scope_inviters:
        for inviter in scope_inviters:
            ensure_invitation_milestone_rewards(conn, inviter_username=inviter)
    else:
        ensure_invitation_milestone_rewards(conn)
    return created


def get_referral_progress(conn, inviter_username):
    """返回邀请人数、当前档位及下一档位信息。"""
    rows = _fetch_first_paid_rows(conn, inviter_username)
    effective_count = len(rows)
    current = get_referral_level_for_count(effective_count)
    levels = _level_items()
    next_level = next((level for level in levels if level['min_count'] > effective_count), None)
    return {
        'effective_invite_count': effective_count,
        'current_reward': current['reward'],
        'next_level_count': next_level['min_count'] if next_level else None,
        'next_reward': next_level['reward'] if next_level else None,
        'levels': levels,
    }


def get_referral_milestone_status(conn, username, now=None):
    """返回用户的限时任务进度；奖励记录存在即表示已发放。"""
    rows = _fetch_first_paid_rows(conn, username)
    rewarded_rows = conn.execute(
        'SELECT milestone_id FROM invitation_milestone_rewards WHERE username = ?',
        (username,),
    ).fetchall()
    rewarded_ids = {_row_value(row, 'milestone_id') for row in rewarded_rows}
    current_time = _parse_datetime(now) or datetime.now()

    result = []
    for milestone in REFERRAL_MILESTONES or []:
        milestone_id = str(milestone.get('id') or '').strip()
        start_at = _parse_datetime(milestone.get('start_at'))
        end_at = _parse_datetime(milestone.get('end_at'))
        try:
            target_count = max(int(milestone.get('target_count', 0)), 0)
        except (TypeError, ValueError):
            target_count = 0
        count = 0
        for row in rows:
            paid_at = _parse_datetime(_row_value(row, 'paid_at'))
            if paid_at and start_at and end_at and start_at <= paid_at <= end_at:
                count += 1
        completed = target_count > 0 and count >= target_count
        result.append({
            'id': milestone_id,
            'label': milestone.get('label') or milestone_id,
            'start_at': milestone.get('start_at'),
            'end_at': milestone.get('end_at'),
            'target_count': target_count,
            'bonus': _money_string(milestone.get('bonus', '0')),
            'count': count,
            'remaining': max(target_count - count, 0),
            'completed': completed,
            'rewarded': milestone_id in rewarded_ids,
            'is_active': bool(start_at and end_at and start_at <= current_time <= end_at),
        })
    return result


def get_invitation_earning_total(conn, username):
    """汇总订单返佣和里程碑奖励，供用户端、提现和管理员共用。"""
    rows = conn.execute(
        'SELECT amount FROM invitation_earnings WHERE username = ?',
        (username,),
    ).fetchall()
    milestone_rows = conn.execute(
        'SELECT amount FROM invitation_milestone_rewards WHERE username = ?',
        (username,),
    ).fetchall()
    order_total = sum((_money(_row_value(row, 'amount')) for row in rows), Decimal('0.00'))
    milestone_total = sum((_money(_row_value(row, 'amount')) for row in milestone_rows), Decimal('0.00'))
    return order_total + milestone_total


def calculate_invitation_rate(conn, inviter_username):
    """兼容旧调用方：返回当前每位有效邀请的奖励数值，不再读取会员等级百分比。"""
    progress = get_referral_progress(conn, inviter_username)
    return float(_money(progress['current_reward']))
