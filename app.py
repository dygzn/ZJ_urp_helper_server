"""
URP教务系统助手 - Flask后端入口
"""
import os
from urllib.parse import urlencode
from flask import Flask, render_template, request, jsonify, redirect, url_for
from werkzeug.exceptions import HTTPException
from database import ensure_api_keys_table, init_db
from services.logging_service import init_logging
from services.config_service import get_admin_key
from routes.auth_routes import auth_bp
from routes.data_routes import data_bp
from routes.admin_routes import admin_bp
from routes.member_routes import member_bp
from routes.shortcut_routes import shortcut_bp
from routes.misc_routes import misc_bp
from routes.sign_routes import sign_bp

app = Flask(__name__)
app.secret_key = 'your-secret-key-change-this'
INDEX_QUERY_ALLOWLIST = ('page', 'invite')

def initialize_database():
    """初始化完整数据库，并为快捷指令 API 保留独立兜底。"""
    try:
        init_db()
    except Exception as e:
        print(f"数据库初始化失败，请进入管理员后台检查数据库配置: {e}")
    finally:
        try:
            ensure_api_keys_table()
        except Exception as e:
            print(f"快捷指令 API 密钥表初始化失败: {e}")


# 初始化数据库
initialize_database()

# 注册日志钩子
init_logging(app)

# 注册所有 Blueprint
app.register_blueprint(auth_bp)
app.register_blueprint(data_bp)
app.register_blueprint(admin_bp)
app.register_blueprint(member_bp)
app.register_blueprint(shortcut_bp)
app.register_blueprint(misc_bp)
app.register_blueprint(sign_bp)

@app.errorhandler(Exception)
def handle_api_exception(error):
    if isinstance(error, HTTPException):
        if request.path.startswith('/api/'):
            return jsonify({
                'success': False,
                'message': error.description,
            }), error.code or 500
        return error

    if request.path.startswith('/api/'):
        return jsonify({
            'success': False,
            'message': f'服务器内部错误: {str(error)}',
        }), 500
    raise error

@app.route('/favicon.ico')
def favicon():
    return '', 204

@app.route('/ad-detail')
def ad_detail():
    return render_template('ad_detail.html')

@app.route('/')
def index():
    if any(key not in INDEX_QUERY_ALLOWLIST for key in request.args):
        clean_params = [
            (key, request.args.get(key))
            for key in INDEX_QUERY_ALLOWLIST
            if request.args.get(key)
        ]
        target = url_for('index')
        if clean_params:
            target = f'{target}?{urlencode(clean_params)}'
        response = redirect(target, code=302)
        response.headers['Cache-Control'] = 'no-store'
        return response
    return render_template('index.html')


if __name__ == '__main__':
    admin_key = get_admin_key()
    print("=" * 50)
    print(f"管理员密钥: {admin_key}")
    print("请妥善保管此密钥，访问管理页面时需要使用")
    print("=" * 50)

    debug = os.environ.get('FLASK_DEBUG', '').lower() in ('1', 'true', 'yes', 'on')
    port = int(os.environ.get('PORT', '5000'))
    app.run(debug=True, host='0.0.0.0', port=port, use_reloader=debug)
