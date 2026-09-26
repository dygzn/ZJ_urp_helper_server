"""日历导出使用的考试详情必须保留在已缓存考试接口中。"""

import json
import os
import tempfile
import unittest
from pathlib import Path

from services.urp_service import get_exams


class CalendarExamDetailsTests(unittest.TestCase):
    def test_cached_exam_retains_campus_building_and_room(self):
        previous = os.getcwd()
        with tempfile.TemporaryDirectory() as directory:
            try:
                os.chdir(directory)
                path = Path('user_data/student/exams.json')
                path.parent.mkdir(parents=True)
                path.write_text(json.dumps({'2': [{
                    '考试名': '期末考试', '课程': '高等数学', '考试周次': '2',
                    '考试星期': '5', '考试时间': '08:30-10:30',
                    '位置': '东校区一教201', '校区': '东校区',
                    '教学楼': '一教', '教室': '201', '座位号': '12',
                }]}, ensure_ascii=False), encoding='utf-8')

                exams = get_exams('student')
                self.assertEqual(exams[0]['campus'], '东校区')
                self.assertEqual(exams[0]['building'], '一教')
                self.assertEqual(exams[0]['room'], '201')
                self.assertEqual(exams[0]['seat'], '12')
            finally:
                os.chdir(previous)


if __name__ == '__main__':
    unittest.main()
