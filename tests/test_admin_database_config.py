import unittest
from unittest import mock

from flask import Flask

from routes.admin_routes import admin_bp


class AdminDatabaseConfigTests(unittest.TestCase):
    def setUp(self):
        app = Flask(__name__)
        app.register_blueprint(admin_bp)
        self.client = app.test_client()
        self.admin_key = mock.patch('auth.get_admin_key', return_value='test-key')
        self.admin_key.start()
        self.addCleanup(self.admin_key.stop)

    def test_get_config_does_not_return_mysql_password(self):
        config = {
            'database': {
                'type': 'mysql',
                'mysql': {
                    'host': 'db.example', 'port': 3306,
                    'database': 'urp', 'user': 'app', 'password': 'secret',
                },
            }
        }
        with mock.patch('routes.admin_routes.get_config', return_value=config):
            response = self.client.get(
                '/api/admin/config', headers={'Admin-Key': 'test-key'}
            )

        self.assertEqual(response.status_code, 200)
        self.assertNotIn('password', response.get_json()['config']['database']['mysql'])

    def test_save_response_does_not_return_existing_password(self):
        config = {
            'database': {
                'type': 'mysql',
                'sqlite_path': 'data/urp_helper.db',
                'mysql': {
                    'host': 'old.example', 'port': 3306,
                    'database': 'urp', 'user': 'app', 'password': 'secret',
                },
            }
        }
        with (
            mock.patch('routes.admin_routes.get_config', return_value=config),
            mock.patch('routes.admin_routes.test_database_config', return_value=(True, 'ok')),
            mock.patch('routes.admin_routes.save_config') as save_config,
        ):
            response = self.client.post(
                '/api/admin/config/database',
                headers={'Admin-Key': 'test-key'},
                json={'type': 'mysql', 'mysql': {
                    'host': 'new.example', 'port': 3306,
                    'database': 'urp', 'user': 'app', 'password': '',
                }},
            )

        self.assertEqual(response.status_code, 200)
        self.assertNotIn('password', response.get_json()['config']['database']['mysql'])
        saved = save_config.call_args.args[0]
        self.assertEqual(saved['database']['mysql']['password'], 'secret')


if __name__ == '__main__':
    unittest.main()
