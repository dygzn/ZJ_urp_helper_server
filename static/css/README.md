# CSS 层级与主题

三个入口模板首先加载 `layers.css`，显式声明 `reset, base, components, themes, utilities` 的顺序。所有外链样式都有命名层，不能新增未分层的全局规则，因为未分层声明会压过普通分层声明。

- `base`：重置、基础字体与原生控件。`style.css` 保留的旧组件结构属于 `components.legacy`。
- `components.workspace`：`ui-components.css` 中的当前组件布局，及后台、外观选择器专用组件。按组件或交互状态选择元素；祖先、页面 ID 与主题作用域使用 `:where()`，避免把定位范围变成优先级竞争。
- 直接定位控件时，旧的 ID 使用 `[id="..."]` 保持类级权重，避免零权重的目标规则被通用类隐藏；页面 ID 仅用于限定祖先范围时仍放在 `:where()` 内。
- `components.appearance`：可选材质的组件使用规则与现有玻璃导航交互布局，仍在 `ui-components.css`。消费颜色、填充、阴影、模糊与圆角 Token。
- `themes`：`taste-theme.css`、`liquid-glass.css` 只定义 Token。系统明暗配色使用 `prefers-color-scheme`；减少透明效果和高对比度偏好通过同一组 Token 回退。
- `utilities`：可见性、减少动态效果等明确的功能约束。历史上必须覆盖内联状态的少量 `!important` 集中在此，主题不得引入 `!important`。

`--ui-*` 是共享语义；`--glass-*` 是浏览器玻璃材质参数。课程颜色仍按课程身份产生，深色只通过色条的 `color-mix()` 调整亮度；详情过渡使用相同处理，不修改课程配色映射和业务数据。旧浏览器不支持 `color-mix()` 时，深色色条回退到高对比度实色。

明暗偏好独立保存为 `urp_ui_color_mode`（`light`、`dark`、`system`），默认 `system`。`appearance.js` 在首屏设置解析后的 `data-color-scheme`；手动选择覆盖系统偏好，系统选项响应媒体查询变化。深色值只保存在 `--ui-dark-*` / `--glass-dark-*` 预设中，手动和无脚本系统回退通过别名引用同一份值，避免两份配色漂移。

修改颜色、材质或圆角时优先调整主题 Token；改变尺寸、布局或显示状态时修改组件层。主题不持有元素布局规则，切换系统明暗不会重新查询教务数据。静态资源版本在三个模板中保持一致。

验证：`tests/browser_css_layers.cjs` 检查实际 CSSOM 的分层约束、不同特异性下的层优先级、系统深色变量、布局稳定性、360 种课程色条及考试色标的 4.5:1 对比度、实色回退和共享页面；外观与成绩浏览器用例覆盖交互和窄屏布局。
