"""会员实验提交 API。"""
from flask import Blueprint, jsonify, request

from auth import require_member
from services import lab_service as lab


lab_bp = Blueprint('lab', __name__)


def _key(user):
    device = request.headers.get('X-Device-ID', '').strip()
    if not device or len(device) > 128:
        raise lab.LabError('请使用已绑定的设备访问')
    return user['username'], device


def _result(action):
    try:
        return action()
    except lab.LabError as exc:
        return jsonify({'success': False, 'message': str(exc)}), 400


@lab_bp.route('/api/lab/status')
@require_member('basic')
def status(user):
    return _result(lambda: jsonify({'success': True, 'student_id': _key(user)[0],
                                    'password_bound': lab.credential_status(user['username'])}))


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
        _key(user), request.args.get('semester', ''))}))


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
        result = lab.upload(_key(user), request.form.get('item_id'),
                            request.form.get('kind'), file.filename, data)
        return jsonify({'success': True, 'data': result, 'message': result['message']})
    return _result(run)


@lab_bp.route('/api/lab/credential', methods=['DELETE'])
@require_member('basic')
def unbind(user):
    return _result(lambda: (lab.remove_credential(_key(user)[0]) or
                            jsonify({'success': True, 'message': '已解除实验站密码绑定'})))
