"""
全局常量配置
"""
import os

DATA_DIR = 'data'
DB_FILE = os.path.join(DATA_DIR, 'urp_helper.db')
CONFIG_FILE = os.path.join(DATA_DIR, 'config.json')

# 确保数据目录存在
os.makedirs(DATA_DIR, exist_ok=True)

# 会员支付配置
PAY_API_URL = "https://zfapi.nnt.ltd/api/startOrder"
MERCHANT_NUM = "622981851413626880"
PAY_SECRET_KEY = "31351beba3aa2327817b01c78bccf2f5"
MEMBER_PRICES = {'basic': '3.00', 'advanced': '5.00'}
MEMBER_DURATION_DAYS = 180  # 半年

# 邀请返佣配置：按累计有效邀请人数决定后续每单奖励金额。
# 有效邀请指被邀请用户首次完成有效付费，同一被邀请用户只计一次。
# 达到门槛的订单立即使用新档位，历史已发放收益不补差价。
REFERRAL_LEVELS = [
    {'min_count': 0, 'reward': '0.80'},
    {'min_count': 3, 'reward': '1.00'},
    {'min_count': 10, 'reward': '1.10'},
    {'min_count': 20, 'reward': '1.20'},
]

# 限时邀请任务。发布下一期活动时只需在这里增加或调整配置，
# invitation_milestone_rewards 表会保证同一用户同一任务只奖励一次。
REFERRAL_MILESTONES = [
    {
        'id': '2026-09-invite-10',
        'label': '9月邀请10人',
        'start_at': '2026-09-01T00:00:00',
        'end_at': '2026-09-30T23:59:59',
        'target_count': 10,
        'bonus': '3.00',
    },
]

