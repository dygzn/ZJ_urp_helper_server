import os
import pathlib
import tempfile
import unittest
from unittest import mock

from flask import Flask

import auth
import database
from routes import misc_routes


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[1]


class ServiceStatusApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.sqlite_path = os.path.join(self.temp_dir.name, 'service-status.db')
        self.database_config = {
            'database': {
                'type': 'sqlite',
                'sqlite_path': self.sqlite_path,
            }
        }
        database.init_db(self.database_config)

        self.get_db_patcher = mock.patch.object(
            misc_routes,
            'get_db',
            side_effect=lambda: database.get_db(self.database_config),
        )
        self.admin_key_patcher = mock.patch.object(
            auth,
            'get_admin_key',
            return_value='test-admin-key',
        )
        self.get_db_patcher.start()
        self.admin_key_patcher.start()

        test_app = Flask(__name__)
        test_app.register_blueprint(misc_routes.misc_bp)
        test_app.config['TESTING'] = True
        self.client = test_app.test_client()

    def tearDown(self):
        self.admin_key_patcher.stop()
        self.get_db_patcher.stop()
        self.temp_dir.cleanup()

    def get_db(self):
        return database.get_db(self.database_config)

    def test_default_public_status_is_not_accepting_orders(self):
        response = self.client.get('/api/service-status')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.get_json()['data'],
            {
                'status_text': '暂未设置状态',
                'accepting_orders': False,
                'updated_at': None,
            },
        )

    def test_status_table_is_created(self):
        with self.get_db() as conn:
            row = conn.execute(
                "SELECT name FROM sqlite_master "
                "WHERE type = 'table' AND name = 'admin_service_status'"
            ).fetchone()

        self.assertIsNotNone(row)

    def test_admin_status_requires_key(self):
        response = self.client.get('/api/admin/service-status')

        self.assertEqual(response.status_code, 403)
        self.assertFalse(response.get_json()['success'])

    def test_update_rejects_blank_status_text(self):
        response = self.client.put(
            '/api/admin/service-status',
            json={'status_text': '   ', 'accepting_orders': True},
            headers={'X-Admin-Key': 'test-admin-key'},
        )

        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.get_json()['success'])

    def test_update_rejects_status_text_longer_than_40_characters(self):
        response = self.client.put(
            '/api/admin/service-status',
            json={'status_text': '忙' * 41, 'accepting_orders': True},
            headers={'X-Admin-Key': 'test-admin-key'},
        )

        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.get_json()['success'])

    def test_update_rejects_non_boolean_accepting_orders(self):
        response = self.client.put(
            '/api/admin/service-status',
            json={'status_text': '空闲', 'accepting_orders': 'yes'},
            headers={'X-Admin-Key': 'test-admin-key'},
        )

        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.get_json()['success'])

    def test_admin_update_is_visible_to_public(self):
        update_response = self.client.put(
            '/api/admin/service-status',
            json={'status_text': ' 上课 ', 'accepting_orders': True},
            headers={'X-Admin-Key': 'test-admin-key'},
        )

        self.assertEqual(update_response.status_code, 200)
        self.assertTrue(update_response.get_json()['success'])
        public_data = self.client.get('/api/service-status').get_json()['data']
        self.assertEqual(public_data['status_text'], '上课')
        self.assertTrue(public_data['accepting_orders'])
        self.assertIsNotNone(public_data['updated_at'])


if __name__ == '__main__':
    unittest.main()
