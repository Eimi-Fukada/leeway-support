# Leeway Knowledge · 知识空间

独立 Next.js 应用。当前完成固定管理员登录/退出、知识库创建与列表、持久数据库会话和原创图标。卡片可进入 /knowledge-bases/:id，详情采用知识库列表、文档区、库内问答区布局；外层不再保留聊天导航。

详情已接入真实上传、预览、处理进度、全文解析、成熟分块、本地嵌入和 Qdrant 写入/读回核对。当前仅接受 TXT、Markdown、DOCX；worker 全程处理后标记为“可检索”。聊天 Agent 和库内问答尚未接入。历史 PDF 仍可预览，暂不接受新上传。

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

另开一个终端启动同一知识库应用的处理进程：

```sh
corepack pnpm knowledge:worker
```

网页服务负责接收文件和查询状态，worker 从 PostgreSQL 领取已提交的待处理文档；它们需连接同一数据库和私有文件目录。未启动 worker 时文件保持待处理，不依赖浏览器保持打开。单次领取并执行可使用 `corepack pnpm knowledge:worker --once`；日常使用保持 worker 运行。关闭时允许当前任务收尾，不启动新任务。

## 嵌入配置

配置只在知识库服务端/worker 使用，和 Agent 聊天模型独立；不要使用 NEXT_PUBLIC_ 前缀。当前本地设置见 .env.example：

```dotenv
EMBEDDING_PROVIDER=ollama
EMBEDDING_BASE_URL=http://127.0.0.1:11434
EMBEDDING_MODEL=qwen3-embedding:0.6b
EMBEDDING_MODEL_REVISION=ac6da0dfba84a81fdbfbaf330198c33cd77c4cdfc53e8bc50eb581914a15621d
EMBEDDING_DIMENSIONS=1024
EMBEDDING_TIMEOUT_MS=120000
EMBEDDING_BATCH_SIZE=8
EMBEDDING_API_KEY=
EMBEDDING_DOCUMENT_PREFIX=
EMBEDDING_QUERY_PREFIX="Instruct: Given a customer support question, retrieve relevant passages that answer the question\nQuery: "
```

Windows 的模型文件在 D:/ollama-models 时，先在单独 PowerShell 中启动模型服务，再启动 worker：

```powershell
$env:OLLAMA_MODELS = "D:\ollama-models"
ollama serve
```

本机本轮发现默认 GPU 探测后 API 无响应，临时关闭 GPU 的 CPU 模式可成功运行；已在 11434 启动 CPU 模式服务。若重启后仍有相同问题，可在启动前额外设置 `$env:OLLAMA_VULKAN="0"` 和 `$env:CUDA_VISIBLE_DEVICES="-1"`。这是当前启动方式的排障结果，不代表已完成 GPU 驱动或硬件问题定位。

已运行的 Ollama 不需重复启动。模型目录是 Ollama 的配置，不是知识库代码直接读权重的路径。首次加载和并发会影响耗时；单批默认 120 秒，整个文档嵌入截止 30 分钟。批次失败不自动重试，页面明确重试可复用既有片段，仅重新生成向量。

切换云端 OpenAI 兼容嵌入服务时，设置 EMBEDDING_PROVIDER=openai-compatible，BASE_URL 为供应商 API 基础地址（通常包含 /v1），填写 MODEL、MODEL_REVISION、DIMENSIONS 和 API_KEY，按模型官方要求设置文档/查询前缀，重启 worker。底层分别调用 /api/embed 或 /embeddings；不是任意云厂商协议都能只改地址复用。当前兼容适配器只发送 model/input/encoding_format=float，DIMENSIONS 用来校验原生输出，不自动请求降维；需要指定降维参数的供应商另行适配。

模型版本字段由部署人员固定和更新，运行时不自动识别权重漂移；不要不更新 revision 就覆盖同名本地权重。provider、地址哈希、模型/版本、维度及前缀形成 profile 标识（不含密钥），随完整向量结果保存。更换模型/配置后已有 embedded 文档不会自动重建，也不能与新模型混检；批量重建入口留给后续索引生命周期切片。

embedding 以 JSONB 保存在原有片段表，是 Qdrant 写入/核对/重试的可恢复输入，不是使用 PostgreSQL 做向量检索。六张知识库表数量不变，浏览器和片段接口均不返回向量数组或密钥。只有 Qdrant 全部写入并读回核对成功，才设置 ready。

## Qdrant 配置和查看

```dotenv
QDRANT_URL=http://127.0.0.1:6333
QDRANT_API_KEY=
QDRANT_COLLECTION_PREFIX=leeway_knowledge
QDRANT_TIMEOUT_MS=30000
QDRANT_BATCH_SIZE=32
```

当前使用 Docker 容器 leeway-knowledge-qdrant（实测 1.19.1），绑定 127.0.0.1:6333，数据卷 leeway-knowledge-qdrant-data:/qdrant/storage。原 grace-support 未更改，它没有端口映射；项目使用新的持久实例。重启机器后 Docker/Ollama 与 worker 都需可用。部署时保持应用到 Qdrant 的受控连接，不能把本机地址直接照搬进其他容器。

collection 名为前缀加完整 embedding profile ID。同模型的多个知识库在 collection 内由 knowledge_base_id 区分，写入前创建必要 payload 索引，不能依赖模型或用户传入的字符串授予权限。维度/距离不匹配时拒绝，不删旧 collection 重建。更换配置或模型后不自动移动已写入内容，也不会重新定向一个尚未核对的旧写入任务。

写入使用片段稳定 ID、wait=true，检查 completed 后按 ID 读回正文、范围、来源指纹、内容批次和向量。全部一致才保存 ready 与 index_receipt；响应仅 acknowledged、超时或进程中断都不能直接宣告成功。相同 ID upsert 可用于明确重试，不重新调用嵌入模型。

打开 http://127.0.0.1:6333/dashboard ，进入 Collections → leeway_knowledge_... → Points，查看 payload.text、文档/库 ID 和 vector。support 账号下保留了两个入库验收知识库，真实桌面文档分别写入 21/9 个 1024 维 point。具体 ID、筛选请求、单条 point 链接见 [查看指南](../../docs/qdrant-data-viewing.md)。Dashboard 是管理员入口，不执行网页用户权限。

ready 是最近核对完成的业务状态，不是持续健康检查。未来检索必须同时使用授权知识库过滤，并校验 PostgreSQL 中 ready/有效 generationId；部分写入点即使已在 Qdrant 物理存在，也不能提前用于回答。当前尚未发布业务检索接口。

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
- sql/003_documents.sql：knowledge_documents 文档元数据、库内内容指纹唯一性与索引。
- sql/004_document_processing.sql：现有文档表的处理状态、失败阶段、安全错误码和更新时间；兼容旧文档，不新增业务表。
- sql/005_document_ingestion.sql：处理轮次与租约、分块完成状态，以及 knowledge_document_contents 正文和 knowledge_document_chunks 片段两张业务表。
- sql/006_document_embeddings.sql：片段表 embedding 向量结果、文档 embedding_profile 配置标识，以及 embedded 等待索引状态；不新增表或 pgvector 扩展。
- sql/007_qdrant_index.sql：现有文档表增加 index_target 和 index_receipt，保存写入目标及逐项核对的完成依据；不新增表。

可以按 001–007 顺序直接执行 SQL，也可以使用 db:init。脚本按文件名顺序执行 sql 目录全部编号 SQL，使用一笔事务和 advisory lock，不保存执行记录；现有 SQL 可重复执行，已有账号不重置。`corepack pnpm knowledge:db:status` 只读检查表、字段、必要约束/索引和 support 账号，缺失时提示对应文件。数据库需预先存在，脚本不修改 Agent 表。完整表清单与检查范围见 [SQL 目录说明](sql/README.md)。

## 原文件与预览

支持 DOCX、UTF-8 TXT/Markdown，每文件最大 10 MiB（页面显示 10 MB），每次最多选择 10 个，逐个上传；每库最多 200 个。同库相同内容（SHA-256）不重复创建，改名重传返回原记录；不同库独立保存。同名不同内容是不同文档，尚未实现替换/版本发布。前台选择器与后端上传白名单都由解析适配器注册表生成，不能只改后缀绕过后端。

- 历史 PDF：浏览器原生阅读器预览，支持字节 Range；不支持内嵌 PDF 的浏览器可下载原文。当前不新上传或解析入库。
- DOCX：通过 mammoth 提取纯文本，忽略 Word 排版、图片；ZIP 条目及声明解压大小有上限，损坏/加密文件明确拒绝。不是 OCR 或知识入库解析。
- TXT/Markdown：严格 UTF-8，作为纯文本展示，不执行 HTML、不自动请求文档中的图片/链接。
- 文本预览最多 100,000 字符，超过时提示下载全文；所有格式保留原文件，列表、预览和下载均需有效会话并核对库归属。

数据库只保存文档信息和内部存储引用，原文件保存在私有 `.knowledge-storage/`，不在 public 中。可通过 `KNOWLEDGE_STORAGE_DIR` 指定持久目录，修改后重启服务；该目录不被 Git 或 Next 静态部署追踪。备份/迁移需同时包含数据库与原文目录。

当前本机/单实例使用持久磁盘可直接运行，不需要 OSS 账号。多实例或没有持久磁盘的平台，应换成私有 OSS/S3 对象存储；`DocumentStorage` 封装了原文读写接口，但本轮没有实现或验收云适配器。不能把临时目录当作永久存储；多实例也不能各用不同本地目录却共用同一数据库。

上传先完成原文件写入再提交数据库记录；仅提交成功的记录对列表可见。文件系统与数据库不是原子事务，进程崩溃/数据库提交不确定时可能保留无引用文件，本轮不盲删以免破坏已提交结果；生产运维需据数据库引用做离线对账。读原文时验证大小与 SHA-256，损坏明确失败。格式签名检查不等于杀毒，当前仍是受控管理员上传入口。

接口：`GET/POST /api/knowledge-bases/:id/documents`，POST 使用原始文件 body 和 URL 编码的 X-File-Name；`GET .../:documentId/preview` 返回文本，`GET .../:documentId/original` 预览 PDF，增加 `?download=1` 下载原文。服务端在读取上传 body 之前确认会话和库权限，再按实际字节限流。

## 请求链与安全行为

处理进度：`GET /api/knowledge-bases/:id/documents/:documentId/processing`。要求有效会话和目标库归属，非法 ID、跨库或越权返回 404，未登录返回 401。GET 只读 PostgreSQL，不启动处理或访问 Qdrant；五步无计数/百分比，ready 时返回 collection、generationId、verifiedAt。待处理、等待向量化/写入及运行中串行轮询，失败/就绪停止，关闭或切换时取消请求。

明确失败由 `POST .../processing/retry` 携带当前 attempt 排队；解析、嵌入、索引分别从必要阶段继续，旧轮次返回 409。索引结果未知时不能直接重试，需 `POST .../processing/reconcile` 核对；该操作只读 Qdrant，全部匹配则完成，否则明确缺失后才允许重试。核对与重试都需要登录、库权限与同源 Origin，接口不会接受用户指定的 collection/向量库地址；普通 GET 不做修复。

分块只读接口：`GET .../:documentId/chunks?offset=0`，每页最多 20 条，返回 nextOffset；仍需库权限，尚无完整结果返回 409。正文、章节、来源片段、解析器和切分器配置持久保存在 PostgreSQL。偏移基于规范化正文的 UTF-16 字符位置，不是原文件字节或 Word 页码。嵌入失败重试重新排入 chunked，不会重新解析或改动片段 ID；未知索引结果不能通过此入口重试。

解析适配器位于 src/documents/parsers：TXT 严格 UTF-8，Markdown 用 Marked 识别标题结构且不执行 HTML/链接，DOCX 用 Mammoth 提取正文全文。统一输出 ParsedDocument 后，下游不再按格式分支；新增格式实现并注册适配器即可复用执行和切分。当前分块复用 LangChain RecursiveCharacterTextSplitter，按章节和中文段句边界处理，目标 1000 UTF-16 单元、重叠 120，保留稳定 ID、章节与来源位置；这些是初始配置，不是通用最优值或 token 数。

worker 原子领取任务、两分钟租约、心跳和轮次校验，解析/分块使用 60 秒异步截止保护。租约过期只标记中断，用户明确重试；旧轮次无法提交新结果。正文、片段与 chunked 状态在同一事务提交，失败不暴露半成品。空白、损坏、超过解析上限的文件明确失败。软截止不硬杀同线程 CPU；复杂重型格式后续按需求加入子进程隔离。

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
scripts/worker.ts     持久任务领取、全文解析和分块处理
src/documents/parsers 格式适配器注册与统一正文契约
public/brand-icon.svg 可编辑原创图标；PNG 为 512px 导出
tests/                密码/输入/请求边界及真实 PostgreSQL 测试
```

```sh
corepack pnpm --filter @leeway-support/knowledge test
corepack pnpm knowledge:test:postgres
corepack pnpm knowledge:test:qdrant
corepack pnpm --filter @leeway-support/knowledge typecheck
```

PostgreSQL 测试使用随机 it- 用户与其知识库，结束后只清理这些记录；另用临时表验证 SQL 完整性和只读状态检查。运行截图保存在根目录 output/playwright/knowledge，默认不提交。

运行 PostgreSQL/Qdrant 集成测试时先暂停常驻 worker，避免它领取测试创建的待处理记录；测试完成后再启动 worker。Qdrant 测试创建随机 test_ 集合，结束后只清理这些集合。
