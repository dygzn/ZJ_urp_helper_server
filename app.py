"""
URP教务系统助手 - Flask后端主程序
功能：用户绑定管理、教务数据爬取、API接口提供
"""

from flask import Flask, render_template, request, jsonify, session, send_file, Response
from datetime import datetime, timedelta
import json
import os
import hashlib
import uuid
from functools import wraps
import sqlite3
from contextlib import contextmanager

app = Flask(__name__)
app.secret_key = 'your-secret-key-change-this'  # 请修改为随机密钥

# ==================== 配置区域 ====================
DATA_DIR = 'data'  # 数据存储目录
DB_FILE = os.path.join(DATA_DIR, 'urp_helper.db')  # SQLite数据库文件
ADMIN_KEY_FILE = os.path.join(DATA_DIR, 'admin_key.txt')  # 管理员密钥文件
CONFIG_FILE = os.path.join(DATA_DIR, 'config.json')  # 系统配置文件

# 确保数据目录存在
os.makedirs(DATA_DIR, exist_ok=True)


# ==================== 数据库初始化 ====================

@contextmanager
def get_db():
    """获取数据库连接的上下文管理器"""
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row  # 使查询结果可以像字典一样访问
    try:
        yield conn
        conn.commit()
    except Exception as e:
        conn.rollback()
        raise e
    finally:
        conn.close()


def init_db():
    """初始化数据库表结构"""
    with get_db() as conn:
        # 用户绑定表
        conn.execute('''
            CREATE TABLE IF NOT EXISTS users (
                device_id TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                password TEXT NOT NULL,
                bind_time TEXT NOT NULL
            )
        ''')

        # 换绑请求表
        conn.execute('''
            CREATE TABLE IF NOT EXISTS pending_requests (
                request_id TEXT PRIMARY KEY,
                device_id TEXT NOT NULL,
                old_username TEXT NOT NULL,
                new_username TEXT NOT NULL,
                reason TEXT NOT NULL,
                request_time TEXT NOT NULL,
                status TEXT DEFAULT 'pending'
            )
        ''')

        # 公告表
        conn.execute('''
            CREATE TABLE IF NOT EXISTS announcements (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                create_time TEXT NOT NULL,
                is_active INTEGER DEFAULT 1
            )
        ''')

        # 用户已读公告表
        conn.execute('''
            CREATE TABLE IF NOT EXISTS user_read_announcements (
                device_id TEXT NOT NULL,
                announcement_id INTEGER NOT NULL,
                read_time TEXT NOT NULL,
                never_show INTEGER DEFAULT 0,
                PRIMARY KEY (device_id, announcement_id)
            )
        ''')

        # 创建索引以提高查询性能
        conn.execute('''
            CREATE INDEX IF NOT EXISTS idx_username ON users(username)
        ''')
        conn.execute('''
            CREATE INDEX IF NOT EXISTS idx_device_id ON pending_requests(device_id)
        ''')
        conn.execute('''
            CREATE INDEX IF NOT EXISTS idx_announcement_active ON announcements(is_active)
        ''')
        conn.execute('''
            CREATE INDEX IF NOT EXISTS idx_user_read ON user_read_announcements(device_id)
        ''')


# 在应用启动时初始化数据库
init_db()


# ==================== 工具函数 ====================

def get_device_id():
    """
    获取设备唯一标识
    优先使用前端传来的设备ID（存储在 localStorage），否则使用User-Agent+IP生成
    """
    # 优先使用前端传来的设备ID
    device_id = request.headers.get('X-Device-ID')
    if device_id:
        return device_id

    # 降级方案：使用User-Agent+IP（兼容旧版本）
    user_agent = request.headers.get('User-Agent', '')
    ip = request.remote_addr
    device_string = f"{user_agent}_{ip}"
    return hashlib.md5(device_string.encode()).hexdigest()


def load_json_file(filepath, default=None):
    """加载JSON文件（仅用于配置文件）"""
    if default is None:
        default = {}
    if os.path.exists(filepath):
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                return json.load(f)
        except:
            return default
    return default


def save_json_file(filepath, data):
    """保存JSON文件（仅用于配置文件）"""
    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def get_admin_key():
    """获取管理员密钥"""
    # 固定的管理员密钥
    return "786171937Wzs"


def get_config():
    """获取系统配置"""
    default_config = {
        'urp_url': 'http://your-urp-url.com',  # 默认教务系统URL
        'current_url_index': 0,  # 当前使用的URL索引
        'urp_urls': [
            'http://your-urp-url-1.com',
            'http://your-urp-url-2.com'
        ]
    }
    return load_json_file(CONFIG_FILE, default_config)


def save_config(config):
    """保存系统配置"""
    save_json_file(CONFIG_FILE, config)


def get_current_urp_url():
    """获取当前使用的教务系统URL"""
    config = get_config()
    index = config.get('current_url_index', 0)
    urls = config.get('urp_urls', [])
    if urls and 0 <= index < len(urls):
        return urls[index]
    return config.get('urp_url', 'http://your-urp-url.com')


def require_admin(f):
    """管理员权限装饰器"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        admin_key = request.headers.get('X-Admin-Key') or request.headers.get('Admin-Key') or request.args.get('admin_key')
        if admin_key != get_admin_key():
            return jsonify({'success': False, 'message': '管理员密钥错误'}), 403
        return f(*args, **kwargs)
    return decorated_function


def require_login(f):
    """用户登录状态检查装饰器"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        device_id = get_device_id()
        user = get_user_by_device(device_id)

        if not user:
            return jsonify({'success': False, 'message': '未绑定账号'})

        # 检查登录状态
        username = user['username']
        password = user['password']

        is_logged_in, _ = check_login_status(username, password, {})

        if not is_logged_in:
            return jsonify({'success': False, 'message': '登录已失效，请重新绑定'})

        # 将用户信息传递给路由函数
        return f(user=user, *args, **kwargs)

    return decorated_function


def require_bindding(f):
    """账号绑定检查装饰器（不验证URP登录状态）"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        device_id = get_device_id()
        user = get_user_by_device(device_id)

        if not user:
            return jsonify({'success': False, 'message': '请先绑定账号后使用此功能'})

        # 将用户信息传递给路由函数
        return f(user=user, *args, **kwargs)

    return decorated_function


# ==================== 用户绑定管理 ====================

def get_user_by_device(device_id):
    """根据设备ID获取绑定的用户信息"""
    with get_db() as conn:
        row = conn.execute(
            'SELECT * FROM users WHERE device_id = ?',
            (device_id,)
        ).fetchone()
        if row:
            return {
                'device_id': row['device_id'],
                'username': row['username'],
                'password': row['password'],
                'bind_time': row['bind_time']
            }
        return None


def bind_user(device_id, username, password):
    """绑定用户到设备"""
    with get_db() as conn:
        conn.execute('''
            INSERT OR REPLACE INTO users (device_id, username, password, bind_time)
            VALUES (?, ?, ?, ?)
        ''', (device_id, username, password, datetime.now().isoformat()))


def update_user_cookies(device_id, cookies):
    """
    更新用户的cookies（已废弃，cookies现在保存在user_data目录）
    保留此函数以保持兼容性
    """
    # cookies 现在由 URP.py 的 login() 方法自动保存到 user_data/{account}/cookie.json
    # 不再保存到数据库
    return True


def unbind_user(device_id):
    """解绑用户"""
    with get_db() as conn:
        cursor = conn.execute(
            'DELETE FROM users WHERE device_id = ?',
            (device_id,)
        )
        return cursor.rowcount > 0


# ==================== 教务系统交互 ====================

def urp_login(username, password):
    """
    登录URP教务系统
    返回: (success: bool, message: str, cookies: dict)
    """
    from URP import URP_login

    # 获取当前配置的URL
    url = get_current_urp_url()

    try:
        # 创建URP实例并登录
        urp = URP_login(url, username, password)
        login_result = urp.login()

        # 检查登录结果
        if login_result is True:
            # 登录成功，获取cookies
            cookies = urp.x.cookies.get_dict()
            return True, "登录成功", cookies
        elif isinstance(login_result, dict) and 'Error' in login_result:
            # 登录失败，返回错误信息
            return False, login_result['Error'], None
        else:
            # 其他情况
            return False, "登录失败，请检查账号密码", None
    except Exception as e:
        return False, f"登录异常: {str(e)}", None


def check_login_status(username, password, cookies):
    """
    检查登录状态，如果未登录则重新登录
    返回: (is_logged_in: bool, cookies: dict)
    """
    from URP import URP_login

    url = get_current_urp_url()
    urp = URP_login(url, username, password)

    # 检查是否已登录
    is_logged_in = urp.is_logined()

    if is_logged_in is True:
        # 已登录，返回当前cookies
        current_cookies = urp.x.cookies.get_dict()
        return True, current_cookies
    else:
        # 未登录，删除旧cookie文件后重新登录
        cookie_file = f'user_data/{username}/cookie.json'
        if os.path.exists(cookie_file):
            os.remove(cookie_file)

        # 尝试重新登录
        try:
            login_result = urp.login()
            if login_result is True:
                # 重新登录成功
                new_cookies = urp.x.cookies.get_dict()
                return True, new_cookies
            else:
                # 重新登录失败
                return False, {}
        except Exception as e:
            print(f"重新登录失败: {str(e)}")
            return False, {}



def get_urgent_event(username):
    """
    获取最紧急的事件（下一节课或最近的考试）
    返回: {
        'type': 'class' | 'exam',  # 事件类型
        'title': str,  # 课程名称
        'location': str,  # 地点
        'time': str,  # 时间
        'countdown': int,  # 倒计时（分钟）
        'seat': str  # 座位号（仅考试）
    }

    TODO: 实现具体的数据爬取逻辑
    """
    # 临时返回模拟数据
    return {
        'type': 'class',
        'title': '高等数学',
        'location': '教学楼A101',
        'time': '2026-01-26 14:00',
        'countdown': 30
    }


def get_schedule(username, week=None):
    # 读取用户的 schedule.json 文件
    schedule_file = os.path.join('user_data', username, 'schedule.json')

    if not os.path.exists(schedule_file):
        return {
            'week': week,
            'schedule': {},
            'message': '课表文件不存在，请先生成课表'
        }

    try:
        with open(schedule_file, 'r', encoding='utf-8') as f:
            schedule_data = json.load(f)

        # 如果指定了周次，只返回该周的课程
        if week is not None:
            week_str = str(week)
            if week_str in schedule_data:
                return {
                    'week': week,
                    'schedule': {week_str: schedule_data[week_str]}
                }
            else:
                return {
                    'week': week,
                    'schedule': {},
                    'message': f'第{week}周没有课程'
                }

        # 返回所有周次的课程
        return {
            'week': None,
            'schedule': schedule_data
        }
    except Exception as e:
        return {
            'week': week,
            'schedule': {},
            'message': f'读取课表失败: {str(e)}'
        }


def get_exams(username):
    """
    获取考试安排
    返回: [
        {
            'exam_name': str,  # 考试名称
            'course': str,  # 课程名称
            'time': str,  # 考试时间
            'week': str,  # 考试周次
            'day': str,  # 考试星期
            'location': str,  # 考场
            'seat': str  # 座位号
        }
    ]
    """
    # 读取用户的 exams.json 文件
    exams_file = os.path.join('user_data', username, 'exams.json')

    if not os.path.exists(exams_file):
        return []

    try:
        with open(exams_file, 'r', encoding='utf-8') as f:
            exams_data = json.load(f)

        result = []

        # 如果是字典（按周次组织的格式）
        if isinstance(exams_data, dict):
            # 遍历所有周次
            for week, exams in exams_data.items():
                if isinstance(exams, list):
                    for exam in exams:
                        # 转换为前端期望的格式
                        result.append({
                            'exam_name': exam.get('考试名', ''),
                            'course': exam.get('课程', ''),
                            'time': exam.get('考试时间', ''),
                            'week': exam.get('考试周次', ''),
                            'day': exam.get('考试星期', ''),
                            'location': exam.get('位置', ''),
                            'seat': exam.get('座位号', '')
                        })
            return result

        # 如果是列表（已经是期望的格式）
        if isinstance(exams_data, list):
            return exams_data

        return []
    except Exception as e:
        print(f"读取考试安排失败: {str(e)}")
        return []


def get_grades(username):
    """
    获取成绩
    返回: [
        {
            'course': str,  # 课程名称
            'score': str,  # 成绩
        }
    ]
    """
    from URP import URP_query

    # 获取当前配置的URL
    url = get_current_urp_url()

    try:
        # 创建URP_query实例
        urp_query = URP_query(url, username)

        # 调用成绩查询方法
        courses = urp_query.score_query()

        # 转换为前端需要的格式
        grades = []
        for course in courses:
            grades.append({
                'course': course.get('课程名', ''),
                'score': course.get('成绩', '')
            })

        return grades
    except Exception as e:
        print(f"获取成绩失败: {str(e)}")
        # 返回空列表而不是模拟数据
        return []


def get_experiments(username):
    """
    获取实验系统信息

    TODO: 实现具体的数据爬取逻辑
    """
    # 临时返回模拟数据
    return [
        {
            'name': '物理实验1',
            'status': '已完成',
            'score': '90'
        }
    ]


def get_unevaluated_courses(username):
    """
    获取未评估的课程列表

    返回:
        list: 未评估课程列表，如果没有未评估课程则返回None
    """
    try:
        from URP import URP_query
        urp_url = get_current_urp_url()
        query = URP_query(urp_url, username)
        result = query.check_evaluation()
        return result
    except Exception as e:
        print(f"获取未评估课程失败: {str(e)}")
        return None


def do_evaluation(username, courses_data):
    """
    执行教务评价

    参数:
        username: 用户名
        courses_data: 课程数据列表，每个课程包含:
            - wjbm: 问卷编码
            - bpr: 被评人
            - pgnr: 评估内容

    返回:
        (success: bool, message: str)
    """
    try:
        from URP import URP_query
        urp_url = get_current_urp_url()

        urp = URP_query(urp_url, username)
        result = urp.do_evaluation(courses_data)

        if result:
            return True, f"成功评价 {len(courses_data)} 门课程"
        else:
            return False, "评价失败"

    except Exception as e:
        return False, f"评价失败: {str(e)}"


# ==================== 路由：页面渲染 ====================

@app.route('/')
def index():
    """首页"""
    return render_template('index.html')


@app.route('/admin')
def admin():
    """管理页面"""
    return render_template('admin.html')


# ==================== API接口：用户认证 ====================

@app.route('/api/check_bind', methods=['GET'])
def check_bind():
    """
    检查设备是否已绑定账号
    返回: {
        'bound': bool,  # 是否已绑定
        'username': str  # 用户名（如果已绑定）
    }
    """
    device_id = get_device_id()
    user = get_user_by_device(device_id)

    if user:
        return jsonify({
            'success': True,
            'bound': True,
            'username': user['username']
        })
    else:
        return jsonify({
            'success': True,
            'bound': False
        })


@app.route('/api/login', methods=['POST'])
def login():
    """
    用户登录并绑定设备
    请求体: {
        'username': str,
        'password': str
    }
    """
    data = request.get_json()
    username = data.get('username')
    password = data.get('password')

    if not username or not password:
        return jsonify({'success': False, 'message': '用户名和密码不能为空'})

    # 尝试登录教务系统
    success, message, _ = urp_login(username, password)

    if success:
        # 绑定设备（不保存cookies）
        device_id = get_device_id()
        bind_user(device_id, username, password)

        return jsonify({
            'success': True,
            'message': '登录成功',
            'username': username
        })
    else:
        return jsonify({
            'success': False,
            'message': message
        })


@app.route('/api/request_rebind', methods=['POST'])
def request_rebind():
    """
    请求换绑账号
    请求体: {
        'new_username': str,
        'reason': str
    }
    """
    data = request.get_json()
    device_id = get_device_id()
    current_user = get_user_by_device(device_id)

    if not current_user:
        return jsonify({'success': False, 'message': '设备未绑定账号'})

    # 保存换绑请求到数据库
    request_id = str(uuid.uuid4())

    with get_db() as conn:
        conn.execute('''
            INSERT INTO pending_requests
            (request_id, device_id, old_username, new_username, reason, request_time, status)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ''', (
            request_id,
            device_id,
            current_user['username'],
            data.get('new_username', ''),
            data.get('reason', ''),
            datetime.now().isoformat(),
            'pending'
        ))

    return jsonify({
        'success': True,
        'message': '换绑请求已提交，等待管理员审批',
        'request_id': request_id
    })


# ==================== API接口：数据获取 ====================

@app.route('/api/check_login_status', methods=['GET'])
def api_check_login_status():
    """
    检查当前用户的登录状态
    返回: {
        'success': bool,
        'logged_in': bool,
        'username': str,
        'message': str
    }
    """
    device_id = get_device_id()
    user = get_user_by_device(device_id)

    if not user:
        return jsonify({
            'success': True,
            'logged_in': False,
            'message': '未绑定账号'
        })

    # 检查登录状态
    username = user['username']
    password = user['password']
    cookies = user.get('cookies', {})

    from URP import URP_login
    url = get_current_urp_url()

    try:
        urp = URP_login(url, username, password)
        is_logged_in = urp.is_logined()

        # 明确检查是否为 True
        if is_logged_in is True:
            return jsonify({
                'success': True,
                'logged_in': True,
                'username': username,
                'message': '登录状态正常'
            })
        else:
            # 登录失效，尝试重新登录
            login_result = urp.login()

            # 检查登录结果
            if login_result is True:
                # 登录成功，更新cookies
                new_cookies = urp.x.cookies.get_dict()
                update_user_cookies(device_id, new_cookies)

                return jsonify({
                    'success': True,
                    'logged_in': True,
                    'username': username,
                    'message': '重新登录成功'
                })
            else:
                # 登录失败，提取错误信息
                error_msg = '重新登录失败'
                if isinstance(login_result, dict) and 'Error' in login_result:
                    error_msg = login_result['Error']
                elif login_result is False:
                    error_msg = '登录失败，请检查账号密码'

                return jsonify({
                    'success': True,
                    'logged_in': False,
                    'username': username,
                    'message': error_msg
                })
    except Exception as e:
        return jsonify({
            'success': False,
            'logged_in': False,
            'message': f'检查登录状态失败: {str(e)}'
        })


@app.route('/api/urgent_event', methods=['GET'])
@require_login
def api_urgent_event(user):
    """
    获取最紧急的事件
    需要先绑定账号
    """
    try:
        event = get_urgent_event(user['username'])
        return jsonify({
            'success': True,
            'event': event
        })
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@app.route('/api/schedule', methods=['GET'])
@require_bindding
def api_schedule(user):
    """
    获取课程表（读取本地文件，不需要登录）
    参数: week - 周次（可选）
    """
    week = request.args.get('week', type=int)

    try:
        schedule = get_schedule(user['username'], week)
        return jsonify({
            'success': True,
            'data': schedule
        })
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@app.route('/api/update_schedule', methods=['POST'])
@require_login
def api_update_schedule(user):
    """
    更新课程表（从教务系统获取最新数据）
    TODO: 后续实现具体的更新逻辑
    """
    # TODO: 使用 user['username'] 从教务系统获取最新课程表并保存到 schedule.json
    return jsonify({
        'success': False,
        'message': '此功能正在开发中，敬请期待'
    })


@app.route('/api/exams', methods=['GET'])
@require_bindding
def api_exams(user):
    """获取考试安排（读取本地文件，不需要登录）"""
    try:
        exams = get_exams(user['username'])
        return jsonify({
            'success': True,
            'exams': exams
        })
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@app.route('/api/update_exams', methods=['POST'])
@require_login
def api_update_exams(user):
    """更新考试安排（从教务系统获取最新数据）"""
    try:
        from URP import URP_query

        username = user['username']
        password = user['password']

        # 检查登录状态
        is_logged_in, _ = check_login_status(username, password, {})

        if not is_logged_in:
            return jsonify({
                'success': False,
                'message': '登录已过期，请重新登录'
            })

        # 获取当前 URL
        current_url = get_current_urp_url()

        # 创建 URP_query 实例并调用 exam_cx
        urp = URP_query(current_url, username)
        exams_data = urp.exam_cx()

        return jsonify({
            'success': True,
            'message': '考试安排更新成功',
            'data': exams_data
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'message': f'更新失败: {str(e)}'
        })


@app.route('/api/grades', methods=['GET'])
@require_login
def api_grades(user):
    """获取成绩"""
    try:
        grades = get_grades(user['username'])
        return jsonify({
            'success': True,
            'grades': grades
        })
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@app.route('/api/experiments', methods=['GET'])
@require_login
def api_experiments(user):
    """获取实验系统信息"""
    try:
        experiments = get_experiments(user['username'])
        return jsonify({
            'success': True,
            'experiments': experiments
        })
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@app.route('/api/unevaluated_courses', methods=['GET'])
@require_login
def api_unevaluated_courses(user):
    """获取未评估的课程列表"""
    try:
        courses = get_unevaluated_courses(user['username'])

        if courses is None:
            return jsonify({
                'success': True,
                'has_courses': False,
                'message': '没有未评估的课程',
                'courses': []
            })

        return jsonify({
            'success': True,
            'has_courses': True,
            'courses': courses
        })
    except Exception as e:
        return jsonify({'success': False, 'message': f'查询失败: {str(e)}'})


@app.route('/api/evaluation', methods=['POST'])
@require_login
def api_evaluation(user):
    """执行教务评价"""
    try:
        # 获取前端传来的课程数据
        data = request.get_json()
        courses_data = data.get('courses', [])

        if not courses_data:
            return jsonify({'success': False, 'message': '没有课程数据'})

        # 调用评价函数
        success, message = do_evaluation(user['username'], courses_data)
        return jsonify({
            'success': success,
            'message': message
        })
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


# ==================== API接口：论文生成 ====================

@app.route('/api/generate_paper', methods=['POST'])
def api_generate_paper():
    """生成论文（带进度的SSE流）"""
    data = request.get_json()
    if not data or not data.get('title'):
        return jsonify({'success': False, 'message': '请输入论文标题'})

    title = data.get('title', '')
    subject = data.get('subject', '')
    requirements = data.get('requirements', '')
    keywords = data.get('keywords', '')
    wordcount = data.get('wordcount', '3000')
    template = data.get('template', 'simple')

    def generate():
        from paper_generator import generate_paper_content_with_progress
        try:
            for progress in generate_paper_content_with_progress(
                title, subject, requirements, keywords, wordcount, template
            ):
                yield f"data: {json.dumps(progress, ensure_ascii=False)}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)}, ensure_ascii=False)}\n\n"

    return Response(generate(), mimetype='text/event-stream', headers={
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no'
    })


@app.route('/api/download_paper/<filename>')
def download_paper(filename):
    """下载生成的论文"""
    filepath = os.path.join('user_data/papers', filename)
    if not os.path.exists(filepath):
        return jsonify({'success': False, 'message': '文件不存在'}), 404
    return send_file(filepath, as_attachment=True, download_name=filename)


# ==================== API接口：复杂论文需求管理 ====================

USER_REQUEST_DIR = 'user_request'  # 用户需求存储目录

@app.route('/api/save_complex_request', methods=['POST'])
@require_bindding
def save_complex_request(user):
    """保存复杂论文需求（文本或文件）"""
    username = user['username']

    # 创建用户需求目录
    user_request_dir = os.path.join(USER_REQUEST_DIR, username)
    os.makedirs(user_request_dir, exist_ok=True)

    # 生成唯一的请求ID
    request_id = datetime.now().strftime('%Y%m%d_%H%M%S_') + uuid.uuid4().hex[:8]

    # 检查是否有上传文件
    if 'file' in request.files:
        file = request.files['file']
        if file.filename:
            # 保存上传的文件
            safe_filename = f"{request_id}_{file.filename}"
            file_path = os.path.join(user_request_dir, safe_filename)
            file.save(file_path)

            # 保存元数据
            meta = {
                'id': request_id,
                'title': request.form.get('title', ''),
                'requirements': request.form.get('requirements', ''),
                'file': safe_filename,
                'finish_file': None,
                'created_at': datetime.now().isoformat()
            }
    else:
        # 纯文本需求
        data = request.get_json() if request.is_json else request.form
        title = data.get('title', '')
        requirements = data.get('requirements', '')

        if not title:
            return jsonify({'success': False, 'message': '请输入论文标题'})

        meta = {
            'id': request_id,
            'title': title,
            'requirements': requirements,
            'file': None,
            'finish_file': None,
            'created_at': datetime.now().isoformat()
        }

    # 保存元数据文件
    meta_file = os.path.join(user_request_dir, f"{request_id}_meta.json")
    with open(meta_file, 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    return jsonify({'success': True, 'message': '需求保存成功', 'request_id': request_id})


@app.route('/api/get_complex_requests', methods=['GET'])
@require_bindding
def get_complex_requests(user):
    """获取用户保存的所有复杂论文需求"""
    username = user['username']
    user_request_dir = os.path.join(USER_REQUEST_DIR, username)

    if not os.path.exists(user_request_dir):
        return jsonify({'success': True, 'requests': []})

    requests_list = []
    for filename in os.listdir(user_request_dir):
        if filename.endswith('_meta.json'):
            meta_path = os.path.join(user_request_dir, filename)
            with open(meta_path, 'r', encoding='utf-8') as f:
                meta = json.load(f)
                requests_list.append(meta)

    # 按创建时间倒序排列
    requests_list.sort(key=lambda x: x.get('created_at', ''), reverse=True)

    return jsonify({'success': True, 'requests': requests_list})


@app.route('/api/delete_complex_request/<request_id>', methods=['DELETE'])
@require_bindding
def delete_complex_request(user, request_id):
    """删除复杂论文需求"""
    username = user['username']
    user_request_dir = os.path.join(USER_REQUEST_DIR, username)

    # 删除元数据文件和关联的上传文件
    meta_file = os.path.join(user_request_dir, f"{request_id}_meta.json")
    if os.path.exists(meta_file):
        with open(meta_file, 'r', encoding='utf-8') as f:
            meta = json.load(f)

        # 删除上传的文件
        if meta.get('file'):
            file_path = os.path.join(user_request_dir, meta['file'])
            if os.path.exists(file_path):
                os.remove(file_path)

        # 删除元数据文件
        os.remove(meta_file)

        return jsonify({'success': True, 'message': '删除成功'})

    return jsonify({'success': False, 'message': '需求不存在'})


@app.route('/api/download_finished_paper/<request_id>')
@require_bindding
def download_finished_paper(user, request_id):
    """下载已完成的复杂论文"""
    username = user['username']
    user_request_dir = os.path.join(USER_REQUEST_DIR, username)

    # 查找完成的文件
    finish_filename = f"{request_id}_finished.docx"
    finish_filepath = os.path.join(user_request_dir, finish_filename)

    if not os.path.exists(finish_filepath):
        return jsonify({'success': False, 'message': '文件不存在'}), 404

    # 获取论文标题作为下载文件名
    meta_file = os.path.join(user_request_dir, f"{request_id}_meta.json")
    download_name = finish_filename
    if os.path.exists(meta_file):
        with open(meta_file, 'r', encoding='utf-8') as f:
            meta = json.load(f)
            if meta.get('title'):
                download_name = f"{meta['title']}.docx"

    return send_file(finish_filepath, as_attachment=True, download_name=download_name)


@app.route('/api/download_request_file/<request_id>')
@require_bindding
def download_request_file(user, request_id):
    """下载用户上传的需求附件"""
    username = user['username']
    user_request_dir = os.path.join(USER_REQUEST_DIR, username)

    # 读取元数据获取文件名
    meta_file = os.path.join(user_request_dir, f"{request_id}_meta.json")
    if not os.path.exists(meta_file):
        return jsonify({'success': False, 'message': '需求不存在'}), 404

    with open(meta_file, 'r', encoding='utf-8') as f:
        meta = json.load(f)

    if not meta.get('file'):
        return jsonify({'success': False, 'message': '该需求没有附件'}), 404

    file_path = os.path.join(user_request_dir, meta['file'])
    if not os.path.exists(file_path):
        return jsonify({'success': False, 'message': '附件文件不存在'}), 404

    # 提取原始文件名（去掉 request_id 前缀）
    original_filename = meta['file']
    if original_filename.startswith(request_id + '_'):
        original_filename = original_filename[len(request_id) + 1:]

    return send_file(file_path, as_attachment=True, download_name=original_filename)


@app.route('/api/update_request_finish_file/<request_id>', methods=['POST'])
@require_bindding
def update_request_finish_file(user, request_id):
    """更新复杂论文需求的完成文件路径"""
    username = user['username']
    user_request_dir = os.path.join(USER_REQUEST_DIR, username)

    meta_file = os.path.join(user_request_dir, f"{request_id}_meta.json")
    if not os.path.exists(meta_file):
        return jsonify({'success': False, 'message': '需求不存在'})

    data = request.get_json()
    finish_file = data.get('finish_file')

    # 读取并更新元数据
    with open(meta_file, 'r', encoding='utf-8') as f:
        meta = json.load(f)

    meta['finish_file'] = finish_file

    with open(meta_file, 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    return jsonify({'success': True, 'message': '更新成功'})


@app.route('/api/submit_feedback/<request_id>', methods=['POST'])
@require_bindding
def submit_feedback(user, request_id):
    """用户提交论文修改反馈，将论文状态重置为待处理"""
    username = user['username']
    user_request_dir = os.path.join(USER_REQUEST_DIR, username)

    meta_file = os.path.join(user_request_dir, f"{request_id}_meta.json")
    if not os.path.exists(meta_file):
        return jsonify({'success': False, 'message': '需求不存在'})

    data = request.get_json()
    feedback = data.get('feedback', '').strip()

    if not feedback:
        return jsonify({'success': False, 'message': '请输入修改意见'})

    # 读取并更新元数据
    with open(meta_file, 'r', encoding='utf-8') as f:
        meta = json.load(f)

    # 检查是否已完成
    if not meta.get('finish_file'):
        return jsonify({'success': False, 'message': '该需求尚未完成，无法提交反馈'})

    # 添加反馈记录
    if 'feedback_history' not in meta:
        meta['feedback_history'] = []

    meta['feedback_history'].append({
        'feedback': feedback,
        'submitted_at': datetime.now().isoformat(),
        'previous_finish_file': meta['finish_file']
    })

    # 清除完成状态，重新变为待处理
    meta['finish_file'] = None

    with open(meta_file, 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    return jsonify({'success': True, 'message': '反馈提交成功'})


@app.route('/api/confirm_receipt/<request_id>', methods=['POST'])
@require_bindding
def confirm_receipt(user, request_id):
    """用户确认签收论文，删除该需求的所有文件"""
    username = user['username']
    user_request_dir = os.path.join(USER_REQUEST_DIR, username)

    meta_file = os.path.join(user_request_dir, f"{request_id}_meta.json")
    if not os.path.exists(meta_file):
        return jsonify({'success': False, 'message': '需求不存在'})

    # 读取元数据
    with open(meta_file, 'r', encoding='utf-8') as f:
        meta = json.load(f)

    # 检查是否已完成
    if not meta.get('finish_file'):
        return jsonify({'success': False, 'message': '该需求尚未完成，无法签收'})

    # 删除完成的论文文件
    finish_filepath = os.path.join(user_request_dir, meta['finish_file'])
    if os.path.exists(finish_filepath):
        os.remove(finish_filepath)

    # 删除用户上传的附件文件
    if meta.get('file'):
        file_path = os.path.join(user_request_dir, meta['file'])
        if os.path.exists(file_path):
            os.remove(file_path)

    # 删除元数据文件
    os.remove(meta_file)

    # 如果用户文件夹为空，删除该文件夹
    if os.path.exists(user_request_dir) and not os.listdir(user_request_dir):
        os.rmdir(user_request_dir)

    return jsonify({'success': True, 'message': '签收成功'})


# ==================== API接口：管理员功能 ====================

@app.route('/api/admin/complex_requests', methods=['GET'])
@require_admin
def admin_get_all_complex_requests():
    """管理员获取所有用户的复杂论文需求"""
    all_requests = []

    if not os.path.exists(USER_REQUEST_DIR):
        return jsonify({'success': True, 'requests': []})

    # 遍历所有用户目录
    for username in os.listdir(USER_REQUEST_DIR):
        user_dir = os.path.join(USER_REQUEST_DIR, username)
        if os.path.isdir(user_dir):
            for filename in os.listdir(user_dir):
                if filename.endswith('_meta.json'):
                    meta_path = os.path.join(user_dir, filename)
                    with open(meta_path, 'r', encoding='utf-8') as f:
                        meta = json.load(f)
                        meta['username'] = username  # 添加用户名
                        all_requests.append(meta)

    # 按创建时间倒序排列
    all_requests.sort(key=lambda x: x.get('created_at', ''), reverse=True)

    return jsonify({'success': True, 'requests': all_requests})


@app.route('/api/admin/update_finish_file', methods=['POST'])
@require_admin
def admin_update_finish_file():
    """管理员标记复杂论文需求为已完成"""
    data = request.get_json()
    username = data.get('username')
    request_id = data.get('request_id')

    if not username or not request_id:
        return jsonify({'success': False, 'message': '缺少必要参数'})

    user_request_dir = os.path.join(USER_REQUEST_DIR, username)
    meta_file = os.path.join(user_request_dir, f"{request_id}_meta.json")

    if not os.path.exists(meta_file):
        return jsonify({'success': False, 'message': '需求不存在'})

    # 检查完成文件是否存在
    finish_filename = f"{request_id}_finished.docx"
    finish_filepath = os.path.join(user_request_dir, finish_filename)

    if not os.path.exists(finish_filepath):
        return jsonify({'success': False, 'message': f'完成文件不存在，请先将论文放到 user_request/{username}/{finish_filename}'})

    # 读取并更新元数据
    with open(meta_file, 'r', encoding='utf-8') as f:
        meta = json.load(f)

    meta['finish_file'] = finish_filename

    with open(meta_file, 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    return jsonify({'success': True, 'message': '标记完成成功'})


@app.route('/api/admin/upload_finish_file', methods=['POST'])
@require_admin
def admin_upload_finish_file():
    """管理员上传完成的论文文件（自动重命名）"""
    username = request.form.get('username')
    request_id = request.form.get('request_id')

    if not username or not request_id:
        return jsonify({'success': False, 'message': '缺少必要参数'})

    if 'file' not in request.files:
        return jsonify({'success': False, 'message': '请选择要上传的文件'})

    file = request.files['file']
    if not file.filename:
        return jsonify({'success': False, 'message': '请选择要上传的文件'})

    user_request_dir = os.path.join(USER_REQUEST_DIR, username)
    meta_file = os.path.join(user_request_dir, f"{request_id}_meta.json")

    if not os.path.exists(meta_file):
        return jsonify({'success': False, 'message': '需求不存在'})

    # 确保目录存在
    os.makedirs(user_request_dir, exist_ok=True)

    # 保存文件，自动重命名为 {request_id}_finished.docx
    finish_filename = f"{request_id}_finished.docx"
    finish_filepath = os.path.join(user_request_dir, finish_filename)
    file.save(finish_filepath)

    # 更新元数据
    with open(meta_file, 'r', encoding='utf-8') as f:
        meta = json.load(f)

    meta['finish_file'] = finish_filename

    with open(meta_file, 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    return jsonify({'success': True, 'message': '上传成功，已标记为完成'})


@app.route('/api/admin/download_attachment')
def admin_download_attachment():
    """管理员下载用户上传的附件"""
    admin_key = request.args.get('key', '')
    if admin_key != get_admin_key():
        return jsonify({'success': False, 'message': '需要管理员权限'}), 403

    username = request.args.get('username')
    request_id = request.args.get('request_id')

    if not username or not request_id:
        return jsonify({'success': False, 'message': '缺少必要参数'}), 400

    user_request_dir = os.path.join(USER_REQUEST_DIR, username)
    meta_file = os.path.join(user_request_dir, f"{request_id}_meta.json")

    if not os.path.exists(meta_file):
        return jsonify({'success': False, 'message': '需求不存在'}), 404

    with open(meta_file, 'r', encoding='utf-8') as f:
        meta = json.load(f)

    if not meta.get('file'):
        return jsonify({'success': False, 'message': '该需求没有附件'}), 404

    file_path = os.path.join(user_request_dir, meta['file'])
    if not os.path.exists(file_path):
        return jsonify({'success': False, 'message': '附件文件不存在'}), 404

    # 提取原始文件名
    original_filename = meta['file']
    if original_filename.startswith(request_id + '_'):
        original_filename = original_filename[len(request_id) + 1:]

    return send_file(file_path, as_attachment=True, download_name=original_filename)


@app.route('/api/admin/pending_requests', methods=['GET'])
@require_admin
def admin_pending_requests():
    """获取待审批的换绑请求"""
    with get_db() as conn:
        rows = conn.execute('''
            SELECT * FROM pending_requests
            WHERE status = 'pending'
            ORDER BY request_time DESC
        ''').fetchall()

        pending_list = []
        for row in rows:
            pending_list.append({
                'id': row['request_id'],
                'device_id': row['device_id'],
                'old_username': row['old_username'],
                'new_username': row['new_username'],
                'reason': row['reason'],
                'time': row['request_time'],
                'status': row['status']
            })

    return jsonify({
        'success': True,
        'requests': pending_list
    })


@app.route('/api/admin/approve_rebind', methods=['POST'])
@require_admin
def admin_approve_rebind():
    """
    审批换绑请求
    请求体: {
        'request_id': str,
        'approved': bool
    }
    """
    data = request.get_json()
    request_id = data.get('request_id')
    approved = data.get('approved', False)

    with get_db() as conn:
        # 查找请求
        row = conn.execute(
            'SELECT * FROM pending_requests WHERE request_id = ?',
            (request_id,)
        ).fetchone()

        if not row:
            return jsonify({'success': False, 'message': '请求不存在'})

        if approved:
            # 批准换绑 - 只解绑旧账号，让用户重新登录绑定新账号
            unbind_user(row['device_id'])

            # 更新请求状态
            conn.execute(
                'UPDATE pending_requests SET status = ? WHERE request_id = ?',
                ('approved', request_id)
            )
            message = '换绑请求已批准，用户需要重新登录绑定新账号'
        else:
            # 拒绝换绑
            conn.execute(
                'UPDATE pending_requests SET status = ? WHERE request_id = ?',
                ('rejected', request_id)
            )
            message = '换绑请求已拒绝'

    return jsonify({
        'success': True,
        'message': message
    })


@app.route('/api/admin/users', methods=['GET'])
@require_admin
def admin_users():
    """
    获取绑定用户列表（分页）
    参数:
        page: 页码（从1开始，默认1）
        per_page: 每页数量（默认50）
        search: 搜索关键词（可选，搜索用户名）
    """
    # 获取分页参数
    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 50, type=int)
    search = request.args.get('search', '', type=str).strip()

    # 限制每页数量
    per_page = min(per_page, 100)  # 最多100条

    with get_db() as conn:
        # 构建查询
        if search:
            # 搜索用户名
            query = '''
                SELECT device_id, username, bind_time
                FROM users
                WHERE username LIKE ?
                ORDER BY bind_time DESC
            '''
            rows = conn.execute(query, (f'%{search}%',)).fetchall()
        else:
            query = '''
                SELECT device_id, username, bind_time
                FROM users
                ORDER BY bind_time DESC
            '''
            rows = conn.execute(query).fetchall()

        # 构建用户列表
        user_list = []
        for row in rows:
            user_list.append({
                'device_id': row['device_id'],
                'username': row['username'],
                'bind_time': row['bind_time']
            })

    # 计算分页
    total = len(user_list)
    total_pages = (total + per_page - 1) // per_page  # 向上取整

    # 获取当前页数据
    start = (page - 1) * per_page
    end = start + per_page
    page_data = user_list[start:end]

    return jsonify({
        'success': True,
        'users': page_data,
        'pagination': {
            'page': page,
            'per_page': per_page,
            'total': total,
            'total_pages': total_pages,
            'has_prev': page > 1,
            'has_next': page < total_pages
        }
    })


@app.route('/api/admin/config', methods=['GET'])
@require_admin
def admin_get_config():
    """获取系统配置"""
    config = get_config()
    return jsonify({
        'success': True,
        'config': config
    })


@app.route('/api/admin/config/url', methods=['POST'])
@require_admin
def admin_switch_url():
    """
    切换教务系统URL
    请求体: {
        'url_index': int  # URL索引（0或1）
    }
    或
    {
        'urls': [str, str]  # 更新URL列表
    }
    """
    data = request.get_json()
    config = get_config()

    # 如果提供了新的URL列表，更新它
    if 'urls' in data:
        urls = data['urls']
        if isinstance(urls, list) and len(urls) >= 2:
            config['urp_urls'] = urls
            save_config(config)
            return jsonify({
                'success': True,
                'message': 'URL列表已更新',
                'config': config
            })
        else:
            return jsonify({'success': False, 'message': 'URL列表格式错误，需要至少2个URL'})

    # 切换URL索引
    if 'url_index' in data:
        url_index = data['url_index']
        urls = config.get('urp_urls', [])

        if 0 <= url_index < len(urls):
            config['current_url_index'] = url_index
            save_config(config)

            return jsonify({
                'success': True,
                'message': f'已切换到URL: {urls[url_index]}',
                'config': config
            })
        else:
            return jsonify({'success': False, 'message': 'URL索引超出范围'})

    return jsonify({'success': False, 'message': '缺少必要参数'})


# ==================== API接口：公告管理 ====================

@app.route('/api/admin/announcements', methods=['GET'])
@require_admin
def admin_get_announcements():
    """获取所有公告列表"""
    with get_db() as conn:
        rows = conn.execute('''
            SELECT id, title, content, create_time, is_active
            FROM announcements
            ORDER BY create_time DESC
        ''').fetchall()

        announcements = []
        for row in rows:
            announcements.append({
                'id': row['id'],
                'title': row['title'],
                'content': row['content'],
                'create_time': row['create_time'],
                'is_active': bool(row['is_active'])
            })

    return jsonify({
        'success': True,
        'announcements': announcements
    })


@app.route('/api/admin/announcements', methods=['POST'])
@require_admin
def admin_create_announcement():
    """
    创建新公告
    请求体: {
        'title': str,
        'content': str
    }
    """
    data = request.get_json()
    title = data.get('title', '').strip()
    content = data.get('content', '').strip()

    if not title or not content:
        return jsonify({'success': False, 'message': '标题和内容不能为空'})

    with get_db() as conn:
        cursor = conn.execute('''
            INSERT INTO announcements (title, content, create_time, is_active)
            VALUES (?, ?, ?, 1)
        ''', (title, content, datetime.now().isoformat()))

        announcement_id = cursor.lastrowid

    return jsonify({
        'success': True,
        'message': '公告发布成功',
        'announcement_id': announcement_id
    })


@app.route('/api/admin/announcements/<int:announcement_id>', methods=['PUT'])
@require_admin
def admin_update_announcement(announcement_id):
    """
    更新公告
    请求体: {
        'title': str,
        'content': str,
        'is_active': bool
    }
    """
    data = request.get_json()
    title = data.get('title', '').strip()
    content = data.get('content', '').strip()
    is_active = data.get('is_active', True)

    if not title or not content:
        return jsonify({'success': False, 'message': '标题和内容不能为空'})

    with get_db() as conn:
        cursor = conn.execute('''
            UPDATE announcements
            SET title = ?, content = ?, is_active = ?
            WHERE id = ?
        ''', (title, content, 1 if is_active else 0, announcement_id))

        if cursor.rowcount == 0:
            return jsonify({'success': False, 'message': '公告不存在'})

    return jsonify({
        'success': True,
        'message': '公告更新成功'
    })


@app.route('/api/admin/announcements/<int:announcement_id>', methods=['DELETE'])
@require_admin
def admin_delete_announcement(announcement_id):
    """删除公告"""
    with get_db() as conn:
        cursor = conn.execute('''
            DELETE FROM announcements WHERE id = ?
        ''', (announcement_id,))

        if cursor.rowcount == 0:
            return jsonify({'success': False, 'message': '公告不存在'})

    return jsonify({
        'success': True,
        'message': '公告删除成功'
    })


@app.route('/api/announcements', methods=['GET'])
def get_announcements():
    """获取所有活跃的公告（用户端）"""
    device_id = get_device_id()

    with get_db() as conn:
        # 获取所有活跃公告
        rows = conn.execute('''
            SELECT id, title, content, create_time
            FROM announcements
            WHERE is_active = 1
            ORDER BY create_time DESC
        ''').fetchall()

        announcements = []
        for row in rows:
            # 检查用户是否已读
            read_row = conn.execute('''
                SELECT never_show FROM user_read_announcements
                WHERE device_id = ? AND announcement_id = ?
            ''', (device_id, row['id'])).fetchone()

            is_read = read_row is not None
            never_show = read_row['never_show'] if read_row else 0

            announcements.append({
                'id': row['id'],
                'title': row['title'],
                'content': row['content'],
                'create_time': row['create_time'],
                'is_read': is_read,
                'never_show': bool(never_show)
            })

    return jsonify({
        'success': True,
        'announcements': announcements
    })


@app.route('/api/announcements/<int:announcement_id>/read', methods=['POST'])
def mark_announcement_read(announcement_id):
    """
    标记公告为已读
    请求体: {
        'never_show': bool  # 是否不再显示
    }
    """
    device_id = get_device_id()
    data = request.get_json() or {}
    never_show = data.get('never_show', False)

    with get_db() as conn:
        # 检查公告是否存在
        announcement = conn.execute('''
            SELECT id FROM announcements WHERE id = ?
        ''', (announcement_id,)).fetchone()

        if not announcement:
            return jsonify({'success': False, 'message': '公告不存在'})

        # 插入或更新已读记录
        conn.execute('''
            INSERT OR REPLACE INTO user_read_announcements
            (device_id, announcement_id, read_time, never_show)
            VALUES (?, ?, ?, ?)
        ''', (device_id, announcement_id, datetime.now().isoformat(), 1 if never_show else 0))

    return jsonify({
        'success': True,
        'message': '已标记为已读'
    })


if __name__ == '__main__':
    # 启动时显示管理员密钥
    admin_key = get_admin_key()
    print("=" * 50)
    print(f"管理员密钥: {admin_key}")
    print("请妥善保管此密钥，访问管理页面时需要使用")
    print("=" * 50)

    app.run(debug=True, host='0.0.0.0', port=5000)
