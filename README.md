# Leeway Support

逐步建设的智能客服系统，当前完成最小工作区、无工具 Agent 的真实问答与离线流程测试。

开发遵守 [小步迭代约定](AGENTS.md)，每项功能先说明解决的问题、主流实现方式和替代方案，再给出调用链与验证结果。[学习覆盖表](docs/learning-coverage.md) 连接本项目与 `E:/GraceProject/agent-practice` 的已有实验及待补知识点；[细粒度路线图](docs/agent-development-roadmap.md) 规定推进顺序。

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
# 启动开发模式，修改源码后重新调用模型；Ctrl+C 退出
pnpm dev

# 执行一次固定问题的流式问答，结束后退出
pnpm start

# 单次流式调试，观察文本片段、节点更新和最终结果
pnpm start -- --debug

# 使用 fakeModel 验证 Agent 流程，不需要模型配置、不发真实模型请求
pnpm test

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
```

模型服务必须兼容所选接口；不根据模型名称猜测接口模式。入口静态导入 `createModel`，在 main 中调用后才使用 Node 内置 `loadEnvFile` 加载文件、校验配置并创建模型；导入模块本身不执行这些操作。环境文件相对 model.ts 定位，运行环境已有的同名变量优先。配置错误在 main 执行期间抛出，进入 main().catch 的统一处理。Turbo 的 dev/start 允许传递这四个变量，不缓存真实模型调用。

启动时会发送一个固定问题并输出真实回答（以下回答内容以实际模型为准）：

```text
[用户] 你好，请简要介绍你现在能够做什么，以及还不能做什么。
[客服] ……
[完成] 耗时 … ms
```

真实入口每次运行会请求模型并产生相应费用，自动重试已关闭，单次模型请求超时为 60 秒。开发模式继续监听源码变化，每次重启都会再次发出请求。配置缺失或接口模式不合法会在请求前报错；调用失败以非零状态退出，不输出原始请求、密钥或供应商错误内容。

## 执行过程观察

`pnpm start` / `pnpm dev` 使用同一个 index.ts 入口，通过 `runSupportAgent` 调用主 Agent 的 `stream`。默认连续输出文本片段；执行 `pnpm start -- --debug`（开发模式为 `pnpm dev -- --debug`）额外展示片段所属节点、节点更新和最终回答。`--` 后的参数经 Turbo 转发到应用，index.ts 读取 `--debug` 切换展示。需要模型服务支持流式响应；dev/start 不缓存，根命令指定 `--log-order=stream` 转发输出，避免按任务分组攒到结束才显示。

`src/run.ts` 统一消费一次执行中的三类 streamMode；`src/cli-run.ts` 控制普通/调试展示：

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

## 离线流程测试

根目录运行 `pnpm test`，或者单独执行 `pnpm --filter @leeway-support/agent test`。测试使用 Node 内置测试运行器，无需新增测试框架依赖。

测试统一放在应用的 `tests/` 目录，与 `src/` 业务代码分开；TypeScript 同时检查这两个目录。`tests/agent.test.ts` 使用 `fakeModel` 控制模型返回或抛错，将它传给真实 `createSupportAgent` 并执行 `invoke`。它不导入真实模型配置、不读取 .env，也不请求模型服务。测试关注执行链路，不维护客服固定问答表。Turbo 不缓存 test，保证每次实际执行；断言失败时返回非零退出码。

当前验证三个场景：

- 用户消息和服务端提示词是否实际传入模型，回答是否写入状态，流程是否只调用模型一次后结束。
- 同一 Agent 处理不同输入时，未开启记忆的各次运行是否保持独立。
- 模型抛错是否向调用方传播，而非返回伪造的成功回答。

`tests/cli-debug.test.ts` 验证同一 CLI 的调试展示：单次调用即可获得片段/节点/最终回答，不输出内部推理和元数据；失败不泄露原始错误；已产生部分文本后断流仍不报告成功。

`tests/cli-run.test.ts` 验证正常入口所用的同一展示/执行路径：模型在首段输出后暂停，收到消费者确认后才继续，以此证明完成前已展示文本；同时验证单次执行、最终结果、不重复打印、断流、空回答和输出范围。

`respond(message)` 安排测试消息，`respond(messages => ...)` 在模型边界检查输入并生成测试返回值，`respond(error)` 注入错误。fakeModel 不理解问题，测试不证明真实模型会遵循提示词或正确选择工具；真实供应商能力另行验证。之后添加工具、中间件或结构化输出时，围绕实际流程扩展场景与断言。当前没有添加这些业务能力。

## 目录和调用链

```text
apps/agent/
  src/index.ts           应用执行入口
  src/model.ts           定义 createModel，调用时加载配置并创建真实模型
  src/agent.ts           Agent 工厂，接收模型并定义提示词和工具列表
  src/run.ts             单次 stream 执行、事件投影与最终结果校验
  src/cli-run.ts         普通连续文本 / 调试事件两种终端展示
  tests/agent.test.ts    fakeModel 流程测试：输入、结束、运行隔离、错误传播
  tests/cli-debug.test.ts 调试展示的成功、失败、断流和输出范围测试
  tests/cli-run.test.ts  正常流式路径、完成前输出、最终结果和失败测试
  package.json           Agent 自己的命令和依赖
  tsconfig.json          Agent 的 TypeScript 配置
docs/                    技术方案和调研记录
package.json             根命令、pnpm 版本、Turbo 依赖
pnpm-workspace.yaml      声明哪些目录是工作区包
pnpm-lock.yaml           固定整个工作区的依赖解析结果
turbo.json               声明任务的缓存和运行方式
```

以 `pnpm dev` 为例：根 package.json → `turbo run dev` → 工作区中 Agent 的 `dev` 脚本 → `tsx watch src/index.ts` → 执行入口。

应用内的调用链：

```text
index.ts      → createModel() → createSupportAgent(model) → runSupportCli（按 --debug 选择展示）→ runSupportAgent → stream
agent.test.ts → fakeModel 控制响应或错误               → createSupportAgent(model) → invoke → 断言执行行为
```

以上路径共用 agent.ts 中的定义；正常和调试展示使用同一应用入口和执行层。工厂每次调用创建一个 Agent 实例；依赖注入在这里就是把模型作为函数参数传入，没有额外容器。

ChatOpenAI 负责与模型接口通信，createAgent 负责执行流程；createAgent 内部基于 LangGraph，因此本阶段安装了相关依赖但尚未手写 StateGraph。当前 tools 为空，没有知识库、业务操作、会话持久化或交互式终端输入。

pnpm 负责多包依赖和安装；Turbo 负责调度各包的任务。dev 和 start 每次真实执行，不缓存；typecheck 可复用缓存，只缓存检查结果，不生成编译产物。

TypeScript 负责类型检查，tsx 负责运行源码。本地模块导入使用实际 `.ts` 扩展名，配置已开启 `allowImportingTsExtensions` 和 `noEmit`。当前没有 JavaScript 构建步骤。

也可以跳过 Turbo，单独运行应用以排查问题：

```sh
pnpm --filter @leeway-support/agent start
```

当前只创建一个可运行应用。后续逐块讨论、实现工具调用和 Agent 流程，出现实际共享需求后再提取 packages。

API 参考：[LangChain Agent](https://docs.langchain.com/oss/javascript/langchain/agents)、[ChatOpenAI](https://docs.langchain.com/oss/javascript/integrations/chat/openai)。

长期目标见 [技术方案](docs/technical-proposal.md)，其中的目录是目标规划，当前实现范围以本 README 为准。
