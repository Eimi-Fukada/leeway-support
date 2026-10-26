# 现有执行链的运行可靠性修复

日期：2026-10-25。范围：修复审查发现的四个问题，复用原 Agent、表单 interrupt、请求账本与消息档案，不新增执行路线。关联学习点：A2/A3、D7、F、G3。

## 问题、输入输出与失败行为

1. 原 withThread 从业务池取连接并持锁到执行结束，执行中又从同一个池查询。默认五个并发会话耗尽五连接，内部查询全部超时。现在专用物理连接持锁，业务池继续供内部查询使用；锁连接并发满时立即拒绝，执行结束关闭连接并释放名额。
2. 补资料恢复沿用原逻辑 runId。请求接收落库后、accept/resume 前中断时，原 interrupt 被误当成本次恢复的等待回执，导致重复提交永远只返回等待。现在记录 message/resume，只有 message 可用匹配原逻辑任务的暂停点对账；没有匹配终态回执的恢复请求返回 unknown，不自动执行。
3. 原重试层在记忆 wrapModelCall 外，模型 503 被框架包装后无法识别。现在记忆在重试外层，实际模型 handler 位于内层；本来符合有限重试条件的模型故障仍尝试一次，记忆读取仅一次，存储故障直接停止。已有片段后不重试、预算与 SDK maxRetries=0 策略保留。
4. 原快照吞掉表单存储错误，可能返回没有表单的等待态；前端仅根据表单对象禁用输入，出现能输入却一直被后端拒绝。现在读取表单失败明确抛安全错误，HTTP 入口返回 STATE_UNAVAILABLE；页面核对失败禁用输入。状态门禁进一步限定只有 empty/completed 可输入，waiting 即使没有表单也不能提交普通消息。

历史恢复与状态核对的调用链是浏览器 GET /api/conversation → 服务端可信身份 → 会话锁/运行中只读分支 → 请求与消息档案 + graph.getState → 前端投影。getState 只读取 checkpoint；不会 invoke/stream、调用模型或再次执行工具。必要时服务端补齐已被 checkpoint 证明的结果记录，所以这不是数据库层面完全无写入的查询。只有新问题或用户明确提交/取消表单，才进入模型执行/Command.resume。

## 机制、一手资料与版本

本项目锁定 langchain 1.5.18、langgraph 1.5.2、checkpoint-postgres 1.1.2、pg 8.23.1。以下官方资料于 2026-10-25 核对，具体装配行为以本地依赖和回归测试为准，不据此推断行业占有率。

- [node-postgres pooling](https://node-postgres.com/features/pooling)：池连接需要释放，持有全部连接时后续申请无法完成。
- [PostgreSQL advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS)：session 锁绑定数据库会话；持锁与解锁使用同一物理连接。
- [LangChain custom middleware](https://docs.langchain.com/oss/javascript/langchain/middleware/custom)：wrap 钩子包围 handler，可控制调用次数；外层/内层决定错误和重试经过哪些操作。

请求类型与匹配回执是应用的准入和恢复协议，框架 checkpoint 不自动替应用判断某次 HTTP 提交是否执行。失败关闭输入也是应用职责，不能靠模型描述当前状态。

## 替代方案与取舍

锁可以使用独立连接池、事务行锁或带 fencing 的执行租约。本轮采用有界短生命周期专用连接，保留已有 session 锁语义，避免新增锁池初始化/关闭契约；代价是每次加锁有建连开销，未做性能比较。每个业务池当前最多五条锁连接，另有最多五条业务连接和独立 checkpoint 池；不是多实例的总连接配额。高频访问确有瓶颈时再比较专用锁池；需要在网络分区后阻止失锁旧执行继续产生副作用时，应引入执行租约/fencing，当前连接锁不提供该保证。

恢复请求也可新增一个精确的“已恢复”持久阶段，再与 checkpoint 原子协同；本轮没有这一证明协议，选择 unknown。仅递归解包 MiddlewareError 的方案会模糊模型错误与其他中间件错误的重试边界，因此本轮通过包裹顺序限定重试目标。表单失败时可返回降级快照和专门的错误投影，但当前完整快照契约选择明确失败，读服务恢复后由用户核对，不静默丢表单。

## 实践与兼容

已检查实验目录：E:/GraceProject/agent-practice 存在，E:/Projects/agent-practice 不存在。现有 support-chat/time-travel 的历史查询、hitl 的后端幂等提示供对照；四项产品故障由当前工程测试覆盖，不另建 demo，也不跨仓库导入。

- interactions/service.ts：独立 Client、同业务池共享并发上限、同连接解锁与 finally 关闭。
- conversations/service.ts：启动自动迁移 public.support_conversation_requests.request_kind，新增请求显式记录类型，旧行为兼容为 legacy。
- conversations/execution.ts：匹配 requestId/runId 的完成回执仍可补档；暂停回执只确认普通消息；表单读取故障显式向上抛。
- agent/agent.ts：记忆外层、模型重试内层。
- conversations/contracts.ts、web/App.tsx：普通消息状态门禁，读取失败提示与核对入口。

不需要新增环境变量或手动初始化命令，按原方式启动即可迁移。旧记录无法可靠推断类型，legacy 的未确认请求没有匹配终态回执时维持 unknown；本轮不自动重放或批量改写旧异常结果。

## 验证

先新增针对原故障的回归断言，确认旧实现失败，再修复并运行完整检查：

- corepack pnpm test：120/120 通过。覆盖恢复准入中断、普通暂停仍可核对、表单读取失败及恢复、waiting 无表单仍禁用输入、生产装配模型 503 重试成功且记忆只读一次、记忆存储 503 不触发模型或重试。
- corepack pnpm test:postgres：21/21 通过。真实产品数据库验证默认五连接下同时持有五个会话锁仍能内部查询、并发上限跨服务实例共享且结束释放、持久 resume 类型与旧暂停不误确认；同时回归原有跨进程恢复、幂等、预算与记忆测试。仅清理本次随机 integration 范围的数据。
- corepack pnpm typecheck、corepack pnpm build：通过。构建仍有既存的大 chunk 提示，本轮未扩展打包优化。
- 本轮真实模型验证：未执行；上述模型行为使用可注入模型故障，不能作为供应商可用性证明。未重新执行 24 场景真实模型评估。
- 本轮真实业务集成验证：未执行，尚无业务写工具；不宣称 exactly-once 业务动作保证。

运行方式保持 corepack pnpm ui -- --user alice / corepack pnpm start -- --user alice。四个修复沿既有执行链生效，无需切换独立 debug 或恢复路线。
