# LangSmith 执行追踪

日期：2026-10-23。关联 J：可观测性。保留当前 CLI、Agent 与 PostgreSQL，不部署 Agent Server，也不新增业务工具或记忆机制。

最终配置简化：当前单工作区 Key 已成功验收云接收，不再配置 LANGSMITH_WORKSPACE_ID。删除本地/示例环境项、应用读取/传参和对应格式校验测试；历史排障段保留发生过的问题。未来跨工作区需求再讨论，当前不要求用户查找无必要的 ID。

后续同日修正：用户截图为 Agent-based 工作区，已支持 LANGSMITH_AGENT_ID + LANGSMITH_AGENT_ENVIRONMENT，通过官方 AgentAddress 路由到 leeway-support/local；与 LANGSMITH_PROJECT 互斥。旧项目工作区仍保留 project 路由。依据：[官方 Agent 路由](https://docs.langchain.com/langsmith/log-traces-to-agent)，JS SDK >=0.10.9 支持，本项目 0.11.0 已满足；接收端测试验证 address 字段、环境和无项目混用。

## 问题、输入输出与失败语义

已有终端流只能看本次输出，不能集中查看执行层级、输入历史和失败位置。本轮将 Agent 执行和模型子调用记录到 LangSmith，按 thread_id 关联会话，每轮生成独立 runId，并在 debug 模式打印对应 ID。

输入为既有会话请求、服务端追踪配置；输出为本地事件/回答与独立追踪记录。默认关闭，关闭时不创建上传 client/callback。启用却缺 Key 或 endpoint 非法，启动前明确报错；上传服务不可用时只提示追踪可能缺失，既有 Agent 成功/失败规则不变，不为上传重跑模型。

## 机制与取舍

官方 LangChainTracer + LangSmith Client（langsmith 0.11.0，LangChain core 1.2.20），通过 agent.withConfig 注入 callbacks，框架负责嵌套结构。每轮配置 runName=support-turn、runId、tags 与 thread_id metadata；checkpoint 的 configurable.thread_id 继续负责数据库状态，两者职责不同。

本次选显式 Client，使上传匿名化、隐藏选项、限时与退出提交集中在 config/tracing.ts，执行函数无需导入云配置。仅用环境自动追踪更少代码，但客户端策略不够集中；仅本地日志还需自行构建查询与可视化。Langfuse 可作为后续自托管/跨框架需求的对照；OpenTelemetry 可在跨服务追踪时讨论。本轮没有行业使用率或性能排名结论。

官方核对（2026-10-23）：

- [LangChain JS/TS 追踪与退出处理](https://docs.langchain.com/langsmith/trace-with-langchain)
- [会话 metadata](https://docs.langchain.com/langsmith/threads)
- [输入、输出与错误脱敏](https://docs.langchain.com/langsmith/mask-inputs-outputs)
- [项目路由](https://docs.langchain.com/langsmith/log-traces-to-project)

旧项目工作区默认 project 为 leeway-support-dev；用户当前使用 Agent/local 路由，已验证云端接收。非 US 账号配置对应 endpoint。当前单工作区 Key 无需单独指定工作区。

## 调用链与数据边界

index.ts/loadAgentEnv → createTracing → 创建官方 Client/Tracer → Agent.withConfig(callbacks) → runSupportAgent 为本轮配置 runId/name/thread metadata → stream 正常执行 → 框架生成追踪 → Client 批次上传 → 退出 finally 等 awaitAllCallbacks 和 awaitPendingTraceBatches。

上传前过滤已配置的 LangSmith/模型 Key、数据库连接串、常见凭据字段；SDK anonymizer 处理输入、输出、metadata 和 error，不修改模型实际请求、返回值或 checkpoint。默认保留处理后的问答用于调试，LANGSMITH_HIDE_INPUTS/OUTPUTS 可完全隐藏对应字段。不是完整 PII 或所有自由文本秘密检测；生产上线前需明确客户数据策略。关闭 tracing 不会阻止远端模型本身接收其正常输入。

单上传请求默认限制 10 秒（LANGSMITH_TIMEOUT_MS 可配置 100–60000 毫秒），失败不自动重试，缓冲上限 5 MiB，提交并发 1；传输错误保留 HTTP 状态及超时/连接类别，不保留服务器响应体/原始网络错误。退出提交属于尽力而为，不声称进程被强杀也能保留记录，也不承诺全部 flush 有固定全局截止时间。SDK 仍可能输出其自身的安全传输错误摘要。

源码集中 config/tracing.ts，执行关联在 agent/run.ts，debug 展示在现有 cli/chat.ts，不新增一组日志抽象。真实运行 .env 已加关闭状态和空 Key；没有从其他仓库或账号搜集凭据。

## 学习与验证

核对了 E:/Projects/agent-practice 的模型配置及说明，未发现独立 LangSmith 追踪治理示例；该知识点由本产品接入与 tests/tracing.test.ts 覆盖，不另建 demo、数据库或跨仓库依赖。

测试预加载 tests/setup.ts 显式关闭自动云追踪，防止以后填 Key 后默认测试上传真实项目。追踪测试使用 fakeModel + 本机 HTTP 接收端，执行官方真实 SDK 序列化和上传链：

- 关闭时无上传请求。
- 缺 Key/非法 endpoint 在启动前失败，错误不回显配置。
- 同 thread 两轮产生不同根 trace，模型为子 run、会话 metadata 向下传播。
- 已知凭据在上传前过滤，业务回答仍保留原始测试内容；隐藏输入/输出生效。
- 模型失败保留失败追踪，原始错误中已知凭据被过滤。
- 上传 503 不改变成功回答、不触发第二次模型调用。

本地回归：28 个确定性/本地接收端用例、3 个真实 PostgreSQL 集成测试和类型检查通过。真实模型与真实 LangSmith 云接收均未验证（缺 LangSmith API Key）；真实业务集成未实现。不能将本地接收端验收写成“云端接入已通过”。

## 遗留

### 云端连通性排障补充（2026-10-23）

用户实际上传失败，本轮按 diagnosing-bugs 复现：当前链路 /info 在 2 秒上限附近超时，后续 /runs/multipart 返回 401，但旧 wrapper 全部转换成 AbortError，丢失真正原因。

分离探针：同一个有效 PAT 不传 x-tenant-id 时 GET /sessions 返回 200，带原配置返回 401，响应明确为 UUID header value was not a valid UUID。确认 Workspace ID 不是 UUID，非 Key 失效。已清空本地 .env 的这个可选值，未修改 Key 或模型配置；官方说明单工作区 Key 可省略 Workspace ID。

先新增“非 UUID 应本地拒绝”和“401 应保留 HTTP 状态”两个回归测试，均复现失败，再修正配置校验与安全传输错误。2 秒硬编码改为默认 10 秒并可配置，补充 >2 秒响应与超时分类用例。不以开启浏览器系统代理就推断 Node 一定通过代理；实测当前 Node 可直连该 API，本轮未改全局网络设置。

真实云验证：fakeModel 驱动产品 Agent，独立诊断输入不含业务信息；/info 返回 200，/runs/multipart 返回 202。通过 sessions.resolve(Agent=leeway-support,environment=LOCAL) 定位存储，再用 runs.retrieve 读回 ID 2a9575ea-4e35-4019-bd10-d9b0fda7747e。此诊断记录保留供用户在 Tracing 中检查，未上传现有聊天记录，没有调用真实大模型。旧失败批次不自动重放。

此前“缺 Key，云接收未验证”的记录是接入时状态；本段更新为云上传及读取已验证，真实业务集成与真实模型问答追踪仍需分别验收。

修正后 `pnpm test` 34/34 和 `pnpm typecheck` 通过；本轮未重新执行数据库集成测试（没有更改存储逻辑），也未调用真实模型或真实业务工具。真实 LangSmith 上传和读取使用产品 Agent + fakeModel 的单条诊断执行，与本地接收端验证分别记录。

待用户填 Key 并启用后，以真实问答核对云端根/子调用、会话关联、退出提交及错误路径。Token 来自供应商 usage，成本还需模型价格匹配，尤其是中转模型；不能把平台估算当作结算账单。

数据库 SQL、模型调用前的配置错误及应用最终“空回答拒绝”等不保证都在当前 Graph trace 中完整呈现；后续按实际故障补外围运行记录。追踪本身不替代错误分类、取消/超时、并发、权限、业务审计和数据保留/删除策略。
