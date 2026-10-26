"use client";

import { useEffect, useState } from "react";
import { CopilotChat, CopilotKitProvider, useAgent, useCopilotKit, useRenderTool } from "@copilotkit/react-core/v2";
import { informationSpecSchema, type InformationForm as Form } from "../src/interactions/contracts.ts";
import { canSendConversationMessage, conversationSnapshotSchema, pendingMessageSchema, type ConversationSnapshot } from "../src/conversations/contracts.ts";
import { InformationForm } from "./InformationForm.tsx";

const statusLabels: Record<ConversationSnapshot["status"], string> = {
  empty: "新会话", running: "正在处理", waiting_for_input: "等待补充资料", completed: "已完成", failed: "执行失败", unknown: "结果待核对",
};
function Conversation({ user }: { user: string }) {
  const { agent } = useAgent({ agentId: "support" });
  const { copilotkit } = useCopilotKit();
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [checked, setChecked] = useState(false);
  const [pending, setPending] = useState<Form>();
  const [state, setState] = useState<ConversationSnapshot>();
  const [refresh, setRefresh] = useState(0);
  const [unsent, setUnsent] = useState<{ id: string; content: string }>();
  const storageKey = `leeway-support-thread:${user}`;
  useEffect(() => {
    const previous = localStorage.getItem(storageKey);
    if (previous && /^[A-Za-z0-9_-]{1,128}$/.test(previous)) agent.threadId = previous;
    localStorage.setItem(storageKey, agent.threadId);
    const outboxKey = `${storageKey}:${agent.threadId}:pending`;
    const cached = sessionStorage.getItem(outboxKey);
    try { if (cached) setUnsent(pendingMessageSchema.parse(JSON.parse(cached))); } catch { sessionStorage.removeItem(outboxKey); }
    setReady(true);
    const subscription = agent.subscribe({
      onRunInitialized: ({ input }) => {
        if (input.forwardedProps?.informationSubmission) return;
        const latest = input.messages.at(-1);
        const parsed = pendingMessageSchema.safeParse(latest && { id: latest.id, content: latest.content });
        if (latest?.role === "user" && parsed.success) {
          sessionStorage.setItem(outboxKey, JSON.stringify(parsed.data));
          setUnsent(parsed.data);
        }
      },
      onRunStartedEvent: () => { setError(""); },
      onRunFinalized: () => { setRefresh((value) => value + 1); },
    });
    return () => subscription.unsubscribe();
  }, [agent, storageKey]);
  useEffect(() => {
    if (!ready || agent.isRunning) return;
    const abort = new AbortController();
    let poll: ReturnType<typeof setTimeout> | undefined;
    void fetch(`/api/conversation?thread=${encodeURIComponent(agent.threadId)}`, { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const snapshot = conversationSnapshotSchema.parse(await response.json());
        if (abort.signal.aborted || agent.isRunning) return;
        setState(snapshot);
        setPending(snapshot.information);
        agent.pendingInterrupts = snapshot.information?.interruptId && snapshot.information.status === "pending"
          ? [{ id: snapshot.information.interruptId, reason: "information", message: snapshot.information.spec.title }] : [];
        setChecked(true);
        setError("");
        const key = `${storageKey}:${agent.threadId}:pending`;
        const pendingRaw = sessionStorage.getItem(key);
        if (pendingRaw) {
          const pendingInput = pendingMessageSchema.parse(JSON.parse(pendingRaw));
          const accepted = snapshot.requests.find((request) => request.requestId === pendingInput.id);
          if (accepted) { sessionStorage.removeItem(key); setUnsent(undefined); }
        }
        // 持久档案是展示事实源；只在非执行状态替换，未完成片段不伪装为成功消息。
        agent.setMessages(snapshot.messages);
        if (snapshot.status === "running") poll = setTimeout(() => setRefresh((value) => value + 1), 1500);
      }).catch(() => {
        if (!abort.signal.aborted) { setChecked(false); setError("无法核对会话记录，请点击核对状态；不会自动重发消息。"); }
      });
    return () => { abort.abort(); if (poll) clearTimeout(poll); };
  }, [agent, agent.isRunning, ready, refresh, storageKey]);
  useRenderTool({ name: "request_information", parameters: informationSpecSchema, render: () => null }, []);
  if (!ready) return <p>正在恢复会话…</p>;
  const blocked = !!pending || !!unsent || !checked || !state || !canSendConversationMessage(state.status);
  return <>
    <div className="chat-toolbar"><span>{agent.isRunning ? "正在处理" : state ? statusLabels[state.status] : "正在恢复会话"}</span>
      <div><button disabled={agent.isRunning} onClick={() => setRefresh((value) => value + 1)}>核对状态</button>{" "}
      <button disabled={agent.isRunning} onClick={() => {
        sessionStorage.removeItem(`${storageKey}:${agent.threadId}:pending`); localStorage.removeItem(storageKey); location.reload();
      }}>新会话</button></div>
    </div>
    {error && <div role="alert" className="error banner">{error}</div>}
    {state?.notice && <p className="state-notice" role="status">{state.notice}</p>}
    {unsent && checked && state && ["empty", "completed"].includes(state.status) && <div className="state-notice" role="status">
      服务端尚未确认接收上一条消息。可核对状态，或用原请求标识重新发送。
      <button disabled={agent.isRunning} onClick={() => {
        setChecked(false);
        if (!agent.messages.some((message) => message.id === unsent.id)) agent.addMessage({ id: unsent.id, role: "user", content: unsent.content });
        void copilotkit.runAgent({ agent }).catch(() => setError("发送仍未确认，请核对状态。")).finally(() => setRefresh((value) => value + 1));
      }}>重发原消息</button>
    </div>}
    <div className={pending ? "chat-panel awaiting-information" : "chat-panel"}>
      <CopilotChat agentId="support" input={{ textArea: { disabled: blocked }, sendButton: { disabled: blocked } }}
        labels={{ chatInputPlaceholder: pending ? "请填写下方表单，或取消补充" : blocked ? "请先核对状态或新建会话" : "描述你遇到的问题…", welcomeMessageText: "有什么可以帮你？", chatDisclaimerText: "请勿提交密码、验证码或密钥。" }}
        onError={() => { setChecked(false); setError("发送或执行未确认，正在核对服务端记录；不会自动重发。"); setRefresh((value) => value + 1); }} />
    </div>
    {pending && <div className="pending-information" aria-label="等待补充资料"><p>流程已暂停，请填写表单或取消补充。刷新后可继续填写。</p>
      <InformationForm key={pending.formId} form={pending} onResolved={() => setRefresh((value) => value + 1)} /></div>}
    {!!state?.requests.length && <details className="request-history"><summary>处理记录（{state.requests.length}）</summary>
      <ul>{state.requests.map((request) => <li key={request.requestId}>{statusLabels[request.status]} · <code>{request.requestId}</code></li>)}</ul>
    </details>}
  </>;
}
export function SupportChat() {
  const [user, setUser] = useState("");
  useEffect(() => { void fetch("/api/session").then((response) => response.json()).then((data) => setUser(data.user ?? "")); }, []);
  return <main className="support-shell">
    <aside><div className="brand">L<span>Leeway Support</span></div><div className="eyebrow">客服调试工作台</div>
      <h1>把问题说清楚，<br />一起找到下一步。</h1><p>直接描述你遇到的问题。需要补充资料时，助手会暂停并提供表单。</p>
      <div className="capabilities"><span>连续对话</span><span>补充信息</span><span>跨会话记忆</span></div>
      <div className="identity"><span className="status-dot" />本地开发身份 · {user || "正在连接"}</div>
    </aside>
    <section className="conversation" aria-label="客服对话">
      {user && <CopilotKitProvider runtimeUrl="/api/copilotkit" agentId="support"><Conversation user={user} /></CopilotKitProvider>}
    </section>
  </main>;
}
