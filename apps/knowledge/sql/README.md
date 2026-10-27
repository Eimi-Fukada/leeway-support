# 知识库数据库 SQL

核对日期：2026-10-27。覆盖当前登录、会话、知识库、文件上传与预览；没有提前创建 RAG、向量或应用授权表。原文件保存在私有磁盘，数据库保存元数据和存储 key。

| 文件顺序 | 内容 |
| --- | --- |
| 001_schema.sql | knowledge_users、knowledge_sessions、knowledge_bases 及约束/索引 |
| 002_seed_support.sql | support 账号，只有密码哈希；已有账号不覆盖、不重置密码 |
| 003_documents.sql | knowledge_documents 及库内去重、列表索引 |

所有表在产品数据库 public；数据库需预先存在。这里不初始化 Agent 表。

## 命令

配置 apps/knowledge/.env 后，在根目录运行：

```sh
corepack pnpm knowledge:db:status
corepack pnpm knowledge:db:init
```

status 只读检查实际结构和 support 账号，不初始化、不记录执行历史。缺失/不符返回非零状态，提示对应 SQL。它检查当前必要表、字段类型/可空性、按 SQL 命名的必要约束与有效索引；不比较默认值或约束/索引表达式，不检验密码值。详见 [表清单](../../../docs/database-tables.md)。

init 按文件名顺序执行本目录全部编号 SQL，在同一事务与 advisory lock 中完成。每次执行全部文件，不使用自有迁移账本。当前文件可以重复运行；以后新增文件应使用固定宽度编号并保证可重复执行，初始化脚本会自动发现。新增功能时同时维护 scripts/db-status.ts 中的结构检查项。

## 手动执行

数据库工具按 001 → 002 → 003 顺序执行，建议放进同一事务。psql 在本目录可运行：

```sh
psql -X -v ON_ERROR_STOP=1 --single-transaction --dbname=<目标数据库配置> -f 001_schema.sql -f 002_seed_support.sql -f 003_documents.sql
```

不要提交真实连接密码。新建表用新编号 SQL，已有表的字段/约束变化用显式 ALTER；CREATE TABLE IF NOT EXISTS 不会补齐已有表所有差异。

## 验证

corepack pnpm knowledge:test:postgres 验证四张表的空结构初始化、重复运行保留账号、外键与名称唯一性；通过临时表验证状态检查的正常、空库和结构缺失路径。临时对象随测试连接结束清理，不删除 public 业务表。

Agent SQL 见 [Agent 目录](../../agent/sql/README.md)。两个应用一起初始化/检查用根命令 db:init / db:status。旧表手动清理清单见 [表职责](../../../docs/database-tables.md)。
