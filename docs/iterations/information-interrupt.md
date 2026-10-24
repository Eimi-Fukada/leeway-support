# 在现有补资料表单中持久暂停与恢复

日期：2026-10-25。范围：增强现有 request_information、表单存储、CLI、AG-UI 和 CopilotKit 组件，不新建第二条补资料流程，不增加 Deep Agents。

## 问题与结果

此前工具创建表单后返回，模型继续输出正文并完成本轮；页面提交再变成新的 HumanMessage。等待依赖提示词，Graph 没有被真正暂停。本轮工具改为创建表单 → interrupt → 等待用户提交/取消 → 恢复后返回 ToolMessage → 模型继续。

执行结果显式区分 status=completed 和 waiting_for_input；失败仍抛异常。等待结果可以没有最终正文，不能打印“完成”或把上一轮回答当本轮结果。网络请求结束不等于逻辑任务完成。表单规则、text/textarea/select 组件与服务端校验沿用已有实现。

## 官方机制与选择

官方核对（2026-10-25）：[LangGraph Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)。使用锁定的 LangGraph 1.5.2、LangChain 1.5.18，未新增依赖。interrupt 通过框架控制信号保存 checkpoint 并暂停，不冻结 JavaScript 调用栈或长期持有 HTTP 请求；Command.resume 在相同 thread 的暂停点重新进入节点，之前的代码会重新执行。

选择工具内部 interrupt，而不是对原“创建表单”工具直接配置 interruptOn：后者默认会停在创建之前，当前要表达的是“等待并取得用户资料”。同一工具恢复后返回 answered/cancelled 结果。工具错误包装必须原样重新抛出 GraphInterrupt，不能把控制信号变成错误 ToolMessage。

替代方案是 HITL 中间件的 ask-user/respond 模式，或显式 StateGraph 等待节点。它们适用于不同装配方式，本轮不为了 API 名称改用另一条工具链，也没有把答案伪装成工具参数审批。

## 调用链与状态

```text
用户问题 → 原 runSupportAgent → 模型调用 request_information
→ 幂等创建 draft → interrupt({kind, formId, runId}) → PostgreSQL checkpoint
→ 识别任务 interrupt ID → 表单 pending → waiting_for_input → 原表单组件
→ 用户提交/取消 → 服务端身份/会话/表单/interrupt/有效期/答案校验
→ Command({resume: {[interruptId]: verifiedReply}})
→ 原工具重进、复用原表单 → 再次校验 → ToolMessage → 模型继续 → completed
```

逻辑 runId 在等待与恢复之间保持一致；每段实际模型执行仍有新的追踪 run ID，metadata.logical_run_id 用于关联。恢复不提交新的 HumanMessage，也不调用 begin 使原表单作废。等待不执行 afterAgent，原模型/工具 run 预算随 checkpoint 保留；最终正常结束才重置。测试确认模型计数跨等待为 1→2，工具准入计数仅为 1，恢复不再计一次表单工具请求。

一个逻辑任务最多一份表单，不允许与记忆或其他工具组成并行批次；afterModel 在实际工具执行前拒绝混合/多表单调用，避免另一个写操作越过等待点。多阶段多表单将是单独切片。

## 幂等、校验与恢复窗口

产品表 public.support_information_forms 增加 nullable interrupt_id，启动 setup 自动补列，不新建数据库/schema。创建以 scope/thread/原 runId 唯一，只有同 toolCallId 和相同规格可重入；恢复不会重建另一张表单，也不会重置 30 分钟有效期。

执行入口只恢复单个已识别的 information 暂停点；失败任务、未知 interrupt、多个 interrupt 和无明确暂停点的未完成步骤继续拒绝自动执行。提交必须匹配服务端保存的表单、版本、interruptId、身份范围与 thread。答案在进入 resume checkpoint 前经过既有 PII 处理，恢复工具再按原规格验证；客户端不能直接选择任意 Graph resume 值。

提交接收和结果记录保留原有幂等语义：相同 submissionId/规范化答案可重放已保存的结果，不再运行模型；修改答案、错误 interrupt、旧/过期表单拒绝。已接收但结果未确认时不自动重放。表单事务和 Graph checkpoint 不是跨库原子提交，崩溃发生在“接受答案”和“恢复完成”之间时仍可能需要人工核对，不将其自动判为成功。

checkpoint 已保存 interrupt、但进程尚未来得及把 draft 发布为 pending 时，可由后续只读恢复入口根据 checkpoint 的 formId/runId/interruptId 对账并发布同一表单。跨进程测试主动模拟该窗口；不能据此宣称任意执行失败均可安全自动恢复。

会话 advisory lock 只覆盖校验/接受/模型执行这一段，返回 waiting 时释放。等待无需保持连接。观察中断仍沿用取消当前网络执行的策略；已提交的记忆/其他写入不回滚。已持久暂停不因页面关闭而自动执行或取消。

## 页面与 CLI

AG-UI 继续使用原 SupportUiAgent，补充 RUN_FINISHED.outcome=interrupt 以及 support.status 事件，区分一次网络运行结束与任务完成。表单提交同时携带 AG-UI resume 描述与原 informationSubmission；服务端验证二者一致，真正 Graph resume 值仍由服务端构造。

浏览器按本地开发身份在 localStorage 只保存逻辑 thread ID，页面刷新 GET /api/conversation 读取服务器等待态，显示同一个 InformationForm；不调用模型、不替用户提交。该入口只有状态读取/已知暂停点对账，不重新生成历史。React StrictMode 可能造成被取消的状态请求短暂持锁，客户端仅对 HTTP 423 的只读 GET 做最多 4 次、间隔 200ms 的查询；模型与提交请求不因此自动重试。

等待时禁用聊天输入框并展示“等待补充资料”；服务端也拒绝普通新消息绕过暂停。保留表单填写/取消两个入口；“新会话”显式换 thread，不删除旧等待 checkpoint。过期表单显示失效，用户可新建会话，Graph 不自动跳过过期暂停点。旧版没有 interrupt_id 的表单不冒认成新版可恢复请求。

CLI 复用同一逻辑：暂停时打印字段 key 和选项值，不打印最终完成；`/submit {"字段key":"答案"}` 提交、`/cancel` 取消；--thread 可以读取并继续等待表单。/exit 或 EOF 只离开终端，不删除暂停状态。当前格式/执行异常仍按现有 CLI 失败退出语义处理。

## 长期记忆与证据

补资料答案成为 ToolMessage，不再是新 HumanMessage。信息工具输出绑定 submissionId 与经验证的答案/选项标签；记忆工具只在本轮 HumanMessage 之后寻找程序生成的 request_information answered 结果作为用户证据来源。取消结果不充当新答案。数据库与记忆权限仍由可信 SupportContext 确定，不从表单或模型参数获得身份。

记忆/其他工具结果不投影为客服正文；内部工具 JSON 不展示。模型实际回复仍可能不准确，程序不声称已经验证所有自然语言结论。

## 验证与学习对照

按 AGENTS.md 检查两个实验目录，本轮使用存在的 E:/GraceProject/agent-practice，读取其 hitl-agent.ts 中的 askUser interrupt/resume 机制。没有复制退款 demo，也没有修改实验仓库或另配数据库。

本地确定性测试覆盖真实 Agent 在表单工具后停止、无额外模型调用；恢复后 ToolMessage/用户消息数量、原表单幂等、取消、CLI 提交、普通输入不能绕过、AG-UI 客户端 pendingInterrupts/resume、混合批次零执行、失败不伪成功、预算连续、未知暂停拒绝、表单来源进入记忆。

真实 PostgreSQL 验证表单过期/归属/错误 interrupt/重复提交/结果未知、会话锁释放；两个独立进程验证暂停 checkpoint 恢复且不重复建表单，模型和工具预算保留。测试只创建和清理随机 integration-form 范围。

真实模型浏览器验收：提出环境/错误现象表单后暂停；页面刷新及服务重启后同一表单仍可填写；填写 Windows 11/2.0/ERR-TEST 后模型据此继续；另两次流程取消后返回信息不足，输入框恢复。等待时普通输入框禁用。390px 视口无横向溢出。测试开发身份的数据在验收后清理。一次样例不能代替真实业务身份/业务操作验收。

验证结果：pnpm test 91/91、pnpm test:postgres 13/13 通过，pnpm typecheck 与 pnpm build 通过，git diff --check 无空白错误。构建仍有此前 CopilotKit 客户端大 chunk 提示，未在本轮扩大为打包优化任务。真实模型/浏览器验证填写、刷新/服务重启、取消流程；数据库核对三个测试流程全部 submitted 且 completed、每个只有一条 HumanMessage 和一次表单工具计数，已清理测试数据。

未实现生产登录/正式 SDK、运行中断流自动续跑、完整聊天历史重放、多阶段表单及业务操作审批；这些不随本轮自动授权实现。
