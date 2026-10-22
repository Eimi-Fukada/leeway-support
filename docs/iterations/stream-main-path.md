# 正常入口使用主 Agent 的流式执行

日期：2026-10-22。范围：终端交互，不增加工具、记忆或 HTTP 服务。

## 解决的问题与契约

原来 index.ts 使用 invoke，只有独立 debug 入口使用 stream。普通启动无法逐步显示回答，两条入口各自组织执行和完成判定。

现在统一由 index.ts → runSupportCli → runSupportAgent → agent.stream 执行，`--debug` 只控制展示；独立 debug 命令、入口和适配文件已移除。输入是同一个 Agent 与问题；过程输出为 text/node-update 事件；成功返回 `{ answer, elapsedMs }`。模型失败、断流或最终状态没有有效文本时拒绝返回成功，CLI 标记已有片段未完成，入口以非零状态退出。普通展示不重复打印整段回答，调试展示保留最终结果方便走读。

## 常见机制、替代与取舍

LangGraph 的 stream 提供消息片段、节点状态更新与状态快照；流式消费属于调用/展示层，不需要在 Agent 内添加一个 stream 节点。执行只启动一次，从最后状态取得答案，不为最终结果额外 invoke。

本次保留 streamMode 的三个明确分支，与学习仓库示例对应。替代方案是 invoke + callbacks，适合内部追踪；官方还建议新应用评估 event streaming 的独立投影接口。本轮先解决主入口复用与结果返回，不同时切换流 API。以后需要独立消费多个投影时再比较迁移收益，按锁定版本验证。

官方依据（2026-10-22 核对）：[LangGraph Streaming](https://docs.langchain.com/oss/javascript/langgraph/streaming)。项目锁定 LangGraph 1.5.2、LangChain 1.5.18；真实供应商仍需支持所选模型/接口的流响应。官方示例的新 API 不等于本项目已验证支持。

## 学习实验与调用链

agent-practice 已有 `structured-output.ts` 的 streamMode 对照，命令为在该仓库执行 `npx tsx structured-output.ts`；需要模型配置，会执行多个演示调用。另有 `apps/support-chat/basic-chat/` 的 useStream 客户端示例。此次复用已有知识点，不新增独立实验；本轮未运行学习仓库示例。

本项目：index.ts 从 process.argv 读取 --debug → runSupportCli（普通/调试）→ runSupportAgent。只有 run.ts 调用 agent.stream；CLI 负责展示，执行函数不打印日志。独立入口与参数开关都能实现调试展示，此处选择参数开关，减少重复入口；现阶段没有需要单独调试装配的场景。

## 验证与边界

- 确定性验证：`corepack pnpm test`，10/10 通过，覆盖主路径完成前输出、单次执行、最终结果、断流、空回答、输入传递及推理/元数据输出范围，并保留原有 Agent 与调试测试。
- 静态验证：`corepack pnpm typecheck` 通过；`git diff --check` 无空白错误。
- 真实模型：此前 `corepack pnpm start` 已完成普通流式问答；本次以 `corepack pnpm start -- --debug` 验证根命令参数经 Turbo 传到同一 index.ts，真实模型输出多段文本、节点更新与最终回答，退出码为 0。供应商片段粒度不作保证。
- 真实业务：未验证，目前没有业务工具。

当前仅有一个无工具的模型节点。后续加入内部模型、工具或子 Agent 时需定义消息过滤与终止语义，不能把所有文本都直接展示，也不能继续假定每次成功都以自由文本 AI 消息结束。HTTP 传输、取消、并发和恢复仍属于后续切片。
