import { AsyncLocalStorage } from "node:async_hooks";
import { createMiddleware, modelRetryMiddleware } from "langchain";
import type { WrapModelCallHook } from "langchain";
import { currentCapabilities } from "../../knowledge/runtime.ts";

// 每次运行独立的观察状态；不放在全局变量或 checkpoint 中，不跨会话共享。
const progress = new AsyncLocalStorage<{ emitted: boolean }>();

export function withRetryProgress<T>(work: () => Promise<T>): Promise<T> {
  return progress.run({ emitted: false }, work);
}

export function markModelOutput(): void {
  const current = progress.getStore();
  if (current) current.emitted = true;
}

export function isTransientModelError(error: Error): boolean {
  const info = error as Error & {
    status?: number; code?: string; retryAfterMs?: number;
    headers?: Headers | Record<string, string>;
  };
  if (error.name === "AbortError" || error.name === "TimeoutError" || error.name === "APIUserAbortError") return false;
  if (["insufficient_quota", "billing_hard_limit_reached", "invalid_api_key", "account_deactivated"].includes(info.code ?? "")) return false;
  // 不违反过长的 Retry-After，也不无限等待。超时暂不自动重试。
  if (info.retryAfterMs !== undefined && (!Number.isFinite(info.retryAfterMs) || info.retryAfterMs < 0 || info.retryAfterMs > 1000)) return false;
  // SDK 可能只提供 HTTP 头。无法在固定 300ms 内满足时直接失败，不提前重试。
  const retryAfter = info.headers instanceof Headers ? info.headers.get("retry-after") : info.headers?.["retry-after"];
  if (retryAfter) {
    const waitMs = /^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
    if (!Number.isFinite(waitMs) || waitMs > 300) return false;
  }
  if (info.status !== undefined) return [429, 500, 502, 503, 504].includes(info.status);
  return ["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN"].includes(info.code ?? "") || error.name === "APIConnectionError";
}

export function createModelRetryMiddleware() {
  return createMiddleware({
    name: "SupportModelRetry",
    wrapModelCall: async (request, handler) => {
      const startedAt = performance.now();
      // 原生搜索可能在供应商侧已经执行，即使尚无文本也不能自动重新发起。
      if(currentCapabilities()?.details.options.webSearch)return handler(request);
      // 官方重试负责次数/退避；每次调用单独创建过滤闭包。
      const retry = modelRetryMiddleware({
        maxRetries: 1,
        initialDelayMs: 300,
        maxDelayMs: 1000,
        jitter: false,
        onFailure: "error",
        retryOn: (error) => {
          const current = progress.getStore();
          return Boolean(current && !current.emitted && !request.runtime.signal?.aborted &&
            performance.now() - startedAt < 5000 && isTransientModelError(error));
        },
      });
      // 1.5.18 的官方 hook 类型要求 context，实际只读取工厂配置；不向应用暴露其 context schema。
      const hook = retry.wrapModelCall as WrapModelCallHook;
      return hook(request, handler);
    },
  });
}
