# 客服产品与 Agent 实践的双向学习覆盖

更新：2026-10-23。状态：开发与学习约定，缺口清单待逐项实施。

## 两个仓库如何配合

当前 leeway-support 仓库验证能力能否解决真实客服问题；agent-practice 提供对应知识点的最小实验和方案对照。实验仓库候选路径为 `E:/GraceProject/agent-practice` 与 `E:/Projects/agent-practice`，访问前检查并使用实际存在的目录；若两者都存在，按 AGENTS.md 核对后确定本轮检出。本表覆盖现有技术方案与路线图中的目标知识点，后续新增知识点同步登记。覆盖完成以可运行实验和验证记录为准，不以目录、文档或框架依赖存在为准。

学习主要通过当前产品实际开发与验收完成。下表已有示例供对照，缺口不强制新增演示程序或数据库；优先由产品实现、测试和迭代记录覆盖。代码存在也不代表已经通过真实业务验收。目标架构见 [技术方案](technical-proposal.md)，细粒度编号见 [路线图](agent-development-roadmap.md)。

## 知识点、场景和缺口

实验路径均相对本轮实际使用的 agent-practice 根目录；“待补”是建议落点，尚未创建或实现。

| 知识点 / 路线编号 | agent-practice 现有依据或待补实验 | 客服项目要解决的问题 / 验收重点 |
| --- | --- | --- |
| 模型接入与执行基础 A | `model.ts`、`shared/model.ts`、`模型接入说明.md`、各主题测试；待补统一的故障注入实验 | 配置和 Agent 解耦；无密钥复现流程；超时、取消、错误可区分 |
| Agent 循环与工具 B1–B3 | `beginner.ts`、`shared/orders.ts` | 第一个只读业务查询；看清模型 → tool_calls → 工具结果 → 模型的循环及停止条件 |
| Schema / 结构化输出 B4–B7 | `structured-output.ts`、`apps/support-chat/structured-output/` | 工具参数、工具结果、最终回答分别校验；无效输出不能生成成功卡片 |
| 状态和短期记忆 C1–C4 | `memory.ts`、`command-update.ts`、`remember.ts`、`记忆与持久化说明.md`；`labs/persistent-memory/` 仅保留产品实践说明 | C2 及 C4 持久化部分已进入主路径：产品数据库 public 中的 PostgreSQL checkpoint、同 thread 历史、--thread 恢复已完成会话；产品跨进程测试已验证。多用户归属鉴权/安全续跑未实现 |
| 长期记忆 C5–C7 | 已补 `记忆与持久化说明.md`；后续在产品具体场景中补实现、说明与测试 | 已确认需要；首个记忆场景、读写契约与存储方式待讨论，尚未实现。跨会话偏好、来源、删除、冲突；接数据库不自动构成长期记忆，不能把实时业务事实永久记住 |
| 上下文工程 C8–C9 | `summarization-middleware.ts`、`context-editing-middleware.ts` | C8 已加入产品：官方摘要 + 应用失败校验、内部文本过滤与代码集中配置预算（不使用环境变量）；旧原文保留历史 checkpoint，摘要状态可跨进程恢复。C9 工具输出清理未实现，模型窗口/摘要保真仍待校准 |
| Hooks、权限和预算 D1–D5 | `middleware.ts`、`model-call-limit-middleware.ts`、`tool-call-limit-middleware.ts`；待补可信身份和执行侧鉴权实验 | 顺序可观测；并行调用也计数；不把隐藏工具当成授权 |
| 错误、重试、降级、脱敏 D6–D9 | `fallback-middleware.ts`、`pii-middleware.ts`；待补模型/工具分类重试实验 | 控制重试放大；部分流输出后的失败；未知写入结果先核对 |
| 工具发现 D11–D12 | `llm-tool-selector-middleware.ts`、`provider-tool-search-middleware.ts` | 大工具集是否值得预筛；比较成本、漏选与提供商限制 |
| 模拟、规划、文件 D13–D15 | `tool-emulator-middleware.ts`、`todo-list-middleware.ts`、`filesystem-middleware.ts` | 区分模拟证据、计划和完成事实；文件能力只在受控实验/运行环境使用 |
| 流式消息、界面与嵌入 E | `apps/support-chat/basic-chat/`、`generative-ui/`、`ai-elements/`、`apps/copilotkit-demo/` | 文本/状态/工具事件分开；宿主上下文和白名单页面动作；后端负责业务授权 |
| 并发、重连、分支与回放 F | `apps/support-chat/message-queues/`、`join-rejoin/`、`branching/`、`time-travel/`；待补多实例运行所有权实验 | 观察连接不启动新任务；跨用户隔离；回放不执行真实写操作 |
| 显式工作流与人工 G | `apps/support-chat/hitl/`、`time-travel/agent.ts`；待补持久幂等和人工认领实验 | prepare → 确认 → execute；确认绑定参数；恢复不重复副作用；人工接管有实际状态 |
| 子 Agent / 并行 H | `subagent.ts`、`subagent-middleware.ts`、`apps/support-chat/openui/parallel/` | 诊断委派与上下文隔离；受限权限、总预算、超时及部分失败 |
| 知识入库 I1–I3 | `检索策略.md` 为思路资料；待补 `labs/knowledge-ingestion/` | 文档解析、切块、原文定位、版本、发布撤回；上传不等于可检索 |
| RAG I1–I3 | 待补 `labs/rag/` | 先固定证据和引用，再 embedding、dense/关键词融合、可选 rerank；无答案与检索失败不同 |
| MCP I4–I5 | 待补 `labs/mcp/` | 同一只读业务能力从本地函数迁移到远端工具；参数、结果、错误和身份边界一致 |
| 宿主页面动作 / 业务事件 I7–I8 | CopilotKit 已有页面上下文/前端工具；待补 `labs/business-events/` | 页面跳转/填草稿、服务端业务命令、主动事件推送分别验证；重放、重复与乱序有定义 |
| 正式 SDK I6 | 现有 UI 示例作输入；待补 `labs/embedded-sdk/` | 在独立宿主接入，验证公开协议、身份交换、事件/确认/重连和版本兼容 |
| 运营报表 / DSL | `apps/support-chat/openui/` | 白名单组件和数据源；报表需求出现再装配，不与核心客服链路绑定 |
| 观测、评估与运行 J | 现有主题测试与模型配置供对照；LangSmith 治理由当前产品接入及 `tests/tracing.test.ts` 覆盖，不另建 demo | 已接可选 LangSmith Tracer、每轮 runId、会话关联、基础凭据过滤与退出提交；28 个本地回归用例通过。缺 Key，真实云接收未验收；调用预算、答案评估及外围故障记录仍待实现 |

## 记忆与持久化的概念边界

- `new MemorySaver()` 就是内存 checkpointer；主入口本轮已改为 PostgreSQL saver，离线测试保留 MemorySaver。注入 Agent 并传入同一 thread_id 后，框架保存和恢复该会话状态，后续模型调用可收到历史。
- 短期记忆的范围是同一个 thread，与是否落数据库无关。MemorySaver 在进程内保存，进程退出丢失；数据库 saver 可跨进程保存同一会话，仍属于短期记忆。
- 长期记忆面向跨 thread 的偏好或其他经过治理的应用数据；需要定义提取/显式写入、读取范围、来源、冲突、过期和删除机制，通常通过 store 或应用仓储实现。它不等于“引入数据库”；用户已确认需要此能力，具体读写契约和存储方式待讨论，不在本轮实现。
- Agent Server 是承载 Agent 的服务运行层，提供 threads/runs、流接口、内置持久化及任务队列。采用它时由服务集成相应存储；它不是另一种记忆。云端和自托管的基础设施责任不同，本项目尚未采用。

官方核对（2026-10-23）：[持久化与 checkpointer/store](https://docs.langchain.com/oss/javascript/langgraph/persistence)、[长期记忆](https://docs.langchain.com/oss/javascript/langchain/long-term-memory)、[Agent Server](https://docs.langchain.com/langsmith/agent-server)。

## 每增加一个功能，先回答什么

每个切片用下面的记录写入实际功能说明或迭代文档。改完后补实测结果，不只保留计划。

```markdown
# 功能：<一个可以单独验收的问题>
关联路线编号 / 学习知识点：

1. 解决的问题
   用户在什么情况下遇到什么障碍？当前行为与预期行为是什么？
   本轮输入、输出、失败语义、明确范围是什么？
2. 主流实现方式
   常见机制如何达到效果？框架替我们做了什么，应用仍负责什么？
   官方一手资料、核对日期、本项目锁定版本和供应商限制是什么？
3. 替代方案与本轮选择
   至少比较一个相关替代；简单函数/确定性工作流可作为基线。
   比较正确性、可控性、延迟、成本、维护复杂度；何时值得切换？
   缺少测量时写“待验证”，不写“更先进所以更好”。
4. 实践与调用链
   agent-practice 有哪些相关资料？当前产品如何实现并验证这个知识点？不强制另建演示或数据库。
   客服项目的源码入口、数据流、状态变化和关键 API 是什么？
5. 验证结果
   正常 / 边界 / 失败用例；命令、实际结果、验证层级。
   确定性流程、真实模型、真实服务分别写；未执行明确说明。
6. 取舍与遗留
   实验结论是什么？是否进入产品？哪些未验收？下一小步是什么？
```

学习覆盖围绕当前产品切片完成，不先补全上表所有目录，不为学习另配数据库或运行一套重复应用。简单功能不必实现全部替代方案；当方案选择依赖效果差异时，才安排可重复的对照验证。

## 方案学习的几组核心对照

以下是本项目拟采用的学习顺序，不代表存在普遍最优方案，也不代表行业占有率统计。官方机制说明已于 2026-10-22 查阅，具体代码仍须按锁定依赖验证。

| 问题 | 常见机制 | 本项目的基线与对照 |
| --- | --- | --- |
| 模型如何调用业务能力 | Schema 描述的工具 + 执行循环 | 先直接调用只读函数验证契约，再注册为工具；理解循环后才比较手写 StateGraph |
| 如何让回答基于知识 | 2-Step RAG、Agentic RAG、混合流程 | 固定证据 → 检索后生成的基线 → 同一问题集比较按需检索；比较漏检、引用、次数和延迟 |
| 如何记住用户 | Checkpoint 保存会话状态，Store 保存跨会话数据 | 先短期记忆，再明确偏好存储；普通键值查询与向量记忆按需求比较 |
| 如何接业务项目 | 本地/HTTP 适配器、MCP 工具、页面桥接 | 先一个适配器与稳定契约，再比较 MCP 的工具发现和协议成本；页面动作独立实现 |
| 如何执行有副作用的操作 | 显式流程、确认、业务侧幂等和结果查询 | Agent 提议操作，业务服务检查规则；比较自主工具循环与不可跳过的流程节点 |
| 什么时候使用子 Agent | 工具封装专家、上下文隔离、并行只读任务 | 单 Agent 先做基线；只有质量、隔离或并行收益可见时推广 |

资料：[Agent 工具循环](https://docs.langchain.com/oss/javascript/langchain/agents)、[RAG 架构](https://docs.langchain.com/oss/javascript/deepagents/retrieval)、[MCP 工具契约（2025-06-18 版，非最新版声明）](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)。

## “调用业务项目事件”的三种情况

- 服务端工具/命令：查询任务、提交重试申请等。身份从可信服务端上下文取得；写操作由业务服务验证权限、规则和幂等。
- 宿主页面动作：打开任务详情、填写表单草稿等。通过白名单 Host Bridge 或前端工具通知页面；页面动作的成功不代表后台业务已办结。
- 业务主动事件：业务系统通知任务完成或失败。通过约定的 Webhook/事件通道接收，验证来源，按 eventId 去重，定义顺序、版本、重放和会话关联；不能直接把任意载荷当成用户指令执行。

三者各选一个最小例子分别实践；MCP 工具调用不自动实现持久事件消费。真实业务项目、首个事件名称和载荷尚未确定。

## 下一小步

已增加 [会话摘要](iterations/conversation-summary.md)，短会话不增加调用；触发时摘要旧前缀并保留近期消息，无效摘要拒绝更新。模型预算是近似值，后续按真实语料验证；不等同长期记忆。

该切片 39 个本地测试、4 个真实 PostgreSQL 测试通过；真实摘要模型调用超时，保护逻辑已拒绝更新，LangSmith 能定位内部模型错误。真实供应商的成功摘要尚未验收，不把模拟/持久化验证等同于模型成功。

源码组织已按 [整理记录](iterations/source-organization.md)收敛到 agent/、cli/、config/ 三类职责；当前路径以 README 为准。属于已有功能重组，不新增独立知识点或演示。

已补 [LangSmith 追踪](iterations/langsmith-tracing.md)，默认关闭，需填真实 Key 后验收云端接收；本地 callbacks/上传/错误隔离已验证。Agent 运行位置和 PostgreSQL checkpoint 均保持原有方式。

2026-10-23 云端排障验收补充：有效 Key 不带 Workspace header 时读取返回 200，原非 UUID Workspace 配置导致 401。已清空错误的可选项，增加格式校验、HTTP 分类与可配置超时。实际上传诊断 trace 返回 202，并通过 Agent/local 地址解析后读回；证明当前云端路由可用，不代表已验证所有真实业务问答。

同日配置精简：当前无需跨工作区指定目标，已彻底移除 Workspace ID 环境项及应用读取/校验；上段是排障过程，现有设置以 README 和 .env.example 为准。保留实际需要的追踪开关、Key、Agent/环境、endpoint、超时和数据隐藏选项。

现有基础已从 [共享流式执行](iterations/stream-main-path.md)、[多轮流式对话](iterations/multi-turn-chat.md) 推进到 [PostgreSQL checkpoint](iterations/postgres-checkpoint.md)：主入口支持数据库持久化和显式恢复已完成会话；未知或未完成会话拒绝自动恢复。后续优先讨论运行生命周期、分类错误/超时/取消或上下文预算，每轮只选择一个切片；长期记忆需求已确认，存储及读写契约仍待讨论。

业务工具与身份契约在真实嵌入集成时推进；知识库/RAG 独立从证据与引用开始。长期记忆、中间件和子 Agent 按具体需求选择，不为学习数量提前装配。
