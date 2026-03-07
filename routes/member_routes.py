"""
会员系统路由
"""
import uuid
from datetime import datetime, timedelta
from flask import Blueprint, request, jsonify
from database import get_db
from auth import require_bindding
from services.member_service import _generate_md5, _get_server_url
from constants import PAY_API_URL, MERCHANT_NUM, PAY_SECRET_KEY, MEMBER_PRICES, MEMBER_DURATION_DAYS

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
    if pay_type not in ('alipay', 'wxpay'):
        return jsonify({'success': False, 'message': '无效的支付类型'})

    username = user['username']
    device_id = user['device_id']
    amount = MEMBER_PRICES[member_type]
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
            INSERT INTO orders (order_no, device_id, username, member_type, amount, pay_type, status, create_time, notify_url)
            VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        ''', (order_no, device_id, username, member_type, amount, pay_type, datetime.now().isoformat(), notify_url))

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
                return 'success'

            conn.execute(
                "UPDATE orders SET status='paid', pay_time=? WHERE order_no=?",
                (datetime.now().isoformat(), order_no)
            )

            username = order['username']
            member_type = order['member_type']
            existing = conn.execute(
                'SELECT member_type, expire_time FROM memberships WHERE username = ?', (username,)
            ).fetchone()

            new_expire = (datetime.now() + timedelta(days=MEMBER_DURATION_DAYS)).isoformat()
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

        return 'success'

    except Exception:
        return 'fail', 500


@member_bp.route('/api/member/pay_return', methods=['GET', 'POST'])
def member_pay_return():
    return '<script>window.close();window.opener&&window.opener.postMessage("pay_done","*")</script>'


@member_bp.route('/api/member/orders', methods=['GET'])
@require_bindding
def member_orders(user):
    username = user['username']
    with get_db() as conn:
        rows = conn.execute(
            'SELECT order_no, member_type, amount, pay_type, status, create_time, pay_time FROM orders WHERE username=? ORDER BY create_time DESC LIMIT 20',
            (username,)
        ).fetchall()
    return jsonify({'success': True, 'data': [dict(r) for r in rows]})
