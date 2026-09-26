"""Validate the distributable Apple Shortcut against the site's API contract."""

import plistlib
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SHORTCUT = ROOT / 'docs' / 'shortcuts' / 'URP教务查询.wflow'
SIGNED = ROOT / 'docs' / 'shortcuts' / 'URP教务查询-JSON版.shortcut'


class ShortcutArtifactTests(unittest.TestCase):
    def test_signed_file_is_available(self):
        self.assertTrue(SIGNED.is_file(), 'JSON 版签名文件尚未生成')
        self.assertTrue(SIGNED.read_bytes().startswith(b'AEA1'))

    def test_menu_requests_and_import_setup(self):
        self.assertTrue(SHORTCUT.is_file(), '快捷指令构建源尚未生成')
        with SHORTCUT.open('rb') as file:
            workflow = plistlib.load(file)

        actions = workflow['WFWorkflowActions']
        identifiers = [action['WFWorkflowActionIdentifier'] for action in actions]
        self.assertIn('is.workflow.actions.choosefrommenu', identifiers)
        self.assertEqual(identifiers.count('is.workflow.actions.downloadurl'), 3)

        questions = workflow['WFWorkflowImportQuestions']
        self.assertEqual(
            {(q['ActionIndex'], q['ParameterKey']) for q in questions},
            {(0, 'WFTextActionText'), (1, 'WFURLActionURL')},
        )

        menu = next(
            action['WFWorkflowActionParameters'] for action in actions
            if action['WFWorkflowActionIdentifier'] == 'is.workflow.actions.choosefrommenu'
            and action['WFWorkflowActionParameters'].get('WFControlFlowMode') == 0
        )
        self.assertEqual(menu['WFMenuItems'], ['历年课表', '本学期成绩', '紧急事项'])

        requests = []
        for action in actions:
            if action['WFWorkflowActionIdentifier'] != 'is.workflow.actions.downloadurl':
                continue
            params = action['WFWorkflowActionParameters']
            self.assertEqual(params['WFHTTPMethod'], 'POST')
            self.assertEqual(params['WFHTTPBodyType'], 'JSON')
            self.assertEqual(params['WFURL']['WFSerializationType'], 'WFTextTokenString')
            self.assertNotIn('WFRequestVariable', params)
            body = params['WFJSONValues']
            self.assertEqual(body['WFSerializationType'], 'WFDictionaryFieldValue')
            items = body['Value']['WFDictionaryFieldValueItems']
            fields = {item['WFKey']['Value']['string']: item for item in items}
            self.assertEqual(set(fields), {'key', 'action', 'params'})
            self.assertEqual(fields['key']['WFValue']['Value']['attachmentsByRange']['{0, 1}']['OutputName'], 'Text')
            self.assertEqual(fields['params']['WFItemType'], 1)
            requests.append(fields)

        self.assertEqual(
            {request['action']['WFValue']['Value']['string'] for request in requests},
            {'historical_schedule', 'grades', 'urgent_event'},
        )
        schedule = next(request for request in requests if request['action']['WFValue']['Value']['string'] == 'historical_schedule')
        semester_items = schedule['params']['WFValue']['Value']['Value']['WFDictionaryFieldValueItems']
        self.assertEqual([item['WFKey']['Value']['string'] for item in semester_items], ['semester'])
        self.assertEqual(semester_items[0]['WFValue']['Value']['attachmentsByRange']['{0, 1}']['OutputName'], 'Ask for Input')
        dictionary_keys = [
            action['WFWorkflowActionParameters']['WFDictionaryKey']
            for action in actions
            if action['WFWorkflowActionIdentifier'] == 'is.workflow.actions.getvalueforkey'
        ]
        self.assertIn('data', dictionary_keys)
        self.assertIn('semester', dictionary_keys)
        self.assertFalse(any('.' in key for key in dictionary_keys))
        self.assertNotIn('urp_', SHORTCUT.read_bytes().decode('latin1'))


if __name__ == '__main__':
    unittest.main()
