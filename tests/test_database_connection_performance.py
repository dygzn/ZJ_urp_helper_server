"""用驱动替身计数网络连接，禁止测试访问真实 MySQL。"""

import sys
import types
import unittest
from unittest.mock import patch

import database


class FakeConnection:
    def __init__(self):
        self.statements = []
        self.commits = 0
        self.rollbacks = 0
        self.closed = False

    def cursor(self):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def execute(self, sql, params=()):
        self.statements.append(sql)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        self.closed = True


class DatabaseConnectionPerformanceTests(unittest.TestCase):
    def setUp(self):
        self.config = {'database': {'type': 'mysql', 'mysql': {
            'host': 'database.invalid', 'user': 'test', 'database': 'test',
        }}}
        self.connections = []
        module = types.ModuleType('pymysql')
        module.cursors = types.SimpleNamespace(DictCursor=object)

        def connect(**kwargs):
            conn = FakeConnection()
            self.connections.append((kwargs, conn))
            return conn

        module.connect = connect
        replacement = patch.dict(sys.modules, {'pymysql': module})
        replacement.start()
        self.addCleanup(replacement.stop)

    def test_business_transaction_opens_one_connection_without_creating_database(self):
        with database.get_db(self.config) as conn:
            conn.execute('SELECT 1')
        self.assertEqual(len(self.connections), 1)
        kwargs, raw = self.connections[0]
        self.assertEqual(kwargs['database'], 'test')
        self.assertEqual(raw.statements, ['SELECT 1'])
        self.assertEqual(raw.commits, 1)
        self.assertTrue(raw.closed)

    def test_failed_business_transaction_rolls_back_and_closes_single_connection(self):
        with self.assertRaisesRegex(ValueError, 'rollback'):
            with database.get_db(self.config):
                raise ValueError('rollback')
        self.assertEqual(len(self.connections), 1)
        raw = self.connections[0][1]
        self.assertEqual(raw.rollbacks, 1)
        self.assertEqual(raw.commits, 0)
        self.assertTrue(raw.closed)

    def test_explicit_bootstrap_still_creates_database(self):
        conn = database._connect_mysql(database.get_database_config(self.config), ensure_database=True)
        conn.close()
        self.assertEqual(len(self.connections), 2)
        self.assertTrue(self.connections[0][1].statements[0].startswith('CREATE DATABASE IF NOT EXISTS'))
        self.assertTrue(all(raw.closed for _, raw in self.connections))


if __name__ == '__main__':
    unittest.main()
