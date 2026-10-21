import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from flask import Flask

import services.config_service as config_service


class UrlIdentityTests(unittest.TestCase):
    def test_normalization_and_fingerprint_ignore_trailing_slash(self):
        first = 'https://example.edu/urp'
        second = ' https://example.edu/urp/ '
        self.assertEqual(
            config_service.normalize_urp_url(first),
            'https://example.edu/urp/',
        )
        self.assertEqual(
            config_service.urp_url_fingerprint(first),
            config_service.urp_url_fingerprint(second),
        )

    def test_url_validation_accepts_only_http_urls_with_host(self):
        self.assertTrue(config_service.is_valid_urp_url('http://urp.test/a/'))
        self.assertTrue(config_service.is_valid_urp_url('https://urp.test/a/'))
        self.assertFalse(config_service.is_valid_urp_url(''))
        self.assertFalse(config_service.is_valid_urp_url('urp.test/a'))
        self.assertFalse(config_service.is_valid_urp_url('file:///tmp/config'))
        self.assertFalse(config_service.is_valid_urp_url('http://@/'))
        self.assertFalse(
            config_service.is_valid_urp_url('http://urp.test:not-a-port/')
        )


class RequestUrlSnapshotTests(unittest.TestCase):
    def test_same_request_keeps_first_url_after_config_changes(self):
        app = Flask(__name__)
        configs = [
            {'urp_urls': ['http://url1.test/'], 'current_url_index': 0},
            {'urp_urls': ['http://url2.test/'], 'current_url_index': 0},
        ]
        with app.test_request_context('/api/grades'), patch.object(
            config_service,
            'get_config',
            side_effect=configs,
        ) as get_config:
            first = config_service.get_current_urp_url()
            second = config_service.get_current_urp_url()

        self.assertEqual(first, 'http://url1.test/')
        self.assertEqual(second, first)
        self.assertEqual(get_config.call_count, 1)

    def test_new_request_reads_new_url(self):
        app = Flask(__name__)
        with patch.object(
            config_service,
            'get_config',
            side_effect=[
                {'urp_urls': ['http://url1.test/'], 'current_url_index': 0},
                {'urp_urls': ['http://url2.test/'], 'current_url_index': 0},
            ],
        ):
            with app.test_request_context('/first'):
                first = config_service.get_current_urp_url()
            with app.test_request_context('/second'):
                second = config_service.get_current_urp_url()

        self.assertEqual(first, 'http://url1.test/')
        self.assertEqual(second, 'http://url2.test/')


class AtomicConfigTests(unittest.TestCase):
    def test_reader_sees_old_complete_json_until_replace(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'config.json'
            path.write_text('{"version": 1}', encoding='utf-8')
            half_written = threading.Event()
            allow_finish = threading.Event()

            def slow_dump(data, stream, **kwargs):
                stream.write('{"version":')
                stream.flush()
                half_written.set()
                self.assertTrue(allow_finish.wait(2))
                stream.write(str(data['version']))
                stream.write('}')

            with patch.object(config_service.json, 'dump', side_effect=slow_dump):
                writer = threading.Thread(
                    target=config_service.save_json_file,
                    args=(str(path), {'version': 2}),
                )
                writer.start()
                self.assertTrue(half_written.wait(2))
                observed = config_service.load_json_file(
                    str(path),
                    {'version': -1},
                )
                allow_finish.set()
                writer.join(2)

            self.assertFalse(writer.is_alive())
            self.assertEqual(observed, {'version': 1})
            self.assertEqual(
                json.loads(path.read_text(encoding='utf-8')),
                {'version': 2},
            )


if __name__ == '__main__':
    unittest.main()
