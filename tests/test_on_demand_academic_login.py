"""缓存读取不得触发教务连接；实时操作仍必须校验教务登录。"""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from flask import Flask
from cryptography.fernet import Fernet
from database import init_db
from routes import data_routes, shortcut_routes, wechat_routes
from services import urp_service, wechat_access
import auth

class OnDemandAcademicLoginTests(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        config = {'database': {'type':'sqlite','sqlite_path': str(Path(directory)/'test.db')}, 'grades_require_member':False}
        self.enterContext(patch('database.get_config',return_value=config))
        self.enterContext(patch('auth.get_config',return_value=config))
        self.enterContext(patch.object(data_routes,'get_config',return_value=config))
        self.enterContext(patch.object(urp_service,'get_config',return_value=config))
        self.enterContext(patch.object(data_routes,'get_current_urp_url',return_value='http://offline.test/'))
        self.enterContext(patch.dict(os.environ, {'URP_CREDENTIAL_KEY':Fernet.generate_key().decode()}))
        init_db(config)
        user={'username':'student','password':'synthetic','device_id':'device'}
        self.enterContext(patch.object(auth,'get_user_by_device',return_value=user))
        self.enterContext(patch.object(auth,'get_wechat_request_session',return_value={'openid':'test'}))
        self.enterContext(patch.object(wechat_access,'get_account',return_value=user))
        self.check = self.enterContext(patch.object(auth,'check_login_status',return_value=(False,{'message':'expired'})))
        self.wechat_check = self.enterContext(patch.object(urp_service,'check_login_status',return_value=(False,{})))
        self.shortcut_check = self.enterContext(patch.object(shortcut_routes,'check_login_status',return_value=(False,{})))
        self.auto = self.enterContext(patch.object(data_routes,'start_auto_update',create=True,side_effect=AssertionError('local read must not auto update')))
        self.shortcut_auto = self.enterContext(patch.object(shortcut_routes,'start_auto_update',create=True,side_effect=AssertionError('local read must not auto update')))
        self.enterContext(patch('requests.sessions.Session.request',side_effect=AssertionError('no upstream requests')))
        self.enterContext(patch.object(urp_service,'user_data_file',side_effect=lambda username,name: str(Path(directory)/name)))
        Path(directory,'schedule.json').write_text('{}')
        Path(directory,'exams.json').write_text('{}')
        app=Flask(__name__)
        for blueprint in (data_routes.data_bp,wechat_routes.wechat_bp,shortcut_routes.shortcut_bp): app.register_blueprint(blueprint)
        self.client=app.test_client()
        self.headers={'X-Device-ID':'device'}

    def test_web_local_views_succeed_without_valid_school_cookie_or_background_update(self):
        for path in ('/api/urgent_event','/api/schedule','/api/exams'):
            with self.subTest(path=path):
                self.assertTrue(self.client.get(path,headers=self.headers).get_json()['success'])
        self.check.assert_not_called()
        self.wechat_check.assert_not_called()
        self.auto.assert_not_called()

    def test_wechat_cached_views_do_not_need_school_login(self):
        for path in ('/api/wechat/urgent_event','/api/wechat/schedule','/api/wechat/exams'):
            with self.subTest(path=path):
                response=self.client.get(path,headers={'Authorization':'Bearer synthetic'})
                self.assertTrue(response.get_json()['success'])
        self.wechat_check.assert_not_called()

    def test_shortcut_local_agenda_skips_school_login_and_auto_update(self):
        with patch.object(shortcut_routes,'resolve_api_key',return_value='student'), patch.object(shortcut_routes,'_check_member_access',return_value=(True,None)), patch.object(shortcut_routes,'get_user_by_username',return_value={'username':'student','password':'test'}):
            result=self.client.post('/api/shortcut/query',json={'key':'test','action':'urgent_event'}).get_json()
        self.assertTrue(result['success'])
        self.shortcut_check.assert_not_called()
        self.shortcut_auto.assert_not_called()

    def test_live_updates_still_require_school_login(self):
        for path in ('/api/update_schedule','/api/update_exams'):
            self.assertFalse(self.client.post(path,headers=self.headers).get_json()['success'])
        self.assertEqual(self.check.call_count,2)
        for path in ('/api/wechat/update_schedule','/api/wechat/update_exams','/api/wechat/refresh_events'):
            self.assertFalse(self.client.post(path,headers={'Authorization':'Bearer synthetic'}).get_json()['success'])
        self.assertEqual(self.wechat_check.call_count,3)

    def test_local_views_still_enforce_account_identity(self):
        with patch.object(auth,'get_user_by_device',return_value=None):
            self.assertFalse(self.client.get('/api/schedule',headers=self.headers).get_json()['success'])
        with patch.object(wechat_access,'get_account',return_value=None):
            response=self.client.get('/api/wechat/exams',headers={'Authorization':'Bearer synthetic'})
            self.assertEqual(response.status_code,409)
        self.check.assert_not_called()
        self.wechat_check.assert_not_called()

    def test_live_grades_still_validate_school_login(self):
        response=self.client.get('/api/grades/current',headers=self.headers)
        self.assertFalse(response.get_json()['success'])
        self.check.assert_called_once()

    def test_shortcut_live_grades_keep_membership_and_school_checks(self):
        with patch.object(shortcut_routes,'resolve_api_key',return_value='student'), patch.object(shortcut_routes,'_check_member_access',return_value=(True,None)), patch.object(shortcut_routes,'get_user_by_username',return_value={'username':'student','password':'test'}):
            result=self.client.post('/api/shortcut/query',json={'key':'test','action':'grades'}).get_json()
        self.assertFalse(result['success'])
        self.shortcut_check.assert_called_once()
