# Leeway Support

逐步建设的智能客服系统，当前完成 pnpm workspace + Turborepo 最小工作区。

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
# 启动开发模式，修改 Agent 源码后自动重新执行；Ctrl+C 退出
pnpm dev

# 执行一次启动入口，输出启动信息后退出
pnpm start

# 检查 TypeScript 类型，不生成 JavaScript 文件
pnpm typecheck
```

启动输出：

```text
[agent] Leeway Support Agent 已启动。
```

当前入口只打印启动信息；开发模式由 tsx watch 继续监听文件变化。

## 目录和调用链

```text
apps/agent/
  src/index.ts           应用执行入口
  package.json           Agent 自己的命令和依赖
  tsconfig.json          Agent 的 TypeScript 配置
docs/                    技术方案和调研记录
package.json             根命令、pnpm 版本、Turbo 依赖
pnpm-workspace.yaml      声明哪些目录是工作区包
pnpm-lock.yaml           固定整个工作区的依赖解析结果
turbo.json               声明任务的缓存和运行方式
```

以 `pnpm dev` 为例：根 package.json → `turbo run dev` → 工作区中 Agent 的 `dev` 脚本 → `tsx watch src/index.ts` → 执行入口。

pnpm 负责多包依赖和安装；Turbo 负责调度各包的任务。dev 和 start 每次真实执行，不缓存；typecheck 可复用缓存，只缓存检查结果，不生成编译产物。

TypeScript 负责类型检查，tsx 负责运行源码。本地模块导入使用实际 `.ts` 扩展名，配置已开启 `allowImportingTsExtensions` 和 `noEmit`。当前没有 JavaScript 构建步骤。

也可以跳过 Turbo，单独运行应用以排查问题：

```sh
pnpm --filter @leeway-support/agent start
```

当前只创建一个可运行应用。后续逐块讨论、实现模型调用和 Agent 流程，出现实际共享需求后再提取 packages。

长期目标见 [技术方案](docs/technical-proposal.md)，其中的目录是目标规划，当前实现范围以本 README 为准。
