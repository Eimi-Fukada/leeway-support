# 会话摘要中间件

日期：2026-10-23。关联 C8：上下文管理。只增加摘要，不增加业务工具、长期记忆、重试或新的聊天表。

## 问题、输入输出与失败行为

多轮对话持久化后，旧 messages 会持续增长；不能把“数据库能保存”当成“模型应每轮接收全部历史”。输入是该 thread 的消息状态、触发预算和保留数量；输出是摘要 + 最近消息组成的新状态，主模型据此回答。

策略直接在 summarization.ts 的 SUMMARY_CONFIG 中维护：triggerTokens=6000、keepMessages=8，不读取环境变量；测试可以通过工厂参数覆盖预算。沿用框架字符估算（约字符数/4），不是精确 Token，也不是当前模型窗口的自动发现。短会话不触发额外调用；最近消息不足以形成可压缩前缀时跳过。系统提示词通过原 Agent 继续提供，不由摘要替代。

摘要调用出错、空文本、框架错误占位文字或未减少上下文时拒绝本轮，保留原消息，不静默丢历史。总历史估算超过 16000 时请求前拒绝，配合同等 trimTokensToSummarize 上限，避免框架默认只保留 4000 估算 Token 的旧记录来总结。这个上限只限制当前文本估算输入，不代表已经验收模型全部 payload；超长单消息、中文分词校准、系统/输出余量和将来工具内容还需独立设计。

## 官方机制、替代和取舍

核对（2026-10-23）：[官方摘要中间件](https://docs.langchain.com/oss/javascript/langchain/middleware/built-in#summarization)。本项目 langchain 1.5.18 / langgraph 1.5.2；实际包的 beforeModel 调用摘要模型，使用带 lc_source=summarization 的 HumanMessage 替换旧前缀，通过 RemoveMessage reducer 更新状态，并保护工具调用与结果配对。

源码核查发现该版本将摘要模型异常转换成 Error generating summary 字符串返回，而不是抛错。应用包装其 beforeModel，在返回 update 给 Graph 前拒绝无效/非压缩摘要；没有修改第三方包、重写 Graph 或默认允许失败继续。

替代一：只保留近期消息，无额外模型开销，但丢失早期事实。替代二：超限强制新会话，最简单但影响连续客服。采用官方摘要是为了保留必要的早期上下文，同时用现有中间件机制减少自制消息合并逻辑；不声称摘要不会遗漏或这是行业唯一主流方案。

当前复用主模型实例/供应商配置，不预先引入摘要专用模型及一组新密钥。可通过 SummaryOptions.model 注入独立摘要模型；当真实成本或延迟说明有必要时再比较。摘要每触发一次增加一次调用，模型 maxRetries 仍为 0，失败不自动重试。

## 实际调用链与原文保留

index.ts → createSupportAgent(model, saver) → createSummaryMiddleware（读取代码策略）→ 官方 beforeModel → 失败/缩短校验 → 状态更新 → 主模型 → checkpoint。

run.ts 明确过滤内部摘要模型消息的 metadata/tag，只把主回答投影给用户；LangSmith 仍追踪内部模型调用。摘要材料作为数据，不是新的指令、权限或确认；不把摘要作为业务状态事实源。

原文策略：当前不清理旧 checkpoint，摘要只更新最新状态；既有 PostgresSaver 历史快照仍保留原消息。新进程恢复最新摘要状态，历史快照可按 checkpoint_id 查询。不是单独的原始聊天档案，不保证将来删 checkpoint 后原文还在；保留期/数据删除策略须后续讨论。

## 学习覆盖与验证

已检查两个候选实验路径，本机使用 E:/Projects/agent-practice；现有 summarization-middleware.ts 和 context-editing-middleware.ts 提供机制对照。本轮在产品实现/tests 中验证，不另建 demo 或数据库；没有照搬学习注释中“永远能装进窗口”或缓存收益的未验证结论。

- 确定性流程：39 个本地测试通过，其中 6 个摘要场景验证短会话零摘要、触发后的实际模型输入、内部文本不展示、原文历史、失败/空/非压缩结果拒绝、无旧前缀与超大输入、非法配置。
- 真实 PostgreSQL：4 个测试通过；新增两个独立进程验证摘要状态恢复，查询历史确认旧原文仍在。仅删除本轮随机 integration-summary 会话。
- 类型检查通过。
- 真实模型与真实 PostgreSQL：先由测试模型写入一轮无业务数据的背景，再调用真实模型做摘要与回答。摘要模型请求超时，应用保护拒绝无效摘要，主回答没有继续；因此未通过真实模型成功摘要验收，不能用离线结果代替。仅清理了本轮随机 summary-validation 会话，没有修改用户历史。
- 真实 LangSmith：通过 Agent/local 地址查询到内部 lc_source=summarization 模型失败记录，原因为 Request timed out，未出现 401/429；追踪能定位摘要调用。为避免额外消耗，没有反复请求供应商。真实业务集成未执行。

## 遗留

估算与供应商 tokenizer 不同，尚未形成中文语料预算标定；摘要可能失真，需要真实问答回归集验证。未实现摘要前后的结构化实体保真、硬模型窗口保证、专用聊天档案、历史清理、长期记忆、取消或并发控制。摘要失败会留下未完成步骤，当前仍按既定恢复规则拒绝自动续跑。
