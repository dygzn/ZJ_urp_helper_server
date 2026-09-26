# URP 教务查询快捷指令

导入 [URP教务查询-JSON版.shortcut](URP教务查询-JSON版.shortcut)，即可在一个菜单中查询历年课表、本学期成绩和紧急事项。需要已绑定学号，且会员等级为初级或以上。

## 首次配置

1. 在网站打开“快捷指令 API”页面，点击“生成快捷指令密钥”，立即复制密钥。密钥只显示一次。
2. 在 iPhone 或 iPad 上打开本目录中的已签名快捷指令文件，选择“添加快捷指令”。导入提问中粘贴密钥，确认接口地址。默认地址为 `https://www.meizhenxin.cn/api/shortcut/query`；若网站显示的接口地址不同，以网站页面为准。
3. 运行“URP教务查询”，选择菜单项。第一次联网时按系统提示允许访问网站。

如果之前导入过旧版，请先在“快捷指令”App 中删除旧版，再导入当前的已签名文件，避免运行到旧动作。

“历年课表”会询问学期代码。留空时由网站选择最新学期；指定学期时请输入网站课表学期选项中的实际代码。其他两项无需额外输入。

密钥与学号绑定，不使用设备 ID。重新生成密钥后，旧密钥立即失效；在快捷指令的第一个“文本”动作中替换为新密钥。已配置密钥的快捷指令文件含有密钥，请勿转发。

## 接口格式

快捷指令向 `/api/shortcut/query` 发送 `POST` JSON：

```json
{"key":"你的密钥","action":"grades","params":{}}
```

菜单对应的 `action` 分别为 `historical_schedule`、`grades`、`urgent_event`。课表查询的 `params` 可包含 `semester`。快捷指令显示接口的 `message` 和主要 `data` 字段，因此密钥失效、会员资格不足或教务登录失效时，也会显示网站返回的中文提示。

本目录的 `URP教务查询.wflow` 是未签名的构建源，不用于导入。重新生成时运行 `python3 scripts/build_urp_shortcut.py`，然后使用 macOS 的 `shortcuts sign --mode anyone` 签名。签名时 Apple 会收到文件副本用于验证；构建产物不包含真实密钥。JSON 版在“获取 URL 内容”中直接使用 JSON 请求体。
