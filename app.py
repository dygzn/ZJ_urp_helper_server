"""
URP教务系统助手 - Flask后端入口
"""
import os
from urllib.parse import urlencode
from flask import Flask, render_template, request, jsonify, redirect, url_for
from werkzeug.exceptions import HTTPException
from database import ensure_api_keys_table, init_db
from services.logging_service import init_logging
from services.config_service import configure_app_security, get_config
from services.ad_service import EVENT_COLUMNS, record_ad_event
from services.ad_config_service import get_ad_config
from services.temporary_session_service import start_temporary_session_cleanup
from routes.auth_routes import auth_bp
from routes.data_routes import data_bp
from routes.admin_routes import admin_bp
from routes.member_routes import member_bp
from routes.shortcut_routes import shortcut_bp
from routes.misc_routes import misc_bp
from routes.wechat_routes import wechat_bp
from routes.lab_routes import lab_bp

app = Flask(__name__)
configure_app_security(app)
INDEX_QUERY_ALLOWLIST = ('page', 'invite')


@app.template_global()
def static_versioned(filename):
    """使用纳秒级修改时间生成静态资源版本，文件更新后立即生效。"""
    try:
        version = os.stat(os.path.join(app.static_folder, filename)).st_mtime_ns
    except OSError:
        # 缺失或暂时不可读的资源仍交由静态路由处理，不中断页面渲染。
        return url_for('static', filename=filename)
    return url_for('static', filename=filename, v=version)


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

@app.before_request
def ensure_temporary_session_cleanup():
    start_temporary_session_cleanup()

# 注册日志钩子
init_logging(app)

# 注册所有 Blueprint
app.register_blueprint(auth_bp)
app.register_blueprint(data_bp)
app.register_blueprint(admin_bp)
app.register_blueprint(member_bp)
app.register_blueprint(shortcut_bp)
app.register_blueprint(misc_bp)
app.register_blueprint(wechat_bp)
app.register_blueprint(lab_bp)

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
    ad = get_ad_config()
    if not ad['enabled']:
        return render_template('ad_detail.html', ad=ad), 404
    response = render_template('ad_detail.html', ad=ad)
    if request.args.get('source') == 'header':
        try:
            record_ad_event('click')
        except Exception:
            # 统计属于附加能力，数据库异常时不能影响广告详情页正常打开。
            app.logger.exception('广告点击统计写入失败')
    return response


@app.route('/api/ad/event', methods=['POST'])
def ad_event():
    if not get_ad_config()['enabled']:
        return '', 204
    data = request.get_json(silent=True) or {}
    event_type = data.get('event')
    if event_type not in EVENT_COLUMNS:
        return jsonify({'success': False, 'message': '无效的广告事件'}), 400
    try:
        if event_type == 'copy':
            record_ad_event(event_type, username=data.get('username'))
        else:
            record_ad_event(event_type)
    except Exception:
        # 前端统计请求不应影响广告本身的展示和操作。
        app.logger.exception('广告漏斗统计写入失败')
    return '', 204

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
    config = get_config()
    return render_template(
        'index.html',
        ad=get_ad_config(),
        member_page_enabled=config.get('member_page_enabled', True) is not False,
    )


if __name__ == '__main__':
    debug = os.environ.get('FLASK_DEBUG', '').lower() in ('1', 'true', 'yes', 'on')
    host = '127.0.0.1' if debug else os.environ.get('HOST', '0.0.0.0')
    port = int(os.environ.get('PORT', '5050'))
    app.run(debug=debug, host=host, port=port, use_reloader=debug)
