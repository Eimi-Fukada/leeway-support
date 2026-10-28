# 统一 Agent：知识工具、GPT 联网与原生思考模式

日期：2026-10-28（北京时间跨日验证延续至 10 月 29 日）。关联执行方案 S1–S7、旧 K8/K10/K11/K12/K13、学习覆盖 A/B/C/F/I/J。

## 1. 解决的问题与交付边界

知识库此前只有入库完成和问答草稿，Agent 只支持本机开发身份。现在库内问题可由已登录用户经受控 BFF 调用原 Agent：内部资料通过 search_knowledge，公开实时信息通过供应商内置 web_search；输入框快速/深度映射原生 low/high。

本轮完成本地功能实施和分层验收，不代表正式业务系统或生产发布验收。没有创建第二套 Agent 循环，没有新增知识库同级聊天入口，没有实现业务写操作、任意生成式 UI、GraphRAG 或访客试用体系。

## 2. 机制和一手资料

沿用原 createSupportAgent/runSupportAgent、checkpointer、信息表单、独立消息档案、请求幂等与完成回执。官方核对日期 2026-10-28：

- [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)：当前配置模型，支持 reasoning effort 与 Responses 原生搜索。
- [原生思考参数](https://developers.openai.com/api/docs/guides/reasoning)：通过 reasoning.effort，不使用提示词模拟。
- [原生搜索](https://developers.openai.com/api/docs/guides/tools-web-search)：由供应商执行，工具事件与 URL annotations 分别保留。
- [Qdrant 1.19 Query](https://api.qdrant.tech/v-1-19-x/api-reference/search/query-points)：相似度候选和范围过滤；没有将 cosine 分数当答案正确率。

本地锁定 SDK 已检查，实际请求捕获证实 low/high 与 web_search 被发送；真实供应商返回了对应答案、usage、response ID 和搜索调用。简单乘法在两档下均可能没有 reasoning tokens，不用答案长短或推理 token 数证明开关生效。

## 3. 方案对照与实际取舍

固定检索更适合明确的资料问答，Agent 工具便于普通聊天、公开信息和内部资料组合；本轮按已确定的统一助手定位选后者。检索服务仍可由已认证 HTTP 直接调用并独立测试。首版 dense、候选 10/最多补查 20、最终最多 6 条/12000 字符，参数为工程起点而非质量最优结论。

搜索直接用供应商内置能力。实测当前接入端拒绝 `max_tool_calls`（400 Unsupported parameter），已移除该参数，未静默改用第三方搜索。当前有本地工具/模型步数、总超时、搜索记录与 usage 观测；**远端搜索执行前硬次数限额未验收，仍是生产上线门槛**。关闭自动重试，防止远端已经搜索但尚无文本时模糊重发。

知识库初期语义基线有召回噪声：无答案问题也能返回高排名的无关片段。真实模型的董事长问题拒绝猜测；未把这些候选伪装成“确定找到答案”。大范围问题还可能耗尽既有工具预算，实际蓝湾复杂问题触发 5/4 拒绝，页面保留未完成状态，没有伪造成功或自动重跑。

## 4. 实际调用链

1. 浏览器问题、thread/request ID 和开关进入 Knowledge `/api/knowledge-bases/[id]/chat`。
2. BFF 验证 cookie、同源和严格 body，再使用独立方向 HMAC 签名转发主体与 session 摘要。密钥、cookie 和摘要不进入模型/checkpoint。
3. Agent `/api/internal/knowledge-chat` 验签、防 nonce 重放；Knowledge `/api/internal/knowledge` 再查真实 session、active 用户、owner 和应用 grant。
4. 会话绑定库和有效来源修订。长期记忆的 productId 也包含库 ID，防止跨库隐式上下文泄漏。
5. search_knowledge 只开放 query 参数。Knowledge 检查 ready/profile/receipt，调用现有 embedQuery，再向 Qdrant 发送库/profile/文档+generation 组合过滤。
6. 候选回 PostgreSQL 检查来源与正文指纹，去重/限长/再查范围；成功和已授权查询的失败均写检索审计。查询向量只存在内存。
7. 合法原文作为 ToolMessage 返回；主模型按选项使用 low/high。联网开启时在同次 Responses 请求提供 web_search，关闭时不提供。
8. 工具结果、网页 annotations、搜索实际调用数和 provider response/usage 进入本轮 details。完成前核对 K 引用白名单和权限。
9. details 与答案进入完成回执和请求 result；新增 metadata_required 防止新的知识请求在缺来源详情时被恢复成无来源成功。未知只核对，不自动重新执行。
10. 浏览器接收 AG-UI SSE；引用面板与历史恢复读取持久事实。停止通过 AbortSignal 沿 BFF、Agent 和模型传递。

## 5. 与草案的细化差异

- 首版将 scope/search 合并为一个内部 Knowledge route 的 operation，不新增相同职责的并行接口；引用详情使用当前会话已重新授权的来源快照，原文件仍走已有鉴权接口。
- 没有新增独立 run_evidence 表：原请求 result 和 checkpoint 完成回执已经能容纳完整来源及配置，复用它们减少跨存储提交步骤；缺详情保持 unknown。
- 现有库由显式 UUID 命令授权；新增库的创建动作在同一 SQL 语句内给固定内置 knowledge-chat 应用建立 grant，仅此默认应用，不授予其他集成。
- 遇范围/发布修订变化，首版保守要求新会话；没有自动清洗旧摘要再继续。
- 恢复先校验 requestId 与 submissionId 一致；已完成恢复按其原选项回放，新恢复按匹配 formId 的原任务选项运行，不能借用后续表单的开关。
- 恢复原网页引用与原检索时间，但不把历史来源计为新搜索。前端用请求代次防止旧 history 响应覆盖新会话。
- reasoning summary UI 未纳入本轮；原生 effort 开关已经接通，完整思维链展示不是其验收条件。

## 6. 验证结果

### 确定性流程

- 全量 `pnpm test`：Agent 134 项、Knowledge 37 项，共 171 项。新增能力测试包含服务签名、nonce、防串配置、选项幂等、引用白名单、暂停/恢复引用、网页引用编号不冲突、联网禁模糊重试、范围失效、档案提交中断与缺详情保持未知。
- 两个应用类型检查通过；根 `pnpm build` 两个应用生产构建通过；`pnpm db:status` 全部检查项正常。
- 失败注入是模拟边界，不能称为真实模型故障或支付业务结果。完成回执/档案中断新增 details 故障为确定性测试，原有跨进程 PostgreSQL 恢复测试另列。

### 真实存储与 HTTP

- Agent PostgreSQL 23 项、Knowledge PostgreSQL 18 项通过，含初始化/重复迁移/旧字段兼容。Knowledge 新表数为 9，Agent 新增 nonce、thread scope、run options 表，checkpoint 仍为原 public schema。
- 真实 PostgreSQL+Qdrant 5 项入库/核对回归通过。
- 额外真实 HTTP+PostgreSQL 鉴权用例通过：双向签名、nonce 重放、修改 body/audience、伪造主体、应用撤权、session 登出、恢复 ID 不一致均拒绝。
- 真实 embedding/Qdrant：12 条中文查询，8 条可回答问题均召回预期原文；4 条无答案问题记录候选，仅说明召回行为，不宣称模型已经证明无答案。

### 真实 GPT 与界面

- quick/low、deep/high 原生调用通过；脱敏请求记录确认发送的 reasoning 字段。真实模型在复杂组合任务有 reasoning token 记录，但不作为质量保证。
- 内置搜索真实返回 web_search_call 和 URL citations；不依赖模型在正文自称“已经搜索”。
- 普通聊天零搜索、知识价格回答、无答案拒绝猜测、联网开/关、内部资料+公开搜索组合，均有实际结果和会话恢复记录。
- 相同 requestId 重放返回同一结果；修改选项 409；未登录 401；没有重新模型调用或搜索。
- 正式构建后的真实表单链路：检索取得 6 条来源后暂停，恢复答案保留 2 条引用；原 quick/联网关闭选项未因恢复体请求 deep/联网开启而改变；第二个表单等待中重放旧提交成功。
- 桌面/390px 手机浏览器验证输入框、思考选择、联网选择、知识引用/原文、网页链接、刷新恢复、切库历史隔离；测试浏览器使用短时种入的管理员 session，未声称本轮额外验证了真实密码登录流程。
- 实际取消在已收到模型文本后中断连接：状态和是否保存 assistant 完成消息以 `output/integration/cancel-final.jsonl` 为准；不把中断片段当成功答案。
- 取消实测状态为 unknown、assistant 完成档案为 0；线程锁已释放，读取状态不重新执行。不能据此声称供应商必然停止计费。

实际报告位于 `output/integration/`（本机忽略），截图位于 `output/playwright/knowledge-chat/`。真实供应商事实来自本轮 HTTP/模型调用；虚构青禾/蓝湾文档只作受控验收资料。

### 真实业务集成

未执行。未接订单、退款、付款、任务控制等真实业务系统，也未把实验仓库的模拟订单当成正式集成。

## 7. 启动和复现

```powershell
node scripts/init-knowledge-integration.mjs
pnpm knowledge:db:init
pnpm agent:db:init
pnpm db:status
```

两份 .env 均需要双向服务密钥，命令只补缺失，不打印、不覆盖已有密钥。参照两端 `.env.example`。模型仍为用户已有 GPT 配置；knowledge embedding 仍是已入库的匹配 profile。

分别启动 `pnpm knowledge:dev` 和 `pnpm ui -- --user <开发用户ID>`；原开发身份只影响旧调试入口。生产构建后分别运行 `pnpm knowledge:start` 和 `pnpm ui:start -- --user <开发用户ID>`。不要同时用同一份 .next 跑 dev 并重建生产包；本轮最终以停止 dev 后的生产进程做 HTTP 复核。

现有库显式授权：

```powershell
pnpm --filter @leeway-support/knowledge exec tsx scripts/grant-application.ts <知识库UUID>
```

使用新的测试资料时调整脚本 fixture 库 ID，不把示例 UUID 当所有环境通用。固定本机验收脚本：

```powershell
pnpm --filter @leeway-support/knowledge exec tsx scripts/check-retrieval.ts
pnpm --filter @leeway-support/agent exec tsx scripts/check-native-capabilities.ts
pnpm --filter @leeway-support/knowledge exec tsx scripts/check-chat.ts
pnpm --filter @leeway-support/knowledge exec tsx scripts/check-form.ts
pnpm --filter @leeway-support/knowledge exec tsx scripts/check-cancel.ts
pnpm knowledge:test:http
```

这些 check 脚本显式调用真实模型，可能产生费用，未放进默认单元测试。它们创建带 eval 前缀的隔离 thread，短时 session 在 finally 删除；保留会话/检索记录作证据。浏览器测试 session 15 分钟自动到期，state 文件不得提交。

本机 Ollama 初次未读取已有 D:/ollama-models，恢复目录后仍受 GPU 探测影响；本轮以 CUDA_VISIBLE_DEVICES=-1、OLLAMA_VULKAN=0 启动 CPU 模式通过，未重下模型。之后查询约数百毫秒到数秒，不构成跨硬件性能承诺。Qdrant 原容器未删除、未重建原集合。

## 8. 遗留与验收结论

S1–S6 功能已接通；S7 本地功能回归及真实服务验证已完成主要场景。仍须区分：

1. 供应商不支持远端搜索硬次数参数，生产硬预算门槛未通过；当前仅本机受控使用，不宣称生产发布完成。
2. 语法引用有效不代表结论被原文支持；人工语义评估和更大的真实问题集需要持续积累。
3. 新 details 的档案中断已做确定性故障注入；未单独新增“真实 provider 搜索完成后跨进程断电再恢复”的付费故障实验。
   如果 interrupt 已写 checkpoint、但等待结果档案及来源详情没有保存，首版保留 unknown 并隐藏可提交表单，不猜造能安全续跑的 waiting；已补对应故障注入回归。正常已保存的等待结果可真实恢复。
4. 工具预算维持原 4/40；复杂请求可明确失败，不自动提高预算。多模型/多profile、rerank、完整文档替换/撤回产品流程另切片推进。
5. 未部署公网。业务工具、生成式 UI 与业务写入仍需真实项目契约，不在 S7 之后自动扩建。
