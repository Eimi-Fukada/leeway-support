# Leeway Support

逐步建设的智能客服系统，当前完成最小工作区、无工具 Agent 的真实问答与离线流程测试。

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

# 执行一次固定问题的模型问答，结束后退出
pnpm start

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
[agent] 正在等待模型回答……
[客服] ……
```

真实入口每次运行会请求模型并产生相应费用，自动重试已关闭，单次模型请求超时为 60 秒。开发模式继续监听源码变化，每次重启都会再次发出请求。配置缺失或接口模式不合法会在请求前报错；调用失败以非零状态退出，不输出原始请求、密钥或供应商错误内容。

## 离线流程测试

根目录运行 `pnpm test`，或者单独执行 `pnpm --filter @leeway-support/agent test`。测试使用 Node 内置测试运行器，无需新增测试框架依赖。

测试统一放在应用的 `tests/` 目录，与 `src/` 业务代码分开；TypeScript 同时检查这两个目录。`tests/agent.test.ts` 使用 `fakeModel` 控制模型返回或抛错，将它传给真实 `createSupportAgent` 并执行 `invoke`。它不导入真实模型配置、不读取 .env，也不请求模型服务。测试关注执行链路，不维护客服固定问答表。Turbo 不缓存 test，保证每次实际执行；断言失败时返回非零退出码。

当前验证三个场景：

- 用户消息和服务端提示词是否实际传入模型，回答是否写入状态，流程是否只调用模型一次后结束。
- 同一 Agent 处理不同输入时，未开启记忆的各次运行是否保持独立。
- 模型抛错是否向调用方传播，而非返回伪造的成功回答。

`respond(message)` 安排测试消息，`respond(messages => ...)` 在模型边界检查输入并生成测试返回值，`respond(error)` 注入错误。fakeModel 不理解问题，测试不证明真实模型会遵循提示词或正确选择工具；真实供应商能力另行验证。之后添加工具、中间件或结构化输出时，围绕实际流程扩展场景与断言。当前没有添加这些业务能力。

## 目录和调用链

```text
apps/agent/
  src/index.ts           应用执行入口
  src/model.ts           定义 createModel，调用时加载配置并创建真实模型
  src/agent.ts           Agent 工厂，接收模型并定义提示词和工具列表
  tests/agent.test.ts    fakeModel 流程测试：输入、结束、运行隔离、错误传播
  package.json           Agent 自己的命令和依赖
  tsconfig.json          Agent 的 TypeScript 配置
docs/                    技术方案和调研记录
package.json             根命令、pnpm 版本、Turbo 依赖
pnpm-workspace.yaml      声明哪些目录是工作区包
pnpm-lock.yaml           固定整个工作区的依赖解析结果
turbo.json               声明任务的缓存和运行方式
```

以 `pnpm dev` 为例：根 package.json → `turbo run dev` → 工作区中 Agent 的 `dev` 脚本 → `tsx watch src/index.ts` → 执行入口。

应用内的两条调用链：

```text
index.ts      → createModel() 加载配置、创建 ChatOpenAI → createSupportAgent(model) → invoke → 真实模型回答
agent.test.ts → fakeModel 控制响应或错误               → createSupportAgent(model) → invoke → 断言执行行为
```

两条路径共用 agent.ts 中的定义。工厂每次调用创建一个 Agent 实例；依赖注入在这里就是把模型作为函数参数传入，没有额外容器或运行模式分支。

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
