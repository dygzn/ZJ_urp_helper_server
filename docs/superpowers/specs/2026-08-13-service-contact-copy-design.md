# “找我做事”联系方式点击复制设计

## 目标

为“找我做事”页面现有 QQ、微信超链接增加点击复制能力。用户点击联系方式时，页面复制对应账号，同时保留浏览器打开原 HTTPS 链接的默认行为。

## 当前基础

- QQ 链接：`https://qm.qq.com/q/c9BOvFT6tc`，账号 `786171937`。
- 微信链接：`https://u.wechat.com/MMwBClCfxTYX-Z1rWS3_esc?s=2`，账号 `Dygzn123`。
- 用户已将入口显示文字手动调整为“QQ”和“微信”；本次保留该未提交修改。

## 交互设计

- 两个 `<a>` 元素分别增加 `data-copy-text="786171937"` 和 `data-copy-text="Dygzn123"`。
- 页面通过统一的点击事件监听识别带 `data-copy-text` 的链接，不使用内联 `onclick`。
- 事件监听不调用 `preventDefault()`，所以链接仍按当前 `target="_blank"` 行为打开。
- 复制成功后，入口的账号文字短暂显示“已复制”，随后恢复原账号。
- 复制失败时不阻止跳转，不显示误导性的成功反馈；错误仅记录到控制台。

## 复制兼容策略

1. 当 `navigator.clipboard.writeText` 可用时优先使用 Clipboard API。
2. Clipboard API 不可用或调用失败时，使用临时 `textarea`、选中文本及 `document.execCommand('copy')` 作为兼容方案。
3. 临时元素在复制尝试后立即移除，不遗留到页面中。

该策略兼顾 HTTPS 部署和部分 HTTP/旧浏览器环境。外部 QQ、微信链接是否成功唤起客户端仍由对应平台决定。

## 代码边界

- 在 `static/js/service-status-ui.js` 中提供可独立测试的复制函数，并保留当前浏览器/Node 双环境模块结构。
- 在 `static/js/main.js` 中绑定联系链接点击事件和短暂反馈。
- 在 `templates/index.html` 中只增加复制数据属性，不增加按钮、弹窗或图片。
- 不修改 API、数据库、管理员后台、外部链接或现有跳转属性。

## 测试

- 模板测试验证两个链接携带精确的 `data-copy-text`。
- Node 测试验证：优先调用 Clipboard API；Clipboard API 失败时进入兼容复制；复制失败返回失败状态。
- 运行完整 Python、Node 和 JavaScript 语法检查，确保链接展示、服务状态和其他页面功能不受影响。

## 验收标准

点击 QQ 或微信入口时，对应账号进入系统剪贴板；链接仍在新标签页中打开。复制成功时提供短暂“已复制”反馈，失败时仍可正常跳转，且不会错误提示成功。
