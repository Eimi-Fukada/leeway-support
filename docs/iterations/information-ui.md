# 补充信息的结构化输出与生成式 UI

日期：2026-10-24；关联 B4/B7、E2–E4/E7。实现现有产品的一个客服交互闭环，基于 [交互设计](../support-interaction-design.md)。

## 问题、输入、输出与失败

普通文本追问无法让页面知道需要什么字段。现在 Agent 可调用 request_information，生成 title/description/fields；fields 支持 text/textarea/select，含 key、label、required，select 另有 options。问题和选项随对话产生，组件/校验规则固定；产品版本、任务、权限等真实选项以后由业务工具提供。

普通问题仍返回文本，不强制表单，不配置每轮 responseFormat。这里的结构化输出首先是模型生成的工具参数；业务最终 structuredResponse 单独按需求加入。不会增加一个模型调用来分类所有回复。

工具参数用 Zod 校验；每轮最多一份，重复 key/选项、未知控件、未知属性、过长内容、保留名称拒绝。非法工具执行停止本轮，不无限修复。原轮正常结束且有最终正文后才发布 pending 表单；失败则作废。表单本身不是业务操作授权。

用户提交 formId/formVersion/submissionId/answers，服务端读取原规格重新校验，绑定固定开发身份和当前 thread。答案转为一条用户补充消息，沿现有流程进入下一轮；不伪造用户已提交的 ToolMessage，不引入 interrupt/resume。

相同 ID/相同答案重放已保存结果，不再调用模型；不同载荷拒绝。已接受但没有持久结果时明确结果未确认，不自动重试。新一轮普通消息使旧未提交表单失效；新会话使用新的 thread，旧表单不能跨会话提交。有效期 30 分钟，过期对外映射为 invalidated。

## 官方机制、替代与取舍

核对日期 2026-10-24：[组件作为工具](https://docs.copilotkit.ai/langgraph-typescript/generative-ui/display)、[后端工具调用渲染](https://docs.copilotkit.ai/langgraph-typescript/generative-ui/tool-rendering)、[AG-UI 事件](https://docs.ag-ui.com/concepts/events)、[LangChain 最终结构化输出](https://docs.langchain.com/oss/javascript/langchain/structured-output)。这些是官方支持的受控交互机制，不作行业占比断言。

锁定 CopilotKit 1.79.1、AG-UI client/core 1.0.2（与 CopilotKit 依赖一致）、React 19.3.1、Vite 8.3.4，沿用现有 langchain 1.5.18/langgraph 1.5.2/zod 4.6.7。

没有另建 BuiltInAgent 或 Agent Server。SupportUiAgent 是 AG-UI AbstractAgent 适配器，内部仍调用 runSupportAgent；Copilot Runtime 提供浏览器协议入口。浏览器传来的旧 messages、system、tools、state 和身份不进入模型，仅接收最后一条用户输入和经校验的提交引用，历史由服务器 checkpoint 提供。普通文本立即流出；表单工具的可见投影在本轮成功后发出，供 useRenderTool 渲染。UI 使用受控组件，不执行模型生成的 HTML/JS。

替代一是直接最终 JSON：适合真正需要最终业务结果的任务，但会改变现有文本流的消费规则；当前不强制使用。替代二是全部交互放 Graph state：可以缩小存储实现，但不直接提供提交的原子状态比较和结果幂等。采用应用表管理表单，checkpoint 继续保存 Agent 会话。替代三是 Agent Server：需要重新确定 run/thread/持久化责任，本次保留已有运行方式。以后需要后台调度、断线重连或托管部署时再比较。

## 存储、身份与并发边界

产品库 public.support_information_forms 保存：id、scope、thread_id、run_id、tool_call_id、spec JSON、status、expires_at、created_at、submission_id、submission_hash、result JSON。没有学习专用数据库/schema。程序启动自动建表与索引，数据库需预先存在并允许建表。

scope 来自 SupportContext；逻辑 thread 经既有 checkpointThreadId 隔离。创建轮和工具标识由程序取得，模型不生成身份/状态。每个 scope/thread/run 唯一；draft 只表示已创建，pending 才能提交，submitted 不等于模型回答已成功。应用在 scope/thread 上使用 PostgreSQL session advisory lock，覆盖状态检查、提交及模型执行；锁释放失败时销毁连接。此处是本地串行交互保护，不是生产任务调度/执行租约。

表单不单独存答案原文；提交哈希用于幂等，校验后的答案组织为用户消息后经过既有 PII 清理。已知密码/API Key/Bearer 形态拒绝提交。表单标题/说明等在存储前复用 PII 清理。没有声称识别所有敏感数据；模型输出/checkpoint 的既有保护边界仍存在，表单/result 的保留期和删除策略尚待制定。

服务只监听 127.0.0.1:3100，检查同源 Origin/Host，身份由启动参数 --user 固定提供。它是可运行的开发入口，尚无业务登录、生产授权或外部 SDK。Vite 不读取应用 env，不向浏览器注入模型/数据库密钥；CopilotKit 的线程/记忆服务未用来替代现有 PostgreSQL。

## 源码与实际调用链

- src/interactions/contracts.ts：两端共用的数据契约与答案校验，不能导入服务端配置。
- src/interactions/agent.ts：request_information 工具及错误传播保护。
- src/interactions/service.ts：数据库记录、会话锁、有效期、接收及结果幂等。
- src/agent/agent.ts：显式装配新工具，沿用模型/工具预算与中间件。
- src/agent/run.ts：持锁、检查会话、接受提交、执行原 Graph、完成/作废表单。
- src/ui/adapter.ts：把已有流和有效表单映射为 AG-UI 事件。
- src/ui/server.ts：本地同源 Runtime、表单状态读取、Vite 开发页面与资源释放。
- web/InformationForm.tsx：预写的输入/选择组件，校验并提交，历史卡片重新核对状态。
- web/App.tsx：CopilotChat 与 useRenderTool；普通文本仍由聊天组件处理。

页面 → Copilot Runtime → SupportUiAgent → runSupportAgent → 既有 Graph/记忆/工具循环 → InformationService 保存 draft → 主回答完成 → pending → AG-UI 工具结果 → 表单组件 → 用户提交 → 服务端读取规格/校验/原子接受 → 同 thread 新一轮 → 保存结果。

CLI 同样装配该工具，把有效规格展示成可读问题；用户直接用文字补充。CLI 与页面使用同一 local-development/local-cli 身份范围，开发用户 ID 相同即可共享长期记忆；页面刷新/新会话不清空该用户长期记忆。

## 运行与验证

```sh
corepack pnpm install
corepack pnpm ui -- --user alice
# 浏览器：http://127.0.0.1:3100

corepack pnpm start -- --user alice --debug
corepack pnpm test
corepack pnpm test:postgres
corepack pnpm typecheck
corepack pnpm build
```

可输入“软件打不开，请用表单询问使用环境和错误现象”，观察模型按需产生的字段及选项；它是手动验收输入，不是代码中的关键词匹配或固定问答。普通问候不必产生表单。

确定性测试新增 6 个：契约/答案边界、普通问题零表单、实际工具循环与内部 JSON 不展示、CLI 同规格展示、失败作废、并行冲突和 AG-UI 输入边界。真实 PostgreSQL 新增 2 个：提交后继续会话、仓储重建后的幂等结果、归属/非法选项/修改拒绝、过期/旧表单、未确认执行、并发锁与异常释放；仅清理随机 integration-form 范围的记录。完整本地测试 85/85、真实 PostgreSQL 12/12、类型检查和客户端构建通过，git diff --check 无空白错误。

真实模型与浏览器：已完成请求表单 → 模型生成桌面端/浏览器/其他选项及错误现象字段 → 选择浏览器、填写现象 → 提交 → 同会话模型正确引用补充内容继续排查。表单随后显示资料已接收并禁用；浏览器无 error，移动 390px 无横向溢出。一次成功样例不代表自然追问质量、所有模型/供应商或业务操作已验收。

构建通过；CopilotKit 默认聊天/Markdown 渲染依赖使客户端包较大，仍是调试页，尚未针对嵌入 SDK 优化体积。业务集成、自动后台恢复、持久消息队列、浏览器重连恢复、复杂图表/布局、确认执行和记忆操作结果卡片均未实现。

## 学习对照

本轮检查两个候选路径，存在并读取 E:/Projects/agent-practice 的 generative-ui/contracts.ts、structured-output/contracts.ts 和 copilotkit-demo 组件/运行方式。复用机制和学习方法，未导入其源码、依赖或教学订单；本项目保持原 LangGraph Agent，不采用实验里的 AI SDK BuiltInAgent。表单工具本身是产品交互能力。
