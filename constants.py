"""
全局常量配置
"""
import os

DATA_DIR = 'data'
DB_FILE = os.path.join(DATA_DIR, 'urp_helper.db')
ADMIN_KEY_FILE = os.path.join(DATA_DIR, 'admin_key.txt')
CONFIG_FILE = os.path.join(DATA_DIR, 'config.json')

# 确保数据目录存在
os.makedirs(DATA_DIR, exist_ok=True)

# 会员支付配置
PAY_API_URL = "https://zfapi.nnt.ltd/api/startOrder"
MERCHANT_NUM = "622981851413626880"
PAY_SECRET_KEY = "31351beba3aa2327817b01c78bccf2f5"
MEMBER_PRICES = {'basic': '3.00', 'advanced': '5.00'}
MEMBER_DURATION_DAYS = 180  # 半年

# 对分易签到服务
DUIFENE_BASE_URL = "https://www.buxiangshangke.icu"

# 免费白名单：这些 URP 学号不需要会员即可使用签到功能
SIGN_FREE_USERS = {
    '202100001',   # 你朋友的学号，可继续添加
}

