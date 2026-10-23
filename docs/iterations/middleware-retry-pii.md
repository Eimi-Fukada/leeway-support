# 中间件目录、有限重试与输入侧 PII

日期：2026-10-23。对应 D7 与 D9 的首个切片，按用户授权同时完成目录整理、主回答有限重试和输入侧脱敏。

## 解决什么问题

摘要中间件已经存在，新增策略需要清晰的维护位置。当前暂时性模型故障会立即中断；用户输入的联系方式又可能进入模型、checkpoint 和追踪。因此将摘要移入 agent/middleware，并在 agent.ts 明确装配 PII → 摘要 → 重试。保持 config 中的 checkpoint/tracing 生命周期职责，不建中间件自动注册器。

输入仍为每轮新增用户文本。run.ts 在提交 Graph 前脱敏，再建立每轮独立的重试观察状态和 callback；输出仍为事件及最终 answer/runId/elapsedMs，不改变正文展示协议。失败仍拒绝返回成功，不将异常变成 AI 回答。新增 wrapModelCall 后框架会使用 MiddlewareError 包裹原始异常，测试验证 cause 保留根因，而不再要求外层 Error 对象恒等。

## 官方方式与本次取舍

核对日期 2026-10-23；锁定 LangChain 1.5.18、LangGraph 1.5.2，无新增依赖。[官方中间件](https://docs.langchain.com/oss/javascript/langchain/middleware/built-in)提供 modelRetryMiddleware、piiMiddleware，以及检测/替换原语。

重试复用官方次数与退避实现，应用包装 retryOn，设 onFailure=error。SDK maxRetries=0，最多额外 1 次；只允许明确的 429/500/502/503/504 或指定网络错误，排除认证、参数、额度耗尽、未知、取消和超时。300ms 退避，normalized retryAfterMs 大于 1 秒拒绝；HTTP Retry-After 超过固定 300ms 也拒绝，避免提前重试。首次调用耗时超过 5 秒不再尝试；run.ts 对包含摘要的整轮 Graph 设置 65 秒截止时间。

直接用官方默认重试会有两个问题：默认 onFailure 会生成错误 AIMessage；默认筛选也不能识别本应用是否已展示片段。应用用 AsyncLocalStorage 保存每轮 emitted 标志，模型 callback 在片段生成时标记，避免只依赖异步 UI 消费时间。任意模型已输出即保守地不重试，包括内部摘要；并发轮次互不影响。绕过产品 run.ts 的直接 invoke 没有进度观察时不自动重试。该范围不是通用框架插件能力。

摘要模型调用在 beforeModel 内，不由主回答 wrapModelCall 重试，仍按已有策略失败即停止。此前真实摘要超时的问题未因此被宣告修复。SDK 重试配置是可行替代，但不负责本项目的流式展示边界；此处由中间件唯一拥有主回答重试策略。

PII 使用官方 resolveRedactionRule + applyStrategy：内置邮箱、Luhn 校验银行卡，自定义大陆手机号正则；全部 redact，不保存原文映射。官方 piiMiddleware 默认只处理最后一条 HumanMessage，且 beforeModel 晚于 Graph 输入 checkpoint；输出 afterModel 又晚于流片段。因此本轮在 run.ts 提交前清理新问题，使用自定义 beforeModel 扫描全部历史文本，保留原 message ID、角色和工具关联，再做摘要。摘要适配也在调用其内部模型前清理输入。追踪 anonymizer 另外清理上传字符串。

替代策略 block 会拒绝整个请求，mask 会保留部分信息，hash 适于关联但不是匿名化保证。当前普通客服问答不需完整联系方式，因此选 redact。没有为了多挂框架中间件同时加入多种策略。

## 覆盖边界

- 仅覆盖文本邮箱、经校验的银行卡号和大陆连续手机号（可带 +86/86 前缀）；不覆盖所有 PII、多模态或所有号码分隔方式，可能漏检或误检。
- 新问题经 run.ts 后再提交，新输入 checkpoint 不保存命中的原文；绕过该入口直接调用 Graph，不具备“首个 checkpoint 前脱敏”保证。
- 历史消息在模型前清理，不迁移/删除此前 checkpoint 原文；数据库保留、访问权限及删除仍需独立治理。
- 输出正文和输出 checkpoint 不保证脱敏。模型可能自行生成新的敏感内容；不能声称 afterModel 已保护流。追踪上传使用同一规则，但不改变实际答案。
- 没有工具/业务执行，未引入业务权限或长期记忆语义。

## 学习对照和调用链

已检查两个实验候选路径，本轮存在并使用 E:/GraceProject/agent-practice；只读取 pii-middleware.ts 作官方参数与时序对照。实验仓库未找到 model-retry-middleware.ts，本次通过产品实现和故障测试学习，不新建 demo/数据库。

调用链：cli/chat.ts → run.ts（输入脱敏、进度 scope、65s signal）→ Graph/checkpoint → PII beforeModel（历史清理）→ 摘要 beforeModel → 主回答 wrapModelCall（有限重试）→ 原有 stream 消费与结果校验。LangSmith callback 保留，每次模型尝试可被追踪，上传字符串再次脱敏。

## 验证

确定性测试覆盖输入边界、所有新 checkpoint、模型实际输入、摘要装配顺序、上传输入/输出、重试成功/耗尽、永久错误/超时/取消/Retry-After、503 断流不重试、并发 scope 隔离和摘要不重试。真实 PostgreSQL 测试使用随机 integration-pii thread，检查初始到完成的全部快照均无测试原文、两次模型尝试只形成一条用户消息；只删除本次随机会话。

运行结果：`corepack pnpm test` 56/56 通过，`corepack pnpm test:postgres` 5/5 通过，`corepack pnpm typecheck` 通过，`git diff --check` 无空白错误。模型故障使用可重复注入，不对真实供应商制造 429/503。

真实模型：关闭本次云追踪后，通过根 start 输入合成的邮箱/手机号，模型回答“已被占位符替换”，正常退出。本次验证会话已从产品库删除；这只验收一条正常调用，不代替模型边界与全部 checkpoint 的确定性检查。真实供应商重试故障、完整输出 PII 防护和真实业务集成未验证。此前摘要成功路径的真实模型验收缺口依然保留。
