import { useEffect, useState } from "react";
import { useAgent, useCopilotKit } from "@copilotkit/react-core/v2";
import {
  informationFormSchema,
  validateAnswers,
  type InformationForm as Form,
} from "../src/interactions/contracts.ts";

export function InformationForm({ form }: { form: Form }) {
  const { agent } = useAgent({ agentId: "support" });
  const { copilotkit } = useCopilotKit();
  const [current, setCurrent] = useState(form);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [submissionId] = useState(() => crypto.randomUUID());
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
    current.status !== "pending" || Date.parse(current.expiresAt) <= Date.now();
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const values = validateAnswers(current.spec, answers);
      setSending(true);
      // 页面只传答案和引用；身份、原始规格及状态都由服务端重新读取。
      if (!agent.messages.some((message) => message.id === submissionId))
        agent.addMessage({
          id: submissionId,
          role: "user",
          content: "提交补充信息。",
        });
      await copilotkit.runAgent({
        agent,
        forwardedProps: {
          informationSubmission: {
            formId: current.formId,
            formVersion: current.formVersion,
            submissionId,
            answers: values,
          },
        },
      });
      const response = await fetch(
        `/api/information/${form.formId}?thread=${encodeURIComponent(agent.threadId)}`,
      );
      if (response.ok)
        setCurrent(informationFormSchema.parse(await response.json()));
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
        void submit(event);
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
      </fieldset>
      {unavailable && (
        <p className="form-status">
          {current.status === "submitted"
            ? "资料已接收"
            : "表单已失效，请继续描述问题"}
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
