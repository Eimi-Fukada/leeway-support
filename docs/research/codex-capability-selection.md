# Codex 功能盘点与本地通用 Agent 平台选型参考

核对日期：2026-10-25。本文是独立新平台的研究资料，不是 leeway-support 客服产品的实施计划，也不授权修改现有产品。

## 1. 结论与取舍前提

目标可行：本地运行、用户自带 API Key（BYOK）、本地保存任务与历史、Linear 风格任务工作台、支持 Skills/MCP、首次公开发布即面向用户。首发可以在明确支持范围内交付完整产品；本表不安排演示版或分批发布，也不替用户确定最终范围。

主要发现：Codex 已有 API Key、本地历史、任务计划和步骤状态、子 Agent、Skills、MCP、审批、沙箱、上下文压缩等能力。因此，“提供任务列表”“使用 API Key”“保存到本地”本身不能被认定为独有能力。可研究的竞争方向是把任务、执行、阻塞、产物和验收做成一致的工作台；能否胜过 Codex，需要同任务对照实测。

### 证据范围

- 源码：下载并检查 openai/codex 的 `main` 快照，固定提交为 `970111f6cb62cc02fe36a82ea7d71b37a2889c97`。所有 C 编号源码链接均固定到此提交，避免 main 变化后失去依据。[仓库快照](https://github.com/openai/codex/tree/970111f6cb62cc02fe36a82ea7d71b37a2889c97)
- 该快照不等于最新已发布稳定版；表中“有实现”不等于所有账户、平台、模型、构建都默认可用。feature registry 的 Stable/Experimental/UnderDevelopment 只用于对应开关，不推广为整个产品的成熟度证明。[开关定义与注册表][S02]
- 桌面宿主、浏览器、云端和第三方服务中的一部分能力，只能由官方产品文档确认，列为 P 类，不能声称公开仓库已完整开源这些系统。
- 对“没有某能力”不做全仓库否定证明；没有查到足够实现证据的内容明确写未知/未核验。这里是面向产品选择的功能盘点，不逐项枚举内部调试命令、旧开关、模型专属参数。
- 本轮只读源码、官方文档和许可证，写研究文件；未编译 Codex、未集成候选库、未调用真实模型或业务系统。库的适用性与性能仍需集成验证。

### 如何使用本表

“基础”表示支撑所述正式产品的基础能力；“可选”表示取决于用户承诺和任务范围；“已排除”只复述用户明确排除的部分。均不是已批准的产品规格。可用功能编号反馈“保留/不要/待定”，然后再形成正式范围。

API Key 是模型连接凭据，不是平台用户登录。用户可以不注册平台账号；但远程 MCP 的 OAuth、Git 凭据、网站登录仍分别存在。本地存储不等于离线：模型请求、联网工具和远端 MCP 会接收任务需要发送的数据。

“Linear 风格”按本地自建工作台理解；若实际接入 Linear 服务，任务数据、身份与同步属于额外范围。

## 2. Codex 已有的核心功能

以下“实现”指本次源码快照包含对应机制；带“条件”的行要额外检查模型、配置或平台。

### 模型、对话与任务执行

| 编号 | 能力与具体行为 | Codex 依据和边界 | 我们的选择提示 |
| --- | --- | --- | --- |
| C01 | API Key 接入；也支持 ChatGPT 等登录路径 | CLI 有独立 `run_login_with_api_key` 路径；不是必须用 GPT 账号。[S03] | **已明确保留 BYOK**；平台账号不需要 |
| C02 | 提供商、endpoint 与本地模型入口 | `ModelProviderInfo`、Ollama/LM Studio 路径；有协议和模型能力要求，不是任意 API 完全兼容。[S04] | 可选多提供商；先定义支持矩阵，不承诺所有兼容接口 |
| C03 | 模型、推理强度及会话配置选择 | TUI model 命令与 provider 配置；可选项依模型支持。[S04][S05] | 基础模型配置；高级参数可选 |
| C04 | 文本和图片输入；本地图片查看 | 输入协议、`view_image` handler；`view_image` 开关 Stable/默认 true。[S02][S06] | 图片若在支持任务中则保留；不是所有文件的通用解析器 |
| C05 | 模型→工具→结果→模型的执行循环 | `run_turn` / `run_sampling_request`，流式事件和继续判定。[S01] | 基础；可复用 Agent harness |
| C06 | 任务步骤计划与状态更新 | `update_plan` 接收 `step` 和 `pending/in_progress/completed`，发送计划事件。[S07][S36] | **工作台核心**；需扩展可信任务记录 |
| C07 | Plan 模式与实施模式 | TUI `/plan`，模式配置；源码明确 TODO 工具不等于 Plan 模式。[S05][S07] | 可选独立模式；是否每个任务先规划由产品决定 |
| C08 | 向用户询问、收集选项和继续对话 | `request_user_input` 与异步询问 handler，有模式/工具暴露限制。[S08] | 基础人工介入；表单布局自建 |
| C09 | 运行中追加指令、排队输入、取消 | `turn/steer`、`turn/interrupt`、queue 与 session input 处理。[S09] | 基础；“取消图执行”和“杀死子进程”需统一契约 |
| C10 | 多会话历史、列表、重命名、归档、删除、导出 | CLI/TUI 生命周期命令、App Server 协议、本地 state/thread store。[S05][S09][S10] | 基础本地历史；云同步已排除 |
| C11 | 恢复、fork、历史 rollback | 协议支持；源码明确 rollback 只更改对话历史，不撤销本地文件修改。[S09][S35] | 恢复基础；分支与历史回退可选，不冒充工作区回滚 |
| C12 | 上下文管理、压缩与长会话 | session/turn 的压缩调用、context manager 与 compact 模块。[S01][S11] | 基础；摘要质量和预算仍需验证 |

### 工具、Skills、MCP 与子 Agent

| 编号 | 能力与具体行为 | Codex 依据和边界 | 我们的选择提示 |
| --- | --- | --- | --- |
| C13 | 全局/项目指令与 AGENTS.md | 指令发现、路径与装配代码。[S12] | 建议基础；需定义指令优先级与信任边界 |
| C14 | Skills 发现、解析、显式/隐式调用 | skills crate、core skills 装配与调用；Skills 是指令/资源能力。[S13] | **已明确保留** |
| C15 | Skills 的脚本/资源及 MCP 依赖装配 | skills 加载/依赖逻辑；MCP 依赖安装开关 Stable/默认 true。[S02][S13] | 本地加载基础；自动下载/安装可选，仍有权限检查 |
| C16 | MCP 连接、工具发现/调用、资源读取 | core MCP、rmcp-client、MCP resource handler 与 CLI 管理。[S14] | **已明确保留**；stdio 与 HTTP 分别验收 |
| C17 | MCP 凭据与 OAuth 登录/刷新 | mcp_login、MCP OAuth refresh 开关 Stable/默认 true。[S02][S14] | 若支持需授权远端 MCP 则需要；与平台无账号不冲突 |
| C18 | 工具路由、动态工具、延迟发现/搜索 | ToolRouter、dynamic 与 tool_search handlers；部分新版协议独立 gated。[S15] | 工具调用基础；大工具集搜索是否需要由规模决定 |
| C19 | 子 Agent 创建、消息、等待、中断、生命周期 | AgentControl 与 multi_agents handlers；`multi_agent` Stable/默认 true，v2 Stable/默认 false。[S02][S16] | 可选功能；任务拆分不要求每项都创建 Agent |
| C20 | 执行 shell、命令结果返回 | shell/unified_exec、exec server；有审批和执行环境。[S17] | 通用执行平台基础 |
| C21 | PTY、stdin、长命令与后台终端 | unified_exec、终端工具事件；unified_exec/TTY 开关 Stable/默认 true。[S02][S17] | 若支持交互/开发任务则保留；PTY 不是沙箱 |
| C22 | 查找文件、读代码、内容搜索 | file-search crate 提供文件搜索，shell 可运行 rg 等工具。[S18] | 基础；需区分文件名搜索、全文与语义检索 |
| C23 | 应用补丁、追踪文件修改和 diff | apply-patch crate、handler、文件变更事件。[S19] | 基础；保护原有修改、冲突处理属于应用 |
| C24 | 专门的代码 Review 流程 | ReviewTask、CLI `/review` 与 `review/start`。[S05][S20] | 可选；模型 Review 不等于独立验收 |
| C25 | Git worktree 创建/列表/绑定/清理机制 | worktree crate；桌面用户流程另有文档。[S21] | 代码任务建议考虑；非 Git 文件任务也需工作区策略 |
| C26 | Web 搜索工具接入与事件 | web-search extension、模型请求/响应项；搜索执行依后端能力。[S22] | 联网任务可选；不能把服务端搜索免费视作库免费 |

### 权限、恢复、配置与工程运行

| 编号 | 能力与具体行为 | Codex 依据和边界 | 我们的选择提示 |
| --- | --- | --- | --- |
| C27 | OS 沙箱与受控执行环境 | Linux bubblewrap/seccomp，另有 macOS/Windows 后端与执行服务；后端能力不同。[S23] | 正式执行产品的基础；支持平台必须明确 |
| C28 | 工具审批、执行策略、权限提升控制 | ToolOrchestrator 协调审批、沙箱选择与拒绝后的重试；execpolicy allow/prompt/forbidden。[S24] | 基础；不能仅靠模型判断授权 |
| C29 | 网络/环境变量/凭据访问约束 | network proxy、执行配置、keyring；网络代理自身有实验开关。[S02][S25][S37] | 基础策略；具体后端可替换，不必复制全部原生实现 |
| C30 | Hooks 生命周期扩展 | hooks crate 与事件定义，hooks 开关 Stable/默认 true。[S02][S26] | 可选用户扩展；内部事件管理仍需具备 |
| C31 | token/用量显示和持续目标 | `/status`、usage 与 Goal extension；goals Stable/默认 true；一般 token/rollout budget 新开关仍 UnderDevelopment。[S02][S05][S27] | 基础成本/超时限制；持续目标可选，不能承诺精确剩余时间 |
| C32 | 本地记忆读取、提取与整合 | memories read/write、两阶段流水线；memories Stable/默认 false，并有会话/数据库条件。[S02][S28] | 可选；不必复制整个自动记忆系统 |
| C33 | 非交互执行、JSONL 事件、最终输出 schema | `codex exec --json`、`--output-schema`。[S29] | 内部事件接口基础；对外 CLI/自动化入口可选 |
| C34 | SDK 与 App Server 自定义客户端接口 | TS SDK 包装 CLI JSONL；App Server 有 threads/turns/审批等协议。[S09][S30] | 自建平台需 UI↔runtime 边界；不必兼容整个 Codex 协议 |
| C35 | 配置分层、profile、项目配置与信任 | config、config loader、requirements 和启动配置。[S31] | 基础设置与项目授权；企业集中配置可选 |
| C36 | 本地数据库、历史存储、迁移、凭据存储 | state、thread-store、rollout、keyring-store。[S10][S25] | 基础；本地数据管理不等于云账号同步 |
| C37 | 日志、诊断与 OpenTelemetry | otel crate、doctor 命令、错误事件。[S32] | 基础本地诊断；遥测上传可不做/默认关闭 |
| C38 | 交互 TUI、快捷键、主题、终端状态等 | TUI slash command 与界面代码。[S05] | 桌面工作台路线下完整 TUI 可不做 |

代码执行/修复中的“运行测试”，通常是调用项目自己的测试命令；仓库包含自身回归测试，但这不等于内置一个能自动证明所有开放任务成功的通用验收器。平台本身的测试、真实模型任务评估、用户任务的验收要分开设计。

## 3. 已有代码但不能统一当作成熟默认能力的部分

这些并非额外必须实现的功能，而是避免把目录或开关误读成首发基线。依据均为固定快照 [feature registry][S02] 及相应模块。

| 编号 | 能力 | 本次核对状态 | 对我们意味着什么 |
| --- | --- | --- | --- |
| X01 | 图片生成 | image_generation：Stable/默认 true；有 extension，仍依工具/模型/账户和宿主装配。[S33] | 可作为工具扩展，不必自建生成模型 |
| X02 | 应用内语音 | in_app_voice：Stable/默认 true；voice/realtime 代码不代表所有宿主都能直接使用 | 非核心任务交付能力，可选 |
| X03 | MCP App UI、较新 MCP 协议与工具变更监听 | enable_mcp_apps、mcp_2026_07_28、mcp_tool_list_changed：UnderDevelopment | 基础 MCP 与交互 UI 扩展分别选择 |
| X04 | Code Mode 高级执行路径 | code_mode_host Stable；code_mode、only、部分搜索/预热路径 UnderDevelopment | 不需要复制 Codex 内部执行架构 |
| X05 | 异步压缩、一般 token/rollout budget 新机制 | 对应开关 UnderDevelopment | 可用框架实现自身明确的预算与压缩，不必照搬这些实现 |
| X06 | 子 Agent 消息板、环境分配和运行身份新机制 | 对应 agent_message_board、subagent_thread_environments、runtime_agent_instances 等 UnderDevelopment | 与基础子 Agent 分开，不因有目录就纳入首发 |
| X07 | Windows sandbox service 与网络代理特定路径 | windows_sandbox_service UnderDevelopment；network_proxy Experimental | 不等于 Windows 全部沙箱都未实现；要按具体后端验收 |

Removed/Deprecated 指的是那个开关的生命周期，不一定表示对应功能已经消失。例如旧沙箱开关移除，不能推导成沙箱不存在。Stable 但 default=false 也不能写成默认开放。

## 4. 桌面/云端/宿主配套功能：独立选择

以下由官方产品文档确认用户功能或接入入口；不声称当前公开仓库提供了它们完整的实现及运营后端。实际可用性还受平台、账户与产品版本限制。

| 编号 | 功能 | 官方证据 | 当前范围提示 |
| --- | --- | --- | --- |
| P01 | 桌面项目/聊天工作台、终端、文件与 diff 展示 | [功能入口](https://learn.chatgpt.com/docs/features)、[终端](https://learn.chatgpt.com/docs/integrated-terminal) | 我们需要自己的任务工作台；无需复刻布局 |
| P02 | 内置浏览器、页面预览、操作与页面批注 | [Browser](https://learn.chatgpt.com/docs/browser) | 可选；Playwright 基础不等于完整浏览器产品 |
| P03 | 原生桌面 Computer Use | [Computer Use](https://learn.chatgpt.com/docs/computer-use) | 可选；比网页操作有更大 OS 权限与验收范围 |
| P04 | 定时任务、会话后续唤醒、后台任务结果入口 | [Scheduled tasks](https://learn.chatgpt.com/docs/automations) | 可选；本地进程退出/设备休眠的行为必须说明 |
| P05 | 云端执行环境与云端任务 | [Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments)；CLI 只有客户端入口不能证明后端开源 | 当前本地运行定位可排除 |
| P06 | IDE 扩展及 IDE 上下文接入 | [IDE extension](https://developers.openai.com/codex/ide) | 可选；独立桌面首发不必同时维护 IDE 产品 |
| P07 | GitHub/GitLab/Slack/Linear 等产品集成 | [第三方集成文档入口](https://learn.chatgpt.com/docs/features)、[Linear](https://learn.chatgpt.com/docs/third-party/linear) | 可经 MCP 按需接入；连接器协议不免除业务实现/授权 |
| P08 | 插件包、发现/安装/共享与市场入口 | [Skills and plugins](https://learn.chatgpt.com/docs/skills-and-plugins)、源码 plugin 模块。[S02] | **插件市场已明确排除**；Skills/MCP 管理仍需保留 |
| P09 | 远程连接/控制、跨设备继续工作 | [Remote connections](https://learn.chatgpt.com/docs/remote-connections)；CLI 有实验 remote 入口。[S03] | **跨设备消息同步已排除**；远程执行也可独立排除 |

未核验项：完整账户/消息同步后端、桌面所有侧栏/附件细节、企业计费与后台权限管理、所有专用文档编辑器与插件的内部实现。不能从 CLI 开源推导整个产品生态开源，也不能从缺少源码推导产品没有这些能力。

## 5. 可以替代自研的免费开源组件

这里的“免费”指相应开源库/工具可以不购买商业许可证来使用其开源部分；模型调用、第三方在线服务、机器资源、签名与分发等成本另算。许可证来自当前官方仓库或官网，发行时须以锁定版本为准。没有实测的数据不用于“最快/最成熟/零成本”结论。

### 建议优先评估的一组组件

| 能力 | 候选 / 许可证 | 可复用的部分 | 仍需自己的应用代码 | 替代边界 |
| --- | --- | --- | --- | --- |
| Agent harness | [Deep Agents JS](https://github.com/langchain-ai/deepagentsjs) / [MIT](https://raw.githubusercontent.com/langchain-ai/deepagentsjs/main/LICENSE) | 模型工具循环、文件工具、上下文、子 Agent、按需规划与 Skills | 工具装配、任务语义、权限与验收 | 可替代大量基础逻辑；部分新特性 Beta，不能统一当作已成熟 |
| 状态执行 | [LangGraph JS](https://github.com/langchain-ai/langgraphjs) / [MIT](https://raw.githubusercontent.com/langchain-ai/langgraphjs/main/LICENSE) | 图状态、checkpoint、interrupt、流式执行基础 | 外部幂等、进程/文件核对、任务恢复契约 | Deep Agents 已基于它，不必再平行建设另一套调度系统 |
| MCP 接入 | [LangChain MCP adapters](https://docs.langchain.com/oss/javascript/langchain/mcp) / LangChain 仓库 [MIT](https://github.com/langchain-ai/langchainjs/blob/main/LICENSE)；或官方 [TS SDK](https://github.com/modelcontextprotocol/typescript-sdk) | 客户端协议、发现、传输、工具适配 | 启停、授权、凭据、超时、工具准入与错误处理 | 当前 adapters 文档为 2.x；SDK 许可见下方说明 |
| 桌面壳 | [Electron](https://github.com/electron/electron) / [MIT](https://raw.githubusercontent.com/electron/electron/main/LICENSE) | 窗口、Node 运行、IPC、桌面平台能力 | 界面、进程分层、安装升级与权限边界 | 对现有 TS/Node 背景是适配候选，不据此声称性能最好 |
| 桌面壳替代 | [Tauri](https://github.com/tauri-apps/tauri) / MIT 或 Apache-2.0 | 系统 WebView、Rust 后端、桌面能力 | 如果 Agent 保留 Node，需要 sidecar、IPC 与分发 | 和 Electron 二选一，不建议同时引入 |
| 本地数据库 | [SQLite](https://www.sqlite.org/copyright.html) / Public Domain | 事务、本地持久化基础 | schema、迁移、备份、并发和任务查询 | checkpoint 表和产品任务记录分别定义职责 |
| Key 落盘保护 | Electron [safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage) / 随 Electron MIT | 使用 OS 机制保护存储字符串 | 读取使用、日志过滤、环境变量隔离、不可用时的行为 | 不是同用户恶意进程的绝对隔离，也不是 Agent 沙箱 |
| 隔离执行 | [Podman](https://github.com/podman-container-tools/podman) / [Apache-2.0](https://github.com/podman-container-tools/podman/blob/main/LICENSE) | OCI 容器生命周期、挂载、资源和网络配置基础 | 镜像、工作区、权限、凭据、终止与回收、产物导出 | Windows 经 WSL2 Linux guest；不是原生 Windows GUI 沙箱 |
| 逻辑/集成测试 | [Vitest](https://vitest.dev/guide/) / [MIT](https://raw.githubusercontent.com/vitest-dev/vitest/main/LICENSE) | 测试、断言、mock、覆盖工具 | 故障场景、恢复用例与验收标准 | mock 通过不证明真实模型完成任务 |
| 浏览器工具/E2E | [Playwright](https://playwright.dev/docs/intro) / [Apache-2.0](https://raw.githubusercontent.com/microsoft/playwright/main/LICENSE) | 浏览器操作、截图、UI 流程验证 | 网站授权、任务行为、连接/关闭、测试用例 | Electron 自动化 API 当前 Experimental，不能泛称桌面 E2E 全成熟 |
| 本地诊断 | [OpenTelemetry JS](https://opentelemetry.io/docs/languages/js/exporters/) / [Apache-2.0](https://raw.githubusercontent.com/open-telemetry/opentelemetry-js/main/LICENSE) | trace/metric SDK、console/OTLP 输出 | 任务关联、脱敏、保留和故障解释 | 不需要购买 SaaS；span 不是产品任务账本 |
| 依赖图展示（可选） | [React Flow](https://reactflow.dev/learn) / [MIT](https://raw.githubusercontent.com/xyflow/xyflow/main/LICENSE) | 节点、边、交互 | 依赖语义、调度、任务状态和验收 | 是 UI 库；Linear 风格列表本身不需要画布 |

### 版本、成熟度和沙箱的特别边界

1. [Deep Agents Skills 文档](https://docs.langchain.com/oss/javascript/deepagents/skills) 当前要求 `deepagents >= 1.7.0`；支持 SKILL.md 和资源渐进加载，但兼容格式不等于 Codex 专属工具/路径/宿主 API 自动兼容。某个 Skill 依赖特定工具时，仍需提供能力或明确报不支持。
2. [Deep Agents overview](https://docs.langchain.com/oss/javascript/deepagents/overview) 标注部分新能力 Beta；开源库与 Managed Deep Agents/LangSmith 托管产品分开。成熟度应按选用的发布版本、功能路径和平台验收，不能只凭品牌判断。
3. 当前 [MCP TS SDK LICENSE](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE) 说明 MIT→Apache-2.0 转换及历史代码/文档的不同许可；不要把整个 main 笼统标为 MIT。无需同时维护 adapter 和一套重复协议实现。
4. [Podman 安装](https://podman.io/docs/installation) 说明 Windows 通过 WSL2 guest、macOS 通过虚拟机运行 Linux 容器。容器是可复用执行基础，不是引入后自动安全；挂载、网络、权限和凭据策略仍决定边界。
5. [Anthropic sandbox-runtime](https://github.com/anthropics/sandbox-runtime) / Apache-2.0 可作为轻量 OS 隔离候选；macOS/Linux 有原生限制机制，当前原生 Windows 支持为 **Alpha**。不能将它列为已经验收的成熟 Windows 替代方案，也不能说完全不支持 Windows。
6. [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/) 不是对所有商业用户无条件免费；不能用“Docker 免费”掩盖桌面产品订阅条件。Podman 是另一条候选路线，不表示零安装成本。
7. [Deep Agents LocalShellBackend](https://docs.langchain.com/oss/javascript/deepagents/backends) 会直接在宿主以当前用户权限执行命令；FilesystemBackend、Electron renderer sandbox、工作目录白名单、child_process/PTY 都不能单独当作 Agent OS 沙箱。[沙箱 backend 说明](https://docs.langchain.com/oss/javascript/deepagents/sandboxes)
8. [safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage) 当前同步接口有弃用标记，实施时按锁定版本选接口；Linux 需检测 secret service/后端可用性，不能默默降级后仍宣称同等保护。

### 一个更省自研的备选：复用 Codex 执行层

Codex 仓库本身为 Apache-2.0。[LICENSE][S34] 可评估通过其 App Server/SDK 复用现有循环、工具、沙箱与 Skills/MCP，自己做任务工作台、状态映射和验收。SDK 是把现成 Agent 嵌入应用，不是通用基础设施框架；会带入其协议、模型支持、版本和功能耦合，需要核对实际支持范围。[SDK][S30]

| 路线 | 好处 | 代价 | 适合的目标 |
| --- | --- | --- | --- |
| Codex 执行层 + 自有任务平台 | 更少重复建设底层执行能力 | 上游行为/协议耦合；模型与产品行为受其边界约束 | 更看重工作台产品和交付控制的实践 |
| Deep Agents/LangGraph + 组件 | 可自行决定任务行为、模型与工具边界 | 更多集成、执行层适配与回归验证 | 更看重独立 Agent 平台完整工程实践 |

两条路线都要自己维护产品任务事实。不能把 SDK 的完成消息、计划状态或模型 Review 直接当作用户验收。

## 6. 真正需要自己的产品逻辑

这不是要求自研替代框架，而是框架之外平台必须定义的行为：

- 任务、子任务、依赖、优先级、计划版本；每次拆分/合并/取消为什么发生。
- `Task → Run/Attempt → Tool execution → Artifact/Evidence` 的关联；同一任务重试不覆盖旧证据。
- “模型提议完成 / 执行结束 / 检查通过 / 用户接受”分别记录；缺少检查为未验证，不伪造通过。
- 等待用户、等待工具、等待依赖、失败与取消等状态，以及实际阻塞原因。
- 工具/进程的取消和超时语义；重启后核对进程、工作区、外部效果，不盲目重放写操作。
- 预算、并发准入、权限与凭据作用域；子 Agent 不自动扩大权限或获得无限预算。
- 用户已有文件修改、产物版本、导出和可恢复操作的处理。
- 本地数据迁移、备份、清理、诊断导出、模型发送范围和远端工具数据流说明。

## 7. 可研究的差异化：围绕工作台形成完整行为

这是产品假设，不是已证实 Codex 不具备相应能力或用户愿意付费。与 Codex 比较必须使用相同任务、环境与验收标准；分别报告实际模型、运行环境和人工干预。

| 编号 | 差异化候选 | 具体做到什么 | 怎样证明有价值 |
| --- | --- | --- | --- |
| D01 | 任务作为核心对象 | 每个子任务有稳定 ID、依赖、执行记录、负责人/Agent、产物和验收；跨轮对话仍可管理 | 用户能直接找到某项工作，修改/取消/继续，不用从聊天记录重建状态 |
| D02 | 有依据的进度与阻塞 | 展示已验证数量、执行项、等待原因、耗时和计划变化；不把步骤数量当时间百分比 | 正常、等待输入、卡命令、依赖失败时，用户能正确判断下一步 |
| D03 | 子任务级控制与恢复 | 单项重试、人工接手、重新规划受影响依赖，保留已有有效结果 | 注入断线、进程退出、模型超时后，重复副作用和人工重做是否减少 |
| D04 | 可验收的交付 | 检查结果绑定产物版本，展示未验证项；用户能接受或提出返工 | 在固定任务集上减少错误“已完成”和用户复核时间 |
| D05 | 看得懂的成本与本地数据流 | 每个任务/子任务记录实际 usage、估算费用与预算；说明哪些数据发给哪个服务 | 对照账单/模型 usage，用户能限制任务并解释费用；不声称绝对不出本地 |
| D06 | 可复用任务模板 | 把输入、步骤约束、工具权限、产物与验收组成模板；Skills 提供操作知识 | 同一类任务在不同项目可重复完成，模板不只是固定提示词 |
| D07 | 中文用户任务工作台 | 清晰中文状态/错误/确认、安装诊断与常见任务流程 | 真实用户能独立完成配置、任务执行、错误恢复，减少支持介入 |

推荐研究主线是 D01–D04 的整体流程；D05–D07 根据目标用户选择。功能多、支持很多模型、拥有 Skills/MCP/本地历史，并不足以单独证明竞争差异。

### 示例：任务完成事实如何呈现

```text
目标：修复登录问题并交付检查结果
├─ T1 复现问题       已验证   证据：失败用例与日志
├─ T2 修改实现       执行结束 产物：补丁版本 A
├─ T3 回归检查       阻塞     原因：测试服务无法连接；尚未验证
└─ T4 交付说明       待执行   依赖：T3，或用户接受带限制交付

计划 v2：增加 T3 的环境诊断，保留 T1/T2 的结果。
可操作：补充测试地址 / 执行环境诊断 / 人工接手 / 取消。
```

不要把 `completedSteps / totalSteps` 显示成预计时间完成率。实际运行时间可显示；ETA 如未来提供，应基于实测并表达不确定性。

## 8. 供用户选择的清单

下面勾选框默认空白，表示未形成产品规格；只复述已明确的约束，不自动扩展为实施授权。

| 选择项 | 已知约束 / 需要决定的内容 |
| --- | --- |
| 已明确 | 独立于客服项目；首发正式可用；Linear 风格本地工作台；BYOK；本地历史；Skills/MCP |
| 已排除 | 平台 GPT 账号登录、账号消息同步、插件市场 |
| [ ] 任务与产物范围 | 代码、文档、数据、网页任务分别承诺到什么程度 |
| [ ] 首发平台 | Windows / macOS / Linux；宿主平台与沙箱内环境分别定义 |
| [ ] 执行底座 | Codex runtime 或 Deep Agents/LangGraph 组件路线 |
| [ ] 运行方式 | 本地 UI+本地受控执行；是否允许明确提示的宿主执行；是否需后台常驻 |
| [ ] 模型范围 | 单提供商多个模型 / 多提供商 / 本地模型；逐项兼容验收 |
| [ ] C01–C38 | 按编号保留、不要或待定；基础提示不代表全部强制 |
| [ ] X01–X07 | 是否需要其中任何高级/条件能力 |
| [ ] P01–P09 | 桌面、浏览器、Computer Use、定时任务、IDE/云/远端配套分别选择 |
| [ ] D01–D07 | 核心差异化、用户收益和对照验收方式 |

## 9. 验证记录

- 源码调查：已下载固定 SHA，检查 CLI/TUI、核心循环、计划工具、App Server 协议、feature registry、沙箱、Skills、MCP、记忆、SDK 等文件。
- 文档与许可证：已查官方文档和仓库；候选组件未安装，未做兼容性、性能或安全验收。后续必须锁定版本。
- 确定性流程测试：未执行；本轮仅研究文档，无实现变更。
- 真实模型验证：未执行。
- 真实业务集成验证：未执行。

## 源码索引（固定提交）

[S01]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/session/turn.rs
[S02]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/features/src/lib.rs
[S03]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/cli/src/main.rs
[S04]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/model-provider-info/src/lib.rs
[S05]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/tui/src/slash_command.rs
[S06]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/tools/handlers/view_image.rs
[S07]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/tools/handlers/plan.rs
[S08]: https://github.com/openai/codex/tree/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/tools/handlers
[S09]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/app-server-protocol/src/protocol/common.rs
[S10]: https://github.com/openai/codex/tree/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/thread-store
[S11]: https://github.com/openai/codex/tree/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/context_manager
[S12]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/agents_md.rs
[S13]: https://github.com/openai/codex/tree/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/skills
[S14]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/mcp.rs
[S15]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/tools/router.rs
[S16]: https://github.com/openai/codex/tree/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/agent/control
[S17]: https://github.com/openai/codex/tree/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/unified_exec
[S18]: https://github.com/openai/codex/tree/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/file-search
[S19]: https://github.com/openai/codex/tree/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/apply-patch
[S20]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/tasks/review.rs
[S21]: https://github.com/openai/codex/tree/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/worktree
[S22]: https://github.com/openai/codex/tree/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/ext/web-search
[S23]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/linux-sandbox/README.md
[S24]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/tools/orchestrator.rs
[S25]: https://github.com/openai/codex/tree/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/keyring-store
[S26]: https://github.com/openai/codex/tree/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/hooks
[S27]: https://github.com/openai/codex/tree/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/ext/goal
[S28]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/memories/README.md
[S29]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/exec/src/cli.rs
[S30]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/sdk/typescript/README.md
[S31]: https://github.com/openai/codex/tree/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/config
[S32]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/otel/README.md
[S33]: https://github.com/openai/codex/tree/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/ext/image-generation
[S34]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/LICENSE
[S35]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/app-server-protocol/src/protocol/v2/thread.rs
[S36]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/protocol/src/plan_tool.rs
[S37]: https://github.com/openai/codex/tree/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/network-proxy
