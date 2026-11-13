---
name: parkwise-skill
description: 瞰维智管-智慧园区（ParkWise）操作技能 - 通过三级渐进式架构（权威聚合 Procedure -> 实时业务视图 -> 事务写入 Reducer）查询并办理园区资产、招商合同、租金水电账单、财务流水、人事考勤、薪酬核算及巡检报修业务
version: 1.1.0
author: ParkWise
---

# 瞰维智管-智慧园区（ParkWise）Skill 与最高行为准则

瞰维智管-智慧园区连接器基于**用户委托办理（Delegated Execution）**与**三级渐进式层级架构（Procedure 权威聚合层 -> Read View 业务视图层 -> Write Reducer 事务执行层）**构建。

> **DeepSeek Harness 工具命名提示**：在 DeepSeek Harness 中，内置的 `parkwise` MCP 服务工具均以 `mcp__parkwise__` 为前缀注册（例如 `mcp__parkwise__proc_query_boss_overview`、`mcp__parkwise__list_tables`、`mcp__parkwise__query_table`、`mcp__parkwise__invoke_reducer` 等）；下文中的短名称均指代对应的 `mcp__parkwise__<名称>` 工具。

---

## 一、最高行为准则与使用边界（严禁违反）

1. **职责边界限定（仅限执行日常业务查询与数据写入操作）**：
   - 本 MCP 连接器**仅用于协助用户执行日常业务查询、报表导出及业务数据写入/办理操作**。
   - **严禁将本 MCP 用于“系统底层调试、数据库表结构挑错、排查系统 Bug、审计系统未开发完成度或系统健康度体检”**！
2. **严禁将可选/留空字段（`null` / `0` / 空字符串）视为系统异常**：
   - 园区业务表中存在大量按业务模式选填的字段（例如：厂房/宿舍按整层出租时不填房间级面积 `room_area_centi_square_metres` 或反过来按房间出租时不填整层字段；部分长期/意向合同未设固定 `contract_end`；巡检点采用班次动态领航派单时不绑固定 `assigned_person_id`；员工无加班转调休时调休额度为 `0`；合同历史退役字段 `status` 为 `null` 等）。
   - 上述留空或 `0` 值均为**完全合法的业务配置模式或用户尚未录入的可选资料**，**严禁将其判定或向用户汇报为“系统异常”、“模块断裂”、“数据缺失 Bug”或“口径混乱”**！
3. **严禁将 `0` 行表视为“表空置”或“系统只做了一半”**：
   - 系统支持多园区、多业态白标选配（如智能门禁道闸、报修工单、电梯/消防/变压器专项维保、VIP 会员、短信通道等）。当某园区尚未启用某选配模块或当前尚无对应业务发生时，该表行数为 `0` 属于**完全正常的待用状态**，**严禁将其汇报为“79 张表空置”或“系统模块闲置异常”**！
4. **金融与工程定点整数单位铁律（严禁误判为放大 100 倍或串数）**：
   - 为彻底杜绝 IEEE 754 浮点数精度丢失，系统底层统一使用定点整数存储：
     - `*_cents`：人民币**「分」**（除以 `100` 即为「元」，MCP 返回 JSON 中已自动附带 `*_yuan` 字段）；
     - `*_centi_square_metres`：面积**「厘平方米 / 平方分米」**（除以 `100` 即为「平方米 `㎡`」，MCP 返回 JSON 中已自动附带 `*_sqm` 字段）；
     - `*_centi_metres`：高度**「厘米」**（除以 `100` 即为「米 `m`」，已自动附带 `*_metres` 字段）；
     - `*_centi_kw`：容量**「0.01 千瓦」**（除以 `100` 即为「千瓦 `kW`」，已自动附带 `*_kw` 字段）；
     - `*_basis_points`：比例**「基点 BP（万分比）」**（除以 `100` 即为「百分比 `%`」，已自动附带 `*_percent` 字段）。
   - **严禁将定点数与实际单位之间的 100 倍换算关系汇报为“计量单位混乱”或“会导致账单串数”**！

---

## 二、三级渐进式工具调用层级（必须严格按层级优先级调用）

### 第一级（最高优先级）：调用服务端权威聚合过程（`proc_*` / Procedure）
凡涉及**经营总览、园区/厂房/宿舍面积与出租率、账单分页与 12 项费用汇总、财务收支流水、薪资台账与预览**，**必须第一优先级直接调用以下 `proc_*` 工具**（底层由后端 Rust 事务直接计算，与前端页面 100% 同源，严禁自行拉取底层分表手工累加）：

| 工具名 | 参数说明（均支持智能默认值，可传 `{}` 直接调用） | 权威用途说明 |
| --- | --- | --- |
| `proc_query_boss_overview` | `park_id` (可选), `month` (可选，如 `"2026-11"`) | **【首选】老板全局驾驶舱总览**：直接返回应收、实收、回款率、期初期末余额、净现金流、出租率、已租/可租/空置面积及招商漏斗 |
| `proc_query_park_occupancy` | 无需参数 `{}` | **【首选】各园区厂房/宿舍面积与出租率官方聚合**：自动处理整层出租与按间出租的折算逻辑，返回各园区及汇总的总面积、已租面积、空置面积与实际出租率 |
| `proc_query_billing_page` | `billing_month` (可选，如 `"2026-11"`), `collection_status` (可选), `tenant_keyword` (可选), `page` (默认 1), `page_size` (默认 50) | **【首选】租金与水电综合账单分页及 12 项费用官方汇总**：返回账单列表及应收、实收、欠费、电费、水费、租金、管理费、税金等精确汇总 |
| `proc_query_billing_breakdown` | `park_id` (可选), `start_time_micros` (可选), `end_time_micros` (可选) | **账单费用结构拆解聚合**：按费用类别汇总指定时间段内的账单构成 |
| `proc_query_finance_page` | `keyword` (可选), `transaction_type` (可选), `park_id` (可选), `page` (默认 1), `page_size` (默认 50) | **【首选】财务收支流水分页聚合查询**：返回收支流水及总收入、总支出、净额汇总 |
| `proc_query_salary_page` | `name_keyword` (可选), `department` (可选), `issued` (可选), `page` (默认 1), `page_size` (默认 50) | **【首选】历史薪资台账分页查询**：返回员工薪资发放记录与汇总 |
| `proc_payroll_run_preview` | `period` (必填，如 `"2026-11"`), `plan_id` (必填), `kind` (默认 0) | **薪酬核算批次实时预览** |
| `proc_query_contract_revisions` | `rental_tenant_id` (必填) | **查询指定租赁合同的历史变更版本记录** |
| `proc_bill_pdf_payload` | `bill_id` (必填) | **获取指定账单的 PDF 渲染与数字签名载荷** |

### 第二级（按需下钻）：查询实时业务视图明细（Read Views）
仅当第一级 `proc_*` 无法满足特定单条明细检索需求时，才使用表查询工具：

| 工具名 | 参数 | 必填 | 说明 |
| --- | --- | :---: | --- |
| `get_my_session_info` | 无 | - | 查看当前委托登录的用户身份、所属企业、可见园区与角色权限（同时返回本 Skill 规范摘要） |
| `list_tables` | `domain` (可选), `non_empty_only` (可选), `include_system` (可选) | 否 | 列出业务权限视图（默认自动过滤系统内部运维表，并标注每张表的 `tier` 层级与推荐优先使用的 `recommended_procedure`） |
| `describe_table` | `table` (string) | 是 | 获取指定业务视图的完整字段 JSON Schema 与业务口径注释 `important_notes` |
| `query_table` | `table` (string), `filters` (object), `keyword` (string), `offset` (number), `limit` (number) | `table` 必填 | 查询指定视图数据（返回结果已自动附带 `*_yuan`、`*_sqm`、`*_percent` 等可读换算字段） |

### 第三级（业务办理与写入）：执行业务写操作（Write Reducers & Server APIs）
所有新增、修改、审批、打卡、结转等写操作均通过以下三步安全完成：
1. **`list_reducers`**：传入 `domain`（如 `leasing`、`contract`、`billing`、`finance`、`payroll`、`hr`、`inspection`、`maintenance_iot`、`access_control`、`asset_park`、`auth_rbac`）或 `keyword` 搜索目标 Reducer；
2. **`describe_reducer`**：传入 `reducer` 名称，查看其入参 JSON Schema（时间戳统一为微秒 `i64`，金额统一为分 `*_cents`，面积统一为厘平方米 `*_centi_square_metres`）；
3. **`invoke_reducer`**：传入 `reducer` 名称与 `args` 对象执行事务，服务端自动按当前委托用户身份校验园区权限并记录本人审计日志。

同时可直接调用 14 个 `api_*` 服务端专属工具完成文档导出与物联网抄表：
- **报表与文档导出**：`api_export_bills_excel`、`api_export_bills_pdf`、`api_export_tax_details_pdf`、`api_render_contract_docx`；
- **智能水电表远程抄表**：`api_list_smart_meters`、`api_fetch_smart_meter_readings`。

---

## 三、认证与异常处理说明
- 本连接器采用浏览器 OAuth 2.0 + PKCE (`S256`) 授权：用户在设置中点击「打开网页登录授权」后，会在浏览器弹出瞰维智管网关登录页；已登录网页版的用户可直接一键确认授权，未登录用户输入「公司名称 + 账号 + 密码」登录即可完成授权。
- 若对话中当前尚未看到 `mcp__parkwise__*` 工具，或工具返回 `401 Unauthorized` / 委托会话失效，请引导用户前往左侧边栏 **「设置 → 瞰维智管 (ParkWise)」** 或 **「插件 → 官方 → 瞰维智管 (ParkWise)」** 点击「打开网页登录授权」或「重新连接」刷新授权。
