# PostgreSQL checkpoint 与显式恢复已完成会话

日期：2026-10-23。关联 C4，完善短期记忆，不接长期记忆、RAG 或业务工具。

## 问题、输入输出与失败契约

之前 MemorySaver 只保存当前进程状态，重启后丢失；chat 每次启动生成新 thread，数据库存储本身还不足以恢复会话。

本轮输入是 DATABASE_URL、可选 --thread ID 和新增用户消息；输出为流式回答、执行结果以及会话 ID。默认新建会话，--thread 仅恢复已完成会话；不存在或有未完成步骤时明确拒绝。/new 不删除旧数据，/exit 结束输入；不是运行中取消。

数据库连接、初始化、读取或写入失败均向上传播并以非零状态退出，不自动降级内存，不自动重试。发生错误时用户输入可能已保存，已展示的文本片段也不保证已经形成完成 checkpoint；本轮不尝试回滚或重放失败步骤。启动配置和初始化错误使用安全描述，其他错误保留统一失败描述，不输出原始连接串或堆栈。

## 常见机制、官方依据与选型

使用官方 @langchain/langgraph-checkpoint-postgres 1.1.2，搭配本项目锁定 LangChain 1.5.18 / LangGraph 1.5.2。pg 8.23.1 提供显式 Pool，设置 max=5、连接等待 5 秒、查询及 statement 各 10 秒截止时间。PostgresSaver.setup 在产品数据库 public 中初始化/迁移四张官方 checkpoint 表；数据库本身需预先存在。setup 在当前单实例启动时执行，后续生产应单独管理迁移和建表权限，不承诺并发迁移安全。

本轮按用户约定统一使用 public；不为学习新建数据库或独立 schema。使用 public 可减少当前项目的额外命名和配置，自定义 schema 的组织/权限优势目前不足以要求增加该层。

官方核对（2026-10-23）：[数据库记忆指南](https://docs.langchain.com/oss/javascript/langgraph/add-memory)。实际包公开 graph getter 支持读取状态，未调用标为 internal/never 的 ReactAgent.getState，也未使用类型断言绕过它。

替代：继续 MemorySaver 无法跨进程；SQLite 可做本地单机，但产品已有 PostgreSQL 连接且目标为服务部署；自制 JSON checkpoint 需自行维护写入和格式；Agent Server 会同时引入运行服务选型。这里选择官方 saver 和现有数据库，不创建 ORM、公共 database 包或第二套 Agent 执行流程。后续若采用 Agent Server，重新评估是否把持久化职责交给服务层。

## 实际调用链

index.ts → parseCliOptions → createModel/loadAgentEnv → createCheckpointer → setup → createSupportAgent(model, saver) → chat → runSupportCli → runSupportAgent → agent.stream → 官方 checkpoint 读写。

--thread 分支通过 agent.graph.getState 检查历史/后续步骤。恢复校验完成后才创建 readline，避免异步读库期间提前消费 stdin。每轮仍只提交新消息。finally 关闭 readline 与 saver/Pool，测试异常路径也释放资源。

真实凭据仅在 Git 忽略的 apps/agent/.env，示例文件只含占位符。离线测试仍可注入 MemorySaver，不需要真实数据库。真实数据库测试独立命令 `pnpm test:postgres`，不参与默认离线 `pnpm test`。

## 在产品实现中学习

E:/Projects/agent-practice/labs/persistent-memory 只保留说明，实际运行与验证均在产品仓库完成；撤去重复脚本、实验环境文件和专门新增的 PostgreSQL saver 依赖。不要求为了学习覆盖再建一个演示应用或数据库。

数据库调整前检查 public 无同名表，旧表没有会话数据；事务内锁定旧表后再次核对，将四张产品表移到 public，保留迁移记录。仅删除已确认无会话数据的实验表和两个旧 schema，未使用 CASCADE。若同名冲突、发现会话数据或存在额外依赖，事务回滚，不能直接删表重建。

## 验证证据

- 确定性流程：`pnpm test`，23/23，通过输入、历史、恢复拒绝、延迟输入监听、错误传播和原有流式场景。
- 真实 PostgreSQL：`pnpm test:postgres`，3/3；两个独立 Node 进程完成 write/read，模型实际收到历史；连接失败不降级；读存储失败不请求模型、不输出成功。随机 integration- 会话结束后清理，未删除其他会话。
- 真实模型 + 真实 PostgreSQL + CLI：两个独立进程运行实际 index.ts；第一进程保存测试代号并退出，第二进程传 --thread，正确回答该代号；随后清理本次随机测试会话。仅证明本次样例，不代表模型记忆准确率。
- 产品 `pnpm typecheck` 通过。统一 public 后重跑真实 PostgreSQL 测试与离线测试；学习仓库只有说明，无另行类型检查对象。
- 真实业务集成：未实现、未验证。生产部署/重启、并发、备份和权限：未验收。

## 遗留边界

当前是可信本地 CLI，持有 thread ID 不等于拥有生产访问权限。同 thread 跨进程并发/运行所有权、未完成步骤的恢复策略、敏感信息治理、历史保留/删除、数据库备份恢复、独立迁移和运行中取消仍需逐项设计。持久短期记忆不替代长期记忆。

学习仓库现有 tools/langgraph-server 的 peer 版本问题不在本轮范围，未修改该工具链或验证其 schema 服务。
