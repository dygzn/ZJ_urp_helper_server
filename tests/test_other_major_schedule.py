"""跨专业课表使用课程最多的有效样本，输出保留脱敏契约。"""
import json
import os
import random
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from flask import Flask

from database import get_db, init_db
from routes.data_routes import data_bp


def course(name, **extra):
    return {'课程名': name, '星期': '1', '节次': '1', '节数': '2', **extra}


class OtherMajorScheduleTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        previous_cwd = os.getcwd()
        os.chdir(self.directory.name)
        self.addCleanup(os.chdir, previous_cwd)
        config = {'database': {'type': 'sqlite', 'sqlite_path': str(Path(self.directory.name) / 'test.db')},
                  'semester_start': '2026-09-07'}
        for name in ('database.get_config', 'routes.data_routes.get_config'):
            override = patch(name, return_value=config)
            override.start()
            self.addCleanup(override.stop)
        init_db(config)
        with get_db() as conn:
            conn.execute('INSERT INTO user_account VALUES (?, ?, ?, ?, ?)', ('viewer', '', '2026', '2026', '2026'))
            conn.execute('INSERT INTO users (device_id, username, password, bind_time) VALUES (?, ?, ?, ?)',
                         ('viewer-device', 'viewer', '', '2026'))
        state = random.getstate()
        self.addCleanup(random.setstate, state)
        random.seed(1)
        app = Flask(__name__)
        app.register_blueprint(data_bp)
        self.client = app.test_client()

    def cache(self, index, data):
        username = f'24001231{index:02d}'
        with get_db() as conn:
            conn.execute('INSERT INTO user_account VALUES (?, ?, ?, ?, ?)', (username, '', '2026', '2026', '2026'))
        path = Path('user_data') / username / 'schedule.json'
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
        return path

    def query(self):
        return self.client.get('/api/schedule/other_major?grade=24&major=123&class_num=1',
                               headers={'X-Device-ID': 'viewer-device'}).get_json()

    def test_selects_most_courses_and_only_exposes_public_fields(self):
        self.cache(1, {'1': [course('退选后唯一课程')]})
        self.cache(2, {'1': [course('高等数学', 教师='私人信息'), course('英语')], '2': [course('物理')]})
        response = self.query()
        self.assertTrue(response['success'])
        self.assertEqual(response['data'], {'grade': '24', 'major': '123', 'class_num': '1',
                                           'semester_start': '2026-09-07',
                                           'schedule': {'1': [course('高等数学'), course('英语')], '2': [course('物理')]}})

    def test_corrupt_and_incomplete_candidates_do_not_hide_valid_sample(self):
        self.cache(1, {}).write_text('{broken', encoding='utf-8')
        self.cache(2, {'1': [{'课程名': '缺节次'}, course('非法星期', 星期='8'), None] * 10,
                       '2': 'not-a-list'})
        self.cache(3, {'1': [course('正常课程')]})
        response = self.query()
        self.assertTrue(response['success'])
        self.assertEqual(response['data']['schedule'], {'1': [course('正常课程')]})

    def test_equal_course_count_prefers_more_covered_weeks(self):
        self.cache(1, {'1': [course('数学'), course('英语')]})
        self.cache(2, {'1': [course('数学')], '2': [course('英语')]})
        self.assertEqual(self.query()['data']['schedule'], {'1': [course('数学')], '2': [course('英语')]})

    def test_no_valid_courses_keeps_the_existing_failure_contract(self):
        self.cache(1, {'1': []})
        self.cache(2, [])
        response = self.query()
        self.assertEqual(response, {'success': False, 'message': '暂无 24级专业123 1班 的课表数据'})


if __name__ == '__main__':
    unittest.main()
