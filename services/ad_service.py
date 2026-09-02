"""广告访问统计服务。

只保存按广告和日期聚合后的次数，不保存设备号、学号或 IP 等用户标识。
"""
from datetime import datetime, timedelta

from database import get_database_config, get_db


AD_KEY = 'student-discount'
EVENT_COLUMNS = {
    'impression': 'impression_count',
    'click': 'click_count',
    'copy': 'copy_count',
    'dismiss': 'dismiss_count',
}


def _current_time(value=None):
    return value or datetime.now()


def record_ad_event(event_type, db_config=None, now=None):
    """记录一次广告漏斗事件，按本地日期匿名聚合。"""
    column = EVENT_COLUMNS.get(event_type)
    if column is None:
        raise ValueError('无效的广告事件')

    current = _current_time(now)
    click_date = current.strftime('%Y-%m-%d')
    updated_at = current.isoformat(timespec='seconds')
    db_type = get_database_config(db_config)['type']
    insert_prefix = 'INSERT IGNORE' if db_type == 'mysql' else 'INSERT OR IGNORE'

    with get_db(db_config) as conn:
        # 先确保当天聚合行存在，再用原子自增避免并发请求覆盖计数。
        conn.execute(
            f'{insert_prefix} INTO ad_click_stats '
            '(ad_key, click_date, impression_count, click_count, copy_count, '
            'dismiss_count, updated_at) VALUES (?, ?, 0, 0, 0, 0, ?)',
            (AD_KEY, click_date, updated_at),
        )
        conn.execute(
            'UPDATE ad_click_stats '
            f'SET {column} = {column} + 1, updated_at = ? '
            'WHERE ad_key = ? AND click_date = ?',
            (updated_at, AD_KEY, click_date),
        )


def record_ad_click(db_config=None, now=None):
    """兼容旧调用方：记录一次广告横幅点击。"""
    record_ad_event('click', db_config, now)


def _percentage(numerator, denominator):
    if not denominator:
        return 0.0
    return round((numerator / denominator) * 100, 1)


def get_ad_click_stats(db_config=None, now=None, daily_days=14):
    """返回累计、今日、近七日和最近若干天的广告进入次数。"""
    if daily_days < 1:
        raise ValueError('daily_days 必须大于 0')

    current = _current_time(now)
    today = current.date()
    start_date = today - timedelta(days=daily_days - 1)
    today_string = today.isoformat()
    start_string = start_date.isoformat()

    with get_db(db_config) as conn:
        total_row = conn.execute(
            'SELECT '
            'COALESCE(SUM(impression_count), 0) AS total_impressions, '
            'COALESCE(SUM(click_count), 0) AS total_clicks, '
            'COALESCE(SUM(copy_count), 0) AS total_copies, '
            'COALESCE(SUM(dismiss_count), 0) AS total_dismissals '
            'FROM ad_click_stats WHERE ad_key = ?',
            (AD_KEY,),
        ).fetchone()
        rows = conn.execute(
            'SELECT click_date, impression_count, click_count, copy_count, '
            'dismiss_count FROM ad_click_stats '
            'WHERE ad_key = ? AND click_date >= ? ORDER BY click_date ASC',
            (AD_KEY, start_string),
        ).fetchall()

    counts = {
        str(row['click_date']): {
            'impressions': int(row['impression_count'] or 0),
            'clicks': int(row['click_count'] or 0),
            'copies': int(row['copy_count'] or 0),
            'dismissals': int(row['dismiss_count'] or 0),
        }
        for row in rows
    }
    daily = []
    for offset in range(daily_days):
        day = start_date + timedelta(days=offset)
        day_string = day.isoformat()
        values = counts.get(day_string, {
            'impressions': 0,
            'clicks': 0,
            'copies': 0,
            'dismissals': 0,
        })
        daily.append({'date': day_string, 'count': values['clicks'], **values})

    last_seven_days = sum(
        counts.get(
            (today - timedelta(days=offset)).isoformat(),
            {'clicks': 0},
        )['clicks']
        for offset in range(min(7, daily_days))
    )

    total_impressions = int(total_row['total_impressions'] or 0)
    total_clicks = int(total_row['total_clicks'] or 0)
    total_copies = int(total_row['total_copies'] or 0)
    total_dismissals = int(total_row['total_dismissals'] or 0)
    today_values = counts.get(today_string, {
        'impressions': 0,
        'clicks': 0,
        'copies': 0,
        'dismissals': 0,
    })

    return {
        'total_impressions': total_impressions,
        'total_clicks': total_clicks,
        'total_copies': total_copies,
        'total_dismissals': total_dismissals,
        'today_impressions': today_values['impressions'],
        'today_clicks': today_values['clicks'],
        'today_copies': today_values['copies'],
        'last_7_days_clicks': last_seven_days,
        'click_through_rate': _percentage(total_clicks, total_impressions),
        'detail_conversion_rate': _percentage(total_copies, total_clicks),
        'overall_conversion_rate': _percentage(total_copies, total_impressions),
        'daily': daily,
    }
