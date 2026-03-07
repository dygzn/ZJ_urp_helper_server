"""
URP教务系统助手 - Flask后端入口
"""
from flask import Flask, render_template

from database import init_db
from services.logging_service import init_logging
from services.config_service import get_admin_key

from routes.auth_routes import auth_bp
from routes.data_routes import data_bp
from routes.admin_routes import admin_bp
from routes.member_routes import member_bp
from routes.misc_routes import misc_bp

app = Flask(__name__)
app.secret_key = 'your-secret-key-change-this'

# 初始化数据库
init_db()

# 注册日志钩子
init_logging(app)

# 注册所有 Blueprint
app.register_blueprint(auth_bp)
app.register_blueprint(data_bp)
app.register_blueprint(admin_bp)
app.register_blueprint(member_bp)
app.register_blueprint(misc_bp)


@app.route('/')
def index():
    return render_template('index.html')


if __name__ == '__main__':
    admin_key = get_admin_key()
    print("=" * 50)
    print(f"管理员密钥: {admin_key}")
    print("请妥善保管此密钥，访问管理页面时需要使用")
    print("=" * 50)

    app.run(debug=True, host='0.0.0.0', port=5000)
