import json
import tempfile
import unittest
from collections import UserDict
from pathlib import Path
from unittest.mock import patch

import urp.session_store as session_store


URL1 = 'http://url1.test/urp/'
URL2 = 'https://url2.test/vpn/urp/'


class UserCookieStoreTests(unittest.TestCase):
    def test_same_user_uses_distinct_files_for_distinct_urls(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ):
            first = session_store.save_user_cookies(
                'student',
                URL1,
                {'JSESSIONID': 'url1'},
            )
            second = session_store.save_user_cookies(
                'student',
                URL2,
                {'JSESSIONID': 'url2'},
            )
            first_cookies, first_source = session_store.load_user_cookies(
                'student',
                URL1,
            )
            second_cookies, second_source = session_store.load_user_cookies(
                'student',
                URL2,
            )

        self.assertNotEqual(first, second)
        self.assertEqual(first_cookies, {'JSESSIONID': 'url1'})
        self.assertEqual(second_cookies, {'JSESSIONID': 'url2'})
        self.assertEqual((first_source, second_source), ('scoped', 'scoped'))

    def test_url_reordering_does_not_change_cookie_path(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ):
            first = session_store.user_cookie_path('student', URL1)
            second = session_store.user_cookie_path(
                'student',
                URL1.rstrip('/'),
            )

        self.assertEqual(first, second)

    def test_user_cookie_file_excludes_vpn_cookies(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ):
            path = session_store.save_user_cookies(
                'student',
                URL2,
                {
                    'JSESSIONID': 'student-session',
                    'route': 'backend',
                    'VSG_SESSIONID': 'vpn-session',
                },
            )
            payload = json.loads(path.read_text(encoding='utf-8'))

        self.assertEqual(
            payload,
            {'JSESSIONID': 'student-session', 'route': 'backend'},
        )

    def test_userdict_cookies_are_saved_and_vpn_cookies_filtered(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ):
            path = session_store.save_user_cookies(
                'student',
                URL1,
                UserDict({
                    'JSESSIONID': 'student-session',
                    'VSG_SESSIONID': 'vpn-session',
                }),
            )
            payload = json.loads(path.read_text(encoding='utf-8'))

        self.assertEqual(payload, {'JSESSIONID': 'student-session'})

    def test_legacy_cookie_is_candidate_only_when_scoped_file_missing(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            session_store,
            'USER_DATA_DIR',
            Path(directory),
        ):
            account_dir = Path(directory) / 'student'
            account_dir.mkdir(parents=True)
            (account_dir / 'cookie.json').write_text(
                json.dumps({
                    'JSESSIONID': 'legacy',
                    'VSG_SESSIONID': 'old-vpn',
                }),
                encoding='utf-8',
            )
            legacy, source = session_store.load_user_cookies('student', URL1)
            session_store.save_user_cookies(
                'student',
                URL1,
                {'JSESSIONID': 'scoped'},
            )
            scoped, scoped_source = session_store.load_user_cookies(
                'student',
                URL1,
            )

        self.assertEqual(legacy, {'JSESSIONID': 'legacy'})
        self.assertEqual(source, 'legacy')
        self.assertEqual(scoped, {'JSESSIONID': 'scoped'})
        self.assertEqual(scoped_source, 'scoped')


if __name__ == '__main__':
    unittest.main()
