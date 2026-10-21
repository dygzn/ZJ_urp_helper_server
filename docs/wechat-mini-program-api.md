# 微信小程序接口说明

小程序由现有 Flask 服务提供 API，身份与网页设备绑定相互独立。网页接口只接受显式 `X-Device-ID`；小程序使用 Bearer token 请求 `/api/wechat/` 专用接口。不要通过通用网页接口使用微信 token，也不要把网页设备 ID 当作微信登录态。

## 服务端与客户端配置

| 环境变量 | 用途 |
| --- | --- |
| `WECHAT_MINIPROGRAM_APPID` | 微信小程序 AppID |
| `WECHAT_MINIPROGRAM_SECRET` | 服务端 AppSecret |
| `URP_CREDENTIAL_KEY` | 服务端 Fernet 密钥，用于教务密码加密保存 |

以上是微信登录及教务绑定涉及的配置；Flask 的通用安全配置仍按现有部署要求设置。AppSecret 和密码加密密钥只能存在于服务端。

客户端在 `miniprogram/utils/config.js` 配置 HTTPS API 根地址，在 `project.config.json` 配置 AppID。正式环境须配置微信 request 合法域名及有效 HTTPS 证书。

## 登录与独立绑定

1. `wx.login()` 获取一次性 code。
2. `POST /api/wechat/session`，JSON 请求体为 `{"code":"wx-login-code"}`。
3. 服务端用 code 向微信换取身份，只返回自定义 token 和绑定状态：

```json
{"success":true,"token":"server-generated-token","bound":true,"username":"2020123456"}
```

未绑定时 `bound` 为 `false`，不包含学号。响应不返回 OpenID、UnionID、`session_key` 或服务端密钥。token 有效期为 30 天，数据库只保存其 SHA-256 哈希。后续请求头为：

```http
Authorization: Bearer server-generated-token
```

`POST /api/wechat/bind` 需要微信会话，请求体为：

```json
{"username":"2020123456","password":"your-urp-password"}
```

服务端先验证教务密码，再加密保存至账号主表，并建立独立的微信学号关联。现有网页设备关系不被新增、复用或删除；同一学号的教务数据和会员资格仍共用。小程序不提交 `device_id`、OpenID 或邀请 token。

一个微信已关联其他学号时，需要先 `DELETE /api/wechat/binding`；同一学号已关联其他微信时返回 HTTP 409。微信解绑只解除微信学号关联，保留网页设备关系、账号数据和有效微信会话。用户可随后重新绑定。

## 当前客户端使用的接口

除创建会话外，下列请求均携带微信 Bearer token。

| 方法 | 路径 | 用途及主要响应字段 |
| --- | --- | --- |
| `POST` | `/api/wechat/session` | 创建会话：`token`、`bound`、可选 `username` |
| `GET` | `/api/wechat/account` | 绑定状态：`bound`、`username`、`membership` |
| `POST` | `/api/wechat/bind` | 验证并绑定学号：`bound`、`username`、`message` |
| `DELETE` | `/api/wechat/binding` | 解除微信关联：`bound:false`、`message` |
| `GET` | `/api/wechat/urgent_event` | 缓存中的紧急事项：`event` |
| `GET` | `/api/wechat/schedule` | 课表：`data.schedule`、`data.semester_start`；可选 `week=1`，范围 1–60 |
| `POST` | `/api/wechat/update_schedule` | 重新获取教务课表：`data`、`message` |
| `GET` | `/api/wechat/grades/latest_summary` | 最近学期：`semester`、`passed`、`failed.current`、`failed.past` |
| `GET` | `/api/wechat/grades/current` | 当前学期：`grades` |
| `GET` | `/api/wechat/exams` | 考试安排：`exams` |
| `POST` | `/api/wechat/update_exams` | 单独重新获取教务考试安排：`exams`、`message` |

服务端另有 `POST /api/wechat/refresh_events`，会同时更新课表和考试安排并返回 `event`。当前客户端的课表与考试按钮分别使用上表中的单独更新接口。

成绩接口沿用后台 `grades_require_member` 开关；启用时需要有效会员。考试、更新和成绩查询需有效教务登录态。小程序不提供充值入口，会员问题按服务端提示前往网页端处理。

## 错误处理

响应遵循 `success` 与可直接展示的 `message` 约定；错误可能同时有 `code`。客户端将失败转为页面错误状态并保留服务端提示。

| HTTP 状态 | code | 客户端处理 |
| --- | --- | --- |
| 401 | `WECHAT_SESSION_REQUIRED` | 清理本地 token，下次请求前重新调用 `wx.login()` |
| 409 | `BINDING_REQUIRED` | 微信会话有效，需要绑定学号 |
| 409 | `URP_LOGIN_REQUIRED` | 微信会话有效，按提示解绑后重新验证教务账号密码 |
| 403 | `MEMBER_REQUIRED` | 微信会话有效，按提示前往网页端开通或续费 |

教务账号冲突或参数错误也可能返回 400/409 和可读 `message`。密码加密配置不可用会返回 `success:false`、`code:ACCOUNT_STORAGE_UNAVAILABLE` 和可读提示。除微信会话失效外，客户端不会因为会员或教务登录错误清理微信 token。

教务密码只在绑定请求中提交，客户端不将其写入本地存储。离线测试模拟微信和教务响应，不证明真实 AppID、服务器外网连接或微信域名设置已联通。
