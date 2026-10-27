# Agent 数据库 SQL 与初始化

核对日期：2026-10-27。目标为产品数据库 public schema；知识库自己的表和初始登录账号在 apps/knowledge/sql。

| 文件 | 表及用途 |
| --- | --- |
| 001_long_term_memory.sql | support_memories 长期记忆；support_memory_operations 记忆写入幂等 |
| 002_information_forms.sql | support_information_forms 补资料、interrupt 与提交恢复 |
| 003_conversations.sql | support_conversation_requests 请求状态/结果/幂等；support_conversation_messages 可见历史 |
| 010_langgraph_checkpoint.sql | checkpoints、checkpoint_blobs、checkpoint_writes、checkpoint_migrations，官方图状态持久化 |

共九张表，全部用于当前运行链路。消息档案、请求状态和图执行快照不能互相替代。checkpoint_migrations 由 SDK 使用，必须保留；不再创建自有 support_schema_migrations。

## 命令

配置 apps/agent/.env 后，从根目录运行：

```sh
corepack pnpm agent:db:status
corepack pnpm agent:db:init
```

status 只读检查当前必需表、字段类型/可空性、按 SQL 命名的必要约束及有效索引，以及官方迁移版本 0–5。缺失/不符返回非零状态并标注 SQL。不调用模型、setup 或任何初始化代码；不比较默认值和约束/索引表达式，也不记录 SQL 执行历史。

init 按文件名顺序读取编号 SQL，010 是官方快照的特例：自有 SQL 在同一事务与 advisory lock 中执行，随后由 SDK 官方 PostgresSaver.setup 初始化 checkpoint。两阶段不是跨连接原子事务，第二阶段失败可修复后重跑。当前自有文件均可重复运行，不重置数据。

未来新增自有 SQL 使用固定宽度编号并保证可重复执行，初始化会自动发现；新增功能时更新 scripts/db-status.ts 的检查项。CREATE TABLE IF NOT EXISTS 不会修复已存在表的全部差异，修改已有结构需要实际 ALTER。

两个应用一起初始化/检查用 db:init / db:status；两者分别读取自己的数据库配置，不创建数据库。

## 手动执行

数据库工具先执行 001 → 002 → 003，可放同一事务；再单独执行 010。010 自带 BEGIN/COMMIT，不要包外层事务。

```sh
psql -X -v ON_ERROR_STOP=1 --single-transaction --dbname=<目标数据库配置> -f 001_long_term_memory.sql -f 002_information_forms.sql -f 003_conversations.sql
psql -X -v ON_ERROR_STOP=1 --dbname=<目标数据库配置> -f 010_langgraph_checkpoint.sql
```

正常应用启动仍保留原幂等 setup，读取同一 001–003 SQL，SDK 自己处理 checkpoint。部署前建议主动执行初始化和状态检查。

## 官方 SQL 来源与验证

010 对应锁定 @langchain/langgraph-checkpoint-postgres 1.1.2 的六条官方迁移（0–5）。开发期离线导出用 corepack pnpm --filter @leeway-support/agent db:export-checkpoint，升级 SDK 后审阅 diff 并更新状态检查。导出器读取包内迁移模块，仅用于开发校验；运行时使用官方 setup。快照拒绝比当前 SDK 新的数据库版本，不能只插官方版本记录而不执行 DDL。

corepack pnpm test 验证快照与当前 SDK 完全一致；corepack pnpm test:postgres 在产品连接的临时表验证全部九张表、重复运行、旧字段补充和只读检查。不会删除 public 表，也没有额外学习数据库。完整 [表职责及旧表清理清单](../../../docs/database-tables.md)。
