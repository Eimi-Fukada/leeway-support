# Leeway Support

逐步建设的智能客服系统，当前支持无工具 Agent 的多轮流式对话、会话级内存 checkpoint 与离线流程测试。

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
# 启动开发模式，修改源码会重启并丢失内存会话
pnpm dev

# 连续输入问题，每轮流式回答；/new 新会话，/exit 退出
pnpm start

# 多轮对话时额外观察文本片段、节点更新和每轮最终结果
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

模型服务必须兼容所选接口；不根据模型名称猜测接口模式。入口静态导入 `createModel`，在 main 中调用后才使用 Node 内置 `loadEnvFile` 加载文件、校验配置并创建模型；导入模块本身不执行这些操作。环境文件相对 model.ts 定位，运行环境已有的同名变量优先。配置错误在 main 执行期间抛出，进入 main().catch 的统一处理。dev/start 通过 pnpm 直接启动应用，继承运行环境，不经过任务缓存。

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

每条非空问题会请求模型并产生相应费用；空行、/new、/exit 和未知命令不调用模型。同一会话逐轮串行执行，后续轮次由 checkpoint 加载历史，每轮仅提交新增用户消息。自动重试已关闭，单次模型请求超时为 60 秒。开发模式监听源码变化，重启会清空内存会话并重新等待输入。配置缺失或接口模式不合法会在请求前报错；调用失败停止输入循环，以非零状态退出，不输出原始请求、密钥或供应商错误内容。

## 会话与短期记忆

index.ts 为本进程创建一个 MemorySaver 和 Agent；chat.ts 生成 thread_id，同一会话复用该 ID，/new 生成新 ID。历史由 Graph state 和 checkpointer 管理，不在终端代码中手工拼接。/new 只切换会话，不等于删除旧 checkpoint；进程退出后所有内存 checkpoint 丢失。EOF 结束输入，排在前面的已读问题仍按顺序处理；/exit 在轮次之间退出，不是运行中取消命令。

失败轮可能已保存用户输入，但不会把断流片段当作成功回答；本轮不实现自动恢复或回滚。当前会话 ID 只是本地状态分区，不提供多用户身份验证或访问控制。长期记忆、持久化重启恢复、摘要和并发控制仍未实现。详细取舍与验证见 [多轮流式对话迭代](docs/iterations/multi-turn-chat.md)。

## 执行过程观察

`pnpm start` / `pnpm dev` 使用同一个 index.ts 入口，每轮通过 `runSupportAgent` 调用主 Agent 的 `stream`。默认连续输出文本片段；执行 `pnpm start -- --debug`（开发模式为 `pnpm dev -- --debug`）额外展示片段所属节点、节点更新和最终回答。参数由 pnpm 传到应用，index.ts 读取 `--debug` 切换展示。需要模型服务支持流式响应。交互入口直接启动应用，以保留 stdin 和逐片段 stdout；Turbo 继续运行 test/typecheck。

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

`tests/memory.test.ts` 检查模型实际收到的历史、thread 隔离、saver 生命周期、失败轮 checkpoint 和空输入拒绝；`tests/chat.test.ts` 检查连续输入、命令、串行执行、失败停止及 EOF。基础 agent.test.ts 保留未注入 saver 的无记忆对照，不代表真实入口未启用记忆。

`respond(message)` 安排测试消息，`respond(messages => ...)` 在模型边界检查输入并生成测试返回值，`respond(error)` 注入错误。fakeModel 不理解问题，测试不证明真实模型会遵循提示词或正确选择工具；真实供应商能力另行验证。之后添加工具、中间件或结构化输出时，围绕实际流程扩展场景与断言。当前没有添加这些业务能力。

## 目录和调用链

```text
apps/agent/
  src/index.ts           应用执行入口
  src/chat.ts            连续输入、会话 ID、/new 和 /exit
  src/model.ts           定义 createModel，调用时加载配置并创建真实模型
  src/agent.ts           Agent 工厂，接收模型与可选 checkpointer
  src/run.ts             单次 stream 执行、事件投影与最终结果校验
  src/cli-run.ts         普通连续文本 / 调试事件两种终端展示
  tests/agent.test.ts    fakeModel 流程测试：输入、结束、运行隔离、错误传播
  tests/cli-debug.test.ts 调试展示的成功、失败、断流和输出范围测试
  tests/cli-run.test.ts  正常流式路径、完成前输出、最终结果和失败测试
  tests/chat.test.ts     连续输入、命令、失败停止与 EOF
  tests/memory.test.ts   多轮历史、隔离、checkpoint 生命周期与失败状态
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
index.ts      → createModel() → createSupportAgent(model, MemorySaver) → chat（thread_id）
每轮输入      → runSupportCli（按 --debug 选择展示）→ runSupportAgent → stream（新增消息 + thread_id）
agent.test.ts → fakeModel 控制响应或错误               → createSupportAgent(model) → invoke → 断言执行行为
```

以上路径共用 agent.ts 中的定义；正常和调试展示使用同一应用入口和执行层。工厂每次调用创建一个 Agent 实例；依赖注入在这里就是把模型作为函数参数传入，没有额外容器。

ChatOpenAI 负责与模型接口通信，createAgent 负责执行流程，MemorySaver 保存进程内会话状态。createAgent 内部基于 LangGraph，尚未手写 StateGraph。当前 tools 为空，没有知识库、业务操作或持久存储。

pnpm 负责多包依赖和安装，并直接启动 dev/start 交互进程；Turbo 调度 test/typecheck。test 每次执行，typecheck 可复用缓存，只缓存检查结果，不生成编译产物。

TypeScript 负责类型检查，tsx 负责运行源码。本地模块导入使用实际 `.ts` 扩展名，配置已开启 `allowImportingTsExtensions` 和 `noEmit`。当前没有 JavaScript 构建步骤。

也可以直接选择应用运行，效果与根 start 相同：

```sh
pnpm --filter @leeway-support/agent start
```

当前只创建一个可运行应用。后续逐块讨论、实现工具调用和 Agent 流程，出现实际共享需求后再提取 packages。

API 参考：[LangChain Agent](https://docs.langchain.com/oss/javascript/langchain/agents)、[ChatOpenAI](https://docs.langchain.com/oss/javascript/integrations/chat/openai)。

长期目标见 [技术方案](docs/technical-proposal.md)，其中的目录是目标规划，当前实现范围以本 README 为准。
