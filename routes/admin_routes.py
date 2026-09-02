"""
管理员功能路由
"""
from collections import defaultdict
from datetime import datetime, timedelta
from flask import Blueprint, request, jsonify, render_template
from database import get_db, get_database_config, test_database_config, migrate_sqlite_to_current_database
from auth import require_admin
from services.config_service import get_config, save_config
from services.user_service import unbind_user
from services.member_service import ensure_invitation_earnings, _money, _money_string
from constants import MEMBER_DURATION_DAYS

admin_bp = Blueprint('admin_bp', __name__)


def _new_commission_stat(username):
    return {
        'username': username,
        'earned': _money('0'),
        'withdrawn': _money('0'),
        'pending_withdraw': _money('0'),
        'invitee_paid_amount': _money('0'),
        'invitees': set(),
        'commission_count': 0,
        'milestone_count': 0,
        'last_earning_time': None,
    }


@admin_bp.route('/admin')
def admin():
    return render_template('admin.html')



@admin_bp.route('/api/admin/invitation_debug', methods=['GET'])
@require_admin
def admin_invitation_debug():
    invitee = (request.args.get('invitee') or '').strip()
    inviter = (request.args.get('inviter') or '').strip()
    if not invitee and not inviter:
        return jsonify({'success': False, 'message': '??? invitee ? inviter ??'})

    try:
        db_config = get_database_config()
        with get_db() as conn:
            created = ensure_invitation_earnings(
                conn,
                inviter_username=inviter or None,
                invitee_username=invitee or None
            )
            invitation_params = []
            invitation_filters = []
            if invitee:
                invitation_filters.append('invitee_username = ?')
                invitation_params.append(invitee)
            if inviter:
                invitation_filters.append('inviter_username = ?')
                invitation_params.append(inviter)
            invitation_where = ' OR '.join(invitation_filters) or '1=1'
            invitations = conn.execute(
                f'SELECT inviter_username, invitee_username, create_time FROM invitations WHERE {invitation_where} ORDER BY create_time DESC',
                tuple(invitation_params)
            ).fetchall()

            order_params = []
            order_where = '1=0'
            if invitee:
                order_where = 'username = ?'
                order_params.append(invitee)
            orders = conn.execute(
                f'SELECT order_no, username, member_type, amount, status, create_time, pay_time FROM orders WHERE {order_where} ORDER BY create_time DESC LIMIT 20',
                tuple(order_params)
            ).fetchall()

            earning_params = []
            earning_filters = []
            if inviter:
                earning_filters.append('username = ?')
                earning_params.append(inviter)
            if invitee:
                earning_filters.append('invitee_username = ?')
                earning_params.append(invitee)
            earning_where = ' OR '.join(earning_filters) or '1=1'
            earnings = conn.execute(
                f'SELECT username, order_no, invitee_username, amount, rate, create_time FROM invitation_earnings WHERE {earning_where} ORDER BY create_time DESC',
                tuple(earning_params)
            ).fetchall()

            matched_paid_orders = conn.execute('''
                SELECT o.order_no, o.username AS invitee_username, o.amount, o.status,
                       i.inviter_username
                FROM orders o
                LEFT JOIN invitations i ON o.username = i.invitee_username
                WHERE (? = '' OR o.username = ?) AND (? = '' OR i.inviter_username = ?)
                ORDER BY o.create_time DESC
                LIMIT 20
            ''', (invitee, invitee, inviter, inviter)).fetchall()

        return jsonify({
            'success': True,
            'data': {
                'database_type': db_config.get('type'),
                'input': {'invitee': invitee, 'inviter': inviter},
                'created_missing_earnings': created,
                'invitations': [dict(r) for r in invitations],
                'orders': [dict(r) for r in orders],
                'matched_orders_with_inviter': [dict(r) for r in matched_paid_orders],
                'earnings': [dict(r) for r in earnings],
            }
        })
    except Exception as e:
        return jsonify({'success': False, 'message': f'????????: {str(e)}'})


@admin_bp.route('/api/admin/pending_requests', methods=['GET'])
@require_admin
def admin_pending_requests():
    with get_db() as conn:
        rows = conn.execute('''
            SELECT * FROM pending_requests
            WHERE status = 'pending'
            ORDER BY request_time DESC
        ''').fetchall()

        pending_list = []
        for row in rows:
            pending_list.append({
                'id': row['request_id'],
                'device_id': row['device_id'],
                'old_username': row['old_username'],
                'new_username': row['new_username'],
                'reason': row['reason'],
                'time': row['request_time'],
                'status': row['status']
            })

    return jsonify({'success': True, 'requests': pending_list})


@admin_bp.route('/api/admin/approve_rebind', methods=['POST'])
@require_admin
def admin_approve_rebind():
    data = request.get_json()
    request_id = data.get('request_id')
    approved = data.get('approved', False)

    with get_db() as conn:
        row = conn.execute(
            'SELECT * FROM pending_requests WHERE request_id = ?',
            (request_id,)
        ).fetchone()

        if not row:
            return jsonify({'success': False, 'message': '请求不存在'})

        if approved:
            unbind_user(row['device_id'])
            conn.execute(
                'UPDATE pending_requests SET status = ? WHERE request_id = ?',
                ('approved', request_id)
            )
            message = '换绑请求已批准，用户需要重新登录绑定新账号'
        else:
            conn.execute(
                'UPDATE pending_requests SET status = ? WHERE request_id = ?',
                ('rejected', request_id)
            )
            message = '换绑请求已拒绝'

    return jsonify({'success': True, 'message': message})


@admin_bp.route('/api/admin/users', methods=['GET'])
@require_admin
def admin_users():
    try:
        with get_db() as conn:
            rows = conn.execute('''
                SELECT username, MIN(bind_time) as first_bind_time
                FROM users
                GROUP BY username
            ''').fetchall()

        total = len(rows)
        daily_counts = defaultdict(int)
        classes = defaultdict(int)

        for row in rows:
            username = row['username']
            first_bind_time = row['first_bind_time'] or ''
            day = str(first_bind_time)[:10] if first_bind_time else ''
            if day:
                daily_counts[day] += 1

            if username and len(username) >= 7:
                classes[username[:7]] += 1
            else:
                classes['其他'] += 1

        daily = []
        cumulative = 0
        for day in sorted(daily_counts):
            count = daily_counts[day]
            cumulative += count
            daily.append({'date': day, 'count': count, 'total': cumulative})

        class_list = [{'class_id': k, 'count': v} for k, v in sorted(classes.items())]

        return jsonify({'success': True, 'total': total, 'classes': class_list, 'daily': daily})
    except Exception as e:
        return jsonify({'success': False, 'message': f'用户统计加载失败: {str(e)}'})

@admin_bp.route('/api/admin/config', methods=['GET'])
@require_admin
def admin_get_config():
    config = get_config()
    return jsonify({'success': True, 'config': config})
@admin_bp.route('/api/admin/config/database', methods=['POST'])
@require_admin
def admin_set_database_config():
    data = request.get_json() or {}
    db_type = (data.get('type') or 'sqlite').lower()
    if db_type not in ('sqlite', 'mysql'):
        return jsonify({'success': False, 'message': '数据库类型只支持 SQLite 或 MySQL/MariaDB'})

    config = get_config()
    existing_db = config.get('database') or {}
    existing_mysql = existing_db.get('mysql') or {}

    if db_type == 'sqlite':
        sqlite_path = (data.get('sqlite_path') or 'data/urp_helper.db').strip()
        database_config = {
            'type': 'sqlite',
            'sqlite_path': sqlite_path,
            'mysql': existing_mysql,
        }
    else:
        mysql = data.get('mysql') or {}
        password = mysql.get('password')
        if password in (None, '') and existing_db.get('type') == 'mysql':
            password = existing_mysql.get('password', '')
        database_config = {
            'type': 'mysql',
            'sqlite_path': existing_db.get('sqlite_path', 'data/urp_helper.db'),
            'mysql': {
                'host': (mysql.get('host') or '').strip(),
                'port': int(mysql.get('port') or 3306),
                'database': (mysql.get('database') or '').strip(),
                'user': (mysql.get('user') or '').strip(),
                'password': password or '',
            }
        }

    ok, message = test_database_config(database_config)
    if not ok:
        return jsonify({'success': False, 'message': f'数据库连接失败: {message}'})

    config['database'] = database_config
    save_config(config)
    return jsonify({'success': True, 'message': message, 'config': config})
@admin_bp.route('/api/admin/config/database/migrate_sqlite', methods=['POST'])
@require_admin
def admin_migrate_sqlite_to_database():
    data = request.get_json() or {}
    sqlite_path = (data.get('sqlite_path') or '').strip() or None
    ok, message, result = migrate_sqlite_to_current_database(sqlite_path)
    return jsonify({'success': ok, 'message': message, 'data': result})

@admin_bp.route('/api/admin/config/grades_member', methods=['POST'])
@require_admin
def admin_set_grades_member_required():
    data = request.get_json() or {}
    require_member = bool(data.get('grades_require_member', True))
    config = get_config()
    config['grades_require_member'] = require_member
    save_config(config)
    message = '查成绩已设置为需要会员' if require_member else '查成绩已设置为无需会员'
    return jsonify({'success': True, 'message': message, 'config': config})

@admin_bp.route('/api/admin/config/url', methods=['POST'])
@require_admin
def admin_switch_url():
    data = request.get_json()
    config = get_config()

    if 'urls' in data:
        urls = data['urls']
        if isinstance(urls, list) and len(urls) >= 2:
            config['urp_urls'] = urls
            save_config(config)
            return jsonify({'success': True, 'message': 'URL列表已更新', 'config': config})
        else:
            return jsonify({'success': False, 'message': 'URL列表格式错误，需要至少2个URL'})

    if 'url_index' in data:
        url_index = data['url_index']
        urls = config.get('urp_urls', [])
        if 0 <= url_index < len(urls):
            config['current_url_index'] = url_index
            save_config(config)
            return jsonify({'success': True, 'message': f'已切换到URL: {urls[url_index]}', 'config': config})
        else:
            return jsonify({'success': False, 'message': 'URL索引超出范围'})

    return jsonify({'success': False, 'message': '缺少必要参数'})


@admin_bp.route('/api/admin/semester', methods=['POST'])
@require_admin
def admin_set_semester_start():
    data = request.get_json()
    date_str = data.get('semester_start', '').strip()
    if not date_str:
        return jsonify({'success': False, 'message': '请提供日期'})
    try:
        parsed = datetime.strptime(date_str, '%Y-%m-%d')
        if parsed.weekday() != 0:
            return jsonify({'success': False, 'message': '日期必须是星期一'})
    except ValueError:
        return jsonify({'success': False, 'message': '日期格式错误，应为 YYYY-MM-DD'})
    config = get_config()
    config['semester_start'] = date_str
    save_config(config)
    return jsonify({'success': True, 'message': f'学期起始日期已设置为: {date_str}'})


@admin_bp.route('/api/admin/members', methods=['GET'])
@require_admin
def admin_members():
    username = (request.args.get('username') or '').strip()
    if not username:
        return jsonify({'success': True, 'data': None, 'message': '???????????'})

    with get_db() as conn:
        user = conn.execute(
            'SELECT username, bind_time FROM users WHERE username = ? LIMIT 1',
            (username,)
        ).fetchone()
        member = conn.execute(
            'SELECT username, member_type, expire_time, create_time FROM memberships WHERE username = ?',
            (username,)
        ).fetchone()
        paid_orders = conn.execute(
            "SELECT order_no, member_type, amount, status, create_time, pay_time FROM orders WHERE username = ? ORDER BY create_time DESC LIMIT 5",
            (username,)
        ).fetchall()

    data = {
        'username': username,
        'user_exists': bool(user),
        'bind_time': user['bind_time'] if user else None,
        'membership': dict(member) if member else None,
        'recent_orders': [dict(r) for r in paid_orders]
    }
    return jsonify({'success': True, 'data': data})


@admin_bp.route('/api/admin/members/grant', methods=['POST'])
@require_admin
def admin_members_grant():
    data = request.get_json() or {}
    username = data.get('username', '').strip()
    member_type = data.get('member_type', 'basic')
    days = int(data.get('days', MEMBER_DURATION_DAYS))

    if not username:
        return jsonify({'success': False, 'message': '请提供学号'})
    if member_type not in ('basic', 'advanced'):
        return jsonify({'success': False, 'message': '无效的会员类型'})

    new_expire = (datetime.now() + timedelta(days=days)).isoformat()
    with get_db() as conn:
        conn.execute('''
            INSERT OR REPLACE INTO memberships (username, member_type, expire_time, create_time)
            VALUES (?, ?, ?, ?)
        ''', (username, member_type, new_expire, datetime.now().isoformat()))

    type_name = '初级会员' if member_type == 'basic' else '高级会员'
    return jsonify({'success': True, 'message': f'已为 {username} 授权 {days} 天{type_name}'})


@admin_bp.route('/api/admin/members/revoke', methods=['POST'])
@require_admin
def admin_members_revoke():
    data = request.get_json() or {}
    username = data.get('username', '').strip()
    if not username:
        return jsonify({'success': False, 'message': '请提供学号'})
    with get_db() as conn:
        result = conn.execute('DELETE FROM memberships WHERE username = ?', (username,))
    if result.rowcount:
        return jsonify({'success': True, 'message': f'已撤销 {username} 的会员'})
    return jsonify({'success': False, 'message': f'未找到 {username} 的会员记录'})


@admin_bp.route('/api/admin/monitor/online', methods=['GET'])
@require_admin
def monitor_online():
    cutoff = (datetime.now() - timedelta(minutes=5)).strftime('%Y-%m-%d %H:%M:%S')
    with get_db() as conn:
        rows = conn.execute('''
            SELECT device_id, username,
                   MAX(request_time) as last_active,
                   endpoint as last_endpoint
            FROM request_logs
            WHERE request_time >= ? AND device_id != ''
            GROUP BY device_id
            ORDER BY last_active DESC
        ''', (cutoff,)).fetchall()

        users = []
        for row in rows:
            last = conn.execute(
                'SELECT endpoint FROM request_logs WHERE device_id = ? ORDER BY request_time DESC LIMIT 1',
                (row['device_id'],)
            ).fetchone()
            users.append({
                'device_id': row['device_id'],
                'username': row['username'] or '未绑定',
                'last_active': row['last_active'],
                'last_endpoint': last['endpoint'] if last else ''
            })

    return jsonify({
        'success': True,
        'data': {
            'online_count': len(users),
            'users': users
        }
    })


@admin_bp.route('/api/admin/withdrawals', methods=['GET'])
@require_admin
def admin_withdrawals():
    try:
        with get_db() as conn:
            ensure_invitation_earnings(conn)
            rows = conn.execute('SELECT * FROM withdrawals').fetchall()
            earnings_rows = conn.execute('SELECT username, amount FROM invitation_earnings').fetchall()
            milestone_rows = conn.execute('SELECT username, amount FROM invitation_milestone_rewards').fetchall()
            withdrawal_amount_rows = conn.execute("SELECT username, amount, status FROM withdrawals WHERE status != 'rejected'").fetchall()

        earned_map = defaultdict(lambda: _money('0'))
        withdrawn_map = defaultdict(lambda: _money('0'))
        for r in earnings_rows:
            earned_map[r['username']] += _money(r['amount'])
        for r in milestone_rows:
            earned_map[r['username']] += _money(r['amount'])
        for r in withdrawal_amount_rows:
            withdrawn_map[r['username']] += _money(r['amount'])

        sorted_rows = sorted(
            rows,
            key=lambda r: (0 if r['status'] == 'pending' else 1, str(r['create_time'] or '')),
            reverse=False
        )
        pending = [r for r in sorted_rows if r['status'] == 'pending']
        others = sorted([r for r in sorted_rows if r['status'] != 'pending'], key=lambda r: str(r['create_time'] or ''), reverse=True)

        result = []
        for r in pending + others:
            earned = earned_map.get(r['username'], _money('0'))
            withdrawn = withdrawn_map.get(r['username'], _money('0'))
            result.append({
                'id': r['id'],
                'username': r['username'],
                'real_name': r['real_name'],
                'alipay_account': r['alipay_account'],
                'amount': r['amount'],
                'status': r['status'],
                'create_time': r['create_time'],
                'review_time': r['review_time'],
                'earned': _money_string(earned),
                'withdrawn': _money_string(withdrawn),
                'available_after': _money_string(max(earned - withdrawn, _money('0')))
            })
        return jsonify({'success': True, 'data': result})
    except Exception as e:
        return jsonify({'success': False, 'message': f'提现列表加载失败: {str(e)}'})
@admin_bp.route('/api/admin/withdrawals/<int:withdrawal_id>/approve', methods=['POST'])
@require_admin
def admin_withdrawals_approve(withdrawal_id):
    with get_db() as conn:
        conn.execute(
            "UPDATE withdrawals SET status = 'approved', review_time = ? WHERE id = ?",
            (datetime.now().isoformat(), withdrawal_id)
        )
    return jsonify({'success': True, 'message': '已审核通过'})


@admin_bp.route('/api/admin/withdrawals/<int:withdrawal_id>/reject', methods=['POST'])
@require_admin
def admin_withdrawals_reject(withdrawal_id):
    with get_db() as conn:
        conn.execute(
            "UPDATE withdrawals SET status = 'rejected', review_time = ? WHERE id = ?",
            (datetime.now().isoformat(), withdrawal_id)
        )
    return jsonify({'success': True, 'message': '已拒绝'})


@admin_bp.route('/api/admin/commission_stats', methods=['GET'])
@require_admin
def admin_commission_stats():
    try:
        with get_db() as conn:
            ensure_invitation_earnings(conn)
            earnings = conn.execute('SELECT username, invitee_username, amount, create_time FROM invitation_earnings').fetchall()
            milestone_earnings = conn.execute('SELECT username, amount, create_time FROM invitation_milestone_rewards').fetchall()
            withdrawals = conn.execute('SELECT username, amount, status FROM withdrawals').fetchall()
            invitations = conn.execute('SELECT inviter_username, invitee_username FROM invitations').fetchall()
            paid_orders = conn.execute("SELECT username, amount FROM orders WHERE status = 'paid'").fetchall()

        stats = {}
        for e in earnings:
            username = e['username']
            item = stats.setdefault(username, _new_commission_stat(username))
            item['earned'] += _money(e['amount'])
            if e['invitee_username']:
                item['invitees'].add(e['invitee_username'])
            item['commission_count'] += 1
            if e['create_time'] and (not item['last_earning_time'] or e['create_time'] > item['last_earning_time']):
                item['last_earning_time'] = e['create_time']

        for e in milestone_earnings:
            username = e['username']
            item = stats.setdefault(username, _new_commission_stat(username))
            item['earned'] += _money(e['amount'])
            item['milestone_count'] = item.get('milestone_count', 0) + 1
            if e['create_time'] and (not item['last_earning_time'] or e['create_time'] > item['last_earning_time']):
                item['last_earning_time'] = e['create_time']

        for inv in invitations:
            stats.setdefault(
                inv['inviter_username'],
                _new_commission_stat(inv['inviter_username']),
            )['invitees'].add(inv['invitee_username'])

        invitee_to_inviter = {inv['invitee_username']: inv['inviter_username'] for inv in invitations}
        for order in paid_orders:
            inviter = invitee_to_inviter.get(order['username'])
            if not inviter:
                continue
            item = stats.setdefault(inviter, _new_commission_stat(inviter))
            item['invitee_paid_amount'] += _money(order['amount'])

        for w in withdrawals:
            username = w['username']
            item = stats.setdefault(username, _new_commission_stat(username))
            amount = _money(w['amount'])
            if w['status'] != 'rejected':
                item['withdrawn'] += amount
            if w['status'] == 'pending':
                item['pending_withdraw'] += amount

        users = []
        total_earned = _money('0')
        total_withdrawn = _money('0')
        total_available = _money('0')
        total_pending = _money('0')
        total_invitee_paid = _money('0')
        for item in stats.values():
            earned = item['earned']
            withdrawn = item['withdrawn']
            pending = item['pending_withdraw']
            invitee_paid = item['invitee_paid_amount']
            available = max(earned - withdrawn, _money('0'))
            users.append({
                'username': item['username'],
                'earned': _money_string(earned),
                'withdrawn': _money_string(withdrawn),
                'available': _money_string(available),
                'pending_withdraw': _money_string(pending),
                'invitee_paid_amount': _money_string(invitee_paid),
                'invitee_count': len(item['invitees']),
                'commission_count': item['commission_count'],
                'milestone_count': item.get('milestone_count', 0),
                'last_earning_time': item['last_earning_time']
            })
            total_earned += earned
            total_withdrawn += withdrawn
            total_available += available
            total_pending += pending
            total_invitee_paid += invitee_paid

        users.sort(key=lambda u: float(u['earned'] or 0), reverse=True)

        return jsonify({
            'success': True,
            'data': {
                'users': users,
                'summary': {
                    'user_count': len(users),
                    'total_earned': _money_string(total_earned),
                    'total_withdrawn': _money_string(total_withdrawn),
                    'total_available': _money_string(total_available),
                    'total_pending': _money_string(total_pending),
                    'total_invitee_paid': _money_string(total_invitee_paid)
                },
                'total_available': _money_string(total_available)
            }
        })
    except Exception as e:
        return jsonify({'success': False, 'message': f'佣金统计加载失败: {str(e)}'})
