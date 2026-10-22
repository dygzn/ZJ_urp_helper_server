"""Render production Jinja templates without importing Flask or touching its database."""
import sys
from pathlib import Path
from jinja2 import Environment, FileSystemLoader

root = Path(__file__).resolve().parents[2]
env = Environment(loader=FileSystemLoader(root / 'templates'), autoescape=True)
env.globals['static_versioned'] = lambda file: '/static/' + file
ad = dict(enabled='--ad' in sys.argv, title='校园活动', detail_title='让学习更有条理',
          summary='这里展示管理员发布的活动说明。', body='活动内容由后台配置。\n请以实际活动说明为准。',
          image_url='', cover_url='', contact='校园活动咨询', button_url='https://example.com/activity', button_text='查看活动')
print(env.get_template(sys.argv[1]).render(ad=ad, member_page_enabled='--no-member' not in sys.argv))
