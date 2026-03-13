import hashlib
import hmac
import json
import time
import uuid

import requests
from flask import Blueprint, Response, jsonify, request

from constants import PAPER_API_URL, PAPER_SECRET_KEY
from auth import require_member

paper_bp = Blueprint('paper', __name__)

PAPER_STATUS_URL = "http://101.35.254.245/api/paper/status"
PAPER_DOWNLOAD_URL = "http://101.35.254.245/api/paper/download"


def _sign(body: str) -> dict:
    timestamp = str(int(time.time()))
    nonce = str(uuid.uuid4())
    body_hash = hashlib.sha256(body.encode()).hexdigest()
    signing_string = f"{timestamp}\n{nonce}\n{body_hash}"
    signature = hmac.new(
        PAPER_SECRET_KEY.encode(),
        signing_string.encode(),
        hashlib.sha256
    ).hexdigest()
    return {'X-Timestamp': timestamp, 'X-Nonce': nonce, 'X-Signature': signature}


@paper_bp.route('/api/paper/generate', methods=['POST'])
@require_member(level='advanced')
def paper_generate():
    body = request.get_data(as_text=True)
    try:
        data = json.loads(body)
    except (ValueError, TypeError):
        return jsonify({'error': '请求格式错误'}), 400

    if not data.get('topic', '').strip():
        return jsonify({'error': '请填写论文主题'}), 400

    headers = _sign(body)
    headers['Content-Type'] = 'application/json'

    try:
        resp = requests.post(
            PAPER_API_URL,
            headers=headers,
            data=body.encode(),
            timeout=30
        )
        result = resp.json()
        if resp.status_code != 202 or result.get('status') != 'accepted':
            return jsonify({'error': result.get('error', result.get('message', '提交失败，请稍后重试'))}), 500
        return jsonify({'job_id': result['job_id']})
    except requests.Timeout:
        return jsonify({'error': '提交超时，请稍后重试'}), 504
    except Exception as e:
        return jsonify({'error': f'服务连接失败: {str(e)}'}), 502


@paper_bp.route('/api/paper/status/<job_id>', methods=['GET'])
def paper_status(job_id):
    try:
        resp = requests.get(
            f"{PAPER_STATUS_URL}/{job_id}",
            timeout=10
        )
        if resp.status_code == 404:
            return jsonify({'error': '任务不存在或已过期'}), 404
        result = resp.json()
        return jsonify(result), resp.status_code
    except requests.Timeout:
        return jsonify({'status': 'pending'}), 200
    except Exception as e:
        return jsonify({'error': f'查询失败: {str(e)}'}), 502


@paper_bp.route('/api/paper/download/<job_id>', methods=['GET'])
def paper_download(job_id):
    try:
        resp = requests.get(
            f"{PAPER_DOWNLOAD_URL}/{job_id}",
            timeout=30,
            stream=True
        )
        content_type = resp.headers.get('Content-Type', '')

        if 'application/json' in content_type:
            result = resp.json()
            return jsonify({'error': result.get('error', '下载失败')}), resp.status_code

        disposition = resp.headers.get('Content-Disposition', 'attachment; filename="paper.docx"')
        return Response(
            resp.iter_content(chunk_size=8192),
            status=200,
            content_type=content_type,
            headers={'Content-Disposition': disposition}
        )
    except requests.Timeout:
        return jsonify({'error': '下载超时'}), 504
    except Exception as e:
        return jsonify({'error': f'下载失败: {str(e)}'}), 502
