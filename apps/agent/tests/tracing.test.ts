import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { AIMessage, fakeModel } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { createSupportAgent } from "../src/agent/agent.ts";
import { runSupportAgent } from "../src/agent/run.ts";
import { createTracing } from "../src/config/tracing.ts";

async function receiver(status = 200, infoDelayMs = 0) {
  const batches: Array<{ post?: Array<Record<string, unknown>>; patch?: Array<Record<string, unknown>> }> = [];
  const server = createServer(async (req, res) => {
    if (req.url === "/info") {
      res.setHeader("content-type", "application/json");
      const body = JSON.stringify({ version: "0.12.0", batch_ingest_config: { use_multipart_endpoint: false } });
      if (infoDelayMs) setTimeout(() => res.end(body), infoDelayMs);
      else res.end(body);
      return;
    }
    const chunks: Buffer[] = [];
    try { for await (const chunk of req) chunks.push(Buffer.from(chunk)); }
    catch (cause) {
      // 超时测试允许客户端在正文读取期间断开；不能让预期中断变成接收端未处理异常。
      if (req.aborted) return;
      throw cause;
    }
    const body = Buffer.concat(chunks).toString();
    // /info 超时后 SDK 可能退回 multipart；此类测试只检查传输，不解析其正文。
    batches.push(req.headers["content-type"]?.includes("multipart/") ? {} : JSON.parse(body));
    res.statusCode = status;
    res.end(status === 200 ? "{}" : "不应回显的服务器错误内容");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    batches,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

test("PII 输入与模型自行生成的联系方式在追踪上传前均被脱敏", async () => {
  const sink = await receiver();
  const tracing = createTracing({
    LANGSMITH_TRACING: "true", LANGSMITH_API_KEY: "pii-local-test-key", LANGSMITH_ENDPOINT: sink.endpoint,
  });
  try {
    const model = fakeModel().respond(new AIMessage("模型生成 contact@example.com，13800138000"));
    const agent = createSupportAgent(model).withConfig({ callbacks: tracing.callbacks });
    const result = await runSupportAgent(agent, "邮箱 user@example.com");
    // 这是追踪边界，不修改流正文；输出 PII 防护是独立需求。
    assert.match(result.answer, /contact@example.com/);
    await tracing.flush();
    const body = JSON.stringify(sink.batches);
    assert.match(body, /REDACTED_EMAIL/);
    assert.match(body, /REDACTED_CN_PHONE/);
    assert.doesNotMatch(body, /user@example\.com|contact@example\.com|13800138000/);
  } finally {
    await tracing.flush();
    await sink.close();
  }
});

test("追踪关闭时不创建 callback 或发出上传请求", async () => {
  let requests = 0;
  const tracing = createTracing({ LANGSMITH_TRACING: "false" }, async () => {
    requests++;
    throw new Error("不应请求网络");
  });
  const model = fakeModel().respond(new AIMessage("正常回答"));
  const result = await runSupportAgent(createSupportAgent(model).withConfig({ callbacks: tracing.callbacks }), "输入");
  await tracing.flush();
  assert.equal(result.answer, "正常回答");
  assert.equal(tracing.callbacks.length, 0);
  assert.equal(requests, 0);
});

test("启用但缺少 Key 或 endpoint 非法时，使用安全的配置错误", () => {
  assert.throws(() => createTracing({ LANGSMITH_TRACING: "true" }), /LANGSMITH_API_KEY/);
  assert.throws(() => createTracing({
    LANGSMITH_TRACING: "true", LANGSMITH_API_KEY: "private-test-key", LANGSMITH_ENDPOINT: "https://user:password@example.com",
  }), /^Error: 追踪配置错误/);
});

test("同会话每轮独立 trace，模型为子调用，凭据在上传前脱敏且不改变回答", async () => {
  const sink = await receiver();
  const key = "test-tracing-key-should-not-appear-in-body";
  const modelKey = "test-model-key-should-not-appear-in-body";
  const tracing = createTracing({
    LANGSMITH_TRACING: "true", LANGSMITH_API_KEY: key,
    LANGSMITH_ENDPOINT: sink.endpoint, LANGSMITH_PROJECT: "support-tracing-test",
    OPENAI_API_KEY: modelKey,
  });
  const previousTracing = process.env.LANGSMITH_TRACING;
  // 真实入口也通过环境开关启用；显式 callback 不应叠加一份默认上传器。
  process.env.LANGSMITH_TRACING = "true";
  try {
    const model = fakeModel().respond(new AIMessage(`回答包含 ${modelKey}`)).respond(new AIMessage("第二轮"));
    const agent = createSupportAgent(model, new MemorySaver()).withConfig({ callbacks: tracing.callbacks });
    const first = await runSupportAgent(agent, `测试输入 ${key}`, undefined, "tracing-thread");
    const second = await runSupportAgent(agent, "继续", undefined, "tracing-thread");
    await tracing.flush();

    assert.equal(first.answer, `回答包含 ${modelKey}`); // 上传脱敏不改变业务数据。
    assert.notEqual(first.runId, second.runId);
    const posts = sink.batches.flatMap((batch) => batch.post ?? []);
    const roots = posts.filter((run) => !run.parent_run_id);
    assert.equal(roots.length, 2);
    assert.deepEqual(new Set(roots.map((run) => run.id)), new Set([first.runId, second.runId]));
    assert.ok(posts.some((run) => run.run_type === "llm" && run.parent_run_id));
    assert.ok(posts.every((run) => JSON.stringify(run.extra).includes("tracing-thread")));
    assert.ok(roots.every((run) => run.session_name === "support-tracing-test"));
    const body = JSON.stringify(sink.batches);
    assert.ok(body.includes("[REDACTED]"));
    assert.ok(!body.includes(key) && !body.includes(modelKey));
    assert.equal(model.calls.length, 2);
  } finally {
    if (previousTracing === undefined) delete process.env.LANGSMITH_TRACING;
    else process.env.LANGSMITH_TRACING = previousTracing;
    await tracing.flush();
    await sink.close();
  }
});

test("可隐藏输入输出，失败仍被记录且原始错误中的已知凭据被过滤", async () => {
  const sink = await receiver();
  const secret = "test-error-key-private";
  const tracing = createTracing({
    LANGSMITH_TRACING: "true", LANGSMITH_API_KEY: secret, LANGSMITH_ENDPOINT: sink.endpoint,
    LANGSMITH_HIDE_INPUTS: "true", LANGSMITH_HIDE_OUTPUTS: "true",
  });
  const failure = new Error(`模型错误 ${secret}`);
  try {
    const agent = createSupportAgent(fakeModel().respond(failure)).withConfig({ callbacks: tracing.callbacks });
    await assert.rejects(runSupportAgent(agent, "不应上传的问句"), (error: unknown) => (error === failure || (error instanceof Error && error.cause === failure)));
    await tracing.flush();
    const body = JSON.stringify(sink.batches);
    assert.ok(body.includes("模型错误"));
    assert.ok(!body.includes(secret) && !body.includes("不应上传的问句"));
  } finally {
    await tracing.flush();
    await sink.close();
  }
});

test("上传服务返回错误不改变 Agent 的成功结果或触发第二次模型调用", async () => {
  const sink = await receiver(503);
  const tracing = createTracing({
    LANGSMITH_TRACING: "true", LANGSMITH_API_KEY: "test-key", LANGSMITH_ENDPOINT: sink.endpoint,
  });
  try {
    const model = fakeModel().respond(new AIMessage("成功回答"));
    const agent = createSupportAgent(model).withConfig({ callbacks: tracing.callbacks });
    const result = await runSupportAgent(agent, "测试上传失败");
    await tracing.flush();
    assert.equal(result.answer, "成功回答");
    assert.equal(model.calls.length, 1);
    assert.ok(sink.batches.length > 0);
  } finally {
    await tracing.flush();
    await sink.close();
  }
});

test("Agent 工作区路由指定 Agent 和环境，不混入项目名", async () => {
  const sink = await receiver();
  const tracing = createTracing({
    LANGSMITH_TRACING: "true", LANGSMITH_API_KEY: "test-agent-routing-key",
    LANGSMITH_ENDPOINT: sink.endpoint,
    LANGSMITH_AGENT_ID: "leeway-support", LANGSMITH_AGENT_ENVIRONMENT: "local",
  });
  try {
    const agent = createSupportAgent(fakeModel().respond(new AIMessage("路由测试")))
      .withConfig({ callbacks: tracing.callbacks });
    await runSupportAgent(agent, "测试 Agent 路由");
    await tracing.flush();
    const posts = sink.batches.flatMap((batch) => batch.post ?? []);
    assert.ok(posts.length > 0);
    assert.ok(posts.every((run) => run.address === "lrn:agents/leeway-support/environments/local"));
    assert.ok(posts.every((run) => !run.session_name));
  } finally {
    await tracing.flush();
    await sink.close();
  }
});

test("拒绝半套 Agent 配置或与项目名混用", () => {
  const base = { LANGSMITH_TRACING: "true", LANGSMITH_API_KEY: "test-key" };
  for (const route of [
    { LANGSMITH_AGENT_ID: "leeway-support" },
    { LANGSMITH_AGENT_ID: "leeway-support", LANGSMITH_AGENT_ENVIRONMENT: "invalid" },
    { LANGSMITH_AGENT_ID: "leeway-support", LANGSMITH_AGENT_ENVIRONMENT: "local", LANGSMITH_PROJECT: "legacy-project" },
  ]) {
    assert.throws(() => createTracing({ ...base, ...route }), /^Error: 追踪配置错误/);
  }
});

test("上传鉴权失败保留 HTTP 状态与安全原因，不伪装为取消", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
  const sink = await receiver(401);
  const tracing = createTracing({
    LANGSMITH_TRACING: "true", LANGSMITH_API_KEY: "test-key", LANGSMITH_ENDPOINT: sink.endpoint,
  });
  try {
    const model = fakeModel().respond(new AIMessage("执行成功"));
    const result = await runSupportAgent(createSupportAgent(model).withConfig({ callbacks: tracing.callbacks }), "测试");
    await tracing.flush();
    assert.equal(result.answer, "执行成功");
    assert.match(logs.join("\n"), /HTTP 401/);
    assert.doesNotMatch(logs.join("\n"), /AbortError|不应回显的服务器错误内容/);
  } finally {
    await tracing.flush();
    await sink.close();
  }
});

test("响应超过旧的 2 秒上限时可按新配置正常提交", { timeout: 10_000 }, async () => {
  const sink = await receiver(200, 2_200);
  const tracing = createTracing({
    LANGSMITH_TRACING: "true", LANGSMITH_API_KEY: "test-key", LANGSMITH_ENDPOINT: sink.endpoint,
    LANGSMITH_TIMEOUT_MS: "5000",
  });
  try {
    const agent = createSupportAgent(fakeModel().respond(new AIMessage("成功"))).withConfig({ callbacks: tracing.callbacks });
    await runSupportAgent(agent, "测试慢响应");
    await tracing.flush();
    assert.ok(sink.batches.length > 0);
  } finally {
    await tracing.flush();
    await sink.close();
  }
});

test("网络超时有独立诊断，仍不影响模型正常结果", { timeout: 5_000 }, async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
  t.mock.method(console, "warn", () => {});
  const sink = await receiver(200, 500);
  const tracing = createTracing({
    LANGSMITH_TRACING: "true", LANGSMITH_API_KEY: "test-key", LANGSMITH_TIMEOUT_MS: "100", LANGSMITH_ENDPOINT: sink.endpoint,
  });
  try {
    const agent = createSupportAgent(fakeModel().respond(new AIMessage("正常回答"))).withConfig({ callbacks: tracing.callbacks });
    const result = await runSupportAgent(agent, "超时场景");
    await tracing.flush();
    assert.equal(result.answer, "正常回答");
    assert.match(logs.join("\n"), /请求超时.*100 ms/);
    assert.doesNotMatch(logs.join("\n"), /HTTP 401|test-key/);
  } finally {
    await tracing.flush();
    await sink.close();
  }
});
