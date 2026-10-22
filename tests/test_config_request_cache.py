import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from flask import Flask
from services import config_service as service

class ConfigRequestCacheTests(unittest.TestCase):
    def test_request_reads_once_and_returns_independent_values(self):
        app = Flask(__name__)
        with app.test_request_context(), patch.object(service, 'load_json_file', side_effect=lambda *a: {'urp_urls':['first']}) as read:
            first = service.get_config();first['urp_urls'].append('changed')
            self.assertEqual(service.get_config()['urp_urls'], ['first'])
            self.assertEqual(read.call_count, 1)
    def test_save_invalidates_request_cache_and_new_request_rereads(self):
        app = Flask(__name__)
        with tempfile.TemporaryDirectory() as directory, patch.object(service,'CONFIG_FILE',str(Path(directory)/'config.json')):
            service.save_config({'semester_start':'old'})
            with app.test_request_context():
                self.assertEqual(service.get_config()['semester_start'],'old')
                service.save_config({'semester_start':'new'})
                self.assertEqual(service.get_config()['semester_start'],'new')
            with app.test_request_context():
                self.assertEqual(service.get_config()['semester_start'],'new')
