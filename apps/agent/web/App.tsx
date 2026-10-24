import { useEffect, useState } from "react";
import { CopilotChat, CopilotKitProvider, useAgent, useRenderTool } from "@copilotkit/react-core/v2";
import { informationFormSchema, informationSpecSchema, type InformationForm as Form } from "../src/interactions/contracts.ts";
import { InformationForm } from "./InformationForm.tsx";

function Conversation({ user }: { user: string }) {
  const { agent } = useAgent({ agentId: "support" });
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [checked, setChecked] = useState(false);
  const [pending, setPending] = useState<Form>();
  const [refresh, setRefresh] = useState(0);
  const storageKey = `leeway-support-thread:${user}`;
  useEffect(() => {
    const previous = localStorage.getItem(storageKey);
    if (previous && /^[A-Za-z0-9_-]{1,128}$/.test(previous)) agent.threadId = previous;
    localStorage.setItem(storageKey, agent.threadId);
    setReady(true);
    const subscription = agent.subscribe({
      onRunStartedEvent: () => { setError(""); },
      onRunFinishedEvent: () => { setRefresh((value) => value + 1); },
    });
    return () => subscription.unsubscribe();
  }, [agent, storageKey]);
  useEffect(() => {
    if (!ready || agent.isRunning) return;
    const abort = new AbortController();
    // StrictMode/刷新会取消观察请求，但服务器可能仍在释放锁；只重试无模型调用的 GET。
    void (async () => {
      let response: Response | undefined;
      for (let attempt = 0; attempt < 4; attempt++) {
        response = await fetch(`/api/conversation?thread=${encodeURIComponent(agent.threadId)}`, { signal: abort.signal });
        if (response.status !== 423) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
        abort.signal.throwIfAborted();
      }
      return response!;
    })().then(async (response) => {
        if (!response.ok) throw new Error();
        const state = await response.json();
        setPending(state.information ? informationFormSchema.parse(state.information) : undefined);
        setChecked(true);
        setError("");
      }).catch(() => { if (!abort.signal.aborted) setError("无法核对当前流程状态，请重试或新建会话。"); });
    return () => abort.abort();
  }, [agent, agent.isRunning, ready, refresh]);
  // 工具结果仍由 AG-UI 承载；实际表单始终从服务端等待状态恢复，只渲染一份。
  useRenderTool({ name: "request_information", parameters: informationSpecSchema,
    render: () => null,
  }, []);
  if (!ready) return <p>正在恢复会话…</p>;
  return <>
    <div className="chat-toolbar"><span>{pending ? "等待补充资料" : "当前会话"}</span><button disabled={agent.isRunning} onClick={() => {
      localStorage.removeItem(storageKey); location.reload();
    }}>新会话</button></div>
    {error && <div role="alert" className="error banner">{error}</div>}
    <div className={pending ? "chat-panel awaiting-information" : "chat-panel"}>
      <CopilotChat agentId="support" input={{ textArea: { disabled: !!pending || !checked }, sendButton: { disabled: !!pending || !checked } }} labels={{ chatInputPlaceholder: pending ? "请填写下方表单，或取消补充" : "描述你遇到的问题…", welcomeMessageText: "有什么可以帮你？", chatDisclaimerText: "请勿提交密码、验证码或密钥。" }}
        onError={() => setError("本次执行未完成。请核对表单和流程状态；不会自动重复执行。 ")} />
    </div>
    {pending && <div className="pending-information" aria-label="等待补充资料"><p>流程已暂停，请填写表单或取消补充。刷新后可继续填写。</p>
      <InformationForm key={pending.formId} form={pending} onResolved={() => setRefresh((value) => value + 1)} /></div>}
  </>;
}

export function App() {
  const [user, setUser] = useState("");
  useEffect(() => { void fetch("/api/session").then((response) => response.json()).then((data) => setUser(data.user ?? "")); }, []);
  return <main className="support-shell">
    <aside><div className="brand">L<span>Leeway Support</span></div><div className="eyebrow">客服调试工作台</div>
      <h1>把问题说清楚，<br />一起找到下一步。</h1><p>直接描述你遇到的问题。需要补充资料时，助手会暂停并提供表单。</p>
      <div className="capabilities"><span>连续对话</span><span>补充信息</span><span>跨会话记忆</span></div>
      <div className="identity"><span className="status-dot" />本地开发身份 · {user || "正在连接"}</div>
    </aside>
    <section className="conversation" aria-label="客服对话">
      {user && <CopilotKitProvider runtimeUrl={`${location.origin}/api/copilotkit`} agentId="support"><Conversation user={user} /></CopilotKitProvider>}
    </section>
  </main>;
}
