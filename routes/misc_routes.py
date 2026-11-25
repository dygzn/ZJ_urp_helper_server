"""
公告、反馈、主题路由
"""
from datetime import datetime
from flask import Blueprint, request, jsonify
from database import get_db
from auth import require_admin, require_binding
from services.user_service import get_device_id

misc_bp = Blueprint('misc', __name__)


DEFAULT_SERVICE_STATUS = {
    'status_text': '暂未设置状态',
    'accepting_orders': False,
    'updated_at': None,
}


def _get_service_status():
    with get_db() as conn:
        row = conn.execute('''
            SELECT status_text, accepting_orders, updated_at
            FROM admin_service_status
            WHERE id = 1
        ''').fetchone()

    if not row:
        return dict(DEFAULT_SERVICE_STATUS)

    return {
        'status_text': row['status_text'],
        'accepting_orders': bool(row['accepting_orders']),
        'updated_at': row['updated_at'],
    }


@misc_bp.route('/api/service-status', methods=['GET'])
def get_service_status():
    return jsonify({'success': True, 'data': _get_service_status()})


@misc_bp.route('/api/admin/service-status', methods=['GET'])
@require_admin
def admin_get_service_status():
    return jsonify({'success': True, 'data': _get_service_status()})


@misc_bp.route('/api/admin/service-status', methods=['PUT'])
@require_admin
def admin_update_service_status():
    data = request.get_json(silent=True) or {}
    status_text = data.get('status_text')
    accepting_orders = data.get('accepting_orders')

    if not isinstance(status_text, str) or not status_text.strip():
        return jsonify({'success': False, 'message': '状态文字不能为空'}), 400

    status_text = status_text.strip()
    if len(status_text) > 40:
        return jsonify({'success': False, 'message': '状态文字不能超过40个字符'}), 400

    if not isinstance(accepting_orders, bool):
        return jsonify({'success': False, 'message': '接单状态格式错误'}), 400

    updated_at = datetime.now().isoformat(timespec='seconds')
    with get_db() as conn:
        conn.execute('''
            INSERT OR REPLACE INTO admin_service_status
            (id, status_text, accepting_orders, updated_at)
            VALUES (1, ?, ?, ?)
        ''', (status_text, 1 if accepting_orders else 0, updated_at))

    return jsonify({
        'success': True,
        'message': '状态已更新',
        'data': {
            'status_text': status_text,
            'accepting_orders': accepting_orders,
            'updated_at': updated_at,
        },
    })



# ==================== 公告 ====================

@misc_bp.route('/api/admin/announcements', methods=['GET'])
@require_admin
def admin_get_announcements():
    with get_db() as conn:
        rows = conn.execute('''
            SELECT id, title, content, create_time, is_active
            FROM announcements
            ORDER BY create_time DESC
        ''').fetchall()

        announcements = [{
            'id': row['id'],
            'title': row['title'],
            'content': row['content'],
            'create_time': row['create_time'],
            'is_active': bool(row['is_active'])
        } for row in rows]

    return jsonify({'success': True, 'announcements': announcements})


@misc_bp.route('/api/admin/announcements', methods=['POST'])
@require_admin
def admin_create_announcement():
    data = request.get_json()
    title = data.get('title', '').strip()
    content = data.get('content', '').strip()

    if not title or not content:
        return jsonify({'success': False, 'message': '标题和内容不能为空'})

    with get_db() as conn:
        cursor = conn.execute('''
            INSERT INTO announcements (title, content, create_time, is_active)
            VALUES (?, ?, ?, 1)
        ''', (title, content, datetime.now().isoformat()))
        announcement_id = cursor.lastrowid

    return jsonify({'success': True, 'message': '公告发布成功', 'announcement_id': announcement_id})


@misc_bp.route('/api/admin/announcements/<int:announcement_id>', methods=['PUT'])
@require_admin
def admin_update_announcement(announcement_id):
    data = request.get_json()
    title = data.get('title', '').strip()
    content = data.get('content', '').strip()
    is_active = data.get('is_active', True)

    if not title or not content:
        return jsonify({'success': False, 'message': '标题和内容不能为空'})

    with get_db() as conn:
        cursor = conn.execute('''
            UPDATE announcements SET title = ?, content = ?, is_active = ? WHERE id = ?
        ''', (title, content, 1 if is_active else 0, announcement_id))
        if cursor.rowcount == 0:
            return jsonify({'success': False, 'message': '公告不存在'})

    return jsonify({'success': True, 'message': '公告更新成功'})


@misc_bp.route('/api/admin/announcements/<int:announcement_id>', methods=['DELETE'])
@require_admin
def admin_delete_announcement(announcement_id):
    with get_db() as conn:
        cursor = conn.execute('DELETE FROM announcements WHERE id = ?', (announcement_id,))
        if cursor.rowcount == 0:
            return jsonify({'success': False, 'message': '公告不存在'})

    return jsonify({'success': True, 'message': '公告删除成功'})


@misc_bp.route('/api/announcements', methods=['GET'])
def get_announcements():
    device_id = get_device_id()

    with get_db() as conn:
        rows = conn.execute('''
            SELECT a.id, a.title, a.content, a.create_time,
                   r.announcement_id AS read_id, r.never_show
            FROM announcements a LEFT JOIN user_read_announcements r
              ON r.announcement_id = a.id AND r.device_id = ?
            WHERE a.is_active = 1 ORDER BY a.create_time DESC
        ''', (device_id,)).fetchall()
        announcements = []
        for row in rows:
            is_read = row['read_id'] is not None
            never_show = row['never_show'] or 0
            announcements.append({
                'id': row['id'],
                'title': row['title'],
                'content': row['content'],
                'create_time': row['create_time'],
                'is_read': is_read,
                'never_show': bool(never_show)
            })

    return jsonify({'success': True, 'announcements': announcements})


@misc_bp.route('/api/announcements/<int:announcement_id>/read', methods=['POST'])
def mark_announcement_read(announcement_id):
    device_id = get_device_id()
    if not device_id:
        return jsonify({'success': False, 'message': '缺少有效设备凭据'}), 401
    data = request.get_json() or {}
    never_show = data.get('never_show', False)

    with get_db() as conn:
        announcement = conn.execute('SELECT id FROM announcements WHERE id = ?', (announcement_id,)).fetchone()
        if not announcement:
            return jsonify({'success': False, 'message': '公告不存在'})

        conn.execute('''
            INSERT OR REPLACE INTO user_read_announcements
            (device_id, announcement_id, read_time, never_show)
            VALUES (?, ?, ?, ?)
        ''', (device_id, announcement_id, datetime.now().isoformat(), 1 if never_show else 0))

    return jsonify({'success': True, 'message': '已标记为已读'})


# ==================== 反馈 ====================

@misc_bp.route('/api/feedback', methods=['GET', 'POST'])
@require_binding
def handle_feedback(user):
    if request.method == 'POST':
        data = request.get_json()
        content = data.get('content', '').strip()
        visibility = data.get('visibility', 'self')

        if not content:
            return jsonify({'success': False, 'message': '反馈内容不能为空'})
        if visibility not in ('self', 'public'):
            visibility = 'self'

        with get_db() as conn:
            conn.execute('''
                INSERT INTO feedbacks (device_id, username, content, visibility, create_time)
                VALUES (?, ?, ?, ?, ?)
            ''', (user['device_id'], user['username'], content, visibility, datetime.now().isoformat()))

        return jsonify({'success': True, 'message': '反馈提交成功'})

    # 反馈归属跟随认证账号，设备换绑不能继承原账号的私密内容。
    username = user['username']

    with get_db() as conn:
        my_rows = conn.execute('''
            SELECT id, device_id, username, content, visibility, create_time
            FROM feedbacks WHERE username = ? ORDER BY create_time DESC
        ''', (username,)).fetchall()

        public_rows = conn.execute('''
            SELECT id, device_id, username, content, visibility, create_time
            FROM feedbacks WHERE username != ? AND visibility = 'public' ORDER BY create_time DESC
        ''', (username,)).fetchall()

        reply_map = {}
        for reply in conn.execute('''
            SELECT r.* FROM feedback_replies r JOIN feedbacks f ON f.id = r.feedback_id
            WHERE f.username = ? OR f.visibility = 'public' ORDER BY r.create_time ASC
        ''', (username,)).fetchall():
            reply_map.setdefault(reply['feedback_id'], []).append(reply)

        def build_feedback(row, is_own):
            feedback = {
                'id': row['id'],
                'username': row['username'],
                'content': row['content'],
                'visibility': row['visibility'],
                'create_time': row['create_time'],
                'is_own': is_own,
                'replies': []
            }
            replies = reply_map.get(row['id'], [])
            for r in replies:
                feedback['replies'].append({
                    'id': r['id'],
                    'username': r['username'],
                    'content': r['content'],
                    'create_time': r['create_time']
                })
            return feedback

        my_feedbacks = [build_feedback(row, True) for row in my_rows]
        public_feedbacks = [build_feedback(row, False) for row in public_rows]

    return jsonify({'success': True, 'my_feedbacks': my_feedbacks, 'public_feedbacks': public_feedbacks})


@misc_bp.route('/api/feedback/<int:feedback_id>/reply', methods=['POST'])
@require_binding
def user_reply_feedback(feedback_id, user):
    data = request.get_json()
    content = data.get('content', '').strip()

    if not content:
        return jsonify({'success': False, 'message': '回复内容不能为空'})

    device_id = user['device_id']

    with get_db() as conn:
        feedback = conn.execute('''
            SELECT id, username, visibility FROM feedbacks WHERE id = ?
        ''', (feedback_id,)).fetchone()

        if not feedback:
            return jsonify({'success': False, 'message': '反馈不存在'})
        if feedback['username'] != user['username'] and feedback['visibility'] != 'public':
            return jsonify({'success': False, 'message': '无权回复此反馈'})

        conn.execute('''
            INSERT INTO feedback_replies (feedback_id, device_id, username, content, create_time)
            VALUES (?, ?, ?, ?, ?)
        ''', (feedback_id, device_id, user['username'], content, datetime.now().isoformat()))

    return jsonify({'success': True, 'message': '回复成功'})


@misc_bp.route('/api/admin/feedback', methods=['GET'])
@require_admin
def admin_get_feedback():
    with get_db() as conn:
        rows = conn.execute('''
            SELECT id, device_id, username, content, visibility, create_time
            FROM feedbacks ORDER BY create_time DESC
        ''').fetchall()

        reply_map = {}
        for reply in conn.execute('SELECT * FROM feedback_replies ORDER BY create_time ASC').fetchall():
            reply_map.setdefault(reply['feedback_id'], []).append(reply)

        feedbacks = []
        for row in rows:
            feedback = {
                'id': row['id'],
                'username': row['username'],
                'content': row['content'],
                'visibility': row['visibility'],
                'create_time': row['create_time'],
                'replies': []
            }
            replies = reply_map.get(row['id'], [])
            for r in replies:
                feedback['replies'].append({
                    'id': r['id'],
                    'username': r['username'],
                    'content': r['content'],
                    'create_time': r['create_time']
                })
            feedbacks.append(feedback)

    return jsonify({'success': True, 'feedbacks': feedbacks})


@misc_bp.route('/api/admin/feedback/<int:feedback_id>/reply', methods=['POST'])
@require_admin
def admin_reply_feedback(feedback_id):
    data = request.get_json()
    content = data.get('content', '').strip()

    if not content:
        return jsonify({'success': False, 'message': '回复内容不能为空'})

    with get_db() as conn:
        feedback = conn.execute('SELECT id FROM feedbacks WHERE id = ?', (feedback_id,)).fetchone()
        if not feedback:
            return jsonify({'success': False, 'message': '反馈不存在'})

        conn.execute('''
            INSERT INTO feedback_replies (feedback_id, device_id, username, content, create_time)
            VALUES (?, ?, ?, ?, ?)
        ''', (feedback_id, 'admin', '管理员', content, datetime.now().isoformat()))

    return jsonify({'success': True, 'message': '回复成功'})


@misc_bp.route('/api/admin/feedback/<int:feedback_id>', methods=['DELETE'])
@require_admin
def admin_delete_feedback(feedback_id):
    with get_db() as conn:
        cursor = conn.execute('DELETE FROM feedbacks WHERE id = ?', (feedback_id,))
        if cursor.rowcount == 0:
            return jsonify({'success': False, 'message': '反馈不存在'})
        conn.execute('DELETE FROM feedback_replies WHERE feedback_id = ?', (feedback_id,))

    return jsonify({'success': True, 'message': '反馈删除成功'})
