"""原课表接口的解析实现，保留供回退和对照使用。"""

import json
import os
from collections import defaultdict

from bs4 import BeautifulSoup
from services.temporary_session_service import user_data_file


def schedule_cx_legacy(query):
    """使用原 ``xkAction.do`` 接口获取并缓存当前课表。"""
    headers = {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
        'Connection': 'keep-alive',
        'Referer': f'{query.url}menu/menu.jsp',
        'Upgrade-Insecure-Requests': '1',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 Edg/145.0.0.0',
    }
    response = query._request(
        'GET',
        f'{query.url}xkAction.do',
        headers=headers,
        params={'actionType': '6', 'yzxh': query.account},
        verify=False,
    )
    soup = BeautifulSoup(response.text, 'html.parser')

    course_table = next(
        (t for t in soup.find_all('table') if t.find('th', class_='sortable')),
        None,
    )
    if not course_table:
        raise Exception("未找到课表数据，学校可能暂未开放课表查询")

    schedule_by_week = defaultdict(list)
    current_course_info = {}

    for row in course_table.find_all('tr', class_='odd'):
        tds = row.find_all('td')
        if not tds:
            continue

        if any(td.get('rowspan') for td in tds):
            rowspan_tds = [td for td in tds if td.get('rowspan')]
            if len(rowspan_tds) >= 5:
                current_course_info['课程号'] = rowspan_tds[1].get_text(strip=True)
                current_course_info['课程名'] = rowspan_tds[2].get_text(strip=True)
                current_course_info['学分'] = rowspan_tds[4].get_text(strip=True)
            if len(rowspan_tds) >= 8:
                current_course_info['教师'] = rowspan_tds[7].get_text(strip=True).rstrip('* ')

        if len(tds) >= 7 and current_course_info.get('课程名'):
            week_str, day_str, period_str, duration_str = (
                tds[-7].get_text(strip=True),
                tds[-6].get_text(strip=True),
                tds[-5].get_text(strip=True),
                tds[-4].get_text(strip=True),
            )
            campus_str, building_str, room_str = (
                tds[-3].get_text(strip=True),
                tds[-2].get_text(strip=True),
                tds[-1].get_text(strip=True),
            )

            if week_str:
                weeks = query._parse_weeks(week_str)
                location = f"{campus_str}{building_str}{room_str}"
                period_num = query._parse_period(period_str)
                for week in weeks:
                    schedule_by_week[week].append({
                        '课程号': current_course_info.get('课程号', ''),
                        '课程名': current_course_info['课程名'],
                        '学分': current_course_info.get('学分', ''),
                        '教师': current_course_info.get('教师', ''),
                        '星期': day_str,
                        '节次': period_num,
                        '节数': duration_str,
                        '校区': campus_str,
                        '教学楼': building_str,
                        '教室': room_str,
                        '位置': location,
                    })

    schedule_data = {str(k): v for k, v in schedule_by_week.items()}

    user_dir = os.path.dirname(user_data_file(query.account, 'schedule.json'))
    os.makedirs(user_dir, exist_ok=True)
    with open(os.path.join(user_dir, 'schedule.json'), 'w', encoding='utf-8') as f:
        json.dump(schedule_data, f, ensure_ascii=False, indent=2)

    return schedule_data
