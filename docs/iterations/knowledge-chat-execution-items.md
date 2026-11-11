# 知识库问答执行条目与回答校正

日期：2026-11-12

## 1. 解决的问题

Knowledge Chat 原来只有一条提示和回答文本增量，用户无法区分知识检索、联网结果和回答生成；回答完成时虽然会用 `support.result` 覆盖文本，但没有独立消息完成事件和条目 ID。本轮为知识库聊天增加版本为 1 的公开执行事件，覆盖知识检索、真实联网搜索结果和回答生成，并使用完成全文校正同一回答消息。

输入是现有知识聊天请求和 Agent 执行结果。输出仍是 SSE：`support.execution` 更新执行条目，`TEXT_MESSAGE_CONTENT` 流式追加可见文本，`support.message.completed` 提供最终回答全文。失败、等待补资料和正常完成分别保留不同状态。

## 2. 主流方式与取舍

Codex 风格的公开协议把一轮请求拆成稳定 ID 的执行条目和消息增量；流式增量用于即时反馈，完成事件中的全文用于修正丢失或不完整的片段。本轮采用同样的状态模型，但只展示服务端确认的公开状态和结果摘要，不透传模型私有推理或供应商原始 JSON。

联网搜索当前只在供应商结果中确认实际 `web_search_call` 后发布已完成条目。供应商流式搜索开始事件尚未接入，因此不伪造“正在联网搜索”。断线重连后的条目恢复和持久化留到下一切片。

## 3. 调用链

```text
KnowledgeChat
  → Knowledge BFF
  → Agent knowledge-chat SSE
  → runSupportAgent
  → search_knowledge / 模型
  → support.execution 与文本事件
  → 前端按 itemId 更新条目、按 messageId 追加回答
  → support.message.completed 覆盖同一回答的最终全文
```

知识检索条目由 `knowledgeTool` 在 HTTP 检索成功、失败或无匹配后发布；回答条目由知识聊天路由在收到第一段可见文本时开始，完成、等待或失败时结束。执行事件带 `version: 1`，前端拒绝未知版本或缺少 ID/标题的载荷。

## 4. 验证结果

- 确定性：Agent 135 项测试通过，新增检索执行条目测试验证 started/completed 使用同一 itemId；Knowledge 37 项测试通过。
- 类型：Agent、Knowledge typecheck 通过。
- 构建：Agent、Knowledge 生产构建通过。
- 真实模型、真实联网搜索、真实浏览器执行条目显示：本轮未重新执行。
- 真实业务系统：未接入。

## 5. 遗留事项

- 供应商联网搜索的 started/searching 事件需要从模型流回调映射后再展示“正在联网搜索”。
- 执行条目当前只在活动 SSE 中存在；刷新或断线后只恢复持久消息和结果，尚不恢复完整条目时间线。
- 需要补充路由级 SSE 测试，覆盖最终全文校正、等待、失败、断流和 reasoning 元数据过滤。
