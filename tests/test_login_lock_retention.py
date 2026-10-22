"""登录锁应跟随在途请求存活，不能保留已结束的账号或临时会话。"""
import gc
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import Mock, patch

import requests
from flask import Flask, g

from services import urp_service


URL = 'http://lock-test.example/urp/'


class LoginLockRetentionTests(unittest.TestCase):
    def setUp(self):
        urp_service._login_cache.clear()
        urp_service._login_failures.clear()
        urp_service._login_locks.clear()
        self.addCleanup(urp_service._login_cache.clear)
        self.addCleanup(urp_service._login_failures.clear)
        self.addCleanup(urp_service._login_locks.clear)

    def assert_registry_empty(self):
        gc.collect()
        self.assertEqual(len(urp_service._login_locks), 0)

    def test_completed_temporary_sessions_do_not_accumulate_locks(self):
        helper = SimpleNamespace(x=requests.Session(), is_logined=lambda: True)
        app = Flask(__name__)
        with app.test_request_context('/'), patch('urp.URP_login', return_value=helper):
            for number in range(256):
                g.temporary_session = {'username': 'student', 'session_id': f'{number:032x}'}
                self.assertTrue(urp_service.check_login_status('student', None, url=URL)[0])
        self.assert_registry_empty()
        # 新版允许隔离的临时会话短缓存，但不能写入持久账号缓存。
        self.assertNotIn(urp_service._login_key('student', URL), urp_service._login_cache)
        self.assertTrue(all(len(key) == 3 for key in urp_service._login_cache))

    def test_completed_distinct_accounts_do_not_accumulate_locks(self):
        for number in range(2000):
            with urp_service._get_login_lock(urp_service._login_key(f'student-{number}', URL)):
                pass
        self.assert_registry_empty()

    def test_unacquired_reference_preserves_lock_identity(self):
        key = urp_service._login_key('student', URL)
        pending = urp_service._get_login_lock(key)
        gc.collect()
        self.assertIs(urp_service._get_login_lock(key), pending)
        del pending
        self.assert_registry_empty()

    def test_active_lock_survives_unrelated_lock_churn(self):
        key = urp_service._login_key('student', URL)
        with urp_service._get_login_lock(key):
            for number in range(1000):
                with urp_service._get_login_lock((key, f'{number:032x}')):
                    pass
            gc.collect()
            candidate = urp_service._get_login_lock(key)
            self.assertFalse(candidate.acquire(blocking=False))
            self.assertEqual(len(urp_service._login_locks), 1)
            del candidate
        self.assert_registry_empty()

    def test_waiting_request_keeps_the_same_lock_after_owner_exits(self):
        key = urp_service._login_key('student', URL)
        owner = urp_service._get_login_lock(key)
        owner.acquire()
        obtained = threading.Event()
        entered = threading.Event()
        finish = threading.Event()

        def wait_for_owner():
            waiting = urp_service._get_login_lock(key)
            obtained.set()
            with waiting:
                entered.set()
                if not finish.wait(5):
                    raise AssertionError('test did not release waiting request')

        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(wait_for_owner)
            try:
                self.assertTrue(obtained.wait(5))
                self.assertIs(urp_service._get_login_lock(key), owner)
            finally:
                owner.release()
                del owner
            try:
                self.assertTrue(entered.wait(5))
                gc.collect()
                candidate = urp_service._get_login_lock(key)
                self.assertFalse(candidate.acquire(blocking=False))
                del candidate
            finally:
                finish.set()
            future.result(timeout=5)
        self.assert_registry_empty()

    def test_simultaneous_lookups_share_one_lock(self):
        key = urp_service._login_key('student', URL)
        start = threading.Barrier(9)
        obtained = threading.Barrier(9)
        finish = threading.Event()
        identities = []

        def lookup():
            start.wait(timeout=5)
            lock = urp_service._get_login_lock(key)
            identities.append(id(lock))
            obtained.wait(timeout=5)
            if not finish.wait(5):
                raise AssertionError('test did not release lookup')
            with lock:
                pass

        with ThreadPoolExecutor(max_workers=8) as executor:
            futures = [executor.submit(lookup) for _ in range(8)]
            try:
                start.wait(timeout=5)
                obtained.wait(timeout=5)
                gc.collect()
                self.assertEqual(len(set(identities)), 1)
                self.assertEqual(len(urp_service._login_locks), 1)
            finally:
                finish.set()
            for future in futures:
                future.result(timeout=5)
        self.assert_registry_empty()

    def test_account_url_and_temporary_session_locks_remain_isolated(self):
        first = urp_service._login_key('student', URL)
        keys = [first, urp_service._login_key('other-student', URL),
                urp_service._login_key('student', 'http://other-lock.example/urp/'),
                (first, 'a' * 32), (first, 'b' * 32)]
        locks = [urp_service._get_login_lock(key) for key in keys]
        self.assertEqual(len({id(lock) for lock in locks}), len(keys))
        for key, lock in zip(keys, locks):
            self.assertIs(urp_service._get_login_lock(key), lock)
        del lock, locks
        self.assert_registry_empty()

    def test_status_failure_and_relogin_paths_release_locks(self):
        app = Flask(__name__)
        for temporary, valid, relogin_success in [(True, False, False), (False, True, False),
                                                (False, False, True), (False, False, False)]:
            with self.subTest(temporary=temporary, valid=valid, relogin_success=relogin_success):
                urp_service._login_cache.clear()
                helper = SimpleNamespace(x=requests.Session(), is_logined=lambda: valid,
                    login=Mock(return_value=(relogin_success, 'synthetic result', {})))
                with app.test_request_context('/'), patch('urp.URP_login', return_value=helper), patch.object(
                    urp_service, 'delete_user_cookies',
                ):
                    if temporary:
                        g.temporary_session = {'username': 'student', 'session_id': 'a' * 32}
                    success, _ = urp_service.check_login_status('student', None if temporary else 'synthetic', url=URL)
                    self.assertEqual(success, valid or relogin_success)
                if temporary or valid:
                    helper.login.assert_not_called()
                else:
                    helper.login.assert_called_once()
                self.assert_registry_empty()

    def test_exception_releases_lock_and_does_not_poison_next_request(self):
        key = urp_service._login_key('student', URL)
        with self.assertRaisesRegex(RuntimeError, 'synthetic'):
            with urp_service._get_login_lock(key):
                raise RuntimeError('synthetic')
        self.assert_registry_empty()
        with urp_service._get_login_lock(key):
            pass
        self.assert_registry_empty()


if __name__ == '__main__':
    unittest.main()
