# 微信小程序接口说明

本文档描述 URP Helper 微信小程序使用的服务端接口。接口仍由现有 Flask 应用提供，网页端的 `X-Device-ID` 认证保持不变；小程序使用服务端生成的 Bearer token。

## 服务端配置

在 Flask 进程环境中配置以下变量：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `WECHAT_MINIPROGRAM_APPID` | 是 | 微信小程序 AppID |
| `WECHAT_MINIPROGRAM_SECRET` | 是 | 微信小程序 AppSecret，只存在于服务端 |

小程序前端只配置 `miniprogram/utils/config.js` 中的 `apiBaseUrl`。不要把 AppSecret、OpenID 或微信 `session_key` 放进小程序源码、请求参数、日志或响应。

## 认证流程

### 1. 创建小程序会话

```http
POST /api/wechat/session
Content-Type: application/json

{"code":"wx-login-code"}
```

`code` 是小程序通过 `wx.login()` 获得的一次性临时凭证。服务端调用微信 `code2Session`，只在服务端处理微信身份，然后返回 URP Helper 自己的随机 token：

```json
{
  "success": true,
  "token": "server-generated-token",
  "bound": true,
  "username": "2020123456"
}
```

未绑定教务账号时：

```json
{
  "success": true,
  "token": "server-generated-token",
  "bound": false
}
```

缺少 code、微信配置缺失、code 失效或微信服务不可用时，接口返回 `success: false` 及可展示的 `message`。不会返回 AppSecret 或 `session_key`。

### 2. 请求需要微信会话的接口

将上一步得到的 token 放在标准请求头中：

```http
Authorization: Bearer server-generated-token
```

服务端数据库只保存 token 的 SHA-256 哈希，不保存小程序端的明文 token。token 默认有效期为 30 天；失效后接口返回：

```json
{
  "success": false,
  "message": "微信登录已失效，请重新登录",
  "code": "WECHAT_SESSION_REQUIRED"
}
```

小程序收到 HTTP 401 或上述 code 后会清理本地 token，并在下一次请求前重新调用 `wx.login()`。

## 教务账号绑定

```http
POST /api/wechat/bind
Authorization: Bearer server-generated-token
Content-Type: application/json

{
  "username": "2020123456",
  "password": "your-urp-password",
  "invitation_token": ""
}
```

成功响应：

```json
{
  "success": true,
  "bound": true,
  "username": "2020123456",
  "message": "微信与教务账号绑定成功"
}
```

服务端会先调用现有 URP 登录逻辑验证账号密码。如果网页端已经存在相同学号，则复用对应的内部 `device_id`；一个教务账号如果已经关联其他微信身份，接口会拒绝新的关联。小程序不提交 OpenID 或 `device_id`，这两个值由服务端会话解析得到。

## 首版业务接口

除新增的微信会话和绑定接口外，以下接口均自动通过 Bearer token 映射到现有用户业务：

| 方法 | 路径 | 用途 | 主要响应字段 |
| --- | --- | --- | --- |
| `GET` | `/api/check_bind` | 查询绑定状态 | `bound`, `username` |
| `GET` | `/api/urgent_event` | 首页紧急事项 | `event` |
| `GET` | `/api/schedule` | 查询课表；可选 `?week=1` | `data.schedule`, `data.semester_start` |
| `POST` | `/api/update_schedule` | 更新课表缓存 | `message`, `data` |
| `GET` | `/api/grades/latest_summary` | 最近学期成绩概览 | `semester`, `passed`, `failed` |
| `GET` | `/api/grades/current` | 当前学期成绩 | `grades` |
| `GET` | `/api/exams` | 查询考试安排 | `exams` |
| `POST` | `/api/update_exams` | 更新考试缓存 | `message`, `data` |
| `POST` | `/api/request_rebind` | 删除当前教务账号绑定 | `message` |

所有成功响应遵循项目约定并包含 `success: true`。业务失败时通常返回 `success: false` 和 `message`，小程序的统一请求封装会将其转换成页面错误状态。成绩接口继续沿用后端现有的登录/会员校验规则。

## 安全边界

- `WECHAT_MINIPROGRAM_SECRET` 只在 Flask 服务端环境中读取。
- OpenID 只来自服务端对微信 `code2Session` 的结果，不接受请求体或自定义请求头中的 OpenID。
- `session_key` 不作为会话凭据，不写入业务表和接口响应。
- 小程序只保存自定义 token；教务密码只在绑定请求提交时传输，不写入小程序本地存储。
- 生产环境必须使用 HTTPS，并在微信公众平台配置 request 合法域名。
