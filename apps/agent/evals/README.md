# 客服行为评估

本目录评估真实模型如何选择行为，复用产品 createSupportAgent/runSupportAgent、PostgreSQL checkpoint、记忆服务和表单暂停流程。不是另一个客服 Agent，也不使用 fakeModel 生成评估结果。

## 运行

在仓库根目录执行：

```sh
# 列出 24 个用例，不需要模型/数据库配置，也不产生请求
pnpm eval:behavior -- --list

# 执行全部用例，各采样一次：需要 apps/agent/.env，会请求真实模型并产生费用
pnpm eval:behavior

# 只执行一例，适合先验证环境
pnpm eval:behavior -- --case greeting

# 关键用例重复采样；支持 1–5，不自动重跑失败样本
pnpm eval:behavior -- --case memory-autonomous --repeat 3

# 运行候选版本并对比历史报告中的自动检查
pnpm eval:behavior -- --case greeting --baseline artifacts/evals/<历史目录>/report.json
```

没有全局 pnpm 时使用 corepack pnpm。参数中的相对路径按仓库根目录解析，--out 指定报告父目录；每次生成新的时间戳/随机后缀目录，不覆盖其他运行。目录时间采用 UTC。

配置沿用 OPENAI_API_KEY/OPENAI_MODEL/OPENAI_BASE_URL/OPENAI_API_MODE 和 DATABASE_URL；数据库必须已存在。使用产品 public schema，没有评估专用数据库或 practice/demo schema。评估进程关闭自动 LangSmith 云追踪，证据默认仅写本地文件。应用本身的有限模型重试仍生效，实际 attempts 会被记录。

## 数据集和判定

dataset.ts 是版本化的场景数据；contracts.ts 校验每例的初始记忆、用户动作、自动检查和人工复核标准。支持 message、submit、cancel、observe；thread 是场景内别名，a/b 是场景内两个隔离用户，每次运行重新生成实际身份和 thread ID。

初始记忆是明确记录的测试前提，不代表验证了模型自动提取。检查规则/预期工具/人工复核标准不传给模型；用户输入本身可以明确要求表单等产品动作，以测试完整交互。模糊问题允许文本澄清或表单，不强制唯一轨迹。自动记忆另有无触发词场景。

动态表单由测试场景的用户资料按字段标签回答；必填字段没有资料、选项不唯一或未产生等待表单时，记录 scenario_unfulfilled，不猜测答案，不伪造工具调用或 interrupt。

自动检查检查真实状态、模型工具提议、工具成功回执、记忆数量与模型输入等。语义正确性、必要追问和记忆失真均保留人工复核；不以固定答案全文匹配或第二个模型的同意直接判定成功。

summary-facts/summary-uncertainty 显式使用低阈值摘要配置以降低验证成本。检查整个场景至少触发一次摘要，不能强制在指定追问轮再次摘要。这验证真实供应商能够完成该摘要链路，不是默认 6000 Token 策略或上下文窗口容量验收。

## 报告

- report.json：版本/内容指纹、选择范围、每步状态、模型输入、工具参数/回执、记忆前后快照、模型尝试、摘要次数和可用 usage。
- report.md：自动检查总览、基线变化、人工复核标准、输入和最终回答。
- reviews.json：人工复核记录模板，运行结束后再填写 status/note；本版本不自动合并成人工验收结论。

automatic=pass/fail/indeterminate，execution=ok/error/blocked，semantic 始终 needs_review。模型/服务异常不算作自动语义失败或通过；未执行、缺少证据、清理失败均明确呈现。数据集、单例或采样次数改变，以及存在执行错误时，基线项标 not_comparable。相同条件下的 improved/regressed 仅指本次自动检查，单次采样不代表稳定胜出。

缺失 usage 不补零，不用 model-call-limit 的成功步骤数代替真实请求数，不估造供应商费用。保存前复用 PII 与已知凭据过滤，但不声称覆盖所有敏感内容。自动检查先在原始证据上完成，再脱敏输出；报告中的脱敏文本不能用来重新证明原始请求没有泄漏。

退出码 0 仅表示已运行样本的自动检查通过，人工语义复核仍未完成；1 表示行为失败、未判定或清理问题；2 表示参数/初始化/报告等运行错误。中途按样本保存报告，未运行完的项不计为通过。

## 隔离与清理

每个样本使用 eval-<uuid>-a/b 本地身份，复用已有产品服务。结束后只删除这些身份对应的表单/记忆/操作账本，以及本次线程 checkpoint；清理代码拒绝不符合评估前缀的身份或 thread。不会删除真实用户数据。清理失败时报告保留具体 eval 身份供核对；评估中途强杀也可能留下记录，不能把报告文件删除当作数据已清理。

当前覆盖没有真实业务工具/RAG的产品行为。存储故障注入、重复提交、跨进程恢复等确定性可靠性测试仍由 pnpm test / pnpm test:postgres 承担；评估不代替这些检查，也不验证生产认证或浏览器呈现。
