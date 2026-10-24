import { useEffect, useState } from "react";
import { CopilotChat, CopilotKitProvider, useAgent, useRenderTool } from "@copilotkit/react-core/v2";
import { informationFormSchema, informationSpecSchema } from "../src/interactions/contracts.ts";
import { InformationForm } from "./InformationForm.tsx";

function Conversation() {
  const { agent } = useAgent({ agentId: "support" });
  const [error, setError] = useState("");
  useRenderTool({ name: "request_information", parameters: informationSpecSchema,
    render: (props) => {
      if (props.status !== "complete") return <p className="preparing">正在整理需要补充的信息…</p>;
      try {
        const form = informationFormSchema.parse(JSON.parse(props.result));
        return <InformationForm key={form.formId} form={form} />;
      } catch { return <p role="alert">表单无法显示，请直接在聊天框补充信息。</p>; }
    },
  }, []);
  return <>
    <div className="chat-toolbar"><span>当前会话</span><button disabled={agent.isRunning} onClick={() => location.reload()}>新会话</button></div>
    {error && <div role="alert" className="error banner">{error}</div>}
    <CopilotChat agentId="support" labels={{ chatInputPlaceholder: "描述你遇到的问题…", welcomeMessageText: "有什么可以帮你？", chatDisclaimerText: "请勿提交密码、验证码或密钥。" }}
      onError={() => setError("本轮未完成，片段不是完整结果。请核对提交状态；失败会话请新建后继续。 ")} />
  </>;
}

export function App() {
  const [user, setUser] = useState("");
  useEffect(() => { void fetch("/api/session").then((response) => response.json()).then((data) => setUser(data.user ?? "")); }, []);
  return <main className="support-shell">
    <aside><div className="brand">L<span>Leeway Support</span></div><div className="eyebrow">客服调试工作台</div>
      <h1>把问题说清楚，<br />一起找到下一步。</h1><p>直接描述你遇到的问题。需要补充资料时，助手会在对话中提供表单。</p>
      <div className="capabilities"><span>连续对话</span><span>补充信息</span><span>跨会话记忆</span></div>
      <div className="identity"><span className="status-dot" />本地开发身份 · {user || "正在连接"}</div>
    </aside>
    <section className="conversation" aria-label="客服对话">
      <CopilotKitProvider runtimeUrl={`${location.origin}/api/copilotkit`} agentId="support"><Conversation /></CopilotKitProvider>
    </section>
  </main>;
}
