# 联系方式客户端协议跳转设计

## 目标

按用户指定的 URL Scheme 原样替换“找我做事”页面中的 QQ、微信 HTTPS 联系链接，尝试直接唤起对应客户端页面。

## 精确链接

- QQ：`tencent://AddContact/?fromId=45&fromSubId=1&subcmd=all&uin=786171937`
- 微信：`weixin://dl/business/?t=Dygzn123`

本次按用户要求使用上述字符串，不改写参数，不增加 HTTPS 回退，也不根据浏览器或设备切换链接。

## 保留行为

- 点击 QQ 时继续自动复制 `786171937`。
- 点击微信时继续自动复制 `Dygzn123`。
- 复制成功后继续短暂显示“已复制”。
- 链接继续使用现有新标签页和安全属性。
- 页面不拦截默认跳转；客户端能否唤起由浏览器、操作系统和对应应用决定。

## 代码范围

- 修改 `templates/index.html` 中两个联系入口的 `href`。
- 修改 `tests/test_service_status.py` 中两个精确链接期望。
- 不修改 JavaScript 复制逻辑、CSS、API、数据库或管理员后台。

## 测试与验收

- 模板测试验证两个 `href` 与用户指定的 Scheme 完全一致。
- 模板测试继续验证账号复制值、链接文字、新标签页和安全属性。
- 完整 Python、Node 与 JavaScript 语法检查保持通过。
- 用户在实际设备上点击两个入口，验证客户端的实际处理结果。

## 已知限制

微信官方文档将 `weixin://dl/business/?t=` 的 `t` 定义为小程序 Scheme Ticket，而不是个人微信号。本次仍遵循用户明确要求填入 `Dygzn123`，不对微信能否打开个人添加好友页作保证。
