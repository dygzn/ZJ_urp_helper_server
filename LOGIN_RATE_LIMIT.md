# 登录接口限流

默认启用，重启应用后生效。保护网页 `/api/login`（包括临时登录）和已认证的小程序 `/api/wechat/bind`，两者共享配额。查询、已有设备自动重新登录、微信 code 换 session 不受此限制。

## 正常用户保护

- 按 **客户端 IP + 学号** 分别计数。同一校园/宿舍出口的不同学号互不影响，同一学号的不同来源也互不影响。不设置全局 IP 封禁或全局学号锁。
- 同一组合在滑动 60 秒内最多提交 12 次；成功也计入此短窗口，防止反复登录消耗验证码识别资源。
- 600 秒内累计 8 次**明确的学号/密码错误**后，后续请求冷却 30 秒。验证码识别失败、维护、VPN 故障、超时或未知错误不计入密码错误次数；高频提交仍受短窗口保护。
- 拒绝的请求不增加次数、不延长冷却。登录成功清除密码错误记录及冷却，保留短窗口计数。旧的并发失败结果不能重新增加成功前的错误记录。
- 返回 HTTP 429、`code=LOGIN_RATE_LIMITED`、`retry_after`（秒）、`Retry-After`、`Cache-Control: no-store`。现有网页保留输入并显示等待秒数，小程序不清除微信登录态；均不自动重试。
- 存储不可用时放行登录，最多每分钟告警一次。可用性优先，因此本机制不能替代网关抗流量攻击能力。

## 部署配置

环境变量在启动时读取，也可在调用 `init_login_rate_limiting(app)` 前设置同名 Flask 配置。

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `LOGIN_RATE_LIMIT_ENABLED` | `1` | `0`、`false` 或 `off` 关闭（Flask 配置使用布尔值） |
| `LOGIN_RATE_LIMIT_ATTEMPTS` | `12` | 短窗口允许的提交次数 |
| `LOGIN_RATE_LIMIT_WINDOW` | `60` | 短窗口秒数 |
| `LOGIN_RATE_LIMIT_FAILURES` | `8` | 触发冷却的明确凭据错误次数 |
| `LOGIN_RATE_LIMIT_FAILURE_WINDOW` | `600` | 密码错误统计窗口秒数 |
| `LOGIN_RATE_LIMIT_COOLDOWN` | `30` | 冷却秒数 |
| `LOGIN_RATE_LIMIT_TRUSTED_PROXIES` | `127.0.0.1/32,::1/128` | 逗号分隔的可信代理 IP/CIDR；设为空字符串表示不信任任何代理 |
| `LOGIN_RATE_LIMIT_PATH` | 自动选择运行目录 | 独立 SQLite 文件路径，同机所有 worker 必须一致 |

计数和时间参数必须为正整数。生产中若需要暂停保护，设置 `LOGIN_RATE_LIMIT_ENABLED=0` 并重启。

### 反向代理

仓库 Nginx 示例是本机代理，并使用 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`，适用默认配置。只从可信对端读取转发链，从右往左跳过可信代理，遇到第一个非可信地址即停止。公网直连伪造 `X-Forwarded-For`、`X-Real-IP` 不会改变限流来源。

Docker、独立代理或 CDN 部署需配置**实际代理地址**，并保证代理正确追加/覆盖转发头，且源站访问边界可信；不要配置 `0.0.0.0/0` 或 `::/0`。否则所有人可能被识别为代理 IP，同一学号的不同用户也会共享配额。未知或格式错误的转发链保守使用已经确认的对端。

保留 429 的 JSON 响应，不要让网关把 429 替换成 HTML 维护页。仓库维护配置仅拦截 502/503/504，无需修改。

### 存储与范围

使用标准库 SQLite，不新增依赖，不修改业务库。Linux 默认优先 `/dev/shm`，其他平台使用系统临时目录；目录按项目路径及运行用户隔离。状态只保存 IP/学号组合摘要、有限数量时间戳及冷却状态，无密码、Cookie 或明文 IP/学号。过期记录在后续登录请求时清理。

同机多进程通过短事务共用配额；多容器需共享适合 SQLite 文件锁的本机卷及同一路径。多台服务器各自计数，不提供跨机器统一限流。轮换来源或学号的攻击不受全局限制，这是避免牵连正常学生的明确取舍。

## 验证

```sh
.venv/bin/python -m unittest discover -s tests -p 'test_login_rate_limit.py'
node --test tests/test_login_rate_limit_ui.js
```

覆盖共享校园网络、异地同账号、伪造转发头、更换设备 ID、失败分类、成功清零、拒绝不续期、多进程竞争、存储故障放行及两端错误展示。
