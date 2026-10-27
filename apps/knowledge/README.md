# Leeway Knowledge · 知识空间

独立 Next.js 应用。当前完成固定管理员登录/退出、知识库创建与列表、持久数据库会话和原创图标。卡片可进入 /knowledge-bases/:id，详情采用知识库列表、文档区、库内问答区布局；外层不再保留聊天导航。

详情已接入真实文档上传、持久列表与原文预览；问答区仍可编辑草稿，发送/新会话/历史暂不可用。原文件保存不代表已完成知识解析、索引或 RAG，列表明确显示“已上传 · 未解析”。

## 本地运行

在仓库根目录：

```sh
corepack pnpm install
```

将 apps/knowledge/.env.example 复制为同目录 .env，配置现有产品数据库的 DATABASE_URL；应用自己的 KNOWLEDGE_APP_URL 默认是 http://127.0.0.1:3200。当前环境已配置，数据库与 Agent 使用同一个 agent-support，不跨应用导入源码。

```sh
corepack pnpm knowledge:db:init
corepack pnpm knowledge:dev
```

打开 http://127.0.0.1:3200。用户名为 support，初始密码按本次用户指定值初始化；数据库和 SQL 文件中只保存随机盐 scrypt 哈希。网页中不预填或展示密码。

生产构建与本机运行：

```sh
corepack pnpm --filter @leeway-support/knowledge build
corepack pnpm knowledge:start
```

页面和 API 由一个 Next 服务运行，端口与 Agent 的 3100 分开。线上反向代理访问时把 KNOWLEDGE_APP_URL 设置为浏览器实际使用的 HTTPS origin；会话 Cookie 根据该 origin 设置 Secure，不信任浏览器任意提交的用户 ID。

## SQL 文件

- sql/001_schema.sql：public 中的 knowledge_users、knowledge_sessions、knowledge_bases 及约束/索引。
- sql/002_seed_support.sql：初始化 support，仅包含密码哈希。username 冲突时不覆盖已有账号或重置密码。
- sql/003_documents.sql：knowledge_documents 文档元数据、库内内容指纹唯一性与索引。本轮已应用，现有环境无需手动改表。

可以按 001–003 顺序直接执行 SQL，也可以使用 db:init。脚本按文件名顺序执行 sql 目录全部编号 SQL，使用一笔事务和 advisory lock，不保存执行记录；现有 SQL 可重复执行，已有账号不重置。`corepack pnpm knowledge:db:status` 只读检查表、字段、必要约束/索引和 support 账号，缺失时提示对应文件。数据库需预先存在，脚本不修改 Agent 表。完整表清单与检查范围见 [SQL 目录说明](sql/README.md)。

## 原文件与预览

支持 PDF、DOCX、UTF-8 TXT/Markdown，每文件最大 10 MiB（页面显示 10 MB），每次最多选择 10 个，逐个上传；每库最多 200 个。同库相同内容（SHA-256）不重复创建，改名重传返回原记录；不同库独立保存。同名不同内容是不同文档，尚未实现替换/版本发布。

- PDF：浏览器原生阅读器预览，支持字节 Range；不支持内嵌 PDF 的浏览器可下载原文。
- DOCX：通过 mammoth 提取纯文本，忽略 Word 排版、图片；ZIP 条目及声明解压大小有上限，损坏/加密文件明确拒绝。不是 OCR 或知识入库解析。
- TXT/Markdown：严格 UTF-8，作为纯文本展示，不执行 HTML、不自动请求文档中的图片/链接。
- 文本预览最多 100,000 字符，超过时提示下载全文；所有格式保留原文件，列表、预览和下载均需有效会话并核对库归属。

数据库只保存文档信息和内部存储引用，原文件保存在私有 `.knowledge-storage/`，不在 public 中。可通过 `KNOWLEDGE_STORAGE_DIR` 指定持久目录，修改后重启服务；该目录不被 Git 或 Next 静态部署追踪。备份/迁移需同时包含数据库与原文目录。

当前本机/单实例使用持久磁盘可直接运行，不需要 OSS 账号。多实例或没有持久磁盘的平台，应换成私有 OSS/S3 对象存储；`DocumentStorage` 封装了原文读写接口，但本轮没有实现或验收云适配器。不能把临时目录当作永久存储；多实例也不能各用不同本地目录却共用同一数据库。

上传先完成原文件写入再提交数据库记录；仅提交成功的记录对列表可见。文件系统与数据库不是原子事务，进程崩溃/数据库提交不确定时可能保留无引用文件，本轮不盲删以免破坏已提交结果；生产运维需据数据库引用做离线对账。读原文时验证大小与 SHA-256，损坏明确失败。格式签名检查不等于杀毒，当前仍是受控管理员上传入口。

接口：`GET/POST /api/knowledge-bases/:id/documents`，POST 使用原始文件 body 和 URL 编码的 X-File-Name；`GET .../:documentId/preview` 返回文本，`GET .../:documentId/original` 预览 PDF，增加 `?download=1` 下载原文。服务端在读取上传 body 之前确认会话和库权限，再按实际字节限流。

## 请求链与安全行为

```text
登录页 → POST /api/auth/login → 数据库用户 + scrypt 校验
→ 随机 token，只将 SHA-256 token 哈希存入数据库
→ HttpOnly / SameSite=Lax Cookie（HTTPS 下 Secure）
→ 页面与 API 按数据库会话鉴权
→ 创建知识库时 owner_id 由会话确定
→ 退出删除数据库会话并清理 Cookie，旧 Cookie 无法重放
```

会话有效期七天；过期或停用用户不能继续访问。同账号可多设备登录，退出仅撤销当前会话。应用不再累计登录频次，接口频率限制由部署网关负责，当前仓库不实现网关。POST 要求精确同源 Origin，实际 JSON 请求体最多 8 KiB。

知识库名称最多 60 字符、描述最多 300 字符；同一账号下名称忽略大小写唯一，数据库原子约束处理并发冲突。知识库不强制归属业务项目，未来通过客服应用授权引用；本轮仅有管理员管理归属。

## 文件与命令

```text
app/                  Next 页面与四组 Route Handlers
components/           登录、知识库列表和创建弹窗
src/                  密码、数据库连接、业务服务、纯数据契约与请求校验
src/server/           server-only 资源与请求会话读取
sql/                  可直接执行的 schema 与账号初始化
scripts/init-db.ts    按编号执行初始化 SQL
scripts/db-status.ts  只读检查结构与初始账号
public/brand-icon.svg 可编辑原创图标；PNG 为 512px 导出
tests/                密码/输入/请求边界及真实 PostgreSQL 测试
```

```sh
corepack pnpm --filter @leeway-support/knowledge test
corepack pnpm knowledge:test:postgres
corepack pnpm --filter @leeway-support/knowledge typecheck
```

PostgreSQL 测试使用随机 it- 用户与其知识库，结束后只清理这些记录；另用临时表验证 SQL 完整性和只读状态检查。运行截图保存在根目录 output/playwright/knowledge，默认不提交。
