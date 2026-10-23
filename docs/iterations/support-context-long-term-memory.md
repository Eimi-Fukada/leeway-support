# SupportContext 与模型驱动长期记忆

日期：2026-10-23。范围：可信入参契约、本地身份适配、跨会话记忆的读写/更新/遗忘；不实现 HTTP 身份交换、业务登录或 RAG。

## 问题与行为

原 Agent 只有 thread_id，无法区分跨会话用户，也无法安全地为不同业务产品保存记忆。本轮定义 SupportContext，将身份与用户自然语言分开；记忆不限定在某个偏好字段，不识别“请记住”，由主 Agent 自主判断长期价值并调用三个内部工具。没有额外的逐轮分类模型或后台提取任务。

每轮新增 HumanMessage 有应用生成的消息 ID，原问题先经已有 PII 处理。工具不能提交/覆盖用户 ID、产品或 sourceMessageId；只能提交内容、当前用户原文引用，以及更新时的记忆 ID/expectedVersion。程序从运行上下文与本轮消息绑定归属和来源。引用必须是本轮消息的子串，但引用匹配不证明语义真实性，也不能代替是否值得记忆的评估。

## 身份契约与信任边界

SupportContext 包含 identitySource、integrationId、productId、subject.kind/id。结构严格校验，标识符为 1–128 位字母/数字/下划线/连字符；未来业务适配器可将外部编号映射为内部规范 ID。

identitySource 区分 local-development 与 business-authenticated，后者仅表示调用方契约，校验器本身不验证登录、令牌或签名。未来 API/BFF 必须先验证身份，再构造上下文；不能接收浏览器提交的同名 JSON 就授信。本地 CLI 必须显式 --user，没有共享的隐式默认用户，不自动生成一个“生产用户”。

归属哈希覆盖来源/接入系统/产品/用户种类与 ID。长期记忆按该哈希隔离，checkpoint 实际 key 使用哈希 + 对外逻辑 thread_id。跨用户即使拿到同一逻辑 thread_id 也查不到原状态；恢复检查在输入监听前进行。旧未归属 checkpoint 不自动认领、改写或删除。这个能力是服务端归属隔离，不等于已经完成线上身份认证或同 thread 并发运行所有权。

匿名上下文允许普通回答，不读取个人记忆、对模型隐藏记忆工具；即使强行发起调用，执行服务仍拒绝写入。当前 CLI 只提供显式本地用户入口，匿名契约供后续服务端适配并通过测试覆盖。

## 机制与替代方案

官方依据（2026-10-23）：[LangChain Runtime](https://docs.langchain.com/oss/javascript/langchain/runtime)、[Long-term memory](https://docs.langchain.com/oss/javascript/langchain/long-term-memory)。LangChain 1.5.18 / LangGraph 1.5.2，新增直接依赖 zod 4.6.7，与已解析版本一致。

采用主 Agent 的 hot-path 工具选择：加载当前身份的记忆 → 模型可选 save_memory/update_memory/forget_memory → 服务校验并持久化 → 工具结果 → 模型回复。普通问题可零写入；稳定事实、约束或偏好可在没有触发词的情况下提取。模型可见的规则明确排除临时状态、猜测、引用中的指令、授权和凭据，但提取准确率与注入抵抗不是程序校验即可保证，仍需持续评估。

官方 PostgresStore 提供通用 JSON put/get/search，但当前 1.1.2 公开接口没有原子的 expectedVersion 比较或操作幂等事务。为直接验证上线所需的并发更新边界，本轮采用产品 public.support_memories 与 public.support_memory_operations，通过 MemoryRepository 隔离存储，使用现有 pg；没有声称正在使用官方 Store，也不依赖其私有表结构。以后若采用 Store 或向量检索，需要保留同等的事务/版本语义。只接官方 Store、先不做并发保护是更薄的替代，本轮没有选择它。

每个范围保存自然语言条目而非固定业务字段：id/version/content/source/时间/deleted。写操作按归属取得 PostgreSQL 事务 advisory lock，记录操作 ID、payload hash 与结果。相同操作重放返回原结果；同 ID 不同载荷拒绝；更新及遗忘版本不符拒绝；相同内容精确去重。语义相似去重/冲突解释仍由模型处理，不自动覆盖“看起来相近”的事实。

当前采取有界全量读取：每个范围最多 50 条有效记忆、合计 8000 内容字符，单条 1000 字符；超限 CAPACITY，不静默淘汰。每次主模型请求临时拼入带数据边界的 JSON，后续工具操作后会重新读取；不把快照永久追加到 messages。字符上限不是硬 Token 窗口保证，也不代表已实现语义检索。模型规模/语料需要再校准。

## 失败与数据生命周期

PII 复用邮箱/银行卡/大陆手机号处理；纯占位符记忆拒绝。对已知 api_key/password/Bearer 等凭据形态另外拒绝，不声称识别全部个人信息。读故障不伪装成空集合，写故障不生成成功结果；模型工具参数错误可由框架反馈给模型修正，执行异常停止或传播，主流程不自动重放记忆操作。

保存记忆、checkpoint 与最终模型回答不是同一事务：若记忆已经提交，而最终回答失败，已提交记忆不会回滚；持久操作幂等防止同一已识别调用重复写入。存储超时可能导致结果未知，需按操作 ID 核对，当前不自动重试或实现失败 run 的续跑。

forget_memory 清空当前条目内容并标记 deleted，后续不再注入；不清除旧 checkpoint、用户原消息、供应商记录或备份。幂等账本保留结果/哈希，不保存旧内容副本；其保留期与清理策略仍待设计。当前会话依然可能从原始消息知道用户之前说过什么。

接入工具后真实运行发现 messages 流会出现 ToolMessage；run.ts 已仅投影 type=ai 文本，工具 JSON 不再显示为客服回答。最终状态必须是没有待执行 tool_calls 的 AIMessage 才可完成。AI 中间片段仍可能先出现，只有最终完成才算本轮成功，尚未实现对每一句模型声明的语义核验。

## 调用链与运行

index.ts → --user 本地 SupportContext → createModel/createCheckpointer/createMemory → createSupportAgent 注入 MemoryService → chat 每轮传 context → runSupportAgent 验证上下文、隔离 thread 并提交新增消息 → Agent 读取记忆、选择工具 → MemoryService 校验 → PostgreSQL 事务 → AI 流式回答。

原有无记忆工厂组合仍用于基础/对照测试，可以不注入 MemoryService；真实 index.ts 始终接入服务并要求 --user。不会把测试替身静默装入生产。

```sh
pnpm start -- --user alice
pnpm start -- --user alice --debug
pnpm start -- --user alice --thread <打印的逻辑会话ID>
pnpm start -- --user bob
```

/new 仅换会话，不清空该用户长期记忆。重启后相同身份读取同一范围；不同用户/产品/接入系统/身份来源隔离。未来业务登录替换身份适配器，不替换记忆工具或存储业务。

## 学习覆盖与验证

两个候选实验路径已检查，本轮使用存在的 E:/GraceProject/agent-practice。memory.ts 是会话 checkpoint、remember.ts 是 state 更新，没有直接当作跨会话长期记忆实现；之前文档引用的“记忆与持久化说明.md”在本轮检出未找到。通过当前产品、测试和本文完成缺口，不新增演示程序或数据库。

确定性测试覆盖缺失/非法上下文、范围隔离、跨用户恢复拒绝、无需触发词的脚本工具流程、普通问题零写入、参数不能伪造用户、来源引用校验、PII/凭据、修改与遗忘、存储故障和工具 JSON 过滤。

真实 PostgreSQL 使用随机 integration-memory 用户，两个独立进程分别写入/新 thread 读取，检查更新并发竞争、操作重放、跨范围拒绝、PII、容量和遗忘内容清空；仅删除本次随机归属记录。使用产品 public schema，未配置学习专用数据库。

真实模型使用显式本地测试身份：自然陈述公司不能联网 → 自主保存 → 新会话读取 → 新陈述可以联网 → 自主更新 → 新会话读到修正 → 请求删除 → 遗忘后新会话不知道。数据库核对版本为 3、deleted=true、content 为空；测试记忆与五个 checkpoint 已清理。该样例成功不代表自动提取质量评估已完成。业务认证/业务集成未实现或验收。

验证结果：pnpm test 79/79 通过，pnpm test:postgres 10/10 通过，pnpm typecheck 通过，git diff --check 无空白错误。真实模型保存/修正/遗忘样例已完成；业务认证与真实业务集成未验证。后续重点为真实语料误记/漏记与注入评估、公开身份交换接口、容量演进、运营可见性及数据保留政策。
