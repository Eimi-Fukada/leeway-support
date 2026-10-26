# 现有客服应用迁移到 Next.js

日期：2026-10-26。关联学习点：E/F、HTTP 接口与客户端/服务端职责。范围是现有应用运行框架迁移，页面与 API 随一个 Next Node 服务构建、启动，不增加独立后端部署。

## 解决的问题与契约

原 ui/server.ts 同时装配模型/数据库、手写 pathname 路由、响应请求并启动 Vite。接口增加后定位和维护不便，生产构建也只有客户端静态产物。按用户确定的统一技术栈，改用 Next App Router 的页面和 Route Handlers。

保留 /api/session、/api/conversation、/api/information/:id、/api/copilotkit 下的协议。普通输入仍经稳定 requestId 接入原 Agent；表单提交仍是原 Command.resume，GET 历史不运行模型或工具；failed/unknown 不自动重放。无效会话参数现在明确返回 400，未支持的 HTTP 方法由框架返回 405。读取状态失败仍返回安全错误并使界面禁用普通输入。

身份继续来自服务端开发配置，当前服务绑定 127.0.0.1:3100，并保留 API Host/Origin 校验。这次框架迁移没有实现生产业务登录、跨域嵌入授权或正式 SDK。

## 官方机制与版本核对

2026-10-26 核对官方一手资料及本地发布包：Next 16.4.3、React/ReactDOM 19.3.1、CopilotKit 1.79.1；LangChain、LangGraph、pg 版本保持原配置。

- [Vite 迁移指南](https://nextjs.org/docs/app/guides/migrating/from-vite)：由 app/layout.tsx 和 page.tsx 接管 HTML 与 React 启动，浏览器交互放在客户端组件。
- [Route Handlers](https://nextjs.org/docs/app/getting-started/route-handlers)：按文件路径与 HTTP 方法分发，使用标准 Request/Response，动态参数使用当前版本的异步 params。
- [服务端外部依赖](https://nextjs.org/docs/app/api-reference/config/next-config-js/serverExternalPackages)：Node SDK 保留原生模块解析，数据库与模型代码不进入客户端。
- [Copilot Runtime](https://docs.copilotkit.ai/strands/copilot-runtime)：当前安装包的 createCopilotRuntimeHandler 返回标准 Fetch handler，直接挂到 Next catch-all Route Handler，无需额外 Hono 适配。
- [Next 自托管](https://nextjs.org/docs/app/guides/self-hosting)：页面与接口可在同一个 Node 服务运行，支持流式响应。反向代理需实际允许流式传输，本轮只验收本机直连。after 在响应完成后执行追踪提交，不在取得流 Response 时提前刷新。

这是本项目选型依据，不据此声称 Next 在所有 Agent 系统中占比最高或性能最优。

## 替代方案与取舍

保留 Vite 并提取原生路由或引入 Hono，也可以在一个服务中部署，并非必然前后端两套服务。但用户已决定后续应用统一 Next；继续维护两类 Web 运行方式没有当前收益，因此直接迁移。

不采用静态导出，因为当前应用需要 Node 数据库连接和流式 API。也不在每个 route.ts 内重复创建模型、池和 Agent：server/runtime.ts 懒初始化并缓存 Promise，解决并发首请求重复初始化及开发热更新重复建池。代价是开发时改 Agent 装配/配置后需要重启 Web 服务，避免把旧 Agent 当成已热更新。进程间仍通过 PostgreSQL 持久化与会话锁协作，globalThis 不是共享数据库或业务身份认证。

本轮先按同一个 Next Node 应用部署，不设置 Edge 运行时，也不拆 worker。以后确有独立后台任务或扩缩容需求，再单独定义持久执行与部署契约。

## 实际调用链与源码

```text
node scripts/ui.mjs --user alice
  → 官方 next dev（或 --production → next start）
  → app/layout.tsx + page.tsx
  → components/SupportChat.tsx / InformationForm.tsx
  → app/api/*/route.ts：本机访问校验、参数与响应
  → server/runtime.ts：服务端开发身份、模型、pool、saver、记忆、表单、档案、Agent
  → 原 SupportUiAgent → runSupportAgent → Graph/工具/checkpoint
```

- 页面和 API 保留在 apps/agent，同一份 package.json、同一 Next 服务。删除 Vite、main.tsx、index.html 和手写 HTTP 服务器。
- server-only 阻止服务端资源模块进入客户端；客户端仍只导入纯 Schema/交互契约。布局引入原 CopilotKit 与产品全局样式，界面功能不重做。
- Web 由 Next 自动加载应用环境文件；CLI/评估/测试仍通过原 env.ts 读取 .env，避免编译 chunk 路径误定位配置文件。环境已有值优先。
- scripts/ui.mjs 只校验 --user 并启动官方 Next CLI，不创建 HTTP 服务器。使用普通 Node JS，生产启动不依赖 tsx；--user 被传成服务端 SUPPORT_DEV_USER。
- 全部 API 禁止缓存；会话和表单接口显式 force-dynamic。CopilotKit 流原样返回 body，增加 X-Accel-Buffering: no，不收集为完整文本后再返回。
- 初始化失败清理已创建资源并清除缓存 Promise。正常 Next 进程的监听与退出由框架管理，连接池随进程生命周期保留；请求完成用 after 等待追踪提交。
- TypeScript 使用 Bundler 解析和 Next 插件，typecheck 先 next typegen，支持尚未执行 build 的检出。显式 allowJs=false，避免 Next 建议值使 tsx 错选第三方包内不完整的 TS 源文件。追踪配置参数改为只读环境映射，避免与 Next 对 ProcessEnv.NODE_ENV 的全局类型增强耦合。
- 测试接收端识别客户端已中断的上传，避免超时故障注入产生未处理 ECONNRESET；不吞掉其他读取错误。

已检查两个实验路径：E:/GraceProject/agent-practice 存在，E:/Projects/agent-practice 不存在。实验仓库 basic-chat、generative-ui 和 hitl 提供现有交互对照，未发现 Next 应用。本轮直接通过产品迁移、官方资料和回归完成该知识点，不新增演示程序、数据库或跨仓库源码导入。

## 运行与验收

仓库根目录：

```sh
corepack pnpm install
corepack pnpm ui -- --user alice

corepack pnpm build
corepack pnpm ui:start -- --user alice
```

开发与生产启动选一个，均打开 http://127.0.0.1:3100。直接使用 Next CLI 时需要配置服务端 SUPPORT_DEV_USER 并保持当前监听地址/端口。原 CLI 的 pnpm dev/start、--thread/--debug 与评估命令保留，不要求先启动 Web。

确定性验证：pnpm test 122/122，pnpm test:postgres 21/21，pnpm typecheck 与 Next 生产 build 通过。新增 HTTP 检查覆盖外部 Host、外部/不透明 Origin 拒绝，以及成功/错误 JSON 禁止缓存。pnpm eval:behavior -- --list 可离线列出原 24 场景，本轮没有重新执行完整真实模型评估。

真实模型与浏览器：在 Next 生产服务完成普通回答、刷新恢复、表单暂停、刷新同一表单、提交恢复及最终答案恢复。重复表单提交后仍为 5 条可见消息、3 条请求，checkpoint 的 threadModelCallCount 保持 3。另一次真实流请求收到 68 个文本事件，首文本约 1906ms、RUN_FINISHED 约 2681ms，证明本机直连在完成前传递片段；同 ID 重放返回单条持久答案，符合既有幂等语义。390px 视口没有横向溢出，生产浏览器无错误/警告。

随后停止生产进程，用 Next 开发服务读取同一 PostgreSQL 历史，原答案恢复成功；开发模式只有依赖既有 Lit 开发提示，无浏览器错误。API 实测包括 session、conversation、CopilotKit info、无效 thread=400、错误 Origin=403、不支持方法=405，成功/业务错误响应禁止缓存。静态客户端 JS 扫描未发现当前模型 Key、数据库连接串或追踪 Key 的实际值（不打印值）。

失败路径另用不可连接的数据库地址启动同一个生产构建：历史接口返回 409、CopilotKit info 返回 503，再次请求仍是明确错误；响应不含连接串、底层异常或凭据，不降级到内存。缺少 --user 的启动在创建服务前拒绝。

本轮隔离身份累计验证 4 个真实主模型步骤。完成后仅清理该身份的 2 个 thread checkpoint、7 条消息、4 条请求、1 张表单；没有产生长期记忆操作。临时验证脚本和测试服务已清理，未改写其他身份数据。

真实业务集成：未执行，仍无业务写工具。Next 生产构建与本机运行通过，不代表公网身份、宿主嵌入、代理流配置和实际业务副作用已验收。
