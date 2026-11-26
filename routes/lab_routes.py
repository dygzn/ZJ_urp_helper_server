"""会员实验提交 API。"""
from flask import Blueprint, jsonify, request, render_template
from werkzeug.exceptions import RequestEntityTooLarge

from auth import require_member
from services import lab_service as lab
from services import wechat_auth_service, wechat_account_service
from services import wechat_lab_upload_service as local_upload
from services.wechat_access import require_wechat_account


lab_bp = Blueprint('lab', __name__)


def _key(user):
    if request.path.startswith('/api/wechat/lab/'):
        session = wechat_auth_service.get_wechat_request_session()
        if not session or not session.get('openid'):
            raise lab.LabError('微信登录已失效，请重新登录')
        return local_upload.session_key(user['username'], session['openid'])
    device = request.headers.get('X-Device-ID', '').strip()
    if not device or len(device) > 128:
        raise lab.LabError('请使用已绑定的设备访问')
    return user['username'], device


def _result(action):
    try:
        return action()
    except RequestEntityTooLarge:
        return jsonify({'success': False, 'message': '上传请求超过 20MB 限制'}), 400
    except lab.LabSessionExpired as exc:
        return jsonify({'success': False, 'code': 'LAB_SESSION_EXPIRED', 'message': str(exc)}), 400
    except lab.LabError as exc:
        return jsonify({'success': False, 'message': str(exc)}), 400


@lab_bp.route('/api/lab/status')
@require_member('basic')
def status(user):
    def run():
        key = _key(user)
        data = lab.session_snapshot(key)
        return jsonify({'success': True, 'student_id': key[0],
                        'password_bound': lab.credential_status(user['username']),
                        'logged_in': data is not None, 'data': data})
    return _result(run)


@lab_bp.route('/api/lab/query', methods=['POST'])
@require_member('basic')
def query(user):
    def run():
        payload = request.get_json(silent=True) or {}
        password = payload.get('password') or lab.read_credential(user['username'])
        if not isinstance(password, str):
            raise lab.LabError('参数格式不正确')
        result = lab.login_and_list(_key(user), user['username'], password)
        if payload.get('bind_password') is True:
            lab.save_credential(user['username'], password)
        return jsonify({'success': True, 'data': result})
    return _result(run)


@lab_bp.route('/api/lab/experiments')
@require_member('basic')
def experiments(user):
    return _result(lambda: jsonify({'success': True, 'data': lab.change_semester(
        _key(user), request.args.get('semester', ''), request.args.get('mode'), request.args.get('course'))}))


@lab_bp.route('/api/lab/submission-status')
@require_member('basic')
def submission_status(user):
    return _result(lambda: jsonify({'success': True, 'data': lab.submission_statuses(
        _key(user), request.args.get('semester', ''), request.args.get('task_key') or None,
        request.args.get('mode'), request.args.get('course'))}))


@lab_bp.route('/api/lab/upload', methods=['POST'])
@require_member('basic')
def upload(user):
    def run():
        request.max_content_length = lab.MAX_PDF + 1024 * 1024
        if request.content_length and request.content_length > lab.MAX_PDF + 1024 * 1024:
            raise lab.LabError('上传请求超过 20MB 限制')
        file = request.files.get('file')
        if not file:
            raise lab.LabError('请选择 PDF 文件')
        data = file.stream.read(lab.MAX_PDF + 1)
        filename = file.filename
        if request.path.startswith('/api/wechat/lab/'):
            local_upload.task_fields(request.form.to_dict())
            filename = request.form.get('filename') or filename
        result = lab.upload(_key(user), request.form.get('item_id'),
                            request.form.get('kind'), filename, data,
                            semester=request.form.get('semester'), task_key=request.form.get('task_key'),
                            **{k: request.form[k] for k in ('mode', 'course') if k in request.form})
        return jsonify({'success': True, 'data': result, 'message': result['message']})
    return _result(run)


@lab_bp.route('/api/lab/credential', methods=['DELETE'])
@require_member('basic')
def unbind(user):
    return _result(lambda: (lab.remove_credential(_key(user)[0]) or
                            jsonify({'success': True, 'message': '已解除实验站密码绑定'})))


# 小程序与网页使用同一实验适配层，认证入口和实验站会话来源分别隔离。
@lab_bp.get('/api/wechat/lab/status')
@require_wechat_account(member=True)
def wechat_status(account):
    return status.__wrapped__(account)


@lab_bp.post('/api/wechat/lab/query')
@require_wechat_account(member=True)
def wechat_query(account):
    return query.__wrapped__(account)


@lab_bp.get('/api/wechat/lab/experiments')
@require_wechat_account(member=True)
def wechat_experiments(account):
    return experiments.__wrapped__(account)


@lab_bp.get('/api/wechat/lab/submission-status')
@require_wechat_account(member=True)
def wechat_submission_status(account):
    return submission_status.__wrapped__(account)


@lab_bp.post('/api/wechat/lab/upload')
@require_wechat_account(member=True)
def wechat_upload(account):
    return upload.__wrapped__(account)


@lab_bp.delete('/api/wechat/lab/credential')
@require_wechat_account(member=True)
def wechat_unbind(account):
    return unbind.__wrapped__(account)


@lab_bp.post('/api/wechat/lab/local-ticket')
@require_wechat_account(member=True)
def wechat_local_ticket(account):
    def run():
        session = wechat_auth_service.get_wechat_request_session()
        ticket = local_upload.create_ticket(account['username'], session['openid'], request.get_json(silent=True))
        return jsonify(success=True, ticket=ticket, expires_in=local_upload.TICKET_TTL,
                       page_path='/wechat/lab/local-upload')
    return _result(run)


def _local_ticket_access(action):
    def run():
        scheme, separator, token = request.headers.get('Authorization', '').partition(' ')
        if scheme != 'LabUpload' or not separator or not token or len(token) > 12000:
            raise lab.LabError('缺少上传凭证，请返回小程序重新选择本地文件')
        context = local_upload.read_ticket(token)
        account = wechat_account_service.get_account(context['openid'])
        if not account or account['username'] != context['username']:
            return jsonify(success=False, code='BINDING_REQUIRED', message='学号绑定已变化，请返回小程序重新验证'), 409
        from auth import _check_member_access
        allowed, _ = _check_member_access(context['username'], 'basic')
        if not allowed:
            return jsonify(success=False, code='MEMBER_REQUIRED', message='此功能需要有效会员，请返回小程序核对'), 403
        return action(context)
    return _result(run)


@lab_bp.get('/wechat/lab/local-upload')
def wechat_local_upload_page():
    return render_template('wechat_lab_upload.html')


@lab_bp.get('/api/wechat/lab/local-ticket-info')
def wechat_local_ticket_info():
    return _local_ticket_access(lambda context: jsonify(success=True, data={
        'title': context['title'], 'semester': context['semester'],
        'kind_label': '预习报告' if context['kind'] == 'pre' else '实验报告'}))


@lab_bp.post('/api/wechat/lab/local-upload')
def wechat_local_upload():
    def run(context):
        request.max_content_length = lab.MAX_PDF + 1024 * 1024
        if request.content_length and request.content_length > request.max_content_length:
            raise lab.LabError('上传请求超过 20MB 限制')
        file = request.files.get('file')
        if not file:
            raise lab.LabError('请选择 PDF 文件')
        data = file.stream.read(lab.MAX_PDF + 1)
        if (not file.filename or not file.filename.lower().endswith('.pdf')
                or len(data) < 8 or len(data) > lab.MAX_PDF or not data.startswith(b'%PDF-')):
            return jsonify(success=False, retryable=True, message='仅支持 20MB 以内的 PDF 文件'), 400
        result = lab.upload(tuple(context['key']), context['item_id'], context['kind'],
                            file.filename, data, semester=context['semester'], task_key=context['task_key'])
        return jsonify(success=True, data=result, message=result['message'])
    return _local_ticket_access(run)


@lab_bp.after_request
def _wechat_lab_private_response(response):
    if request.path.startswith(('/api/wechat/lab/', '/wechat/lab/')):
        response.headers['Cache-Control'] = 'no-store'
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['X-Content-Type-Options'] = 'nosniff'
    return response
