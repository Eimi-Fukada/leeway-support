# Leeway Support

逐步建设的智能客服系统，当前支持多轮流式对话、PostgreSQL checkpoint、身份上下文隔离、模型自主选择的长期记忆工具及离线流程测试。业务工具和 RAG 尚未接入。

开发遵守 [小步迭代约定](AGENTS.md)，每项功能先说明解决的问题、主流实现方式和替代方案，再给出调用链与验证结果。[学习覆盖表](docs/learning-coverage.md) 连接本项目与 agent-practice 的已有实验及待补知识点，实验根目录按约定在两个候选路径中检查；[细粒度路线图](docs/agent-development-roadmap.md) 规定推进顺序。

## 环境与安装

- Node.js >= 22.16.0（本地已验证 22.16.0）
- Corepack（本地已验证 0.34.7），使用 packageManager 固定的 pnpm 10.33.4

在仓库根目录执行：

```sh
pnpm install
```

已安装 Corepack 但未启用 pnpm 命令时，也可以执行 `corepack pnpm install`；无需全局安装另一份 pnpm。

## 运行

```sh
# 启动开发模式；修改源码会重启，已提交 checkpoint 保留，新启动默认创建新会话
pnpm dev -- --user alice

# 连续输入问题，每轮流式回答；/new 新会话，/exit 退出
pnpm start -- --user alice

# 多轮对话时额外观察文本片段、节点更新和每轮最终结果
pnpm start -- --user alice --debug

# 重启后继续一个已完成会话，ID 使用此前打印的值
pnpm start -- --user alice --thread <会话ID>

# 使用 fakeModel 验证 Agent 流程，不需要模型配置、不发真实模型请求
pnpm test

# 使用 .env 中的真实 PostgreSQL 验证跨进程恢复，无真实模型请求
pnpm test:postgres

# 检查 TypeScript 类型，不生成 JavaScript 文件
pnpm typecheck
```

## 模型配置

在 `apps/agent/.env` 配置下列变量，真实配置不提交 Git：

```dotenv
OPENAI_API_KEY=你的密钥
OPENAI_MODEL=模型服务提供的模型ID
# 可选：不填写时使用 SDK 默认地址；填写 API 基础地址而非完整请求路径
OPENAI_BASE_URL=https://your-provider.example/v1
# 可选：默认 responses；仅支持 Chat Completions 的服务使用 chat-completions
OPENAI_API_MODE=responses

# 数据库需提前存在，程序初始化自己的 schema/表；示例不包含真实凭据
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/agent-support
```

模型服务必须兼容所选接口；不根据模型名称猜测接口模式。入口静态导入 `createModel`，在 main 中调用后才使用共享 env.ts 中的 Node 内置 `loadEnvFile` 加载文件、校验配置并创建模型；导入模块本身不执行这些操作。环境文件相对 env.ts 定位，运行环境已有的同名变量优先。配置错误在 main 执行期间抛出，进入 main().catch 的统一处理。dev/start 通过 pnpm 直接启动应用，继承运行环境，不经过任务缓存。

启动后等待输入，不自动发送固定问题。可连续追问（以下回答内容以实际模型为准）：

```text
你> 我使用的是桌面版。
[客服] ……
[完成] 耗时 … ms
你> 我刚才说的是哪个版本？
[客服] 桌面版。
[完成] 耗时 … ms
你> /new
[新会话] …
你> /exit
[会话结束]
```

每条非空问题会请求模型并产生相应费用；空行、/new、/exit 和未知命令不调用模型。同一会话逐轮串行执行，后续轮次由 checkpoint 加载历史，每轮仅提交新增用户消息。SDK 重试关闭，主回答由中间件进行有限分类重试；单次模型请求超时为 60 秒，整轮 Graph 截止时间为 65 秒。开发模式重启后重新等待输入，恢复历史需传原会话 ID。配置缺失或接口模式不合法会在请求前报错；调用失败停止输入循环，以非零状态退出，不输出原始请求、密钥或供应商错误内容。

## 会话与短期记忆

index.ts 创建模型和 PostgreSQL saver，在产品数据库 public 中初始化官方 checkpoint 表并注入 Agent；退出时关闭 readline 和连接池。不配置学习专用数据库或 schema。数据库不会由程序创建。chat.ts 默认生成 thread_id；传 --thread 时先检查已保存状态，未知会话或有未完成步骤的会话明确拒绝，避免隐式创建或重试。恢复成功后仅提交新问题，由框架加载历史。/new 生成新 ID，不删除旧 checkpoint。EOF 结束输入，排在前面的已读问题仍按顺序处理；/exit 在轮次之间退出，不是运行中取消命令。

连接或读写失败不降级为内存。连接等待 5 秒、查询及服务端 statement 超时各 10 秒，每个连接池最多 5 个连接；checkpoint 与长期记忆各有一个池。setup 是官方建表/迁移；当前启动时检查，生产应独立管理迁移和权限。失败轮可能已保存用户输入，但不会把断流片段当作成功回答；不自动重放整轮或回滚 checkpoint。主回答调用的有限重试不重复提交用户消息。数据库 checkpoint 仍是短期记忆，跨会话记忆由独立记忆表提供。

当前是可信本地 CLI，知道会话 ID 不代表在未来多用户服务中拥有权限；身份校验、并发/运行所有权、历史保留/删除、备份恢复和未完成会话的安全续跑仍待设计。见 [PostgreSQL 迭代记录](docs/iterations/postgres-checkpoint.md)。

## 执行过程观察

当前所有真实 CLI 启动命令需提供 `--user <开发用户ID>`。同一开发用户跨会话使用记忆；换用户隔离。仅声明 ID 不等于生产身份认证，真实业务接入须由验证过登录状态的服务端适配器提供 SupportContext。

`pnpm start` / `pnpm dev` 使用同一个 index.ts 入口，每轮通过 `runSupportAgent` 调用主 Agent 的 `stream`。默认连续输出文本片段；执行 `pnpm start -- --user alice --debug`（开发模式为 `pnpm dev -- --user alice --debug`）额外展示片段所属节点、节点更新和最终回答。参数由 pnpm 传到应用，index.ts 读取 `--debug` 切换展示。需要模型服务支持流式响应。交互入口直接启动应用，以保留 stdin 和逐片段 stdout；Turbo 继续运行 test/typecheck。

`src/agent/run.ts` 统一消费一次执行中的三类 streamMode；`src/cli/chat.ts` 集中终端参数、会话循环与普通/调试展示：

| 模式 | 用途 | 实际打印 |
| --- | --- | --- |
| messages | 观察模型输出片段 | 仅文本及所属节点，不打印 reasoning 或完整 metadata |
| updates | 观察节点完成后的状态更新 | 仅节点名；它不是节点开始事件，也不是每次网络请求的计数 |
| values | 获取各步骤的完整状态快照 | 内部读取最后一条 AI 消息，不打印完整 state |

输出形态示意（片段数量由模型服务决定，可能一次返回整段）：

```text
[开始] Agent 流式执行
[文本片段][model] "你好"
[文本片段][model] "……"
[节点更新] model
[最终回答] 你好……
[完成] 耗时 … ms
```

最终回答取自同一次流的最后状态，不再额外 invoke。执行函数返回 `{ answer, elapsedMs }`，不依赖拼接日志获得结果。只有流正常结束且存在有效回答才打印完成；即使已有文本，随后断流也输出失败并以非零状态退出，不把片段报告为成功结果。普通模式不重复打印整段最终回答。

这是终端流式交互与本地观察能力，尚未实现 HTTP/SSE 服务。输出文本属于模型原文，不是完整的生产日志脱敏方案。当前没有工具，因此只观察到模型路径；增加内部模型节点或工具前需定义消息展示过滤，后续再逐步加入工具生命周期、调用预算和取消等能力。

`stream` 的多模式接口适合直接观察 Graph 运行事件。[官方文档](https://docs.langchain.com/oss/javascript/langgraph/streaming)目前也推荐新应用评估 event streaming 的独立投影接口；此处为理解已有 streamMode 知识点，先保留一条迭代器中的明确分支，不同时接入两种流 API。

## 会话摘要中间件

Agent 已装配官方 `summarizationMiddleware`，在 `beforeModel` 阶段检查历史消息。默认超过近似 6000 Token 时压缩早期记录，保留最近 8 条消息（不是 8 轮）；短会话不增加摘要请求。策略直接写在 [summarization.ts](apps/agent/src/agent/middleware/summarization.ts) 的 `SUMMARY_CONFIG` 中，不使用环境变量：

```ts
const SUMMARY_CONFIG = {
  triggerTokens: 6_000,
  keepMessages: 8,
};
```

本轮复用当前配置的模型生成摘要，触发时增加一次真实模型调用，未新增供应商配置或廉价模型假设。代码支持单独注入摘要模型以便测试和后续选型。摘要不是长期记忆，也不会提升模型权限。

调用链：index.ts 创建 Agent → agent/agent.ts 按代码中的策略注册中间件 → 恢复历史、合入新消息 → beforeModel 检查 → 必要时调用摘要模型 → 验证有效且确实缩短 → 更新 messages → 主模型回答 → PostgreSQL 保存新状态。

摘要调用打有框架内部标记；run.ts 过滤 `lc_source=summarization` / `nostream`，其文本不显示在终端，但启用 LangSmith 时仍可查看对应模型调用。失败、空摘要、未缩短历史会停止本轮，不将框架生成的错误文字当作摘要保存；原消息保持，失败轮可能已提交的新输入仍按已有 checkpoint 语义保留。

计数沿用当前框架 `countTokensApproximately` 的字符估算，不是精确 tokenizer；中文、工具、多模态、系统提示词和模型输出预留需后续按供应商校准。6000 是可调整的初始应用预算，不是该模型窗口已验证的结论。当前若消息估算超过 16000，在摘要调用前拒绝处理，避免默认截取一部分旧历史再总结；单条超长输入也可能触发此拒绝。最近保留消息无法压缩时不保证落到阈值以下。

压缩改变最新会话 messages，旧原文仍在此前的数据库 checkpoint，未删除旧表记录；跨进程恢复使用最新摘要状态。checkpoint 不是专门的聊天档案，未来清理历史时要另定原文保留政策。失败/未完成会话仍不自动重试。

取舍、测试和供应商验证见 [摘要迭代记录](docs/iterations/conversation-summary.md)。启动方式仍是 `pnpm start -- --user alice --debug`。调低触发阈值可以检查触发行为，但会增加调用次数；不要把低阈值测试配置当成生产容量结论。

## LangSmith 执行追踪

Agent 和 PostgreSQL 仍在本机运行；本功能仅上传追踪，不启动 Agent Server 或本地 LangSmith。官方接入机制于 2026-10-23 核对，SDK 固定为 langsmith 0.11.0。

在 `apps/agent/.env` 填写：

```dotenv
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=你的LangSmith密钥
LANGSMITH_AGENT_ID=leeway-support
LANGSMITH_AGENT_ENVIRONMENT=local
LANGSMITH_ENDPOINT=https://api.smith.langchain.com
```

endpoint 必须与 LangSmith 账号区域一致。截图中的新版 Agent 工作区使用 AgentAddress：上述配置发送到 leeway-support → Local → Tracing；不要同时配置 LANGSMITH_PROJECT。老版 project 工作区仍可仅设置 LANGSMITH_PROJECT，缺省为 leeway-support-dev。云端是否收到需实际查看，启动提示不代表验收。Key 仅保存在服务端环境配置，不提交 Git。[官方 Agent 路由说明](https://docs.langchain.com/langsmith/log-traces-to-agent)（2026-10-23 核对）。

运行 `pnpm start -- --user alice --debug` 并输入问题，每轮结束显示追踪 ID。每轮是独立 trace，模型调用为子 run；相同 thread_id 的多轮归入同一会话。普通模式展示保持简洁；追踪关闭（默认 false）时不创建上传 client/callback。生成关联 ID 本身不需要联网。

调用链：index.ts 加载环境 → createTracing 创建官方 Client/LangChainTracer → withConfig 注入 callbacks → runSupportAgent 为每轮设置 runId/runName/thread metadata → 框架记录节点与模型 → 退出 finally 等待 callbacks 和 SDK 批次提交。

上传前过滤已配置的模型 Key、LangSmith Key、数据库连接串，以及常见凭据字段；同时应用邮箱、银行卡号和大陆手机号的 PII 规则。默认允许上传处理后的问答用于排查历史输入；这不是完整 PII 脱敏，真实客户数据上线前需要独立治理。可配置 `LANGSMITH_HIDE_INPUTS=true`、`LANGSMITH_HIDE_OUTPUTS=true` 隐藏相应字段；追踪层处理不改变实际模型输出或 PostgreSQL checkpoint。错误记录会过滤已知凭据，不能把用户任意提交的敏感信息当作已全部识别。

上传请求默认限制 10 秒，可通过 `LANGSMITH_TIMEOUT_MS` 配置（100–60000 毫秒）；不开自动上传重试，追踪缓冲最多 5 MiB、提交并发 1。上传不可用时区分 HTTP 401/403/429、网络连接与超时，提示追踪可能缺失，主流程结果不因上传错误改变；启用却缺 Key 或 endpoint 非法时启动前明确报错。当前 Key 已能确定工作区，不配置 Workspace ID；未来确有跨工作区需求再单独设计。退出提交是尽力而为，不保证进程被强杀后仍保存追踪。运行日志、数据库审计、超时/取消/重试和执行预算仍由应用逐步建设，不能由追踪平台代替。

`pnpm test` 与 `pnpm test:postgres` 在预加载阶段关闭自动云追踪；tracing.test.ts 显式使用本地 HTTP 接收端 + fakeModel 验证，不需要真实 LangSmith Key。模型 usage 若缺失则无法凭空计算 Token；中转服务价格需单独配置和验证，界面估算不等于真实账单。

依据：[LangChain 追踪](https://docs.langchain.com/langsmith/trace-with-langchain)、[会话关联](https://docs.langchain.com/langsmith/threads)、[敏感字段处理](https://docs.langchain.com/langsmith/mask-inputs-outputs)。取舍与验收见 [追踪迭代记录](docs/iterations/langsmith-tracing.md)。

## 中间件装配与输入 PII

`agent/agent.ts` 显式装配 `模型调用限制 → PII → 摘要 → 主模型重试 → 工具调用限制`，各实现放在 `agent/middleware/`，不自动扫描。数组顺序不等于所有 hook 都同方向执行：模型限制在 beforeModel 先检查，工具限制在 afterModel、工具执行前检查。数据库与追踪配置继续放在 config。

默认循环预算如下，均采用 `exitBehavior: "error"`，超限停止，不注入成功回答：

| 限制 | 每轮 run | 同一 thread 跨轮 |
| --- | --- | --- |
| 主模型步骤 | 6 | 60 |
| 全部工具共享 | 4 | 40 |

策略分别位于 `middleware/model-call-limit.ts` 与 `middleware/tool-call-limit.ts`；可在服务端创建 Agent 时通过第四参数覆盖，例如 `createSupportAgent(model, saver, {}, { model: { runLimit: 3, threadLimit: 30 } })`。只接受正整数且 threadLimit ≥ runLimit，不接受用户消息控制预算。

正常完成后 run 计数重置，thread 计数进入 checkpoint，重启后继续累计；旧 checkpoint 缺少字段时从零开始，不回算历史调用。失败/超限不保证执行 afterAgent 清零，仍按既定规则拒绝自动恢复未完成会话。模型限制器不计内部重试 attempts、摘要调用和失败模型请求；工具限制器统计获准的 tool_calls，工具失败也可能已经占用预算。并行请求按调用个数检查，一批中任意调用超限时整批拒绝。当前生产 tools 为三项内部记忆工具，均计入预算；没有接入业务工具。

这些是串行会话的循环上限，不是总费用账本、每用户配额或多实例原子限额；/new 会换 thread，不能用于防止用户绕过配额。完整取舍与验证见 [调用限制迭代](docs/iterations/call-limits.md)。

- 输入侧 PII：邮箱、通过 Luhn 校验的银行卡号、大陆连续 11 位手机号（支持 +86/86 前缀）替换为 `[REDACTED_类型]`。run.ts 在提交 Graph 前处理新问题，避免原文进入新输入 checkpoint 和根 trace；beforeModel 在摘要前清理历史文本，复用官方检测/替换函数，扩展了官方 piiMiddleware 只扫描最近用户输入的范围。旧 checkpoint 不删除，多模态、姓名、地址、身份证号和分隔手机号尚未覆盖。
- 输出边界：没有启用“输出已安全”的保证。模型自行生成的 PII 仍可能进入终端流和输出 checkpoint；afterModel 处理太晚，不能阻止已发片段。追踪上传单独执行上述脱敏规则。不要把该能力当作全链路 PII 治理。
- 有限重试：主回答遇到指定暂时错误最多额外尝试 1 次，初始退避 300ms；归一化 retryAfterMs 最多等待 1 秒，HTTP Retry-After 超过 300ms 时不自动重试。认证、参数、额度耗尽、未知错误、超时与取消直接失败；首次失败已经耗时 5 秒以上也不再重试。
- 运行保护：run.ts 为本轮建立独立输出进度与 callback；产生过任意模型片段（包括内部摘要）后不重试。绕过 runSupportAgent 直接 invoke/stream 时缺少进度保护，中间件保守地不重试。摘要内部调用不在主回答 wrapModelCall 内，仍不自动重试。SDK maxRetries 保持 0，整轮 Graph 截止时间 65 秒。

正常使用仍为 `pnpm start` / `pnpm start -- --user alice --debug`，不增加独立运行模式。取舍、调用链与验证见 [中间件迭代记录](docs/iterations/middleware-retry-pii.md)。

## 身份上下文与长期记忆

`src/support-context.ts` 定义 SupportContext：`identitySource`、`integrationId`、`productId`、`subject.kind/id`。运行通过 context 传递，不从用户消息或模型工具参数取得身份。校验器只校验结构，不做登录认证；local-development 与 business-authenticated 是隔离来源标记，后者必须由未来服务端认证适配器构造。

CLI 使用 `--user alice` 构造 local-development/local-cli/support/alice。对外显示逻辑 thread ID，实际 checkpoint key 由身份归属哈希 + 逻辑 ID 组成；同一个逻辑 ID 在其他用户/产品/接入系统下无法读取原历史。`--thread` 也按同一上下文查找，找不到或未完成即拒绝，不把旧的无归属 checkpoint 自动认领给当前用户。

主 Agent 自主判断稳定、跨会话有用的用户陈述，选择 `save_memory` / `update_memory` / `forget_memory`，不依赖“请记住”等触发词，也没有固定偏好字段。工具参数只有内容、依据引用及更新对象/版本；归属、来源消息 ID、thread 和操作 ID 由程序绑定。服务校验本轮原文引用、PII/已知凭据形态、内容长度；匿名上下文不读写个人记忆。模型判断是否值得记、是否为转述及语义冲突仍需评估，引用匹配不能证明内容真实。

记忆存于产品库 public.support_memories，public.support_memory_operations 保存幂等结果；启动自动创建，退出关闭连接池。不用新数据库或演示 schema，也没有向量索引。每个身份范围最多 50 条有效记忆、内容合计 8000 字符、单条 1000 字符；超限明确拒绝，不悄悄覆盖旧记录。每次主模型调用临时注入该范围的有效记忆 JSON，不追加到 messages；这不是硬 Token 窗口保证。

事务与 advisory lock 保护同一归属的写操作，操作 ID 重放返回原结果，相同 ID 不同内容拒绝，更新/遗忘要求 expectedVersion，冲突不覆盖。精确相同内容去重；语义近似去重依赖模型，尚无后台整合。遗忘清空当前记录内容并停用，后续不注入，但不删除旧 checkpoint/追踪；历史对话仍可能包含原陈述。记忆写入与 Graph 执行不是一个跨表原子事务，模型最终回答失败前已成功的记忆操作不会回滚。

新逻辑 `thread` 可以使用同一用户的长期记忆；不同用户、产品、接入系统或身份来源隔离。读写故障明确失败，不伪装成“没有记忆”或“保存成功”。`messages` 流只投影 AI 文本，工具 JSON 结果不显示为客服正文；中间模型片段仍是临时输出，最终完成前不能当作已办结。

机制、替代方案、存储选择与验收见 [SupportContext 与长期记忆迭代](docs/iterations/support-context-long-term-memory.md)。

## 离线流程测试

根目录运行 `pnpm test`，或者单独执行 `pnpm --filter @leeway-support/agent test`。测试使用 Node 内置测试运行器，无需新增测试框架依赖。

测试统一放在应用的 `tests/` 目录，与 `src/` 业务代码分开；TypeScript 同时检查这两个目录。`tests/agent.test.ts` 使用 `fakeModel` 控制模型返回或抛错，将它传给真实 `createSupportAgent` 并执行 `invoke`。它不导入真实模型配置、不读取 .env，也不请求模型服务。测试关注执行链路，不维护客服固定问答表。Turbo 不缓存 test，保证每次实际执行；断言失败时返回非零退出码。

当前验证三个场景：

- 用户消息和服务端提示词是否实际传入模型，回答是否写入状态，流程是否只调用模型一次后结束。
- 同一 Agent 处理不同输入时，未开启记忆的各次运行是否保持独立。
- 模型抛错是否向调用方传播，而非返回伪造的成功回答。

`tests/cli-debug.test.ts` 验证同一 CLI 的调试展示：单次调用即可获得片段/节点/最终回答，不输出内部推理和元数据；失败不泄露原始错误；已产生部分文本后断流仍不报告成功。

`tests/cli-run.test.ts` 验证正常入口所用的同一展示/执行路径：模型在首段输出后暂停，收到消费者确认后才继续，以此证明完成前已展示文本；同时验证单次执行、最终结果、不重复打印、断流、空回答和输出范围。

`tests/memory.test.ts` 检查模型实际收到的历史、thread 隔离、saver 生命周期、失败轮 checkpoint 和空输入拒绝；`tests/chat.test.ts` 检查连续输入、命令、串行执行、失败停止及 EOF。基础 agent.test.ts 保留未注入 saver 的无记忆对照，不代表真实入口未启用记忆。

`respond(message)` 安排测试消息，`respond(messages => ...)` 在模型边界检查输入并生成测试返回值，`respond(error)` 注入错误。fakeModel 不理解问题，测试不证明真实模型会遵循提示词或正确选择工具；真实供应商能力另行验证。之后添加工具、中间件或结构化输出时，围绕实际流程扩展场景与断言。当前没有添加这些业务能力。

## 目录和调用链

```text
apps/agent/
  src/
    index.ts            应用启动、依赖装配与退出清理
    agent/
      agent.ts          Agent 定义，接收模型与 checkpointer
      run.ts            单轮 stream 执行、事件投影与最终结果校验
      middleware/
        summarization.ts 摘要预算、官方中间件及失败保护
        model-retry.ts   有限重试、暂时错误分类和输出进度保护
        pii.ts           文本 PII 规则、提交前与历史清理
        model-call-limit.ts 主模型每轮/会话步骤上限
        tool-call-limit.ts 全工具共享的每轮/会话调用上限
    cli/
      chat.ts           启动参数、会话恢复、输入循环与终端展示
    config/
      env.ts            加载应用环境，路径固定为 apps/agent/.env
      model.ts          创建并配置真实模型
      checkpoint.ts     PostgreSQL 连接池、官方 saver 与初始化
      tracing.ts        可选 LangSmith callback、上传脱敏与退出提交
      database.ts       统一 PostgreSQL 配置与连接池策略
      memory.ts         初始化应用记忆表与生命周期
    support-context.ts  可信运行入参校验与身份范围隔离
    memory/
      agent.ts          记忆策略、工具及临时上下文注入
      service.ts        来源/PII/身份校验与存储接口
      postgres.ts       事务、版本与幂等的 PostgreSQL 实现
  tests/agent.test.ts    fakeModel 流程测试：输入、结束、运行隔离、错误传播
  tests/cli-debug.test.ts 调试展示的成功、失败、断流和输出范围测试
  tests/cli-run.test.ts  正常流式路径、完成前输出、最终结果和失败测试
  tests/chat.test.ts     连续输入、命令、失败停止与 EOF
  tests/memory.test.ts   多轮历史、隔离、checkpoint 生命周期与失败状态
  tests/postgres.integration.ts 真实数据库、跨进程恢复与连接失败验证
  package.json           Agent 自己的命令和依赖
  tsconfig.json          Agent 的 TypeScript 配置
docs/                    技术方案和调研记录
package.json             根命令、pnpm 版本、Turbo 依赖
pnpm-workspace.yaml      声明哪些目录是工作区包
pnpm-lock.yaml           固定整个工作区的依赖解析结果
turbo.json               声明任务的缓存和运行方式
```

以 `pnpm dev` 为例：根 package.json → `pnpm --filter @leeway-support/agent dev` → `tsx watch src/index.ts` → 执行入口。交互进程直接接收终端输入；本次验证中原 Turbo 启动路径未转发输入，故不再用它启动聊天。

应用内的调用链：

```text
index.ts      → 本地 SupportContext + 模型/checkpointer/记忆服务 → Agent → chat
每轮输入      → runSupportAgent（新增消息、身份 context、隔离 thread）→ 模型按需调用记忆工具
agent.test.ts → fakeModel 控制响应或错误               → createSupportAgent(model) → invoke → 断言执行行为
```

以上路径共用 agent.ts 中的定义；正常和调试展示使用同一应用入口和执行层。工厂每次调用创建一个 Agent 实例；依赖注入在这里就是把模型作为函数参数传入，没有额外容器。

根目录仅保留 index.ts。终端相关逻辑已合并；模型、数据库和追踪分别负责不同外部依赖，Agent 执行不依赖终端配置。无需通过 barrel/re-export 文件跳转，直接导入实际实现。历史迭代文档中的旧路径以当时版本为准，最新结构见本文和 [整理记录](docs/iterations/source-organization.md)。

ChatOpenAI 负责模型通信，createAgent 负责执行流程，PostgresSaver 保存会话 checkpoint；离线测试仍使用 MemorySaver。长期记忆由 MemoryService 和应用 PostgreSQL 表提供，生产 Agent 开放三项记忆工具。尚未手写 StateGraph，没有知识库或业务操作。

pnpm 负责多包依赖和安装，并直接启动 dev/start 交互进程；Turbo 调度 test/typecheck。test 每次执行，typecheck 可复用缓存，只缓存检查结果，不生成编译产物。

TypeScript 负责类型检查，tsx 负责运行源码。本地模块导入使用实际 `.ts` 扩展名，配置已开启 `allowImportingTsExtensions` 和 `noEmit`。当前没有 JavaScript 构建步骤。

也可以直接选择应用运行，效果与根 start 相同：

```sh
pnpm --filter @leeway-support/agent start -- --user alice
```

当前只创建一个可运行应用。后续逐块讨论、实现工具调用和 Agent 流程，出现实际共享需求后再提取 packages。

API 参考：[LangChain Agent](https://docs.langchain.com/oss/javascript/langchain/agents)、[ChatOpenAI](https://docs.langchain.com/oss/javascript/integrations/chat/openai)。

长期目标见 [技术方案](docs/technical-proposal.md)，其中的目录是目标规划，当前实现范围以本 README 为准。

## 补充信息表单与生成式 UI

```sh
corepack pnpm ui -- --user alice
```

打开 http://127.0.0.1:3100。这是使用真实模型、现有 PostgreSQL checkpoint 和长期记忆的本地客服调试页，开发身份由服务端启动参数提供。

普通回答继续流式展示；缺少信息时，Agent 可调用 `request_information`，输出 title/description/fields。预写表单组件支持 text/textarea/select，问题和选项按本轮需要产生，不在组件中固定业务选项。可输入“软件打不开，请用表单询问使用环境和错误现象”手动验收；程序不按这些词匹配固定问答。

表单经校验且创建轮成功结束后才可提交。服务端按保存的规格校验答案，提交后在同一会话继续回答；重复提交重放已保存结果，不重复调用模型。新问题使旧表单失效，默认 30 分钟过期；失败/未完成会话不自动续跑。CLI 同样支持结构化工具，把问题转为可读文字展示。

新增产品表 `public.support_information_forms`，启动时自动初始化；表单归属、状态和幂等由程序管理，不由模型生成。模型配置继续使用 apps/agent/.env，表单策略写在代码中，无新增环境变量。

调用链：`web/App.tsx` 注册渲染器 → Copilot Runtime → `src/ui/adapter.ts` → 原 `runSupportAgent` → `request_information` / `InformationService` → 有效表单结果 → `web/InformationForm.tsx` → 提交 → 同会话下一轮。契约在 `src/interactions/contracts.ts`；前端只引用该纯数据模块，服务端源码不打包进页面。

开发入口仅监听本机，不具备业务登录或正式 SDK；页面刷新会创建新会话，长期记忆保留。`corepack pnpm build` 验证客户端构建，目前 ui 命令运行 Vite 开发服务，未提供生产部署入口。完整机制、取舍、验证及遗留见 [实现记录](docs/iterations/information-ui.md)，设计依据见 [交互设计](docs/support-interaction-design.md)。
