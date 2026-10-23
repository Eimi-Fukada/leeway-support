# 模型与工具调用限制

日期：2026-10-23。对应 D3/D4；只加入循环预算，不增加业务工具或用户配额系统。

## 问题、契约与默认策略

仅有重试次数和整轮超时，仍无法限制一次 Agent 循环经过多少模型/工具步骤。本轮装配 modelCallLimitMiddleware 与 toolCallLimitMiddleware：主模型每轮 6 次、会话 60 次；所有工具共享每轮 4 次、会话 40 次。数值是可调整的初始策略，不是性能测量或行业标准。

工厂文件在 agent/middleware，应用通过 createSupportAgent 的第四参数覆盖 `{ model: { runLimit, threadLimit }, tool: { runLimit, threadLimit } }`。只允许正安全整数且 thread ≥ run；策略来自应用代码。官方模型限制器也支持可信 runtime context 覆盖，本地 CLI 不暴露该入口，未来服务端不得透传用户提交的 context。

两者均设 exitBehavior=error。超限拒绝完成，不把框架限额文案写成 AI 成功答案；CLI 输出失败并非零退出。可能已经展示的模型片段不表示完成，也不能撤回此前工具执行。工具批次中任意调用超限时整批抛错，额度内的部分也不会执行。

## 官方机制、源码边界与替代方案

官方资料（2026-10-23 核对）：[Model call limit](https://docs.langchain.com/oss/javascript/langchain/middleware/built-in#model-call-limit)、[Tool call limit](https://docs.langchain.com/oss/javascript/langchain/middleware/built-in#tool-call-limit)。锁定 LangChain 1.5.18、LangGraph 1.5.2，无新增依赖。

实际安装版本用 stateSchema 保存计数；主模型 beforeModel 检查、afterModel 增加计数，afterAgent 清空 runModelCallCount。工具 afterModel 检查本批 tool_calls，预留获准调用数量，afterAgent 清空 runToolCallCount。thread 计数随 checkpoint 保存；摘要裁剪 messages 不等于重置独立计数字段。

因此这些计数不是精确计费：

- 模型计数在成功模型步骤后的 hook 才更新，不覆盖失败请求、内部 retry attempts、摘要模型或未来子 Agent。afterModel 的其他 hook 若失败，也不保证该模型步骤已经持久计数。测试中一次 503 后重试成功有两次模型请求，但主模型计数为 1。
- 工具计数是准入计数，不是成功业务执行数；工具失败仍可能占额度。超限 error 路径直接抛错，不保证持久记录被拒绝尝试。
- 正常完成时 run 清零；失败/超限不会保证执行 afterAgent。应用继续拒绝自动恢复未完成 thread，不在本轮强行清零或重放。
- 旧 checkpoint 缺少字段时默认从零起算，不从历史消息反推实际账单。同 thread 并发执行尚未实现原子配额；/new 换 thread 可获得新循环预算。

选择官方中间件而非自行维护计数，是为了复用状态 schema 与框架 hook。exitBehavior=end/continue 可让模型收尾，但当前自由文本完成判定容易把限制文案当作正常答案，所以选择显式失败。Graph recursionLimit 可限制图步数，不能精确表达模型/工具次数；独立持久配额账本可以管理真实尝试、跨线程和并发，但属于后续服务层范围。

## 装配与调用链

agent.ts：模型限制 → PII → 摘要 → 重试 → 工具限制。不同 hook 执行方向按框架实现，本次以测试验证行为，不把列表解释成所有 hook 都顺序执行。

runSupportAgent 提交新增消息和 thread_id → 模型限制 beforeModel → 历史 PII 与摘要 → 主模型（有条件地有限重试）→ afterModel 预算 hooks → 获准工具执行/下一模型步骤 → 正常 afterAgent 重置 run → checkpoint 保留 thread 计数。模型限额先检查，已耗尽时摘要也不再调用。

当前产品工具列表仍为空，没有添加模拟任务查询功能。工具 fixture 仅在自动测试中用于验证执行前拦截与并行批次，不进入产品装配。

## 学习对照与验证

按 AGENTS.md 检查两个候选目录，本机只有 E:/GraceProject/agent-practice 存在。已读取 model-call-limit-middleware.ts、tool-call-limit-middleware.ts；示例注释提供线索，计数时机以锁定源码与测试为准，不修改实验仓库。

本地测试覆盖每轮清零、会话累计、新 thread 隔离、模型循环截断、并行工具逐个计数/整批拒绝、工具确实未执行、失败状态、重试与摘要不计入主模型步骤、耗尽时不生成摘要、CLI 失败、旧 checkpoint 缺省字段、非法预算。

PostgreSQL 测试分别为 model/tool 启动两个独立进程，首进程消耗额度，后进程读取相同 thread 并确认超限且未执行相应能力。仅创建/删除随机 integration-limits 会话，沿用产品 public schema，不新增数据库表或演示数据库。

验证结果：`corepack pnpm test` 69/69 通过，`corepack pnpm test:postgres` 7/7 通过，`corepack pnpm typecheck` 通过，`git diff --check` 无空白错误。真实模型验证本轮未执行：计数与拦截由真实 Agent + fakeModel/无副作用工具确定性验证，没有为了触发上限反复请求供应商。真实业务集成未验证，当前也不存在业务工具。
