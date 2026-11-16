# SPA 模块

`../main.js` 只负责注册页面、启动应用、提供 `window.URP` 和旧内联函数兼容入口。业务模块使用显式 `import/export` 协作；`window` 仅保留旧内联入口及原有 UI 适配器（如课程详情过渡与课表菜单）。

| 模块 | 职责 |
| --- | --- |
| `store.js` | 共享用户、周次、教务缓存及视图状态；`store.setState()`、`store.subscribe()` |
| `router.js` | 页面注册、权限视图、导航状态，先卸载旧页再挂载新页 |
| `lifecycle.js` | 每次挂载独立的资源作用域，管理请求、计时器、帧、监听器、观察器 |
| `schedule.js` | 周次、课表查询与网格渲染、课程详情、其他专业和历史课表 |
| `schedule-gestures.js` | 课表滑动、过渡动画、操作区手势与响应式布局 |
| `schedule-menu.js` | 课表菜单及随页面销毁的 MutationObserver |
| `grades.js` | 默认成绩汇总与补考独立加载、GPA、五项其他查询菜单、完整学期及场次选择、焦点恢复 |
| `auth.js` | 登录、设备换绑、免责声明、账号缓存失效和临时使用期限 |
| `home.js` | 首页安排、课程清单、倒计时 |
| `exams.js`、`calendar.js` | 考试弹窗和日历导出；关闭弹窗或离开来源页时取消请求 |
| `member.js` | 会员、邀请及提现；会员页面注册独立生命周期 |
| `evaluation.js`、`feedback.js`、`service.js`、`lab.js` | 各自业务页；实验上传也使用页面资源作用域 |
| `ui.js`、`navigation.js`、`announcements.js`、`ad.js` | 应用级弹窗、导航、公告和广告 |

## 页面约定

在入口中调用 `registerPage(name, { mount, unmount })`。路由激活对应资源作用域后调用 `mount(container, params)`；离开时先调用 `unmount()`，并在 `finally` 中销毁该页作用域。同页再次进入也执行卸载和挂载，保留原有刷新行为。访客访问受限页面时由路由显示权限提示，不发起教务查询。

```js
const resources = pageResources('example');

export function mountExample(container, params) {
    resources.listen(container, 'click', handleClick);
    resources.observe(new ResizeObserver(handleResize)).observe(container);
    return loadExample(params);
}

export function unmountExample() {
    resources.dispose();
}

async function loadExample() {
    const operation = resources.capture();
    try {
        await operation.wait(checkLoginStatus());
        const response = await operation.wait(resources.fetch('/api/example'));
        const data = await operation.wait(response.json());
        renderExample(data);
    } catch (error) {
        if (error.name === 'AbortError') return;
        showError(error);
    }
}
```

异步操作开始时保存 `operation`，所有等待通过它的 `wait()` 完成，避免在下一次挂载中继续旧操作。请求取消一直覆盖响应体下载和 SSE 读取。使用 `resources.api` 可沿用现有 API 客户端的超时、鉴权及同类查询取消机制。忙碌按钮或其他临时状态可通过 `operation.addCleanup()` 恢复，并在正常结束时释放清理回调。

定时器、动画帧和页面监听器使用 `resources` 对应方法；Web Animations 动画及指针捕获由页面卸载钩子释放。临时登录到期计时、主导航及全局外观观察器属于应用资源，切页后继续生效。

原有 HTML 的 `onclick="showLoginModal()"` 等入口继续可用；新入口可以使用 `URP.auth.openLogin()`、`URP.router.switchPage('schedule', { scheduleWeek: 4 })`。

## 验证

- `node --test tests/*.js`：现有 DOM 单元测试与新增原生模块、状态和生命周期测试。旧 VM 测试通过 `tests/helpers/app-source.js` 读取并组合真实模块，保留原断言；原生模块测试直接导入生产模块。
- `node tests/browser_spa_modules.cjs`：需要环境中可用的 Playwright；使用本机服务器和模拟接口验证 1440px、390px 的真实模块加载、页面入口、计时器、观察器、请求取消。可用 `CHROMIUM_EXECUTABLE` 指定已安装浏览器。
