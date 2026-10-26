# 用户可见会话档案、普通消息幂等与结果核对

日期：2026-10-25。按用户授权完成原计划中的 A2/A3，沿当前 Agent/UI/CLI 和补资料暂停链路增强，不增加另一套 Agent 运行时。

## 问题与范围

原 GET /api/conversation 只返回等待状态，刷新后看不到历史；最新 checkpoint.messages 还会被摘要改变，不能充当完整聊天档案。普通消息没有持久接收标识，网络重发可能再次执行；表单已有幂等，但接受答案和 Graph 完成不在同一事务中，存在结果未知窗口。

本轮增加独立的消息/请求账本、稳定 ID、匹配 checkpoint 的完成回执和只读核对。恢复当前会话的用户可见消息与当前表单，不做全会话管理、历史分页、Graph 分支或流事件重放。

## 机制、替代与职责

官方资料（2026-10-25 核对）：[LangGraph Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)、[Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)。项目仍使用 LangChain 1.5.18、LangGraph 1.5.2、原 PostgreSQL；未新增依赖。

常见方法是在应用层持久保存用户可见消息，以 idempotency key 记录接收/完成结果，框架 checkpoint 负责执行恢复。单纯读取最新 messages 会漏掉摘要替换的早期内容；扫描所有 checkpoint 重建聊天容易混入系统/工具/摘要、分支和重复消息，因此不作为本轮档案实现。Agent Server 的托管会话能力是另一种整体方案，但会改变现有自管运行/存储边界，本轮不迁移运行时。

新增 public.support_conversation_requests：scope/thread/request ID 联合唯一，包含原载荷 hash、逻辑 run ID、状态、结果、接收顺序和历史完整标记。新增 public.support_conversation_messages：scope/thread/message ID 联合唯一，保存 user/assistant 文本和顺序。启动 setup 在事务锁内创建表；不存在演示数据库或 practice schema。

普通 user message ID 作为稳定请求 ID；表单恢复为 submissionId。浏览器的 assistant ID 统一为 assistant-<requestId>，档案与流使用同一显示标识。CLI 每个明确输入动作生成一次 ID，失败不自动重试。普通请求 hash 在原问题 PII 清理前计算但不保存原文，避免两个不同邮箱清理后被当成同一载荷；表单 hash 规范化答案 key 顺序、表单版本、interrupt ID 与取消状态，不接受用户替换身份。

## 执行与归档

```text
客户端稳定消息 ID + 新问题
→ 服务端身份/会话锁
→ 查请求：同 ID 同载荷返回持久结果；不同载荷拒绝
→ 新请求事务保存 running + 已脱敏用户消息
→ 原 runSupportAgent/Graph/工具/interrupt
→ 正常 afterAgent 写匹配 requestId/runId 的 checkpoint 回执
→ 事务保存 completed + 最终客服消息，或 waiting_for_input + 表单结果
→ 原 AG-UI 流；刷新从档案读取
```

只保存程序接受的用户内容和正常完成后的最终 AI 文本；模型中间片段、系统提示词、内部摘要、工具参数/JSON 结果不转为聊天消息。补资料提交以保存规格的标签和答案构成人类可读摘要，取消以明确取消文本记录。它是可见提交档案，不额外添加 HumanMessage 到执行状态；补资料仍通过 Command.resume 返回 ToolMessage。

独立档案不随摘要修改，原始长对话可以显示；这是从本功能上线后开始记录的历史。旧 checkpoint 没有档案时不伪造完整历史，首次继续时保存 history_complete=false，后续仍提示只显示已归档部分。没有自动认领其他用户的 thread，也没有从 checkpoint 抽取隐藏状态回填 UI。

## 幂等、状态与结果未知

现有 InformationService.withThread 的 PostgreSQL session advisory lock 覆盖查重、准入、Graph 执行与结果落库；并发请求拒绝，不额外建队列。正常接收/用户消息是一个事务，完成结果/客服消息是另一个事务；后者失败不会留下半条成功回答。请求 ID 不只是前端按钮禁用。

2026-10-25 审查后修复：锁改用有界专用连接，避免持锁耗尽业务池；请求保存 message/resume/legacy 类型，旧暂停点不能确认新恢复请求；表单读取失败显式拒绝返回成功快照。详见 [运行可靠性修复](runtime-reliability-fixes.md)。下文的暂停对账仅适用于明确记录为 message 的普通请求，旧记录不猜测类型。

普通消息/表单提交沿一份账本处理，表单仍保留原幂等结果作为产品交互事实。相同已完成请求重放不调用模型或再次写记忆。初始请求的等待表单若已被后续提交处理，不重新发布旧 interrupt，而是要求读取当前会话记录。处理记录中的 waiting_for_input 是该次提交当时的结果，整体当前状态取最新请求；不将它误解释成存在第二个未处理表单。

显示状态包括 empty、running、waiting_for_input、completed、failed、unknown。锁仍被执行持有时，GET 只读取档案返回 running；不会把尚在工作中的请求判为崩溃或抢占执行。锁释放后，核对 running/unknown 请求：

- checkpoint 无后续任务/错误/interrupt，且 afterAgent 回执的 requestId 与逻辑 runId 都匹配：补写持久答案，必要时补齐表单 submission 的结果账本。
- 普通 message 请求的 checkpoint 有合法且匹配逻辑 run 的单个补资料 interrupt：对账同一表单，保存 waiting_for_input。resume/legacy 不使用旧暂停作为本次执行证据。
- checkpoint 记录明确任务错误：标 failed，不自动重试；此前写入记忆等副作用不回滚。
- 只有接收记录、没有匹配完成/暂停证据：标 unknown，不猜测成功，不以原 ID 或新 ID 自动续跑同一 thread。

旧请求的回执不能证明新请求成功；查询不会运行 Graph、模型或工具。补写后结果带 reconciled=true；原 elapsedMs 无法确定，保留数值 0 为现有契约占位，不当作真实耗时，CLI 明确显示原耗时未知。

这不是消息账本和 checkpoint 的跨库原子事务，也不是 exactly-once 业务副作用保证。缺乏可靠证据的中断仍需要人工核对或显式新建会话，不能让用户无限盲点“重试”。当前没有真实业务写工具；未来动作的执行回执与核对仍须由业务后端提供。

## UI、刷新与未确认发送

GET /api/conversation 按可信身份和 thread 返回严格校验的消息/状态投影，不暴露内部 receipt、scope、hash、系统消息、工具或错误堆栈。浏览器在非执行状态用持久消息替换显示，刷新不会重新请求模型。等待表单照常从产品表恢复；pendingInterrupts 与服务器状态对齐，已处理表单不留下客户端幽灵 interrupt。

新增“核对状态”、可展开的处理记录、failed/unknown 提示；running 时只轮询状态，不重新发起消息。对失败/未知会话禁用继续输入，保留核对与新会话操作。历史片段不作为成功消息保存；失败后服务器档案可能只含用户请求和状态，不包含已输出但未完成的片段。

普通待发送消息在 sessionStorage 临时保存 ID/内容，按当前开发身份与 thread 隔离。服务器未确认接收且会话处于 empty/completed 时，可显式“重发原消息”，复用原 ID；失败请求没有自动重发。该标签页暂存并非服务器接收凭据，可能包含用户原文，不是长期聊天存储；关闭标签页可能丢失。表单 submissionId 也在标签页刷新间复用。同一 ID 改答案仍会拒绝，避免覆盖已接受提交。

当前客户端完整读取该会话档案，未实现分页或跨会话列表；旧消息保留/导出/删除、持续流事件日志及运行中重连续流留待后续。生产认证也仍未实现，本地入口继续要求 --user。

## 代码与学习覆盖

- conversations/contracts.ts：纯前后端投影、请求 ID、状态与安全错误。
- conversations/service.ts：PostgreSQL 请求/消息事务与持久状态。
- conversations/receipt.ts：正常 afterAgent 写完成回执，明确声明 contextSchema 读取该请求身份。
- conversations/execution.ts：已有锁内的幂等准入、只读核对和用户可见快照。
- agent/run.ts：原流程可选接入账本，生产 CLI/UI 始终装配；测试对照可不注入。
- ui/adapter.ts：稳定 user/assistant ID；忽略客户端伪造状态和历史。
- ui/server.ts、web/App.tsx：读档案、刷新恢复、状态核对与未接收消息显式重发。
- interactions/service.ts：由完成回执修复表单结果账本，不重新接受答案。

按约定检查两个实验目录，本轮存在并使用 E:/GraceProject/agent-practice 作为历史/重连机制对照；当前工程使用应用档案与原 Graph，不复制 Agent Server 的托管历史假设或另建数据库。评估入口也注入相同请求/档案服务，并清理本次 eval 范围的新表记录。

## 验证

确定性测试覆盖重复请求零模型/零记忆重放、不同载荷拒绝、摘要后完整归档、失败无成功消息、已完成但档案丢失的修复、接收窗口 unknown、旧回执不误匹配、新身份隔离、旧档案完整性提示、补资料与稳定 AG-UI ID。

真实 PostgreSQL 验证事务/新仓储重放、并发锁与 running 查询、unknown 拒绝盲重试、表单结果账本修复；两个独立进程验证完成回执跨重启恢复且不调用模型。只清理 integration-history 随机身份与线程。

真实模型浏览器验证：普通回答刷新前后完整一致；表单暂停刷新后保留原问题与表单；填写后答案/补充资料刷新恢复。网络故障注入分两种：请求未到服务器前中断，刷新后手动复用原 ID 重发；服务器已完成但响应丢失，通过 GET 找回答案，再用相同 ID 提交返回持久结果，消息/请求数量未增加。另用本轮隔离身份模拟无 checkpoint 证据的接收记录，页面显示“结果待核对”、禁用继续输入，390px 无横向溢出。

验证结果：pnpm test 114/114、pnpm test:postgres 18/18、pnpm typecheck、pnpm build 全部通过；git diff --check 无空白错误。客户端仍有此前大 chunk 提示，未扩展为打包优化任务。

浏览器测试归属下核对 5 次实际主模型步骤、1 次表单工具准入；响应丢失后的重放没有增加计数。已清理该身份的 6 条请求（含 1 条人为模拟的 unknown）、10 条可见消息、表单、记忆与 checkpoint；临时服务已关闭。无故障注入时的页面恢复正常，网络错误日志来自明确的测试中断。

真实模型样例验证开发链路，不代表线上身份或业务副作用验收。故障注入与存储异常覆盖以程序断言为依据，不能用模型“已完成”的文字证明状态。后续可进入真实资料的知识入库/检索切片，生产身份交换和数据保留策略仍需在真实业务接入前验收。
