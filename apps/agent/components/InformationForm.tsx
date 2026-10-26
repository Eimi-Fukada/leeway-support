// 由 SupportChat 的客户端入口引用；onResolved 只在客户端组件之间传递。
import { useEffect, useState } from "react";
import { useAgent, useCopilotKit } from "@copilotkit/react-core/v2";
import type { Message } from "@ag-ui/core";
import {
  informationFormSchema,
  validateAnswers,
  type InformationForm as Form,
} from "../src/interactions/contracts.ts";

export function InformationForm({ form, onResolved }: { form: Form; onResolved?: () => void }) {
  const { agent } = useAgent({ agentId: "support" });
  const { copilotkit } = useCopilotKit();
  const [current, setCurrent] = useState(form);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [submissionId] = useState(() => {
    const key = `support-submission:${form.formId}`;
    const saved = sessionStorage.getItem(key);
    const id = saved ?? crypto.randomUUID();
    sessionStorage.setItem(key, id);
    return id;
  });
  // 执行新一轮后重新核对服务端状态；历史卡片不能继续提交。
  useEffect(() => {
    const abort = new AbortController();
    void fetch(
      `/api/information/${form.formId}?thread=${encodeURIComponent(agent.threadId)}`,
      { signal: abort.signal },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error();
        setCurrent(informationFormSchema.parse(await response.json()));
      })
      .catch(() => {
        if (!abort.signal.aborted) setError("无法核对表单状态，请稍后再试。");
      });
    return () => abort.abort();
  }, [form.formId, agent.threadId, agent.isRunning]);
  const unavailable =
    current.status !== "pending" || !current.interruptId || Date.parse(current.expiresAt) <= Date.now();
  async function submit(cancelled = false) {
    setError("");
    try {
      const values = cancelled ? {} : validateAnswers(current.spec, answers);
      if (!current.interruptId) throw new Error("暂停点不可用，请刷新表单。");
      setSending(true);
      // 页面只传答案和引用；身份、原始规格及状态都由服务端重新读取。
      if (!agent.messages.some((message: Message) => message.id === submissionId))
        agent.addMessage({
          id: submissionId,
          role: "user",
          content: cancelled ? "取消补充信息。" : "提交补充信息。",
        });
      await copilotkit.runAgent({
        agent,
        resume: [{ interruptId: current.interruptId, status: cancelled ? "cancelled" : "resolved" }],
        forwardedProps: {
          informationSubmission: {
            formId: current.formId,
            formVersion: current.formVersion,
            submissionId,
            interruptId: current.interruptId,
            cancelled,
            answers: values,
          },
        },
      });
      const response = await fetch(
        `/api/information/${form.formId}?thread=${encodeURIComponent(agent.threadId)}`,
      );
      if (response.ok)
        setCurrent(informationFormSchema.parse(await response.json()));
      onResolved?.();
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message.startsWith("补充信息：")
          ? cause.message
          : "提交未完成，请检查表单状态；不会自动重复执行。",
      );
    } finally {
      setSending(false);
    }
  }
  return (
    <form
      className="information-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="card-kicker">补充信息</div>
      <h3>{current.spec.title}</h3>
      <p>{current.spec.description}</p>
      <fieldset disabled={unavailable || sending || agent.isRunning}>
        {current.spec.fields.map((field) => (
          <label key={field.key}>
            <span>
              {field.label}
              {field.required && <span aria-label="必填"> *</span>}
            </span>
            {field.type === "select" ? (
              <select
                name={field.key}
                required={field.required}
                value={answers[field.key] ?? ""}
                onChange={(event) =>
                  setAnswers((previous) => ({
                    ...previous,
                    [field.key]: event.target.value,
                  }))
                }
              >
                <option value="">请选择</option>
                {field.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : field.type === "textarea" ? (
              <textarea
                name={field.key}
                required={field.required}
                maxLength={2000}
                rows={3}
                value={answers[field.key] ?? ""}
                onChange={(event) =>
                  setAnswers((previous) => ({
                    ...previous,
                    [field.key]: event.target.value,
                  }))
                }
              />
            ) : (
              <input
                name={field.key}
                required={field.required}
                maxLength={500}
                value={answers[field.key] ?? ""}
                onChange={(event) =>
                  setAnswers((previous) => ({
                    ...previous,
                    [field.key]: event.target.value,
                  }))
                }
              />
            )}
          </label>
        ))}
        <button type="submit">{sending ? "正在提交…" : "提交信息"}</button>
        <button type="button" onClick={() => { void submit(true); }}>取消补充</button>
      </fieldset>
      {unavailable && (
        <p className="form-status">
          {current.status === "submitted"
            ? "资料已接收"
            : "表单已失效，请新建会话"}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </form>
  );
}
