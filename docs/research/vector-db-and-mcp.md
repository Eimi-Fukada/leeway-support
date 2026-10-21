# 向量数据库与 MCP 边界调研

核实日期：2026-10-21。仅参考官方文档；建议部分是结合本项目目标的工程判断，未进行项目负载基准测试。

## 结论

本项目以多业务客服、知识库平台、RAG 实战为目标，建议 **PostgreSQL 保存业务事实，Qdrant 保存可重建的检索索引**。Qdrant 便于集中练习 dense/sparse 混合召回、过滤和检索调优；这是对项目目标的取舍，不是对所有场景的性能排名。

如果第一阶段最重要的是少维护一个基础设施，且文档规模和并发尚未形成压力，则 **PostgreSQL + pgvector** 完全合理。不要按未经压测的“百万向量阈值”自动换库。向量库后端通过窄接口封装，不同时实现两套生产适配器。

## 选型依据

| 方案 | 官方能力 | 本项目采用条件 |
| --- | --- | --- |
| Qdrant | dense/sparse 向量、混合查询融合、payload 过滤和索引、collection alias | 默认选择，检索是独立能力，接受额外服务和索引同步成本 |
| pgvector | PostgreSQL 内精确/近似向量检索，可结合 SQL、JOIN、事务和恢复能力 | 优先精简基础设施、强关系查询，能够单独验证带过滤条件的 ANN 召回 |
| Milvus | Lite、Standalone、Distributed 部署形态，分离存储与计算的扩展架构 | 已有 Milvus 经验或明确分布式检索需求，并有团队维护能力时评估 |
| 托管向量库 | 例如 Pinecone 的 namespace 和托管服务 | 更重视减少数据库运维，区域、网络、成本和数据落地要求允许时评估；也可直接采用 Qdrant Cloud |

来源：[Qdrant hybrid queries](https://qdrant.tech/documentation/search/hybrid-queries/)、[Qdrant filtering](https://qdrant.tech/documentation/search/filtering/)、[pgvector 官方 README](https://github.com/pgvector/pgvector)、[Milvus deployment options](https://milvus.io/docs/install-overview.md)、[Milvus architecture](https://milvus.io/docs/architecture_overview.md)、[Pinecone production checklist](https://docs.pinecone.io/guides/operations/moving-to-production)。

pgvector 的近似索引结合过滤时，过滤可能在索引扫描后执行，返回不足预期数量的候选；官方提供 iterative scans、分区等方案。必须用真实租户/产品过滤后的数据做 Recall@k 和延迟验证。[pgvector filtering / iterative scans](https://github.com/pgvector/pgvector#filtering)

## 中文混合检索

Qdrant 当前官方 BM25 文档提供 `multilingual` tokenizer，适用于不以空格分词的语言；默认 `word` tokenizer 和英文 stemming/stopwords 不能直接作为中文业务配置。入库与查询必须使用一致的处理设置。文档特别标注 FastEmbed 不支持 `tokenizer` 选项，不能把服务端 BM25 配置照搬到 FastEmbed；需验证所锁定服务端、推理部署和 JS SDK 的支持范围。[Qdrant full-text search](https://qdrant.tech/documentation/search/text-search/full-text-search/)

工程建议：先用中文 dense embedding 建立基线，再对“产品型号、错误码、接口名、版本号”样本增加 BM25/sparse 召回，使用 RRF 融合并评估 reranker。中文业务词、混合英文符号、错别字和同义表达都纳入评测。text payload 的全文过滤只决定是否匹配，不等于 BM25 排名，不能拿过滤功能冒充完整的混合检索。

## 隔离、索引和知识发布

工程建议：检索服务从受信会话构建 `tenant_id + app_id + kb_id + release_id + visibility` 等过滤条件，不允许模型或浏览器任意指定授权范围。dense 和 sparse 两个候选分支都应用同样的过滤。常用字段预先创建 payload index；官方建议在写入数据前建索引，才能生成相应的 filter-aware HNSW 边。[Qdrant indexing](https://qdrant.tech/documentation/manage-data/indexing/)

工程建议：文档版本和知识库发布版本分开管理。构建不可变的 release 索引，完成写入、可查询性和抽样验证后，最后在 PostgreSQL 事务内更新 active release 指针；一次检索固定一个 release，引用绑定具体文档版本。失败版本不发布，重试使用确定性 chunk ID，旧版本保留以便回滚；删除/撤权另有立即生效的运行时校验，不能等待后台重建。

Qdrant 的 alias 删除与新建可放在同一次请求中原子切换，适合整 collection 的 embedding 升级；共享 collection 下单知识库发布更适合 release 过滤。**alias 原子性不等于 PostgreSQL 与 Qdrant 之间的分布式事务**。集群点数据的一致性还受 write consistency、read consistency 和 ordering 配置影响，不能把 `wait=true` 解读成跨系统事务保证。[Qdrant model migration](https://qdrant.tech/documentation/tutorials-operations/embedding-model-migration/)、[consistency guarantees](https://qdrant.tech/documentation/scaling/consistency-guarantees/)、[horizontal scaling](https://qdrant.tech/documentation/scaling/horizontal-scaling/)

## MCP 与 SDK 的边界

官方 HTTP MCP 授权规范定义 transport 层授权。受保护 MCP server 要验证 token 是发给自己的；不能把发给其他资源的 token 当成 MCP token 接收并直接透传，避免 confused deputy。[MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)、[MCP security best practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)

工程建议：浏览器 SDK 负责客服 UI、流式消息和短期客服会话凭据；业务 server SDK/adapter 提供业务侧 MCP server。调用链为 `Agent runtime → policy/tool gateway → MCP client → 业务 MCP server → 业务 API`。产品系统始终拥有用户身份、订单归属、额度和操作授权；客服系统保存受限会话与委托信息，避免把业务主 token 暴露给模型或复用到不同 audience。

工具 schema 只定义输入形状，不代表业务授权。网关做工具白名单、预算、超时和审计，业务执行端每次核验当前用户与资源权限。写操作使用 prepare/confirm/execute、幂等键和结果查询；人工确认绑定参数与有效期，模型不能自行制造批准。网络超时后先查询执行状态再决定重试。上述流程是本项目工程契约，并非声称 MCP 协议替业务实现了这些能力。

## 验收边界

本次核实的是文档能力与设计边界，尚未锁定依赖版本、部署数据库或验证 SDK/API 兼容性。正式选型用同一中文客服问答集、相同 embedding 和过滤条件对比召回、错误引用率、无答案拒答率、延迟、内存及恢复流程；尤其包含跨租户负例、草稿不可见、撤权立即生效、发布中断和重复执行场景。

获取方式：按 agent-reach 的网页读取指引尝试 Jina Reader，访问超时无正文，改用 web 工具直接读取和搜索上述官方站点。
