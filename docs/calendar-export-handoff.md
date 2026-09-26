# 课表与考试日历导出交接

## 目标与当前状态

用户希望课表、考试安排展示详细信息，并可导出到日历。代码已实现，尚未提交或发布。学期首周星期一以管理员后台 `/api/admin/semester` 的配置为准；未采用个人日期设置。

## 已实现

- `static/js/calendar-export.js`：将逐周课程和考试转换为 `.ics`。按北京时间计算日期与时段，写入教师、课程号、地点、考场、座位等详情；无效日期或时间跳过并计数；处理 ICS 转义、UTF-8 折行和按账号区分的稳定 UID。
- `templates/index.html`、`static/js/main.js`、`static/js/schedule-layout.js`、`static/css/style.css`：课程和考试页各有一个统一的日历导出按钮；两类数据都有时合并到同一 `.ics`，只有一种可用时只导出该种。课表页移除了“刷新显示”，将“更新课程表”和导出按钮并排。课程详情显示周次、日期、节次及钟点时间，考试卡片显示日期与考场详情；导出弹窗可核对后台日期并下载文件。当前后台日期无效或已过期时提示管理员校正，本次导出可临时填写日期。
- `routes/data_routes.py`、`services/urp_service.py`：课表与考试接口返回后台学期日期、绑定账号及导出所需信息；考试接口保留校区、教学楼和教室；课表接口返回新生作息标记。
- `routes/admin_routes.py`：管理员变更学期日期时写入缓存失效时间戳。课程、考试和首页日程对变更前的缓存分别标记为旧数据；网页不展示或导出这些旧数据，并提示先更新课程表或考试安排。
- `services/urp_service.py`：后台学期日期被直接改成非法值时，首页接口不会崩溃，而是返回校正标记；首页提示管理员修正后再查看或导出日程。
- 切换绑定账号会清除页面里的课程、考试缓存。异步请求带账号代次检查，避免旧账号响应回填。进入课表页会重新读取后台配置。

## 验证记录

- 最新全量运行：`node --test tests/*.js`，36 项通过；`python3 -m unittest tests/test_calendar_schedule.py tests/test_calendar_exams.py`，5 项通过。
- `python3 -m py_compile routes/admin_routes.py routes/data_routes.py services/urp_service.py`、`node --check static/js/main.js`、`git diff --check` 均通过。
- 完整 Python 发现运行被环境缺少 `cryptography` 阻断，错误来自现有 `tests/test_lab_service.py`，并非日历测试失败。

## 接手后的下一步

1. 如有可用的 Flask 环境，手动验证从后台设置学期日期、更新课表和考试、下载 `.ics` 的完整流程；当前环境未做浏览器端到端验证。
2. 当前工作区的 `data/config.json` 已设置 `semester_start` 为 `2026-09-07`，部署前需由管理员核对是否为真实学期首周星期一，并更新用户的课程/考试缓存。通过后台 API 修改日期才会写入缓存失效标记；直接编辑配置文件不会写入该标记。

## 工作区注意

原有 `.DS_Store`、`docs/lab-submission.md`、`static/js/lab.js`、`templates/index.html` 中实验功能片段、`tests/test_lab_ui.js` 有用户先前的未提交修改，均应保留。日历相关代码和测试也仍是未提交状态，不要直接覆盖工作区。
