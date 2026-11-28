# URP 教务助手

基于 Flask、原生 JavaScript 和 HTML/CSS 的教务辅助工具，提供教务账号绑定、课表、成绩、考试、评教、管理员后台，以及可选的微信小程序、实验报告提交和会员支付功能。网页端无需 Node.js 或前端构建步骤。

> **适用范围：面向所有采用 URP 系列教务系统的高校，原则上可通过适配用于各校部署。** 不同学校的 URP 版本、登录认证、验证码、接口路径和页面结构可能不同，部署时需要核对并调整相应配置或解析代码。当前仓库包含学校专用的 VPN、实验站和客户端配置，各校兼容性以实际联调结果为准。

## 1. 部署前准备

- 一台能访问目标学校教务系统的服务器；仅校园网可访问的教务系统，需要先接入学校允许的校园网络或 VPN。
- Python 环境：建议优先使用 Python 3.10 或 3.11。依赖含固定版本的 NumPy、ONNX Runtime 和验证码识别组件，安装前确认目标 Python 版本与系统架构有对应安装包。
- 默认使用 SQLite，无需额外安装数据库；也可在后台配置 MySQL/MariaDB。
- 正式部署准备域名与有效 HTTPS 证书。以下生产示例使用 Linux、systemd、Gunicorn 和 Nginx。

所有启动命令均在包含 `app.py` 的仓库根目录执行。运行数据使用相对路径，工作目录错误会导致读取另一份配置或创建另一份数据库。

## 2. 获取代码与安装依赖

以 Ubuntu 22.04 为例，可先安装 Python 虚拟环境工具、Git、Nginx 和 ONNX Runtime 常用的系统运行库；其他发行版按包管理器调整：

```bash
sudo apt-get update
sudo apt-get install -y python3 python3-venv python3-pip git nginx libgomp1
```

```bash
git clone https://github.com/dygzn/ZJ_urp_helper_server.git
cd ZJ_urp_helper_server
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

Windows 可使用 `py -3 -m venv .venv` 创建虚拟环境，并在 PowerShell 中运行 `.\.venv\Scripts\Activate.ps1`。后续生产部署示例面向 Linux。

## 3. 配置环境变量

| 变量 | 要求与用途 |
| --- | --- |
| `SECRET_KEY` | 生产启动必填；Flask 会话签名密钥，独立生成并固定保存。 |
| `ADMIN_KEY` | 生产启动必填；管理员后台登录密钥。 |
| `MERCHANT_NUM` | 生产启动必填；当前支付服务商的真实商户号。 |
| `PAY_SECRET_KEY` | 生产启动必填；与支付平台一致的签名密钥。 |
| `URP_CREDENTIAL_KEY` | 保存教务账号所需的 Fernet 加密密钥，应在首次启动前配置。 |
| `FLASK_DEBUG` | 生产设置为 `0`；本机开发可设为 `1`。 |
| `HOST` / `PORT` | 直接运行 `python app.py` 时的监听地址与端口，非调试模式默认 `0.0.0.0:5050`。Gunicorn 使用自身的监听参数。 |

分别执行两次以下命令，生成不同的 `SECRET_KEY` 和 `ADMIN_KEY`：

```bash
python -c 'import secrets; print(secrets.token_hex(32))'
```

生成 `URP_CREDENTIAL_KEY`：

```bash
python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'
```

在仓库根目录创建 `.env`，填入实际配置。以下尖括号内容均为待替换占位值：

```dotenv
FLASK_DEBUG=0
HOST=127.0.0.1
PORT=5050
SECRET_KEY=<独立生成的随机签名密钥>
ADMIN_KEY=<独立生成的管理员密钥>
MERCHANT_NUM=<支付平台商户号>
PAY_SECRET_KEY=<支付平台签名密钥>
URP_CREDENTIAL_KEY=<生成的Fernet密钥>
```

环境文件每行使用 `变量名=值`，不要加 `export`。上面生成的十六进制与 Fernet 密钥可直接填写；包含空格等特殊字符的自定义值需使用引号。

**应用不会自动读取 `.env`。** Linux/macOS 下手动启动时，在当前终端加载：

```bash
chmod 600 .env
set -a
source .env
set +a
```

仅加载自己维护的可信环境文件。systemd 部署时使用下文的 `EnvironmentFile` 注入变量；终端中的变量不会自动传给系统服务。

当前生产启动会校验前四项变量，关闭前端会员入口也不会跳过支付配置校验。尚未接入支付时，可用 `FLASK_DEBUG=1` 在本机进行开发联调；不要用虚构商户配置作为正式支付部署方案。

保管并备份加密密钥。更换或丢失 `URP_CREDENTIAL_KEY` 会导致已有加密密码无法解密；多个实例应使用相同的密钥。

## 4. 设置学校教务地址

首次部署时创建 `data/config.json`。目录不存在时先运行 `mkdir -p data`；已有配置请合并修改，避免覆盖后台设置。

```json
{
  "urp_url": "https://urp.example.edu.cn/",
  "urp_urls": [
    "https://urp.example.edu.cn/"
  ],
  "current_url_index": 0,
  "server_url": "https://urp-helper.example.com",
  "semester_start": "2026-09-01",
  "grades_require_member": false,
  "member_page_enabled": false,
  "database": {
    "type": "sqlite",
    "sqlite_path": "data/urp_helper.db"
  }
}
```

- 将教务域名替换为学校实际地址，保留真实的应用路径；不要填写账号登录后的功能页面地址。
- 将 `server_url` 改为本服务的公网 HTTPS 根地址，支付通知与返回地址会使用它。
- `semester_start` 是示例日期，请按目标学校校历修改。
- `urp_urls` 可配置多个有效入口，`current_url_index` 从 `0` 开始；也可在管理员后台维护和切换。
- 上例关闭成绩会员限制并隐藏会员入口，仍需满足生产启动的环境变量要求。

### 适配其他学校的 URP

| 检查位置 | 按学校核对的内容 |
| --- | --- |
| `data/config.json` | 教务系统根地址、可用入口、开学日期与服务公网地址。 |
| `urp/login.py` | 登录表单、验证码、认证跳转、登录状态识别与 VPN 逻辑。 |
| `urp/query.py`、`urp/schedule_legacy.py` | 成绩、课表、考试和评教的请求路径、字段及 HTML 解析。 |
| `services/urp_service.py` | 查询流程、学期参数、缓存与业务数据整理。 |
| `services/lab_service.py` | 实验站地址、登录和上传流程；该模块属于独立学校系统，需要单独适配。 |
| `templates/`、`static/`、`miniprogram/` | 学校名称、品牌素材、课程作息、二维码及客户端 API 地址等。 |

当前内置 VPN 的识别依赖 `urp/login.py` 中的固定主机与端口，凭据可通过 `VPN_AUTH_USERNAME`、`VPN_AUTH_PASSWORD` 配置；特殊认证请求还可能使用 `VPN_AUTH_BODY`。**这些变量只配置现有适配器的认证信息，不会自动适配其他学校的 VPN。** 使用其他 VPN 时应调整适配器，或先在服务器网络层建立连接，再配置可直达的教务地址。

## 5. 首次启动与验证

加载环境变量并配置教务地址后运行：

```bash
python app.py
```

访问用户端 `http://127.0.0.1:5050/` 和后台 `http://127.0.0.1:5050/admin`，后台使用 `ADMIN_KEY` 登录。管理员接口使用 `X-Admin-Key` 请求头。

程序会尝试初始化数据库和执行迁移。若日志出现数据库初始化失败，应先解决配置或权限问题；首页能够打开不代表数据库与教务登录已经正常。

首次联调依次确认：后台配置可读写、本人教务账号可绑定、课表/成绩/考试可查询，再验证评教、实验、支付等所需功能。部分 URP 页面差异需要真实账号与学校网络环境才能验证。

`python app.py` 用于首次验证和本机开发；生产使用 WSGI 服务。开发调试会强制监听本机地址。[Flask 部署说明](https://flask.palletsprojects.com/en/stable/deploying/)

## 6. Linux 生产运行：systemd + Gunicorn

下例约定代码已按前述步骤放在 `/opt/urp-helper`，虚拟环境为 `/opt/urp-helper/.venv`。若使用其他目录，请同步修改服务文件中的两处路径。

在虚拟环境中额外安装 Gunicorn，它不包含在当前 `requirements.txt` 中：

```bash
python -m pip install gunicorn
```

创建专用运行用户，并将项目交给该用户管理。已有服务账号时替换为实际账号：

```bash
sudo useradd --system --home-dir /opt/urp-helper --shell /usr/sbin/nologin urp-helper
sudo chown -R urp-helper:urp-helper /opt/urp-helper
sudo install -o root -g root -m 600 .env /etc/urp-helper.env
```

创建 `/etc/systemd/system/urp-helper.service`：

```ini
[Unit]
Description=URP Helper
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=urp-helper
Group=urp-helper
WorkingDirectory=/opt/urp-helper
EnvironmentFile=/etc/urp-helper.env
Environment=PYTHONUNBUFFERED=1
ExecStart=/opt/urp-helper/.venv/bin/gunicorn --config /opt/urp-helper/gunicorn.conf.py --workers 1 --worker-class gthread --threads 8 --bind 127.0.0.1:5050 --timeout 120 --access-logfile - --error-logfile - app:app
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=multi-user.target
```

先使用一个 worker：实验站会话等状态仍保存在进程内，直接增加 worker 可能使连续操作落到不同进程而丢失上下文。扩容前应先解决这些状态的共享问题；仅将业务数据库切换到 MySQL 不会共享全部运行状态。

启动并查看日志：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now urp-helper
sudo systemctl status urp-helper
sudo journalctl -u urp-helper -n 100 --no-pager
```

修改环境变量后，更新 `/etc/urp-helper.env` 并运行 `sudo systemctl restart urp-helper`。Gunicorn 的地址和端口由 `--bind` 控制。[Flask 的 Gunicorn 配置说明](https://flask.palletsprojects.com/en/stable/deploying/gunicorn/)

## 7. Nginx 反向代理与 HTTPS

在 Nginx 已加载的站点配置中添加以下服务，将域名替换为自己的域名：

```nginx
server {
    listen 80;
    server_name urp-helper.example.com;

    client_max_body_size 25m;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 150s;
    proxy_buffering off;

    location = /api/lab/upload {
        client_max_body_size 41m;
        proxy_pass http://127.0.0.1:5050;
    }

    location / {
        proxy_pass http://127.0.0.1:5050;
    }
}
```

```bash
sudo nginx -t
sudo systemctl reload nginx
```

网页 `/api/lab/upload` 的 `41m` 限额容纳各 20 MB 的报告和附件及 multipart 表单开销。

聊天室启用前，在 Nginx 的 `http` 层定义访问日志规则，并在该站点的 `server` 中使用 `access_log /var/log/nginx/urp-access.log urp if=$urp_log_access;`。成功轮询不写访问日志，管理员聊天室请求的查询参数和解禁路径中的学号会被过滤。Gunicorn 配置使用同样的规则。

```nginx
map "$request_method:$uri:$status" $urp_log_access {
    ~^GET:/api/chat/(messages|unread):2[0-9][0-9]$ 0;
    default 1;
}

map $uri $urp_log_uri {
    ~^/api/admin/chat/mutes/ /api/admin/chat/mutes/hidden;
    ~^/api/admin/chat/ $uri;
    default $request_uri;
}

log_format urp '$remote_addr [$time_local] "$request_method $urp_log_uri $server_protocol" '
               '$status $body_bytes_sent $request_time';
```

这是初始 HTTP 代理配置。正式向用户开放前，通过服务器面板或证书工具配置有效 HTTPS 证书，并将 HTTP 跳转到 HTTPS。应用只监听本机 `5050`，外部流量由 Nginx 的 `80/443` 端口进入。不要将整个项目目录配置为静态站点根目录。

默认登录限流信任本机代理。若使用 Docker、CDN 或独立代理，需将 `LOGIN_RATE_LIMIT_TRUSTED_PROXIES` 配置为实际可信代理的 IP/CIDR，并保证源站访问边界可信。代理需传递 `X-Device-ID`、`X-Admin-Key` 与小程序的 `Authorization` 请求头，保留 API 的 JSON 错误和 HTTP 429 响应。

## 8. 可选功能

### 微信小程序

1. 服务端配置 `WECHAT_MINIPROGRAM_APPID`、`WECHAT_MINIPROGRAM_SECRET`，并确保 `URP_CREDENTIAL_KEY` 已配置。
2. 在微信开发者工具中导入 `miniprogram/`，将 `project.config.json` 中的 AppID 替换为自己的 AppID。
3. 将 `miniprogram/utils/config.js` 的 `apiBaseUrl` 替换为本服务的 HTTPS 根地址；仓库中的地址属于原部署环境。
4. 在微信公众平台配置请求合法域名；使用实验 PDF 的网页上传入口时，还需核对 `web-view` 业务域名及小程序主体资格，并验证真机上传。[微信 web-view 说明](https://developers.weixin.qq.com/miniprogram/dev/component/web-view.html)
5. 重启服务后验证微信登录、教务绑定及查询功能。AppSecret 仅保存在服务端。

### 实验报告提交

生成并配置独立的 `LAB_CREDENTIAL_KEY`，格式与 `URP_CREDENTIAL_KEY` 相同。确认服务器可以访问目标实验站，并适配 `services/lab_service.py` 中的固定地址、安全跳转校验及 WebForms 流程。实验系统独立于 URP，各学校需分别核对；仅修改教务 URL 无法完成实验站适配。

### 会员支付

当前支付接口地址和协议位于 `constants.py`、`services/member_service.py` 与 `routes/member_routes.py`。更换支付服务商需要同步适配下单、签名、通知和金额校验。设置正确的 `server_url`，确保公网可访问 `/api/member/pay_notify` 和 `/api/member/pay_return`。联调完成后按需在后台开启会员入口及成绩会员限制。

### MySQL / MariaDB

可在管理员后台配置数据库并进行连接测试；从 SQLite 切换时，使用后台提供的迁移功能，并先备份原库。数据库切换不会自动迁移 `user_data/` 中的文件缓存，也不会将进程内会话转换为跨实例共享会话。

## 9. 更新与备份

每次更新前备份以下内容：

- `data/`：配置、默认 SQLite 数据库及 VPN 会话等运行文件；外部 MySQL 需单独备份。
- `user_data/`：用户 Cookie、课表和考试等缓存。
- 实际使用的环境文件，尤其是 `URP_CREDENTIAL_KEY` 和 `LAB_CREDENTIAL_KEY`；与公开源码分开保管。

SQLite 文件备份应在服务停止时进行，或使用 SQLite 的在线备份机制，避免直接复制正在写入的数据库文件。

以专用运行用户在项目目录更新代码和依赖，再重启服务：

```bash
sudo -u urp-helper git -C /opt/urp-helper pull --ff-only
sudo -u urp-helper /opt/urp-helper/.venv/bin/python -m pip install -r /opt/urp-helper/requirements.txt
sudo systemctl restart urp-helper
sudo journalctl -u urp-helper -n 100 --no-pager
```

`data/`、`user_data/` 和环境文件应保持不被 Git 追踪。网站设计规范见 [DESIGN.md](DESIGN.md)。

## 10. 常见问题

| 现象 | 优先检查 |
| --- | --- |
| 启动提示“安全配置缺失或不安全” | 四项生产必填变量是否被实际服务进程读取，是否仍为占位值。 |
| 首页正常，但绑定账号失败 | `URP_CREDENTIAL_KEY`、数据库权限、学校网络、真实教务地址和登录页面适配。 |
| 提示密码无法解密 | 是否更换了加密密钥，环境文件是否与原数据库配套。 |
| 验证码组件安装失败 | Python 版本、CPU 架构、固定依赖版本是否有可用安装包；避免直接改用最新 Python。 |
| Nginx 返回 502 | systemd 日志、Gunicorn 是否启动、代理端口是否与 `--bind` 一致。 |
| 教务连接或 VPN 失败 | 服务器网络连通性、学校 VPN 认证方式及内置固定主机适配。 |
| 实验操作偶发要求重新登录 | 是否启用了多个 worker、会话是否过期，以及实验站网络是否正常。 |
| 小程序请求或上传失败 | AppID/AppSecret、客户端 API 地址、HTTPS 证书、请求合法域名及网页入口的业务域名。 |
| 支付回调失败 | 真实商户配置、签名协议、订单金额、`server_url` 和公网回调地址。 |
