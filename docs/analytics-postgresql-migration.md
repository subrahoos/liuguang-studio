# 经营复盘 PostgreSQL 迁移准备

当前 3100 仍使用本地 SQLite，现阶段不切换数据库。经营复盘新增表已按“批次、数据归属用户、操作用户”三层拆分，后续迁移 PostgreSQL 时不需要改变页面和 API 业务语义。

## 迁移边界

- `analytics_imports`：导入任务、预检、确认和后台进度。
- `analytics_store_daily`、`analytics_product_metrics`：Excel 原口径指标。
- `analytics_data_issues`、`analytics_*_audits`、`analytics_reconciliations`：准确性门禁与数据血缘。
- `analytics_audit_logs`：管理员可追溯的操作记录。

经营复盘只迁移 Excel 原表解析结果。不得在 PostgreSQL 中恢复订单重算指标表或数据修正表。

## PostgreSQL 映射要求

1. 金额字段从 SQLite `real` 改为 PostgreSQL `numeric(20,6)`，导入和汇总继续使用微元精度。
2. 时间字段改为 `timestamptz`，业务日期继续使用 `date`。
3. JSON 文本字段改为 `jsonb`。
4. 导入批次状态使用数据库 enum 或受约束文本：`queued`、`processing`、`preview_ready`、`completed`、`failed`。
5. 所有经营查询必须保留 `owner_id` 条件；管理员跨用户读取由服务层显式传入 owner ID 集合。
6. 原始 XLSX 继续放对象存储或受控文件系统，数据库仅保存路径、哈希和解析结果。

## 上线前步骤

1. 新建 PostgreSQL Drizzle schema 和独立连接适配器。
2. 双写一轮导入批次，对比 SQLite 与 PostgreSQL 的行数、金额合计和对账门禁。
3. 对 `owner_id + import_id + metric_date`、商品键和审计时间建立索引。
4. 做备份、恢复、并发导入和十用户持续使用压测。
5. 通过环境变量切换读库，保留 SQLite 只读回退窗口，再停止双写。

当前禁止直接把生产读取切到 PostgreSQL；需要等公网服务器、备份策略和连接密钥管理确定后再执行。
