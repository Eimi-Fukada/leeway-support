# Agent 精细开发路线

日期：2026-10-22。状态：逐项推进的开发路线，未完成条目不授权批量实现。每次迭代遵守根目录 AGENTS.md，按 [学习覆盖与迭代模板](learning-coverage.md) 解释问题、主流实现、替代方案与验证结果。

当前已实现（按源码核对）：pnpm/Turbo 工作区、apps/agent、环境加载、ChatOpenAI、无工具 createAgent、可注入模型、fakeModel 离线流程测试，以及正常/调试展示共用的 stream 执行层。主入口已接入连续输入、MemorySaver + thread_id、多轮历史、/new 和 /exit，C2 已落地，见 [多轮对话迭代](iterations/multi-turn-chat.md)。A1 已落地；A2/A3 具备部分基础，但未实现完整场景入口、runId/调用次数观测和故障注入。当前尚未实现工具、结构化结果、长期记忆、持久 checkpoint、知识库/RAG、HTTP 流式服务、CopilotKit 或业务集成。终端流式输出不等于对外流式服务。

## 推进方式

每次只选择下面一个编号的小单元：说明问题、方案对照与契约 → 在用户已授权范围内实现（业务事实缺失时先澄清）→ 走读调用链 → 验证正常和失败场景 → 更新学习映射。阶段是能力分组，不是一轮代码生成的范围。不预先建立全部目录、接口或通用中间件框架。

每个单元记录输入、处理、输出、源码入口、框架 API、失败用例及验证层级。业务代码沿同一客服场景逐步积累；独立概念实验保留在开发入口，生产入口只能装配已验收的能力。不同实现的比较先在实验路径完成，不直接替换稳定实现。

暂定贯穿场景：“用户查询处理任务 → 追问处理异常 → 获取解释 → 准备重新处理 → 用户确认 → 执行或转人工”。这只是默认讨论载体，不把真实业务接口、规则、权限假设成已经确定。

## A. 可模拟、可调试的执行基础

来源：beginner.ts、model.ts、shared/model.ts、middleware.ts、tool-emulator-middleware.ts、各 agent.test.ts。

| 编号 | 本轮只解决什么 | 最小验收 |
| --- | --- | --- |
| A1 | 将 Agent 构造和真实配置解耦：createSupportAgent 接受模型；真实模型仍由生产入口加载 | 使用脚本模型执行相同 Agent，不读取真实密钥、不联网；真实入口仍可用 |
| A2 | 定义一个场景输入和预期轨迹，提供独立开发入口 | 指定场景可重复运行；不依赖交互输入才能验证 |
| A3 | 基础调试记录：runId、阶段、调用次数、耗时、脱敏错误类型 | 看出开始、模型返回和失败位置；保留诊断而不输出密钥或完整供应商响应 |
| A4 | 故障注入：超时、429、结构错误、取消 | 可指定发生在哪次调用；失败不伪装成成功 |

模拟分四层，明确标识且禁止测试配置进入生产装配：

1. 脚本模型 + 固定工具数据：无 LLM 费用，确定性验证流程和状态。
2. 真实模型 + 固定工具数据：验证模型理解、选工具和输出能力，不验收业务 API。
3. toolEmulatorMiddleware：真实模型生成模拟工具结果，仅探索未覆盖场景，仍有费用且不可复现，不能用来验证金额、幂等或业务正确性。
4. 真实模型 + 测试环境业务服务：验收协议和授权；最终再做真实业务灰度。

## B. 输入、工具与结构化结果

来源：beginner.ts、structured-output.ts、shared/orders.ts、apps/support-chat/structured-output/contracts.ts 与 agent.ts。

| 编号 | 本轮只解决什么 | 最小验收 |
| --- | --- | --- |
| B1 | 定义本次运行输入及可信 context：request/run 标识、产品、用户授权引用 | 用户消息无法覆盖服务端 context；开发用户必须显式标成模拟身份 |
| B2 | 定义第一个只读工具 get_task_status 的参数和返回契约 | 合法 ID、非法参数、无此任务有不同结果；失败数据不冒充任务状态 |
| B3 | 工具直接执行，再注册进 Agent | 观察 Human → AI tool_calls → ToolMessage → AI；缺 ID 追问、不查工具 |
| B4 | 区分工具参数、工具返回、Agent 最终结构化结果 | 三者有各自 schema；格式合法不代表业务事实正确 |
| B5 | 单独讨论并定义最小 SupportResult（结果类型、回答、证据引用等） | 不要求自由对话每轮提取全部字段；缺失信息可表达，不用空字符串假装事实 |
| B6 | 用 toolStrategy 产生 structuredResponse，再按供应商能力比较 providerStrategy | 测非法枚举、字段缺失、多次结构化提交；有限修复后明确失败；真实模型验证能力 |
| B7 | 结构化结果消费规则 | 仅本轮成功结束且匹配请求的校验结果可消费；半截 JSON、旧轮次结果、失败流都不能变成成功卡片 |

requestId 等可信关联字段由服务端绑定/校验，不依赖模型逐字复述建立信任。模型可产生“建议”，业务层校验事实和规则后才能产生“可执行动作”。工具错误、用户结果类别、Graph 运行状态分别建模，不能混成一个 status 字段。

## C. 短期记忆、长期记忆与上下文工程

来源：memory.ts、command-update.ts、remember.ts、summarization-middleware.ts、context-editing-middleware.ts。当前学习仓库没有等价完整的生产长期记忆闭环，需要补充设计。

| 编号 | 本轮只解决什么 | 最小验收 |
| --- | --- | --- |
| C1 | 区分 state、context、store、业务数据库 | messages/当前任务属 state；本次授权属 context；偏好属 store；权益属业务系统 |
| C2 | MemorySaver + thread_id：内存短期记忆实验 | 同一 thread 可追问，换 thread 隔离，重启丢失得到明确验证 |
| C3 | 自定义 state：currentTaskId，通过 Command 更新 | 返回 ToolMessage 正确配对；实体切换后不误用旧任务，使用时重新查权限 |
| C4 | PostgreSQL checkpointer 与会话归属检查 | 重启恢复；伪造其他用户 thread_id 被拒绝；API 鉴权不靠 checkpointer 自动实现 |
| C5 | 长期记忆的读写范围与生命周期契约 | namespace 隔离产品/租户/用户；记录来源、更新时间、有效期、版本；用户可删除 |
| C6 | 先实现明确偏好的保存和跨会话读取 | 例：“请默认简短回答”；新会话生效，别的用户不生效；不必一开始用向量搜索 |
| C7 | 可选的自动记忆提取：候选 → 规则校验/确认 → 写入 | 不把单轮猜测、订单状态、配额、凭证、外部指令写成永久事实；处理冲突、撤回和并发写 |
| C8 | summarization：长对话压缩实验 | token 触发可观测；保留必要消息配对；审批和关键实体由独立结构状态保留，摘要不是授权 |
| C9 | contextEditing：清理可重新获取的大型工具输出 | 和摘要分别比较，再讨论顺序；被清理事实可重查；原始审计证据不靠模型历史保存 |

短期记忆按生命周期指一个 thread；使用数据库并不会使它变成长时记忆。长期记忆是跨 thread 的应用数据；RAG 是有来源/发布流程的业务知识。摘要只缩减模型上下文，也不等于业务审计或长期记忆。

## D. 中间件逐项设计、装配与验证

不一次性挂齐所有中间件。每引入一项，先用脚本模型/固定工具制造触发条件，再用真实供应商验证必要路径。顺序、包裹关系、重试次数、错误传播和流输出都要可观测。

| 编号 | 来源/机制 | 客服中的具体用途 | 生产注意事项与验收 |
| --- | --- | --- | --- |
| D1 | middleware.ts：六类钩子 | 分清 beforeAgent/afterAgent、beforeModel/afterModel、wrapModelCall/wrapToolCall 的时机 | 用执行轨迹证明装配顺序，不凭“洋葱模型”猜全部 hooks 的顺序 |
| D2 | 入口校验与动态工具过滤 | 匿名用户只允许公开问题，已授权用户看到对应工具 | 执行侧再鉴权；从模型隐藏工具不能替代授权 |
| D3 | model-call-limit | 单轮/会话模型次数预算 | 正常、超限、失败恢复后计数均正确；重试/摘要/筛选/子 Agent 另计真实总消耗 |
| D4 | tool-call-limit | 防反复查询和循环 | 并行多个调用也计数；被阻断工具确实未执行，模型能够解释限制 |
| D5 | toolErrorMiddleware / 自定义错误转换 | 将可解释的工具失败交还模型 | NOT_FOUND/FORBIDDEN/TIMEOUT 等分类；日志留脱敏根因，输出不泄露内部细节 |
| D6 | toolRetryMiddleware | 对只读查询的暂时失败重试 | 仅暂时错误、有限退避和截止时间；写操作执行未知先核对，不套通用重试 |
| D7 | modelRetryMiddleware | 模型暂时故障重试 | SDK 与 middleware 仅一层拥有重试策略，控制乘法重试；实际 attempts 可见 |
| D8 | fallback-middleware | 主模型不可用时切备用 | 备用有独立配置并满足工具/结构化契约；流已输出后不能静默拼另一模型答案 |
| D9 | pii-middleware | 发往模型的个人信息最小化 | 同时设计输入接收、工具结果、流输出、日志、checkpoint 的数据策略；afterModel 太晚时不能阻止已发出的流内容 |
| D10 | summarization / context-editing | 上下文预算 | 按 C8/C9 实施；保留授权、确认和证据记录，处理租户资料撤权后的历史内容 |
| D11 | llm-tool-selector | 大工具集的候选预筛 | 先权限过滤，再模型筛选；测试多轮指代和误筛；评估额外调用成本与漏选 |
| D12 | provider-tool-search | 供应商侧工具延迟披露 | 与 D11 对照，非强制叠加；按所锁定包、模型和接口模式验证支持，不照搬示例版本声明 |
| D13 | tool-emulator | 开发原型和边界探索 | 只在开发入口启用；生产配置误启应拒绝启动；不能作为确定性业务测试 |
| D14 | todo-list | 多步骤诊断过程展示 | TODO 不授予权限、不等于业务状态；步骤完成以工具证据为依据，简单问答不强制规划 |
| D15 | filesystem | 大型诊断材料的受控读写与外置 | 先实验；真正隔离执行环境、路径/体积/权限限制，不能把路径前缀或 virtualMode 当作 OS 级沙箱；在线客服不开放任意 shell |

D1 及最小观测在 A/B 期间引入；D2–D5 在接入真实个人数据/业务工具前完成；D6–D9 按对应故障路径逐项加入。成本统计覆盖实际所有模型/子调用，框架内计数器不作为计费账本。限流、熔断、每用户配额、全局并发、请求截止时间和任务取消属于服务层能力，不能只依赖 Agent hooks。

## E. 流式交互、CopilotKit 与生成式 UI

来源：structured-output.ts 的多种 streamMode/streamEvents、apps/support-chat/{basic-chat,generative-ui,ai-elements}、apps/copilotkit-demo。

| 编号 | 本轮只解决什么 | 最小验收 |
| --- | --- | --- |
| E1 | 分别观察 messages、updates、custom 和最终结果 | 文本增量、节点变化、工具进度分得清；不展示内部推理或原始 state |
| E2 | 选择 Agent 服务/协议适配路径，做一次技术验证 | 同一个现有 TS Agent 经选定 adapter 到客户端；验证流、工具、状态和错误，不另起 BuiltInAgent 替代它 |
| E3 | 增加开发调试页面，最小 CopilotKit 聊天 | CLI 与页面使用同一 Agent；固定/真实模式有明显标识；不是正式 SDK |
| E4 | 第一张受控任务卡片 | ToolResult 与 Agent 最终结构化结果分别消费；pending/success/failure 可见，完整参数校验后才展示事实 |
| E5 | useAgentContext：页面当前任务等上下文 | 选择变化、卸载、数据更新可追踪；浏览器信息是提示，服务端重新鉴权 |
| E6 | useFrontendTool：打开页面、选择任务、填草稿 | 注册白名单，参数校验、执行回执、超时处理；浏览器离线不能伪造完成，后台写操作仍留服务端 |
| E7 | 前后端状态契约 | 只同步 UI 必需字段；客户端不能覆盖 pendingAction、授权、执行结果；旧轮次卡片失效 |
| E8 | CopilotKit HITL 卡片 | 将 G 阶段的 interrupt/confirmation 展示并回传；重复点击、断流、过期和无权限均可解释 |
| E9 | 声明式 UI/OpenUI | 按运营报表需求启用；组件/DSL/action 白名单、渐进半成品、依赖未到齐、渲染失败降级 |

推荐 E2 在 B/C 基础稳定后提前验证，不等到整个系统写完才发现协议不兼容。详细 UI 可以和 D 阶段交替推进。CopilotKit 是交互层选型，不接管业务权限或长期记忆事实源。

优先验证官方 LangGraph TypeScript adapter 所要求的服务协议；Agent Server 和自托管 AG-UI 接口的取舍在 E2 决定。不能假设 createAgent 对象、任意 Hono/SSE 接口或学习项目的 useStream 都天然兼容。若选择 Agent Server，明确它负责的 thread/run/checkpoint 生命周期，避免和自管实现重复存储/调度；验证已锁定版本、授权、部署许可和 CLI schema 工具链。

学习仓库 CopilotKit 示例的 BuiltInAgent 使用 AI SDK，是独立教学路径；本项目保留 LangGraph Agent，通过适配器连接。当前官方 TS quickstart 的部分示例对 SDK/Zod 有特定版本约束，实施时验证兼容，不强制降级整个应用或绕过 peer 冲突。

## F. 会话服务、并发与恢复

来源：apps/support-chat/{message-queues,join-rejoin,branching,time-travel}。这些示例依赖 Agent Server/SDK 行为，不能只复制客户端 hook 就认为服务端能力存在。

| 编号 | 本轮只解决什么 | 最小验收 |
| --- | --- | --- |
| F1 | 会话/run/事件的归属、版本与 ID | 服务端生成/绑定身份；跨用户不能读取结果、历史或流 |
| F2 | 同一 thread 的忙碌策略：排队、拒绝或取消后重跑 | 默认串行；队列持久性、顺序、容量和失败语义明确；前端本地队列不当成生产保障 |
| F3 | 观察断开、run 取消和业务任务取消分别定义 | 关闭页面可继续后台工作；取消不能撤销已提交业务副作用 |
| F4 | 重连、快照与事件去重 | 重连不 submit 新任务；完成结果可读，保留期外有明确恢复方式 |
| F5 | API 多实例执行租约/调度所有权 | 崩溃/租约过期后恢复，不出现两实例同时执行同一写动作 |
| F6 | 分支、重新生成和只读历史回放 | 新分支不自动复用旧审批；查看/回放禁真实写工具 |

## G. 确定性业务流程、HITL 与人工接管

来源：apps/support-chat/hitl，以及 time-travel 中的显式节点设计。应先定义权限、动作契约和验收再实现真实写入。

| 编号 | 本轮只解决什么 | 最小验收 |
| --- | --- | --- |
| G1 | 识别哪些由 createAgent 自主探索，哪些是必须遵循的业务步骤 | 写出“查询资格 → prepare → 确认 → execute”的不可跳跃约束 |
| G2 | 显式 StateGraph 包裹受限 Agent 节点 | 走读 addNode/addEdge/条件边/compile，状态 schema 与 reducer 可解释 |
| G3 | interrupt/resume 补资料与确认实验 | 持久检查点；恢复输入校验；重进节点不重复执行副作用 |
| G4 | Action/Confirmation 契约 | actionId 绑定 actor、conversation、参数版本/哈希、有效期；编辑参数后重新确认 |
| G5 | 幂等执行与执行未知核对 | 业务侧持久幂等约束；超时先 query action；重复确认、重放和恢复不重复扣费 |
| G6 | 人工接管 | staff 角色、队列认领、转移、超时、交还和审计；接管后机器人不能新增执行 |

“用户确认”“员工审批”“人工接管”是三种不同业务状态，不统一成一个 approve=true。人工审批也不自动绕过业务执行权限。

## H. Subagents 与复杂诊断

来源：subagent.ts、subagent-middleware.ts、todo-list-middleware.ts、openui/parallel。

| 编号 | 本轮只解决什么 | 最小验收 |
| --- | --- | --- |
| H1 | 定义专家职责与交接契约 | 一个主客服 + 一个技术诊断专家；明确何时委派、专家需要哪些事实、返回什么、失败怎么办 |
| H2 | 将已有 createAgent 包成父 Agent 工具 | 限制专家工具/上下文；子结果 schema 校验，父 Agent 不直接转发未验证结论 |
| H3 | 权限、记忆和预算传播 | 从可信执行上下文显式传递受限身份；不默认继承主 Agent 所有 tools；总预算含子调用 |
| H4 | 单次隔离专家与有连续状态专家的比较 | 默认先单次隔离；需要连续状态时明确子 thread namespace/并发及清理，避免用户串线 |
| H5 | 手动专家封装与 createSubAgentMiddleware/Deep Agents 对照 | 比较默认工具、文件能力、模型调用、失败传播与维护成本，明确是否推广 |
| H6 | 并行只读调查、父级聚合和 UI 呈现 | 限并发/截止时间/取消传播；部分失败可解释；输出冲突有策略；真实写操作不并行竞跑 |

Subagent 的收益应是上下文隔离、专业策略或独立任务，不为一次查询多加一个模型。学习中必须做出可运行实验；是否进入生产由质量、成本、延迟和复杂度对照决定。

## I. RAG、MCP 与正式 SDK 接入

这些作为独立阶段后接，但契约、权限和 UI 消费边界在前面预留，不先实现全套平台。

| 编号 | 小单元 | 验收 |
| --- | --- | --- |
| I1 | 本地固定证据的检索接口与 evidence schema | 答案有来源；检索失败和无答案不同；提示注入不能提升权限 |
| I2 | 原文/元数据/向量分层、解析和中文召回实验 | 固定问题集比较召回、过滤、引用；不只看向量距离 |
| I3 | 入库任务、不可变版本、审核发布/撤回、Qdrant | 发布失败不暴露半成品；撤权也处理会话历史和缓存；原文下载受控 |
| I4 | MCP 测试 Server，替换本地业务适配器 | schema、结果、错误与本地契约对齐；发现工具、重连、超时均测 |
| I5 | 真实业务身份交换、受限授权和端点登记 | 不允许用户自带任意 MCP URL；业务端每次核对用户/资源/权限/配额 |
| I6 | 从已稳定交互抽取 sdk-core/sdk-react，业务 server adapter | 版本契约、安装、事件/确认/重连、宿主白名单；SDK 不依赖数据库源码 |
| I7 | 宿主页面动作桥接：先实现一个白名单动作 | 参数校验、宿主结果回传、重复请求；页面动作不当成服务端业务执行成功 |
| I8 | 业务主动事件接收：先处理一种任务状态事件 | 来源验证、eventId 去重、顺序/版本、重放和会话归属；重复事件不重复触发动作 |

## J. 贯穿各阶段的生产验收

每一块都积累回归用例和观测，最终阶段是集成验收而非首次考虑可靠性：

- 确定性测试：状态、schema、权限、确认、幂等、middleware 顺序及预算。
- 服务集成：数据库重启、并发、断流、崩溃恢复、协议版本、真实 MCP、持久事件。
- 模型评估：任务理解、工具选择、追问、结构化输出、证据支持、转人工、滥用和注入。
- UI 端到端：当前请求绑定、生成中/失败/取消/确认、断网恢复、无障碍和宿主集成。
- 运行：产品/用户限流、总成本预算、模型/索引/提示词/Graph 版本、灰度、回滚、配置/凭证隔离、健康检查、优雅退出、备份恢复及告警。
- 数据：最小化收集、日志/checkpoint/store/索引/缓存保留期与删除，模型供应商的数据边界。

schema 正确不等于事实正确；脚本模型正确不等于真实模型稳定；本地服务通过不等于生产授权和部署通过。主/备模型、摘要、筛选和子 Agent 的真实调用均需计入成本、延迟和错误评估。

## 推荐推进顺序

A1 与 C2 已落地，无需重做。按用户明确的三块边界推进：知识库/RAG、Agent 编排、嵌入业务与工具集成。当前优先编排；下一切片讨论 C4 中的持久 checkpoint 与重启恢复，再按真实故障需要逐项加入观测、预算、上下文管理。C4 的会话归属/鉴权在服务接入时单独验收，不能因本地存储通过就宣告完成。

业务工具 B1–B3 留给真实业务集成切片，不为先凑工具循环制造任务查询 demo。长期记忆、上下文压缩、HITL 和 subagent 以各自真实问题为单位加入；RAG/MCP/正式 SDK 独立接入。所有编号都是待讨论工作，不因写进文档而自动开始实施。

A1 的现有实现见 apps/agent/src/agent.ts 与 tests/agent.test.ts；正常/调试展示统一由 src/index.ts 的 --debug 参数选择，见 src/cli-run.ts 与对应测试。下一步也保持这一粒度，不顺便添加数据库、HTTP 服务或 UI。

## 资料依据

已查看 E:/GraceProject/agent-practice 根目录模型、工具、结构化输出、记忆、Command、中间件与子 Agent 示例，以及 support-chat 的主题目录和 CopilotKit/OpenUI 说明。示例注释中的版本特性、阈值和性能断言只作阅读线索；实施时以本项目锁定依赖与实际测试为准。现有示例与待补实验的双向映射见 learning-coverage.md，不将检索说明或演示代码当成完整生产能力。

官方核对入口（2026-10-22）：

- 结构化输出：https://docs.langchain.com/oss/javascript/langchain/structured-output
- 短期记忆：https://docs.langchain.com/oss/javascript/langchain/short-term-memory
- 长期记忆：https://docs.langchain.com/oss/javascript/langchain/long-term-memory
- 中间件：https://docs.langchain.com/oss/javascript/langchain/middleware/built-in
- 测试：https://docs.langchain.com/oss/javascript/langchain/test
- CopilotKit TypeScript 集成：https://docs.copilotkit.ai/langgraph-typescript
- CopilotKit TypeScript 版本约束：https://docs.copilotkit.ai/langgraph-typescript/quickstart
