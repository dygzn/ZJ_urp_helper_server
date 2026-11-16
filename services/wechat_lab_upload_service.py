"""十分钟、加密且限定实验任务的本地文件上传凭证，不包含业务登录 Token。"""
import base64
import hashlib
import json
import os
import re

from cryptography.fernet import Fernet, InvalidToken
from services import lab_service as lab

TICKET_TTL = 600


def session_key(username, openid):
    return username, 'wechat-lab:' + hashlib.sha256(openid.encode()).hexdigest()


def task_fields(payload):
    if not isinstance(payload, dict):
        raise lab.LabError('参数格式不正确')
    task = {name: payload.get(name) for name in ('item_id', 'kind', 'semester', 'task_key')}
    if (not isinstance(task['item_id'], str) or not re.fullmatch(r'\d{1,8}', task['item_id'])
            or task['kind'] not in ('pre', 'report')
            or not isinstance(task['semester'], str) or not task['semester'] or len(task['semester']) > 128
            or not isinstance(task['task_key'], str) or not re.fullmatch(r'[a-f0-9]{64}', task['task_key'])):
        raise lab.LabError('实验任务参数无效，请重新查询后选择报告')
    return task


def _cipher():
    secret = os.environ.get('WECHAT_MINIPROGRAM_SECRET', '')
    if not secret:
        raise lab.LabError('服务器尚未配置小程序上传凭证密钥')
    key = hashlib.sha256(b'urp-wechat-lab-upload-v1\0' + secret.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def create_ticket(username, openid, payload):
    task = task_fields(payload)
    key = session_key(username, openid)
    listing = lab.session_snapshot(key)
    if not listing:
        raise lab.LabSessionExpired('实验站会话已过期，请重新登录查询')
    matches = [item for item in listing['items'] if item['task_key'] == task['task_key']]
    if (listing['semester'] != task['semester'] or len(matches) != 1
            or matches[0]['id'] != task['item_id'] or not matches[0].get(task['kind'])):
        raise lab.LabError('实验任务已变化或没有提交入口，请重新查询后选择报告')
    title = ' · '.join(str(cell) for cell in matches[0].get('cells', [])[:3])[:300]
    content = dict(task, username=username, openid=openid, key=list(key), title=title, purpose='lab-local-upload-v1')
    return _cipher().encrypt(json.dumps(content, ensure_ascii=False).encode()).decode()


def read_ticket(token):
    try:
        content = json.loads(_cipher().decrypt(token.encode(), ttl=TICKET_TTL))
        task_fields(content)
        if (content.get('purpose') != 'lab-local-upload-v1'
                or not isinstance(content.get('username'), str) or not content['username']
                or not isinstance(content.get('openid'), str) or not content['openid']
                or content.get('key') != list(session_key(content['username'], content['openid']))):
            raise ValueError('invalid scope')
        return content
    except (InvalidToken, ValueError, TypeError, AttributeError, KeyError) as exc:
        raise lab.LabError('上传凭证无效或已过期，请返回小程序重新选择本地文件') from exc
