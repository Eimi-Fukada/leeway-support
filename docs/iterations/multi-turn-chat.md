# 会话级多轮流式对话

日期：2026-10-22。对应 C1/C2，当前聚焦 Agent 编排；不引入 RAG 或业务工具。

## 问题与本轮契约

原来启动后只问一个固定问题，无法连续追问。现在用户连续输入，每轮沿既有主 Agent stream 执行；同一 thread 使用历史，/new 切换新 thread，/exit 或 EOF 结束输入。空行和未知命令不会请求模型。

每轮只提交新增用户消息，由 checkpointer 恢复历史。一个进程复用同一个 Agent 和 MemorySaver，同一输入循环串行 await。MemorySaver 仅在 RAM 中保存状态，退出或 watch 重启后丢失；/new 不删除旧 checkpoint。这里的 thread 隔离是状态分区，不是生产访问控制。

## 常见实现、替代与选择

使用 LangChain createAgent 的 checkpointer 配置，在 stream 的 configurable 中传 thread_id。短期记忆是会话行为，checkpoint 是状态保存机制；长期记忆是跨会话应用数据，不能因用了数据库就混同。

手工维护 messages[] 也能实现对话，但需要自行管理追加、隔离和失败语义。本次选框架 checkpoint，便于后续持久化和 HITL。另一选择是直接接 PostgreSQL saver，能重启恢复，但会同时引入存储配置、生命周期和服务集成验证；留给下一切片，届时替换注入的 saver。未以成本或性能宣称某方案最优。

官方核对（2026-10-22）：[LangChain 短期记忆](https://docs.langchain.com/oss/javascript/langchain/short-term-memory)、[Node Readline](https://nodejs.org/api/readline.html)。本项目锁定 LangChain 1.5.18、LangGraph 1.5.2，未增加依赖。

## 实践与调用链

学习仓库已有 `E:/GraceProject/agent-practice/memory.ts`，可在该仓库用 `npx tsx memory.ts` 运行，需模型配置并会发真实请求。本轮已核对其 MemorySaver + thread_id 示例，未运行该实验；没有新增知识点缺口。

index.ts 创建模型、MemorySaver、Agent 和 readline；chat.ts 管理 thread_id 与命令；每轮调用 cli-run.ts → run.ts → agent.stream。工厂可选注入 BaseCheckpointSaver，未注入时保留无记忆运行用于对照测试。执行层接受 threadId 并在请求前拒绝空输入/空 ID。

根 dev/start 改为 pnpm 直接启动应用：实验中给原 Turbo 路径传 /unknown、/new、/exit 时应用未消费这些行；直接启动后命令生效，stdin/stdout 可直达交互应用。test/typecheck 仍由 Turbo 调度。

## 失败语义与验证

模型失败或断流仍向上传播，输入循环停止，CLI 显示未完成，入口关闭 readline 并非零退出；不自动重试，不静默提交后续输入。checkpoint 可能已经保存失败轮用户输入，但不写入伪成功回答，不承诺失败回滚。后续恢复策略独立设计。

- 确定性测试：`corepack pnpm test`，17/17 通过。新增验证历史实际进入模型、新 thread 隔离、相同 saver 跨 Agent 共享、新 saver 无历史、失败轮状态、输入命令、EOF 和失败停止。
- 类型检查：`corepack pnpm typecheck` 通过。
- 真实模型：通过根 `corepack pnpm start` 顺序输入代号、追问代号、/new、再次追问、/exit。同一会话回答“蓝松”，新会话回答“不知道”，退出码 0。该验证仅证明本次样例，不代表模型记忆正确率评估。
- 根命令参数验证：`corepack pnpm start -- --debug` 接收 /unknown、/new、/exit 并正常结束，没有发送模型问题。
- 真实业务与持久化重启恢复：未验证，也未实现。

## 遗留

下一步优先讨论持久 checkpoint 的存储与重启恢复，而非补模拟业务工具。多用户鉴权、运行中取消、同 thread 跨请求并发、历史保留/删除、上下文预算及长期记忆仍需分别设计。终端连续输入可以按序缓存，但不是持久消息队列。
