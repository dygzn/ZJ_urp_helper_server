# 快捷指令公共查询 API 设计

## 目标

为初级会员及以上用户提供一个面向 Apple 快捷指令的公共查询接口。用户在网站中按学号生成一个唯一的 API 密钥，快捷指令通过 POST 请求携带密钥和动作名称，查询历年课表或网页“一键查本学期成绩”对应的成绩汇总。

## 范围

本次只实现以下两个公共查询动作：

- `historical_schedule`：查询指定学期的历年课表；未提供学期时自动选择 URP 返回的最新学期。
- `grades`：复用网页“一键查本学期成绩”逻辑，返回最新学期及格成绩、尚不及格记录和曾不及格记录。

本次不开放当前周课表、考试安排、GPA、教学评估、其他班级课表等动作，也不改变现有网页接口的请求和响应格式。

## 已确认的产品规则

### API 密钥

- 密钥按学号归属，不按设备归属；同一学号在系统中只有一个当前有效密钥。
- 首次生成和主动重新生成都会产生新密钥，旧密钥立即失效。
- 使用密码学安全随机源生成密钥，格式使用 `urp_` 前缀加 URL 安全随机字符串。
- 数据库只保存密钥哈希、展示前缀和生成时间，不保存密钥明文。
- 明文密钥只在生成接口的响应中返回一次；网页提示用户立即复制保存。
- 生成或重新生成密钥必须使用已绑定设备，并且当前学号拥有有效的 `basic` 或 `advanced` 会员资格。
- 公共查询每次请求都重新检查会员有效期；会员到期后原密钥不再可查询。
- 设备换绑、解绑或切换当前设备绑定学号时不自动撤销密钥；密钥只按学号归属，只有该学号主动重新生成时旧密钥才失效。

### 公共接口请求

接口地址为 `POST /api/shortcut/query`，请求体为 JSON：

```json
{
  "key": "urp_xxxxxxxxx",
  "action": "historical_schedule",
  "params": {
    "semester": ""
  }
}
```

其中：

- `key` 必填，必须是网站生成的密钥。
- `action` 必填，只允许 `historical_schedule` 或 `grades`。
- `params` 可省略；`historical_schedule` 可在其中传 `semester`，`grades` 使用空对象即可。
- 密钥放在 POST JSON 中，不放在 URL 查询参数中，避免出现在常见 URL 日志中。

### 公共接口成功响应

成功响应统一包含 `success`、`action`、`message`、`data` 四个顶层字段，字段名使用英文，便于 Apple 快捷指令读取。

历年课表响应：

```json
{
  "success": true,
  "action": "historical_schedule",
  "message": "查询成功",
  "data": {
    "student_id": "2415108133",
    "semester": "2025-2026-2-1",
    "semester_name": "2025-2026学年春(两学期)",
    "course_count": 1,
    "courses": [
      {
        "course_name": "软件工程导论",
        "weekday": 3,
        "weekday_name": "星期三",
        "start_section": 1,
        "section_count": 2,
        "section_name": "第1-2节",
        "location": "仙林校区实C-501",
        "class_no": "01"
      }
    ]
  }
}
```

其中 `semester` 和 `semester_name` 来自 URP 历年课表页面的学期选项，`courses` 来自该页面星期网格；`course_count` 与数组长度一致。没有课程时仍返回成功和空数组。

成绩响应：

```json
{
  "success": true,
  "action": "grades",
  "message": "查询成功",
  "data": {
    "student_id": "2415108133",
    "semester": "2025-2026学年春",
    "passed_count": 2,
    "failed_current_count": 0,
    "failed_past_count": 1,
    "passed": [
      {
        "course_name": "软件工程导论",
        "score": "92"
      }
    ],
    "failed_current": [],
    "failed_past": [
      {
        "course_name": "高等数学",
        "score": "58",
        "credit": "4",
        "exam_time": "20250101"
      }
    ]
  }
}
```

成绩数据直接复用 `services/urp_service.py` 中 `get_latest_semester_grade_summary()` 的结果：该函数从 URP 获取学期列表，选择最新学期查询及格成绩，并查询当前及历史不及格成绩。公共 API 只负责把现有中文字段转换为稳定的快捷指令字段，不改变成绩值的原始字符串语义。

### 公共接口失败响应

业务错误统一返回可解析的 JSON，保持 HTTP 200，以便快捷指令始终能执行“从输入获取字典”并判断 `success`。响应格式为：

```json
{
  "success": false,
  "action": "grades",
  "error_code": "member_required",
  "message": "此功能需要初级会员",
  "data": null
}
```

稳定错误码：

- `invalid_request`：请求体不是 JSON、缺少必要字段或字段类型错误。
- `invalid_key`：密钥不存在或已被重新生成替换。
- `member_required`：没有有效的初级或高级会员资格。
- `invalid_action`：动作名称不受支持。
- `invalid_params`：动作参数不完整或格式不正确。
- `login_required`：无法使用该学号的有效 URP 登录状态。
- `query_failed`：URP 查询或解析失败。

Flask 对非 POST 请求返回的 405 不属于业务响应；公共 POST 接口内部的上述预期错误都保持统一 JSON 格式。

## 系统设计

### 数据库

在 SQLite 和 MySQL 两套 schema 中增加 `api_keys` 表：

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `username` | TEXT / VARCHAR(64) | PRIMARY KEY | 学号，一学号一条记录 |
| `key_hash` | TEXT / VARCHAR(64) | NOT NULL、唯一索引 | SHA-256 十六进制哈希 |
| `key_prefix` | TEXT / VARCHAR(24) | NOT NULL | 页面识别用的脱敏前缀 |
| `create_time` | TEXT / VARCHAR(32) | NOT NULL | 当前密钥生成时间 |

迁移、索引以及 SQLite 到 MySQL 的数据迁移清单都要同步增加该表。重新生成使用事务内的更新或插入，确保同一学号不会产生两条有效记录。

### 后端模块

- 新建 `services/shortcut_service.py`，负责密钥生成、哈希、状态查询、密钥认证、会员状态检查和两个动作的数据适配。
- 新建 `routes/shortcut_routes.py`，注册快捷指令相关 Blueprint，提供密钥管理接口和公共查询接口。
- `services/user_service.py` 增加按学号读取绑定用户的内部辅助函数，公共密钥认证成功后使用它取得密码和设备无关的 URP 登录信息。
- `database.py` 增加表结构、索引和迁移清单。
- `urp/query.py` 调整历年课表查询的空学期行为：先读取 URP 学期选项，按学年和学期进行语义排序并选择最新值；显式传入学期时保持原有查询行为。
- `app.py` 注册新的 Blueprint。
- `services/logging_service.py` 增加 `/api/shortcut/query` 和密钥管理接口的日志名称；日志不记录请求体、密钥、密码或课程成绩。

### 接口分层

- `GET /api/member/api-key` 使用现有设备绑定认证，仅返回是否存在密钥、前缀和生成时间，不返回明文。
- `POST /api/member/api-key` 使用现有 `require_member('basic')`，生成新密钥并在本次响应返回明文。
- `POST /api/shortcut/query` 不依赖 `X-Device-ID`；按请求体密钥查找学号，检查会员，读取该学号的绑定凭据，调用现有 `check_login_status()`，最后分发到两个查询动作。
- 新公共接口不复用现有网页路由的 JSON 外壳，避免把网页使用的 `grades` 顶层字段或中文课表字段暴露成外部契约。

### 数据流

```text
网站绑定设备
  └─ POST /api/member/api-key
       └─ 校验设备绑定 + 初级会员
            └─ 生成明文 key，保存 SHA-256(key) → username

Apple 快捷指令
  └─ POST /api/shortcut/query {key, action, params}
       └─ hash(key) → api_keys.username
            └─ 校验会员有效期
                 └─ 读取 users + URP Cookie/自动登录
                      ├─ historical_schedule → URP 历年课表页面 → 解析并规范化
                      └─ grades → 最新学期成绩汇总 → 规范化
```

## 前端设计

增加独立的“快捷指令 API”页面：

- 未绑定账号：沿用现有绑定提示。
- 无会员：显示该功能需要初级会员以上，不显示生成按钮。
- 已有会员但没有密钥：显示“生成快捷指令密钥”。
- 已有密钥：显示脱敏前缀和生成时间，提供“重新生成”按钮；重新生成前使用确认提示。
- 生成成功后显示一次完整密钥、复制按钮、接口地址和最小请求示例，并明确提示刷新页面后无法再次查看旧密钥。
- 页面加载快捷指令 API 页面时调用 `GET /api/member/api-key`；生成后刷新状态卡片。

## 安全和边界

- 使用 `secrets` 生成随机密钥，使用 SHA-256 保存和验证，不保存明文。
- 公共查询每次检查会员，不依赖生成密钥时的会员状态。
- 不在 URL、前端日志或请求日志中记录密钥；公共响应不返回密码、Cookie 或其他账号凭据。
- 仅允许白名单动作和明确参数，拒绝把任意函数名或任意 URL 转发给 URP。
- 本版本不引入新的限流系统；若后续发现公共接口存在滥用，再单独设计限流和密钥撤销管理。

## 测试策略

使用仓库现有的 `unittest` 手动测试风格，不引入 pytest。

- 数据库测试：临时 SQLite 初始化后确认 `api_keys` 表、唯一约束和迁移清单存在。
- 密钥服务测试：确认生成密钥可认证、哈希不等于明文、同一学号重新生成后旧密钥失效、不同学号密钥不冲突。
- 密钥路由测试：确认未绑定和非会员不能生成，会员生成响应只在生成时返回明文，状态接口只返回前缀和时间。
- 公共路由测试：确认缺少字段、无效密钥、会员过期、未知动作和错误参数返回稳定错误码；成功请求按动作返回统一 `data`。
- 查询适配测试：用假的 URP 服务结果确认历年课表和成绩字段映射、计数和默认最新学期行为。
- URP 查询测试：增加空学期自动选择最新选项的 fixture 测试，并保留显式学期查询的原有测试。
- 前端静态测试：确认快捷指令 API 独立页面存在密钥卡片、生成按钮、复制入口和公共 API 地址；主脚本包含页面状态加载和生成调用。

## 验收标准

1. 初级会员和高级会员可以在快捷指令 API 页面生成密钥，普通用户不能生成。
2. 同一学号始终只有一个有效密钥，重新生成后旧密钥立即返回 `invalid_key`。
3. Apple 快捷指令只需向一个 POST 地址提交密钥和动作即可查询两类数据。
4. 历年课表不传学期时返回 URP 最新学期；成绩动作与网页“一键查本学期成绩”口径一致。
5. 成功和失败响应均为可直接解析的 JSON，字段稳定且不泄露密码、Cookie 或密钥明文。
6. 现有网页登录、会员购买、课表和成绩接口行为不被改变。
