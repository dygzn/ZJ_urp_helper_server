"""
管理员功能路由
"""
from collections import defaultdict
from datetime import datetime, timedelta
from flask import Blueprint, request, jsonify, render_template
from database import get_db
from auth import require_admin
from services.config_service import get_config, save_config
from services.user_service import unbind_user
from constants import MEMBER_DURATION_DAYS

admin_bp = Blueprint('admin_bp', __name__)


@admin_bp.route('/admin')
def admin():
    return render_template('admin.html')


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
    with get_db() as conn:
        rows = conn.execute('SELECT DISTINCT username FROM users').fetchall()

        daily_rows = conn.execute('''
            SELECT day, COUNT(*) as cnt FROM (
                SELECT DATE(MIN(bind_time)) as day
                FROM users GROUP BY username
            ) GROUP BY day ORDER BY day ASC
        ''').fetchall()

    total = len(rows)

    daily = []
    cumulative = 0
    for r in daily_rows:
        cumulative += r['cnt']
        daily.append({'date': r['day'], 'count': r['cnt'], 'total': cumulative})

    classes = defaultdict(int)
    for row in rows:
        username = row['username']
        if len(username) >= 7:
            classes[username[:7]] += 1
        else:
            classes['其他'] += 1

    class_list = [{'class_id': k, 'count': v} for k, v in sorted(classes.items())]

    return jsonify({'success': True, 'total': total, 'classes': class_list, 'daily': daily})


@admin_bp.route('/api/admin/config', methods=['GET'])
@require_admin
def admin_get_config():
    config = get_config()
    return jsonify({'success': True, 'config': config})


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


@admin_bp.route('/api/admin/theme', methods=['POST'])
@require_admin
def admin_set_theme():
    data = request.get_json()
    theme = data.get('theme', 'default')
    if theme not in ('default', 'spring'):
        return jsonify({'success': False, 'message': '不支持的主题'})
    config = get_config()
    config['theme'] = theme
    save_config(config)
    return jsonify({
        'success': True,
        'message': f'主题已切换为: {"新春主题" if theme == "spring" else "默认主题"}',
        'theme': theme
    })


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
    with get_db() as conn:
        rows = conn.execute(
            'SELECT username, member_type, expire_time, create_time FROM memberships ORDER BY create_time DESC'
        ).fetchall()
    return jsonify({'success': True, 'data': [dict(r) for r in rows]})


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
