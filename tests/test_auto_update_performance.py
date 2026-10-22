import unittest
from unittest.mock import patch
from services import urp_service as service

class AutoUpdatePerformanceTests(unittest.TestCase):
    def setUp(self):
        service._auto_update_running.clear()
        if hasattr(service, '_auto_update_next'):
            service._auto_update_next.clear()
    def tearDown(self):
        service._auto_update_running.clear()
        if hasattr(service, '_auto_update_next'):
            service._auto_update_next.clear()
    def test_different_accounts_have_global_concurrency_limit(self):
        with patch.object(service.threading, 'Thread') as thread:
            accepted = [service.start_auto_update(str(i), 'test', url='http://urp.test') for i in range(30)]
        self.assertEqual(sum(accepted), 4)
        self.assertEqual(thread.call_count, 4)
    def test_failure_cools_down_without_spawning_more_workers(self):
        with patch.object(service, '_perform_auto_update', return_value=(False, '暂不可用')) as work:
            service.check_and_auto_update('test', 'test', url='http://urp.test')
            service.check_and_auto_update('test', 'test', url='http://urp.test')
            self.assertEqual(work.call_count, 1)
        with patch.object(service.threading, 'Thread') as thread:
            self.assertFalse(service.start_auto_update('test','test',url='http://urp.test'))
            thread.assert_not_called()
