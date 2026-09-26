"""Build the distributable Apple Shortcut for the existing URP query API."""

import plistlib
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'docs' / 'shortcuts' / 'URP教务查询.wflow'
MARKER = '\ufffc'


def uid():
    return str(uuid.uuid4()).upper()


def action(identifier, **params):
    params.setdefault('UUID', uid())
    return {
        'WFWorkflowActionIdentifier': 'is.workflow.actions.' + identifier,
        'WFWorkflowActionParameters': params,
    }


def reference(output_uuid, output_name):
    return {
        'Value': {
            'Type': 'ActionOutput',
            'OutputUUID': output_uuid,
            'OutputName': output_name,
        },
        'WFSerializationType': 'WFTextTokenAttachment',
    }


def token_text(parts):
    """Build a Shortcuts text value from strings and (UUID, output name) pairs."""
    value = ''
    attachments = {}
    for part in parts:
        if isinstance(part, str):
            value += part
        else:
            offset = len(value)
            value += MARKER
            attachments[f'{{{offset}, 1}}'] = reference(*part)['Value']
    if not attachments:
        return value
    return {
        'Value': {'string': value, 'attachmentsByRange': attachments},
        'WFSerializationType': 'WFTextTokenString',
    }


def json_text(value):
    """Encode a string or magic variable as an editable JSON text field."""
    if isinstance(value, tuple):
        return token_text([value])
    return {'Value': {'string': value}, 'WFSerializationType': 'WFTextTokenString'}


def json_item(key, value):
    return {
        'UUID': uid(),
        'WFItemType': 0,
        'WFKey': json_text(key),
        'WFValue': json_text(value),
    }


def json_dictionary(items):
    return {
        'Value': {'WFDictionaryFieldValueItems': items},
        'WFSerializationType': 'WFDictionaryFieldValue',
    }


def get_value(actions, response, key):
    source_uuid = response
    source_name = 'Contents of URL'
    for segment in key.split('.'):
        item = action(
            'getvalueforkey',
            WFInput=reference(source_uuid, source_name),
            WFDictionaryKey=segment,
        )
        actions.append(item)
        source_uuid = item['WFWorkflowActionParameters']['UUID']
        source_name = 'Dictionary Value'
    return source_uuid


def add_query_branch(actions, group, title, key_uuid, url_uuid, api_action, fields):
    actions.append(action(
        'choosefrommenu',
        WFMenuItemTitle=title,
        GroupingIdentifier=group,
        WFControlFlowMode=1,
    ))

    param_items = []
    if api_action == 'historical_schedule':
        semester = action('ask', WFAskActionPrompt='输入学期代码；留空查询默认学期')
        actions.append(semester)
        param_items.append(json_item(
            'semester', (semester['WFWorkflowActionParameters']['UUID'], 'Ask for Input'),
        ))
    params_value = json_dictionary(param_items)
    body = json_dictionary([
        json_item('key', (key_uuid, 'Text')),
        json_item('action', api_action),
        {
            'UUID': uid(),
            'WFItemType': 1,
            'WFKey': json_text('params'),
            'WFValue': {
                'Value': params_value,
                'WFSerializationType': 'WFDictionaryFieldValue',
            },
        },
    ])

    response = action(
        'downloadurl',
        WFURL=token_text([(url_uuid, 'URL')]),
        WFHTTPMethod='POST',
        WFHTTPHeaders=json_dictionary([json_item('Content-Type', 'application/json')]),
        ShowHeaders=True,
        WFHTTPBodyType='JSON',
        WFJSONValues=body,
    )
    actions.append(response)
    response_uuid = response['WFWorkflowActionParameters']['UUID']
    message_uuid = get_value(actions, response_uuid, 'message')
    displayed = [(message_uuid, 'Dictionary Value')]
    for label, key in fields:
        value_uuid = get_value(actions, response_uuid, key)
        displayed.extend(['\n' + label + '：', (value_uuid, 'Dictionary Value')])
    actions.append(action('showresult', Text=token_text([title, '：', *displayed])))


def build():
    actions = []
    key = action('gettext', WFTextActionText='在导入时填写 API 密钥')
    url = action('url', WFURLActionURL='https://www.meizhenxin.cn/api/shortcut/query')
    actions.extend([key, url])

    group = uid()
    actions.append(action(
        'choosefrommenu',
        WFMenuPrompt='想查询什么？',
        WFMenuItems=['历年课表', '本学期成绩', '紧急事项'],
        GroupingIdentifier=group,
        WFControlFlowMode=0,
    ))
    key_uuid = key['WFWorkflowActionParameters']['UUID']
    url_uuid = url['WFWorkflowActionParameters']['UUID']
    add_query_branch(actions, group, '历年课表', key_uuid, url_uuid,
                     'historical_schedule', [
                         ('学期', 'data.semester_name'),
                         ('课程数量', 'data.course_count'),
                         ('课程', 'data.courses'),
                     ])
    add_query_branch(actions, group, '本学期成绩', key_uuid, url_uuid,
                     'grades', [
                         ('学期', 'data.semester'),
                         ('通过数量', 'data.passed_count'),
                         ('本学期不及格数量', 'data.failed_current_count'),
                         ('通过课程', 'data.passed'),
                         ('本学期不及格课程', 'data.failed_current'),
                     ])
    add_query_branch(actions, group, '紧急事项', key_uuid, url_uuid,
                     'urgent_event', [
                         ('是否有事项', 'data.has_event'),
                         ('事项', 'data.event.title'),
                         ('时间', 'data.event.time'),
                         ('地点', 'data.event.location'),
                     ])
    actions.append(action('choosefrommenu', GroupingIdentifier=group,
                          WFControlFlowMode=2))

    workflow = {
        'WFWorkflowName': 'URP教务查询',
        'WFWorkflowActions': actions,
        'WFWorkflowIcon': {
            'WFWorkflowIconStartColor': 2071128575,
            'WFWorkflowIconGlyphNumber': 61440,
        },
        'WFWorkflowClientVersion': '9999',
        'WFWorkflowMinimumClientVersion': 900,
        'WFWorkflowMinimumClientVersionString': '900',
        'WFWorkflowInputContentItemClasses': [],
        'WFWorkflowOutputContentItemClasses': [],
        'WFWorkflowHasOutputFallback': False,
        'WFWorkflowHasShortcutInputVariables': False,
        'WFWorkflowTypes': [],
        'WFWorkflowImportQuestions': [
            {
                'ActionIndex': 0,
                'Category': 'Parameter',
                'ParameterKey': 'WFTextActionText',
                'Text': '粘贴网站“快捷指令 API”页面生成的密钥（仅显示一次）',
            },
            {
                'ActionIndex': 1,
                'Category': 'Parameter',
                'ParameterKey': 'WFURLActionURL',
                'Text': '确认快捷指令 API 地址',
                'DefaultValue': 'https://www.meizhenxin.cn/api/shortcut/query',
            },
        ],
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT.open('wb') as file:
        plistlib.dump(workflow, file, fmt=plistlib.FMT_BINARY, sort_keys=False)


if __name__ == '__main__':
    build()
