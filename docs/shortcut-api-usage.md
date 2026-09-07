# Apple 快捷指令 API 使用文档

## 1. 功能说明

本 API 面向 Apple 快捷指令，当前支持以下三个查询功能：

| `action` | 功能 | 默认行为 |
| --- | --- | --- |
| `historical_schedule` | 查询历年课表 | 未指定学期时查询 URP 返回的最新学期 |
| `grades` | 查询成绩 | 使用网页“一键查询本学期成绩”的查询口径 |
| `urgent_event` | 查询接下来最紧急的事项 | 返回最近的下一节课或下一场考试 |

接口只允许初级会员及高级会员使用。直接查询考试安排、GPA、评教等功能暂未开放。

返回数据来自该学号绑定的 URP 教务系统：课表由 URP 历年课表页面解析，成绩由网页现有的最新学期成绩汇总逻辑查询，紧急事项由课表和考试安排缓存计算。API 只把原始结果转换为适合快捷指令读取的英文 JSON 字段。

## 2. 获取 API 密钥

1. 登录网站并完成学号绑定。
2. 进入“快捷指令 API”页面。
3. 初级会员或高级会员点击“生成密钥”。
4. 立即复制并保存完整密钥。

注意：

- 密钥只在生成成功的页面显示一次，刷新页面后不能再次查看完整密钥。
- 同一学号同时只有一个有效密钥。
- 重新生成密钥会立即使旧密钥失效。
- 密钥只与学号绑定，不与设备 ID 绑定；换绑或更换设备不会自动使密钥失效。
- API 查询请求不需要提交 `X-Device-ID` 请求头。
- 会员到期后，即使密钥仍然存在，也不能继续查询。

## 3. 公共查询接口

### 请求地址

```text
POST https://www.meizhenxin.cn/api/shortcut/query
```

如果部署地址不同，将域名替换为实际网站地址即可。

### 请求头

```http
Content-Type: application/json
```

不需要 `X-Device-ID`。

### 请求体

```json
{
  "key": "urp_你的完整密钥",
  "action": "grades",
  "params": {}
}
```

字段说明：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `key` | string | 是 | 网站生成的完整 API 密钥 |
| `action` | string | 是 | `historical_schedule`、`grades` 或 `urgent_event` |
| `params` | object | 否 | 查询参数；省略时按 `{}` 处理 |

密钥必须放在 JSON 请求体中，不要放在 URL 查询参数中。

## 4. 查询历年课表

### 查询最新学期

不传学期时，系统会自动选择 URP 返回的最新学期：

```json
{
  "key": "urp_你的完整密钥",
  "action": "historical_schedule",
  "params": {}
}
```

`params` 也可以省略：

```json
{
  "key": "urp_你的完整密钥",
  "action": "historical_schedule"
}
```

### 查询指定学期

```json
{
  "key": "urp_你的完整密钥",
  "action": "historical_schedule",
  "params": {
    "semester": "2025-2026-2-1"
  }
}
```

`semester` 应填写 URP 学期选项对应的值，不能随意填写显示名称。

### 成功响应

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

课表字段说明：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `student_id` | string | 学号 |
| `semester` | string | URP 学期值 |
| `semester_name` | string | 学期显示名称 |
| `course_count` | number | 课程数量，与 `courses` 数组长度一致 |
| `courses` | array | 课程列表 |

课程对象字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `course_name` | string | 课程名称 |
| `weekday` | number | 星期几，1 至 7 分别表示周一至周日 |
| `weekday_name` | string | 星期名称 |
| `start_section` | number | 开始节次 |
| `section_count` | number | 连续节数 |
| `section_name` | string | 节次显示名称，例如 `第1-2节` |
| `location` | string | 上课地点 |
| `class_no` | string | 课序 |

没有课程时仍然是成功响应，`course_count` 为 `0`，`courses` 为 `[]`。

## 5. 查询成绩

### 请求

```json
{
  "key": "urp_你的完整密钥",
  "action": "grades",
  "params": {}
}
```

该动作不需要指定学期。系统会按照网页“一键查询本学期成绩”的逻辑，自动选择最新学期，并同时返回及格成绩、当前不及格和历史不及格记录。

### 成功响应

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

成绩字段说明：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `student_id` | string | 学号 |
| `semester` | string | 本次查询使用的最新学期 |
| `passed_count` | number | 及格成绩数量 |
| `failed_current_count` | number | 当前仍不及格的数量 |
| `failed_past_count` | number | 曾经不及格的数量 |
| `passed` | array | 及格成绩列表 |
| `failed_current` | array | 当前不及格列表 |
| `failed_past` | array | 历史不及格列表 |

`passed` 中每项包含：

```json
{
  "course_name": "软件工程导论",
  "score": "92"
}
```

`failed_current` 和 `failed_past` 中每项包含：

```json
{
  "course_name": "高等数学",
  "score": "58",
  "credit": "4",
  "exam_time": "20250101"
}
```

成绩值保持 URP 原始字符串格式，请按字符串读取，不要假定一定是数字。

## 6. 查询接下来最紧急的事项

### 请求

```json
{
  "key": "urp_你的完整密钥",
  "action": "urgent_event",
  "params": {}
}
```

该动作复用网站首页“接下来最紧急的事情”的判断逻辑，并触发现有的课表/考试后台更新，从当前缓存中选择时间最近的下一项。`params` 不需要传其他内容。

### 成功响应

```json
{
  "success": true,
  "action": "urgent_event",
  "message": "查询成功",
  "data": {
    "student_id": "2415108133",
    "has_event": true,
    "event": {
      "type": "class",
      "title": "软件工程导论",
      "location": "仙林校区实C-501",
      "time": "2026-09-03 08:20",
      "countdown": 35
    }
  }
}
```

事项字段说明：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `student_id` | string | 学号 |
| `has_event` | boolean | 是否存在下一事项 |
| `event` | object/null | 下一事项；没有事项时为 `null` |
| `event.type` | string | `class` 表示课程，`exam` 表示考试 |
| `event.title` | string | 课程名称或考试科目 |
| `event.location` | string | 地点 |
| `event.time` | string | 课程或考试时间 |
| `event.countdown` | number | 距离开始的分钟数 |
| `event.seat` | string | 考试座位号，仅考试事项返回 |

没有下一事项时，`data` 为：

```json
{
  "student_id": "2415108133",
  "has_event": false,
  "event": null
}
```

## 7. 失败响应

预期的业务错误统一返回 HTTP `200`，通过 `success` 和 `error_code` 判断是否成功：

```json
{
  "success": false,
  "action": "grades",
  "error_code": "member_required",
  "message": "此功能需要初级会员",
  "data": null
}
```

错误码：

| `error_code` | 含义 | 处理建议 |
| --- | --- | --- |
| `invalid_request` | 请求体不是 JSON，或缺少 `key`、`action` | 检查请求体和字段类型 |
| `invalid_key` | 密钥不存在或已被重新生成替换 | 使用当前保存的完整密钥重新生成请求 |
| `member_required` | 没有有效的初级或高级会员 | 续费或开通会员 |
| `invalid_action` | `action` 不受支持 | 只能使用三个已开放动作 |
| `invalid_params` | 参数格式不正确 | 检查 `params` 是否为对象、学期是否为字符串 |
| `login_required` | 学号没有有效绑定或教务登录已失效 | 先在网站重新绑定或登录 |
| `query_failed` | URP 查询或解析失败 | 稍后重试 |

快捷指令中建议先判断：

```text
success 等于 true
```

只有成功时才读取 `data`。失败时显示 `message`，并可同时显示 `error_code` 方便排查。

## 8. Apple 快捷指令配置

以“查询成绩”为例：

1. 新建快捷指令，添加“获取 URL 内容”操作。
2. URL 填写：

   ```text
   https://www.meizhenxin.cn/api/shortcut/query
   ```

3. 将方法设置为 `POST`。
4. 请求体类型选择 `JSON`。
5. 添加以下 3 个 JSON 字段：

   | 键 | 值 |
   | --- | --- |
   | `key` | 粘贴网站生成的完整密钥 |
   | `action` | `grades` |
   | `params` | 字典，内容为空 |

6. “获取 URL 内容”返回的结果就是一个字典。先获取键 `success`，使用“如果”判断是否为 `true`。
7. 成功时获取键 `data`，再从 `data` 中获取 `passed`、`failed_current` 或 `failed_past`。
8. 可使用“重复项目”逐条读取课程名称和成绩，再通过“显示结果”或“快速查看”展示。

查询最新学期课表时，只需把 `action` 改为 `historical_schedule`，`params` 保持空字典即可。

查询接下来最紧急的事项时，将 `action` 改为 `urgent_event`，`params` 保持空字典；成功后从 `data.event` 读取事项，没有事项时检查 `data.has_event` 为 `false`。

推荐的快捷指令处理结构：

```text
获取 URL 内容
  └─ 如果 success = true
       └─ 获取 data
            ├─ grades → passed / failed_current / failed_past
            ├─ historical_schedule → courses
            └─ urgent_event → event
     否则
       └─ 显示 message
```

## 9. cURL 测试示例

### 查询成绩

```bash
curl -X POST "https://www.meizhenxin.cn/api/shortcut/query" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "urp_你的完整密钥",
    "action": "grades",
    "params": {}
  }'
```

### 查询最新学期课表

```bash
curl -X POST "https://www.meizhenxin.cn/api/shortcut/query" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "urp_你的完整密钥",
    "action": "historical_schedule",
    "params": {}
  }'
```

### 查询接下来最紧急的事项

```bash
curl -X POST "https://www.meizhenxin.cn/api/shortcut/query" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "urp_你的完整密钥",
    "action": "urgent_event",
    "params": {}
  }'
```

## 10. 安全提醒

- API 密钥等同于查询授权凭证，不要发布到群聊、截图或公开代码仓库。
- 不要把密钥拼接到 URL 中。
- 如果怀疑密钥泄露，立即在网站重新生成密钥，旧密钥会失效。
- 当前公共接口未提供独立的限流配置，请避免高频循环请求。
