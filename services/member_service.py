"""
会员支付辅助函数
"""
import hashlib
from datetime import datetime
from services.config_service import get_config


def _generate_md5(s):
    hl = hashlib.md5()
    hl.update(s.encode('utf-8'))
    return hl.hexdigest()


def _get_server_url():
    config = get_config()
    return config.get('server_url', 'http://localhost:5000').rstrip('/')



def calculate_invitation_rate(conn, inviter_username):
    """Return the inviter's commission rate using the current membership state."""
    rate = 0.1
    member = conn.execute(
        'SELECT member_type, expire_time FROM memberships WHERE username = ?',
        (inviter_username,)
    ).fetchone()
    if member:
        try:
            expire_dt = datetime.fromisoformat(member['expire_time'])
            if datetime.now() <= expire_dt and member['member_type'] == 'advanced':
                rate = 0.2
        except (TypeError, ValueError):
            pass
    return rate


def ensure_invitation_earnings(conn, inviter_username=None, invitee_username=None, order_no=None):
    """Create missing commission rows from paid orders and invitation bindings.

    The payment callback is the normal place where a commission row is created,
    but callbacks may be retried after an order is already marked paid, and users
    may bind an inviter after a paid order already exists. This reconciliation is
    idempotent and safe to call before reads.
    """
    where = ["o.status = 'paid'"]
    params = []
    if inviter_username:
        where.append('i.inviter_username = ?')
        params.append(inviter_username)
    if invitee_username:
        where.append('i.invitee_username = ?')
        params.append(invitee_username)
    if order_no:
        where.append('o.order_no = ?')
        params.append(order_no)

    sql = """
        SELECT o.order_no, o.username AS invitee_username, o.amount, o.pay_time,
               i.inviter_username
        FROM orders o
        INNER JOIN invitations i ON o.username = i.invitee_username
        WHERE {where_clause}
        ORDER BY o.pay_time ASC, o.create_time ASC
    """.format(where_clause=' AND '.join(where))
    rows = conn.execute(sql, tuple(params)).fetchall()

    created = 0
    for row in rows:
        inviter = row['inviter_username']
        order = row['order_no']
        exists = conn.execute(
            'SELECT id FROM invitation_earnings WHERE username = ? AND order_no = ?',
            (inviter, order)
        ).fetchone()
        if exists:
            continue
        try:
            amount = float(row['amount'] or 0)
        except (TypeError, ValueError):
            amount = 0.0
        if amount <= 0:
            continue
        rate = calculate_invitation_rate(conn, inviter)
        commission = round(amount * rate, 2)
        conn.execute(
            'INSERT OR IGNORE INTO invitation_earnings (username, order_no, invitee_username, amount, rate, create_time) VALUES (?, ?, ?, ?, ?, ?)',
            (inviter, order, row['invitee_username'], str(commission), f'{int(rate * 100)}%', row['pay_time'] or datetime.now().isoformat())
        )
        created += 1
    return created
