"""
管理员功能路由
"""
from collections import defaultdict
from datetime import datetime, timedelta
import time
from flask import Blueprint, request, jsonify, render_template
from database import get_db, get_database_config, test_database_config, migrate_sqlite_to_current_database
from auth import require_admin
from services.config_service import get_config, save_config, is_valid_urp_url, normalize_urp_url, update_config
from services.ad_config_service import get_ad_config, validate_ad_config

from services.member_service import ensure_invitation_earnings, _money, _money_string
from services.ad_service import get_ad_click_stats
from services.online_service import get_online_snapshot
from services.binding_archive_service import preview_archive, execute_archive, historical_users
from constants import MEMBER_DURATION_DAYS

admin_bp = Blueprint('admin_bp', __name__)


def _public_config(config):
    """返回管理员前端可见的配置，不把数据库密码发回浏览器。"""
    public = dict(config or {})
    database = dict(public.get('database') or {})
    mysql = dict(database.get('mysql') or {})
    mysql.pop('password', None)
    database['mysql'] = mysql
    public['database'] = database
    return public


@admin_bp.route('/api/admin/advertisement', methods=['GET', 'PUT'])
@require_admin
def admin_advertisement():
    if request.method == 'GET':
        return jsonify(success=True, data=get_ad_config())
    try:
        ad = validate_ad_config(request.get_json(silent=True))
    except ValueError as error:
        return jsonify(success=False, message=str(error)), 400
    config = get_config()
    config['advertisement'] = ad
    save_config(config)
    return jsonify(success=True, message='广告配置已保存', data=ad)


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
        return jsonify({'success': False, 'message': '请提供 invitee 或 inviter 参数'})

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
        return jsonify({'success': False, 'message': f'获取邀请调试信息失败: {str(e)}'})


@admin_bp.route('/api/admin/users', methods=['GET'])
@require_admin
def admin_users():
    try:
        with get_db() as conn:
            rows = historical_users(conn)

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


@admin_bp.route('/api/admin/bindings/archive', methods=['GET', 'POST'])
@require_admin
def admin_archive_bindings():
    try:
        from services import binding_archive_service
        if getattr(binding_archive_service, 'PROTOCOL_VERSION', None) != 2:
            raise ValueError('归档模块版本不一致。请更新 services/binding_archive_service.py 并重启所有服务进程，暂勿执行清理')
        if request.method == 'GET':
            response = jsonify(success=True, data=preview_archive())
            response.headers['Cache-Control'] = 'no-store'
            return response
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict) or payload.get('prepared') is not True:
            return jsonify(success=False, message='请先备份数据库并暂停其他实例和用户入口'), 400
        if payload.get('protocol_version') != 2:
            raise ValueError('操作页面版本过旧，请强制刷新页面并重新预览')
        result = execute_archive(payload.get('fingerprint'), payload.get('batch_id'))
        if (not isinstance(result, dict) or result.get('protocol_version') != 2
                or type(result.get('account_count')) is not int):
            raise ValueError('执行返回旧版或不完整结果，未确认精简成功。请核对旧归档表并完整更新、重启服务，暂勿再次清理')
    except ValueError as error:
        return jsonify(success=False, message=str(error)), 409
    except Exception:
        # 数据库异常可能带 INSERT 参数（账号密码），不将其返回或写入日志。
        return jsonify(success=False, message='归档未完成。请重新预览；若结果不确定，可使用原批次重试。'), 500
    # 只有提交成功后才清理当前进程缓存；其他 worker 由部署流程重启。
    from services.urp_service import _login_cache
    _login_cache.clear()
    return jsonify(success=True, data=result, message='用户资料已按学号合并保存，旧设备及会话明细已清理，请重启所有服务进程后开放用户入口')


@admin_bp.route('/api/admin/ad_stats', methods=['GET'])
@require_admin
def admin_ad_stats():
    try:
        return jsonify({'success': True, 'data': get_ad_click_stats()})
    except Exception as e:
        return jsonify({'success': False, 'message': f'广告统计加载失败: {str(e)}'})

@admin_bp.route('/api/admin/config', methods=['GET'])
@require_admin
def admin_get_config():
    config = get_config()
    return jsonify({'success': True, 'config': _public_config(config)})
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
        try:
            mysql_port = int(mysql.get('port') or 3306)
        except (TypeError, ValueError):
            return jsonify({'success': False, 'message': 'MySQL 端口必须是数字'}), 400
        if not 1 <= mysql_port <= 65535:
            return jsonify({'success': False, 'message': 'MySQL 端口范围应为 1-65535'}), 400
        database_config = {
            'type': 'mysql',
            'sqlite_path': existing_db.get('sqlite_path', 'data/urp_helper.db'),
            'mysql': {
                'host': (mysql.get('host') or '').strip(),
                'port': mysql_port,
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
    return jsonify({'success': True, 'message': message, 'config': _public_config(config)})
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


@admin_bp.route('/api/admin/config/member_page', methods=['POST'])
@require_admin
def admin_set_member_page_enabled():
    data = request.get_json() or {}
    enabled = data.get('member_page_enabled')
    if not isinstance(enabled, bool):
        return jsonify({'success': False, 'message': '前端充值页面开关必须是布尔值'}), 400

    config = get_config()
    config['member_page_enabled'] = enabled
    save_config(config)
    message = '前端充值页面已开启' if enabled else '前端充值页面已隐藏'
    return jsonify({'success': True, 'message': message, 'config': _public_config(config)})


@admin_bp.route('/api/admin/config/url', methods=['POST'])
@require_admin
def admin_switch_url():
    data = request.get_json() or {}

    if 'urls' in data:
        urls = data['urls']
        if (
            not isinstance(urls, list)
            or len(urls) < 2
            or not all(is_valid_urp_url(url) for url in urls)
        ):
            return jsonify({
                'success': False,
                'message': 'URL列表格式错误，需要至少2个有效HTTP/HTTPS地址',
            })

        normalized = [normalize_urp_url(url) for url in urls]

        def replace_urls(config):
            config['urp_urls'] = normalized
            index = config.get('current_url_index', 0)
            if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < len(normalized):
                config['current_url_index'] = 0

        config = update_config(replace_urls)
        return jsonify({
            'success': True,
            'message': 'URL列表已更新',
            'config': _public_config(config),
        })

    if 'url_index' in data:
        url_index = data['url_index']
        if isinstance(url_index, bool) or not isinstance(url_index, int):
            return jsonify({'success': False, 'message': 'URL索引必须是整数'})

        class InvalidUrlSwitch(ValueError):
            pass

        def switch_index(config):
            urls = config.get('urp_urls', [])
            if not (0 <= url_index < len(urls)):
                raise InvalidUrlSwitch('URL索引超出范围')
            if not is_valid_urp_url(urls[url_index]):
                raise InvalidUrlSwitch('目标URL无效')
            config['current_url_index'] = url_index

        try:
            config = update_config(switch_index)
        except InvalidUrlSwitch as exc:
            return jsonify({'success': False, 'message': str(exc)})
        return jsonify({
            'success': True,
            'message': f"已切换到URL: {config['urp_urls'][url_index]}",
            'config': _public_config(config),
        })

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
    if config.get('semester_start') != date_str:
        config['semester_cache_reset_at_ns'] = time.time_ns()
    config['semester_start'] = date_str
    save_config(config)
    return jsonify({'success': True, 'message': f'学期起始日期已设置为: {date_str}'})


@admin_bp.route('/api/admin/members', methods=['GET'])
@require_admin
def admin_members():
    username = (request.args.get('username') or '').strip()
    if not username:
        return jsonify({'success': True, 'data': None, 'message': '请提供学号后查询会员信息'})

    with get_db() as conn:
        user = conn.execute(
            '''SELECT username, registered_at AS bind_time
               FROM user_account WHERE username = ? LIMIT 1''',
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
    return jsonify({'success': True, 'data': get_online_snapshot()})


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
