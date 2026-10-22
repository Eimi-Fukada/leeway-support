# 客服产品与 Agent 实践的双向学习覆盖

更新：2026-10-22。状态：开发与学习约定，缺口清单待逐项实施。

## 两个仓库如何配合

`E:/GraceProject/leeway-support` 验证能力能否解决真实客服问题；`E:/GraceProject/agent-practice` 提供对应知识点的最小实验和方案对照。本表覆盖现有技术方案与路线图中的目标知识点，后续新增知识点同步登记。覆盖完成以可运行实验和验证记录为准，不以目录、文档或框架依赖存在为准。

下表的“已有示例”只表示查到对应源码，并未在本轮运行这些示例。说明文档不是完整实验；当前客服项目已存在的代码也不代表已经做过真实业务验收。目标架构见 [技术方案](technical-proposal.md)，细粒度编号见 [路线图](agent-development-roadmap.md)。

## 知识点、场景和缺口

实验路径均相对 `E:/GraceProject/agent-practice`；“待补”是建议落点，尚未创建或实现。

| 知识点 / 路线编号 | agent-practice 现有依据或待补实验 | 客服项目要解决的问题 / 验收重点 |
| --- | --- | --- |
| 模型接入与执行基础 A | `model.ts`、`shared/model.ts`、`模型接入说明.md`、各主题测试；待补统一的故障注入实验 | 配置和 Agent 解耦；无密钥复现流程；超时、取消、错误可区分 |
| Agent 循环与工具 B1–B3 | `beginner.ts`、`shared/orders.ts` | 第一个只读业务查询；看清模型 → tool_calls → 工具结果 → 模型的循环及停止条件 |
| Schema / 结构化输出 B4–B7 | `structured-output.ts`、`apps/support-chat/structured-output/` | 工具参数、工具结果、最终回答分别校验；无效输出不能生成成功卡片 |
| 状态和短期记忆 C1–C4 | `memory.ts`、`command-update.ts`、`remember.ts`；待补持久化/归属实验 | 多轮指代、会话隔离、重启恢复；remember 示例是 state 更新，不是长期记忆 |
| 长期记忆 C5–C7 | 待补 `labs/long-term-memory/` | 跨会话偏好、来源、删除、冲突；不能把实时业务事实永久记住 |
| 上下文工程 C8–C9 | `summarization-middleware.ts`、`context-editing-middleware.ts` | 长对话预算；对照摘要与输出清理；关键动作/授权不靠摘要保存 |
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
| 观测、评估与运行 J | 各主题 `*.test.ts` 提供局部测试；待补 `labs/evaluation/` 与服务故障实验 | trace、调用预算、检索/答案/工具分别评估；发布回滚、数据删除和恢复有证据 |

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
   agent-practice 对应实验和命令是什么？缺失时本轮如何补齐？
   客服项目的源码入口、数据流、状态变化和关键 API 是什么？
5. 验证结果
   正常 / 边界 / 失败用例；命令、实际结果、验证层级。
   确定性流程、真实模型、真实服务分别写；未执行明确说明。
6. 取舍与遗留
   实验结论是什么？是否进入产品？哪些未验收？下一小步是什么？
```

学习实验围绕当前切片补齐，不先补全上表所有目录。简单功能不必实现全部替代方案；当方案选择依赖效果差异时，才安排可重复的对照实验。

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

现有基础是无工具 Agent、可注入模型、fakeModel 流程测试和正常/调试入口共用的单次流式执行（见 [本次迭代](iterations/stream-main-path.md)）。下一切片建议只做 B1/B2：定义可信调用上下文和一个只读 `get_task_status` 的契约，先用固定数据直接执行。验收合法参数、非法参数、无此任务和越权的差异；此时不声称已接真实业务。

之后 B3 才把工具注册到 Agent，用脚本模型验证消息轨迹和停止，再单独验证真实模型会不会正确选择工具、缺参数时是否追问。知识库链路在只读工具循环稳定后，从固定证据与引用开始逐步接入；无需等所有高级中间件完成。
