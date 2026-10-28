# 知识库数据库 SQL

核对日期：2026-10-27。覆盖登录、会话、知识库、上传/预览、解析/分块、嵌入结果和 Qdrant 索引完成回执。原文件在私有磁盘；数据库保存正文/片段、向量及状态，Qdrant 另存检索 point。尚无应用授权表或 Agent 问答集成。

| 文件顺序 | 内容 |
| --- | --- |
| 001_schema.sql | knowledge_users、knowledge_sessions、knowledge_bases 及约束/索引 |
| 002_seed_support.sql | support 账号，只有密码哈希；已有账号不覆盖、不重置密码 |
| 003_documents.sql | knowledge_documents 及库内去重、列表索引 |
| 004_document_processing.sql | 文档表补充处理状态、失败阶段、安全错误码和更新时间；旧文本为待处理，PDF/Word 为仅原文预览 |
| 005_document_ingestion.sql | 扩展轮次、租约和 chunked 状态；旧 DOCX 开放解析，新增 knowledge_document_contents、knowledge_document_chunks |
| 006_document_embeddings.sql | 已有片段表增加 embedding JSONB，文档增加 embedding_profile，embedded 表示向量完成、待写入索引 |
| 007_qdrant_index.sql | 文档表 index_target 与 index_receipt，保存写入目标/内容批次/核对时间；不新增表 |

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

数据库工具按 001 → 002 → 003 → 004 → 005 → 006 → 007 顺序执行，建议放进同一事务。psql 在本目录可运行：

```sh
psql -X -v ON_ERROR_STOP=1 --single-transaction --dbname=<目标数据库配置> -f 001_schema.sql -f 002_seed_support.sql -f 003_documents.sql -f 004_document_processing.sql -f 005_document_ingestion.sql -f 006_document_embeddings.sql -f 007_qdrant_index.sql
```

不要提交真实连接密码。新建表用新编号 SQL，已有表的字段/约束变化用显式 ALTER；CREATE TABLE IF NOT EXISTS 不会补齐已有表所有差异。

## 验证

corepack pnpm knowledge:test:postgres 验证六张表的空结构初始化、已向量化文档的重复初始化、旧 DOCX 升级、原子片段/向量提交、并发领取、进程中断和显式重试。嵌入失败流程使用模拟服务，不能替代真实模型验收。测试只清理各自随机资料，不删除 public 中的实际业务表。

Agent SQL 见 [Agent 目录](../../agent/sql/README.md)。两个应用一起初始化/检查用根命令 db:init / db:status。旧表手动清理清单见 [表职责](../../../docs/database-tables.md)。
