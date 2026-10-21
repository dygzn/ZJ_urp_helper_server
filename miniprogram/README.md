# URP Helper 微信小程序

这是 URP Helper 的原生微信小程序客户端，使用 WXML、WXSS 和 JavaScript 编写，不需要 npm 构建链。首版包含微信登录、教务账号绑定、首页、课表、成绩、考试和“我的”。

## 导入微信开发者工具

项目导入目录是：

```text
<仓库目录>/miniprogram
```

在微信开发者工具中选择“导入项目”，将上面的目录作为项目目录。导入后：

1. 在 `project.config.json` 中把 `appid` 从 `touristappid` 替换为真实的小程序 AppID。
2. 在 `utils/config.js` 中检查 `apiBaseUrl`，它必须是 Flask 服务可访问的 HTTPS 根地址，例如 `https://www.meizhenxin.cn`。
3. 本地联调时可以在开发者工具的项目设置中临时勾选“**不校验合法域名、TLS 版本及 HTTPS 证书**”。这只适用于开发调试，不适用于上线。
4. 正式发布前，在微信公众平台的小程序后台将 API 域名加入 `request 合法域名`，并保证服务端使用有效 HTTPS 证书。

当前 `project.config.json` 的 `urlCheck` 保持为 `true`，因此真机或正式环境必须完成合法域名配置。

## 服务端配置

服务端环境变量、Flask 启动方式和接口错误说明见 [微信小程序接口说明](../docs/wechat-mini-program-api.md)。微信应用密钥只能放在 Flask 服务端环境中，不能写入小程序目录、前端请求或接口响应。服务端缺少配置时，登录接口会返回可读错误；小程序只保存服务端生成的随机业务 token，不保存微信服务端临时密钥、OpenID 或教务密码。

## 登录与绑定

小程序启动时调用 `wx.login()`，将一次性 code 发送给 Flask 的 `/api/wechat/session`。服务端向微信换取身份后生成 30 天有效的自定义 token；后续请求自动携带：

```http
Authorization: Bearer <urp-mini-program-token>
```

首次使用时，在“绑定教务账号”页面输入教务系统账号和密码。微信身份独立绑定学号，网页端设备绑定保持独立；同一学号仍使用同一份教务数据与会员状态。小程序通过 `/api/wechat/account` 查询绑定状态，重新绑定先调用 `DELETE /api/wechat/binding` 解除微信关联，再提交新的教务账号，网页设备绑定不会因此解除。所有小程序业务请求使用 `/api/wechat/` 专用接口，不使用网页设备 ID。

## 目录结构

```text
miniprogram/
├─ app.js / app.json / app.wxss
├─ project.config.json / sitemap.json
├─ utils/
│  ├─ auth.js       # wx.login 与 token 生命周期
│  ├─ config.js     # API 地址和请求超时
│  ├─ request.js    # 统一请求封装
│  └─ format.js     # 课表、分数、考试数据格式化
└─ pages/
   ├─ home/         # 首页
   ├─ schedule/     # 课表
   ├─ grades/       # 成绩
   ├─ exams/        # 考试
   ├─ account/      # 我的
   └─ bind/         # 账号绑定
```

## 本地检查

在仓库根目录 `<仓库目录>` 执行：

```powershell
python -m unittest discover -s tests -p "test_wechat*.py"
python -m unittest discover -s tests -p "test_miniprogram_contract.py"
node --test tests/test_miniprogram*.js
Get-ChildItem miniprogram -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
```

真实微信登录还需要在开发者工具中配置可用 AppID，并让服务端能访问微信接口；没有这些外部条件时，可以完成静态、单元和接口契约验证，但不能据此判断真实微信登录已联通。
