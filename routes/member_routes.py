"""
会员系统路由
"""
import os
import traceback
import uuid
from datetime import datetime, timedelta
from flask import Blueprint, request, jsonify
from database import get_db
from auth import require_bindding, require_member
from services.member_service import _generate_md5, _get_server_url, calculate_invitation_rate, ensure_invitation_earnings
from constants import PAY_API_URL, MERCHANT_NUM, PAY_SECRET_KEY, MEMBER_PRICES, MEMBER_DURATION_DAYS, DATA_DIR

member_bp = Blueprint('member', __name__)


@member_bp.route('/api/member/status', methods=['GET'])
@require_bindding
def member_status(user):
    username = user['username']
    with get_db() as conn:
        row = conn.execute(
            'SELECT member_type, expire_time, create_time FROM memberships WHERE username = ?',
            (username,)
        ).fetchone()
    if not row:
        return jsonify({'success': True, 'data': {'is_member': False, 'member_type': None, 'expire_time': None}})
    expire_dt = datetime.fromisoformat(row['expire_time'])
    is_expired = datetime.now() > expire_dt
    return jsonify({
        'success': True,
        'data': {
            'is_member': not is_expired,
            'member_type': row['member_type'] if not is_expired else None,
            'expire_time': row['expire_time'],
            'is_expired': is_expired
        }
    })


@member_bp.route('/api/member/create_order', methods=['POST'])
@require_bindding
def member_create_order(user):
    data = request.get_json() or {}
    member_type = data.get('member_type')
    pay_type = data.get('pay_type', 'alipay')

    if member_type not in MEMBER_PRICES:
        return jsonify({'success': False, 'message': '无效的会员类型'})
    if pay_type not in ('alipay', 'wechat'):
        return jsonify({'success': False, 'message': '无效的支付类型'})

    username = user['username']
    device_id = user['device_id']
    amount = MEMBER_PRICES[member_type]
    now = datetime.now()

    # 检查 5 分钟内是否有未支付的订单
    with get_db() as conn:
        recent = conn.execute(
            "SELECT order_no, pay_url, create_time FROM orders WHERE username=? AND status='pending' AND member_type=? ORDER BY create_time DESC LIMIT 1",
            (username, member_type)
        ).fetchone()

    if recent and recent['pay_url']:
        create_dt = datetime.fromisoformat(recent['create_time'])
        if (now - create_dt).total_seconds() < 300:
            return jsonify({'success': True, 'data': {'order_no': recent['order_no'], 'pay_url': recent['pay_url'], 'existing': True}})
        else:
            # 超时订单标记为失败
            with get_db() as conn:
                conn.execute("UPDATE orders SET status='failed' WHERE order_no=?", (recent['order_no'],))

    order_no = uuid.uuid4().hex[:20]
    server_url = _get_server_url()
    notify_url = f"{server_url}/api/member/pay_notify"
    return_url = f"{server_url}/?page=member"

    sign_str = MERCHANT_NUM + order_no + amount + notify_url + PAY_SECRET_KEY
    sign = _generate_md5(sign_str)

    order_data = {
        'merchantNum': MERCHANT_NUM,
        'orderNo': order_no,
        'amount': amount,
        'notifyUrl': notify_url,
        'returnUrl': return_url,
        'payType': pay_type,
        'sign': sign
    }

    try:
        import requests as req_lib
        res = req_lib.post(PAY_API_URL, data=order_data, timeout=10)
        if not res.text.startswith('{'):
            return jsonify({'success': False, 'message': f'支付接口异常: {res.text[:100]}'})
        pay_result = res.json()
        if not pay_result.get('success') or not pay_result.get('data', {}).get('payUrl'):
            return jsonify({'success': False, 'message': pay_result.get('msg', '获取支付链接失败')})
        pay_url = pay_result['data']['payUrl']
    except Exception as e:
        return jsonify({'success': False, 'message': f'支付请求失败: {str(e)}'})

    with get_db() as conn:
        conn.execute('''
            INSERT INTO orders (order_no, device_id, username, member_type, amount, pay_type, status, create_time, notify_url, pay_url)
            VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
        ''', (order_no, device_id, username, member_type, amount, pay_type, now.isoformat(), notify_url, pay_url))

    return jsonify({'success': True, 'data': {'order_no': order_no, 'pay_url': pay_url}})


@member_bp.route('/api/member/pay_notify', methods=['GET', 'POST'])
def member_pay_notify():
    params = request.args if request.method == 'GET' else request.form

    try:
        order_no = params.get('orderNo', '')
        amount = params.get('amount', '')
        sign_received = params.get('sign', '')

        with get_db() as conn:
            order = conn.execute(
                'SELECT * FROM orders WHERE order_no = ?', (order_no,)
            ).fetchone()

        if not order:
            return 'fail', 400

        state = params.get('state', '')
        sign_expected = _generate_md5(state + MERCHANT_NUM + order_no + amount + PAY_SECRET_KEY)
        if sign_received != sign_expected:
            return 'fail', 400

        with get_db() as conn:
            order = conn.execute(
                'SELECT * FROM orders WHERE order_no = ?', (order_no,)
            ).fetchone()
            if not order:
                return 'fail', 400
            if order['status'] == 'paid':
                ensure_invitation_earnings(conn, order_no=order_no)
                return 'success'

            paid_at = datetime.now()
            conn.execute(
                "UPDATE orders SET status='paid', pay_time=? WHERE order_no=?",
                (paid_at.isoformat(), order_no)
            )

            username = order['username']
            member_type = order['member_type']
            existing = conn.execute(
                'SELECT member_type, expire_time FROM memberships WHERE username = ?', (username,)
            ).fetchone()

            expire_base = paid_at
            if existing:
                try:
                    existing_expire = datetime.fromisoformat(existing['expire_time'])
                    if existing_expire > paid_at:
                        expire_base = existing_expire
                except (TypeError, ValueError):
                    pass
            new_expire = (expire_base + timedelta(days=MEMBER_DURATION_DAYS)).isoformat()
            if existing:
                final_type = 'advanced' if (member_type == 'advanced' or existing['member_type'] == 'advanced') else 'basic'
                if member_type == 'advanced':
                    final_type = 'advanced'
                conn.execute(
                    'UPDATE memberships SET member_type=?, expire_time=? WHERE username=?',
                    (final_type, new_expire, username)
                )
            else:
                conn.execute(
                    'INSERT INTO memberships (username, member_type, expire_time, create_time) VALUES (?, ?, ?, ?)',
                    (username, member_type, new_expire, datetime.now().isoformat())
                )

            # Reconcile commission rows idempotently for this paid order.
            ensure_invitation_earnings(conn, order_no=order_no)


        return 'success'

    except Exception:
        with open(os.path.join(DATA_DIR, 'pay_notify_errors.log'), 'a', encoding='utf-8') as f:
            f.write(f'[{datetime.now().isoformat()}] {traceback.format_exc()}\n')
        return 'fail', 500


@member_bp.route('/api/member/pay_return', methods=['GET', 'POST'])
def member_pay_return():
    return '<script>window.close();window.opener&&window.opener.postMessage("pay_done","*")</script>'


@member_bp.route('/api/invitation/my_inviter', methods=['GET'])
@require_bindding
def my_inviter(user):
    username = user['username']
    with get_db() as conn:
        row = conn.execute(
            'SELECT inviter_username FROM invitations WHERE invitee_username = ?',
            (username,)
        ).fetchone()
    if row:
        return jsonify({'success': True, 'data': {'inviter': row['inviter_username']}})
    return jsonify({'success': True, 'data': {'inviter': None}})


@member_bp.route('/api/invitation/set', methods=['POST'])
@require_bindding
def set_inviter(user):
    username = user['username']
    inviter = (request.get_json() or {}).get('inviter', '').strip()
    if not inviter:
        return jsonify({'success': False, 'message': '请填写邀请人学号'})
    if inviter == username:
        return jsonify({'success': False, 'message': '不能邀请自己'})

    with get_db() as conn:
        already = conn.execute(
            'SELECT id FROM invitations WHERE invitee_username = ?', (username,)
        ).fetchone()
        if already:
            return jsonify({'success': False, 'message': '你已绑定过邀请人，无法修改'})

        inviter_exists = conn.execute(
            'SELECT username FROM users WHERE username = ?', (inviter,)
        ).fetchone()
        if not inviter_exists:
            return jsonify({'success': False, 'message': '邀请人学号不存在'})

        conn.execute(
            'INSERT INTO invitations (inviter_username, invitee_username, create_time) VALUES (?, ?, ?)',
            (inviter, username, datetime.now().isoformat())
        )
        ensure_invitation_earnings(conn, inviter_username=inviter, invitee_username=username)

    return jsonify({'success': True, 'message': f'已绑定邀请人：{inviter}'})


@member_bp.route('/api/invitation/earnings', methods=['GET'])
@require_bindding
def invitation_earnings(user):
    username = user['username']
    with get_db() as conn:
        ensure_invitation_earnings(conn, inviter_username=username)
        # 被邀请人充值总额
        total_spending = conn.execute('''
            SELECT SUM(o.amount + 0) as total
            FROM orders o
            INNER JOIN invitations i ON o.username = i.invitee_username
            WHERE i.inviter_username = ? AND o.status = 'paid'
        ''', (username,)).fetchone()
        invitee_total = total_spending['total'] or 0

        # 当前会员等级对应的分佣比例
        rate = calculate_invitation_rate(conn, username)

        # 已产生的收益明细
        rows = conn.execute(
            'SELECT amount, invitee_username, create_time FROM invitation_earnings WHERE username = ? ORDER BY create_time DESC',
            (username,)
        ).fetchall()
        total_earned = conn.execute(
            'SELECT SUM(amount + 0) as total FROM invitation_earnings WHERE username = ?',
            (username,)
        ).fetchone()
        earned = total_earned['total'] or 0

        # 已提现
        withdrawn_row = conn.execute(
            "SELECT SUM(amount + 0) as total FROM withdrawals WHERE username = ? AND status != 'rejected'",
            (username,)
        ).fetchone()
        withdrawn = withdrawn_row['total'] or 0

        # 可提现 = 已产生收益 - 已提现
        available = max(earned - withdrawn, 0)

    earnings = [{
        'amount': r['amount'],
        'invitee_username': r['invitee_username'],
        'create_time': r['create_time']
    } for r in rows]
    return jsonify({
        'success': True,
        'data': {
            'invitee_total': str(invitee_total),
            'rate': f'{int(rate * 100)}%',
            'earned': str(earned),
            'withdrawn': str(withdrawn),
            'available': str(available),
            'earnings': earnings
        }
    })


@member_bp.route('/api/invitation/withdraw', methods=['POST'])
@require_member('basic')
def invitation_withdraw(user):
    username = user['username']
    data = request.get_json() or {}
    real_name = (data.get('real_name') or '').strip()
    alipay_account = (data.get('alipay_account') or '').strip()

    if not real_name or not alipay_account:
        return jsonify({'success': False, 'message': '请填写姓名和支付宝账号'})

    # 查询可提现金额
    with get_db() as conn:
        ensure_invitation_earnings(conn, inviter_username=username)
        total_earned = conn.execute(
            'SELECT SUM(amount + 0) as total FROM invitation_earnings WHERE username = ?',
            (username,)
        ).fetchone()
        total_earned = total_earned['total'] or 0

        withdrawn_row = conn.execute(
            "SELECT SUM(amount + 0) as total FROM withdrawals WHERE username = ? AND status != 'rejected'",
            (username,)
        ).fetchone()
        total_withdrawn = withdrawn_row['total'] or 0

    available = max(total_earned - total_withdrawn, 0)
    if available <= 0:
        return jsonify({'success': False, 'message': '暂无可提现金额'})

    # 检查是否有待审核的提现
    with get_db() as conn:
        pending = conn.execute(
            "SELECT id FROM withdrawals WHERE username = ? AND status = 'pending'",
            (username,)
        ).fetchone()
    if pending:
        return jsonify({'success': False, 'message': '你有一笔提现正在审核中，请等待审核完成'})

    with get_db() as conn:
        conn.execute(
            'INSERT INTO withdrawals (username, real_name, alipay_account, amount, status, create_time) VALUES (?, ?, ?, ?, ?, ?)',
            (username, real_name, alipay_account, str(round(available, 2)), 'pending', datetime.now().isoformat())
        )

    return jsonify({'success': True, 'message': f'提现申请已提交，金额 ¥{available:.2f}，请等待管理员审核'})


@member_bp.route('/api/invitation/withdrawals', methods=['GET'])
@require_bindding
def invitation_withdrawals(user):
    username = user['username']
    with get_db() as conn:
        rows = conn.execute(
            'SELECT amount, status, create_time, review_time FROM withdrawals WHERE username = ? ORDER BY create_time DESC',
            (username,)
        ).fetchall()
    records = [{
        'amount': r['amount'],
        'status': r['status'],
        'create_time': r['create_time'],
        'review_time': r['review_time']
    } for r in rows]
    return jsonify({'success': True, 'data': records})


@member_bp.route('/api/member/orders', methods=['GET'])
@require_bindding
def member_orders(user):
    username = user['username']
    now = datetime.now()
    with get_db() as conn:
        rows = conn.execute(
            'SELECT order_no, member_type, amount, pay_type, status, create_time, pay_time, pay_url FROM orders WHERE username=? ORDER BY create_time DESC LIMIT 20',
            (username,)
        ).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        if d['status'] == 'pending' and d['pay_url']:
            create_dt = datetime.fromisoformat(d['create_time'])
            if (now - create_dt).total_seconds() < 300:
                d['active_pay_url'] = d['pay_url']
                d['expire_seconds'] = 300 - int((now - create_dt).total_seconds())
        result.append(d)
    return jsonify({'success': True, 'data': result})
