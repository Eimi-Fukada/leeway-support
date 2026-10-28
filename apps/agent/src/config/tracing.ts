import { AgentAddress, Client } from "langsmith";
import { LangChainTracer } from "@langchain/core/tracers/tracer_langchain";
import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import { redactPii } from "../agent/middleware/pii.ts";

// 显式 Client + callback：配置、上传策略和关闭过程集中在这里，Agent 不依赖云服务。
export function createTracing(
  env: Readonly<Record<string, string | undefined>> = process.env,
  send: typeof fetch = fetch,
) {
  const enabled = env.LANGSMITH_TRACING?.trim() === "true";
  const callbacks: LangChainTracer[] = [];
  if (!enabled) {
    return { enabled, callbacks, flush: async () => {} };
  }
  const apiKey = env.LANGSMITH_API_KEY?.trim();
  if (!apiKey) throw new Error("追踪配置错误：启用 LangSmith 时必须填写 LANGSMITH_API_KEY。");
  const timeoutMs = Number(env.LANGSMITH_TIMEOUT_MS?.trim() || 10_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error("追踪配置错误：LANGSMITH_TIMEOUT_MS 必须是 100–60000 之间的毫秒整数。");
  }
  const agentId = env.LANGSMITH_AGENT_ID?.trim();
  const environment = env.LANGSMITH_AGENT_ENVIRONMENT?.trim();
  const configuredProject = env.LANGSMITH_PROJECT?.trim();
  let address: AgentAddress | undefined;
  if (agentId || environment) {
    if (!agentId || !environment || configuredProject) {
      throw new Error("追踪配置错误：Agent 路由需同时填写 AGENT_ID/AGENT_ENVIRONMENT，并移除 LANGSMITH_PROJECT。");
    }
    try {
      address = new AgentAddress(agentId, environment);
    } catch {
      throw new Error("追踪配置错误：Agent 标识或环境无效，环境支持 local/development/staging/production。");
    }
  }
  const projectName = address ? undefined : configuredProject || "leeway-support-dev";
  const apiUrl = env.LANGSMITH_ENDPOINT?.trim() || "https://api.smith.langchain.com";
  try {
    const url = new URL(apiUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error();
    }
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error();
  } catch {
    throw new Error("追踪配置错误：LANGSMITH_ENDPOINT 必须是 HTTPS 地址（本地测试允许 HTTP）。");
  }

  const secrets = [apiKey, env.OPENAI_API_KEY, env.DATABASE_URL, env.AGENT_KNOWLEDGE_WEB_SECRET, env.KNOWLEDGE_SUPPORT_AGENT_SECRET].filter(
    (value): value is string => Boolean(value),
  );
  // SDK 对输入、输出、metadata 和错误调用此函数；不改模型请求和 checkpoint。
  // 这里只保护已知凭据/常见敏感字段，不声称能识别全部个人信息。
  function redact(value: unknown): unknown {
    if (typeof value === "string") {
      let result = redactPii(value);
      for (const secret of secrets) result = result.replaceAll(secret, "[REDACTED]");
      return result
        .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[REDACTED_DATABASE_URL]")
        .replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]");
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        key, /^(?:api[_-]?key|password|authorization|cookie|access[_-]?token|refresh[_-]?token|database_url|sessionHash|x-service-signature)$/i.test(key)
          ? "[REDACTED]" : redact(item),
      ]));
    }
    return value;
  }

  let warned = false;
  function warn(reason = "提交失败") {
    if (warned) return;
    warned = true;
    console.error(`[追踪] LangSmith 上传失败（${reason}），本次运行的追踪可能缺失；客服执行结果独立处理。`);
  }
  function transportError(message: string, status?: number) {
    // ECONNABORTED 仅控制当前 SDK 不重复上传；消息保留真实类别，不冒充用户取消。
    const error = Object.assign(new Error(message), { code: "ECONNABORTED", status });
    error.stack = message;
    return error;
  }
  const client = new Client({
    apiKey,
    apiUrl,
    timeout_ms: timeoutMs,
    callerOptions: { maxRetries: 0 },
    maxIngestMemoryBytes: 5 * 1024 * 1024,
    traceBatchConcurrency: 1,
    disablePromptCache: true,
    anonymizer: (values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, redact(value)])),
    hideInputs: env.LANGSMITH_HIDE_INPUTS === "true" ? true : undefined,
    hideOutputs: env.LANGSMITH_HIDE_OUTPUTS === "true" ? true : undefined,
    // 不让供应商响应体或网络异常中的敏感信息进入 SDK 日志；上传失败不重试放大。
    fetchImplementation: async (input, init) => {
      let response: Response;
      const signal = init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);
      try {
        response = await send(input, { ...init, signal });
      } catch (error: unknown) {
        const timedOut = signal.aborted || (error instanceof Error && error.name === "TimeoutError");
        const reason = timedOut ? `请求超时，当前上限 ${timeoutMs} ms` : "网络连接失败，请检查 Node 到 API 的网络或代理";
        warn(reason);
        throw transportError(`LangSmith ${reason}`);
      }
      if (!response.ok) {
        const hint = response.status === 401 ? "检查 Key 和账号区域"
          : response.status === 403 ? "检查 Key 对工作区及 Agent 的权限"
          : response.status === 429 ? "请求限流" : "服务端拒绝请求";
        const reason = `HTTP ${response.status}：${hint}`;
        warn(reason);
        // 丢弃响应体，保留安全的状态与原因，避免服务端回显敏感配置。
        await response.body?.cancel();
        throw transportError(`LangSmith ${reason}`, response.status);
      }
      return response;
    },
  });
  const tracer = new LangChainTracer({ client, ...(address ? { address } : { projectName }) });
  tracer.raiseError = false;

  return {
    enabled,
    callbacks: [tracer],
    async flush() {
      try {
        // 先等框架 callbacks 将记录交给 SDK，再等 SDK 批次提交，避免 CLI 退出丢尾部。
        await awaitAllCallbacks();
        await client.awaitPendingTraceBatches();
      } catch {
        warn();
      }
    },
  };
}
