import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createModel } from "../src/config/model.ts";
import { loadAgentEnv } from "../src/config/env.ts";
import { createMemory } from "../src/config/memory.ts";
import { createDatabasePool } from "../src/config/database.ts";
import { createCheckpointer } from "../src/config/checkpoint.ts";
import { InformationService } from "../src/interactions/service.ts";
import { ConversationService } from "../src/conversations/service.ts";
import { checkpointThreadId, memoryScope } from "../src/support-context.ts";
import { behaviorCases, DATASET_VERSION } from "./dataset.ts";
import { runCase, hash, type EvaluationServices } from "./runner.ts";
import { compareReports, markdownReport, sanitizeArtifact, type BehaviorReport } from "./report.ts";

export function parseEvalOptions(args: string[]) {
  const options: { list: boolean; caseId?: string; repeat: number; out?: string; baseline?: string } = { list: false, repeat: 1 };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") continue;
    if (seen.has(arg)) throw new Error("评估参数重复。");
    seen.add(arg);
    if (arg === "--list") { options.list = true; continue; }
    if (!["--case", "--repeat", "--out", "--baseline"].includes(arg)) throw new Error("评估参数支持 --list、--case、--repeat、--out、--baseline。");
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error("评估参数缺少值。");
    if (arg === "--case") options.caseId = value;
    else if (arg === "--repeat") {
      if (!/^[1-5]$/.test(value)) throw new Error("评估采样次数须为 1–5。");
      options.repeat = Number(value);
    } else if (arg === "--out") options.out = value;
    else options.baseline = value;
  }
  if (options.caseId && !behaviorCases.some((entry) => entry.id === options.caseId)) throw new Error("没有这个评估用例；使用 --list 查看。");
  return options;
}

const applicationRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = path.resolve(applicationRoot, "../..");
async function codeFingerprint() {
  const entries: Array<[string, string]> = [];
  async function visit(directory: string) {
    for (const item of (await readdir(path.join(applicationRoot, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = path.join(directory, item.name);
      if (item.isDirectory()) await visit(relative);
      else if (/\.ts$/.test(item.name)) entries.push([relative.replaceAll("\\", "/"), await readFile(path.join(applicationRoot, relative), "utf8")]);
    }
  }
  await visit("src"); await visit("evals");
  entries.push(["package.json", await readFile(path.join(applicationRoot, "package.json"), "utf8")]);
  return hash(entries);
}

async function main() {
  const options = parseEvalOptions(process.argv.slice(2));
  if (options.list) {
    console.log(`数据集 ${DATASET_VERSION} · ${behaviorCases.length} 个用例；此命令不调用模型或数据库。`);
    for (const entry of behaviorCases) console.log(`${entry.id}\t${entry.category}\t${entry.description}`);
    return;
  }
  const selected = behaviorCases.filter((entry) => !options.caseId || entry.id === options.caseId);
  const baseline: unknown = options.baseline ? JSON.parse(await readFile(path.resolve(repositoryRoot, options.baseline), "utf8")) : undefined;
  const report: BehaviorReport = { schemaVersion: 1, datasetVersion: DATASET_VERSION, datasetHash: hash(behaviorCases),
    createdAt: new Date().toISOString(), environment: {}, selection: { caseIds: selected.map((entry) => entry.id), repeat: options.repeat }, results: [] };
  // 先验证基线格式，再创建会请求外部资源的运行环境。
  if (baseline !== undefined) compareReports(report, baseline);
  loadAgentEnv();
  // 本轮报告仅保存在本机；避免用户的云追踪环境隐式上传评估输入。
  for (const name of ["LANGSMITH_TRACING", "LANGCHAIN_TRACING", "LANGCHAIN_TRACING_V2"]) process.env[name] = "false";
  const model = createModel();
  let commit = "unavailable"; let dirty: boolean | null = null;
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
    dirty = !!execFileSync("git", ["status", "--porcelain"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  } catch { /* 产物仍有内容指纹，不凭空声称 Git 版本可用。 */ }
  report.environment = { commit, dirty, codeFingerprint: await codeFingerprint(), node: process.version,
    model: model.model, apiMode: process.env.OPENAI_API_MODE ?? "responses", providerFingerprint: hash(process.env.OPENAI_BASE_URL ?? "sdk-default"),
    lockfileFingerprint: hash(await readFile(path.join(repositoryRoot, "pnpm-lock.yaml"), "utf8")),
    storage: "product-postgresql-public", cloudTracing: false, semanticJudge: "human-pending", caseRetries: 0 };
  const output = path.join(options.out ? path.resolve(repositoryRoot, options.out) : path.join(repositoryRoot, "artifacts/evals"),
    `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
  await mkdir(output, { recursive: true });
  console.log(`将运行 ${selected.length * options.repeat} 个用例样本，使用真实模型和产品 PostgreSQL，会产生模型费用；不自动重跑失败用例。`);
  const closers: Array<() => Promise<unknown>> = [];
  await saveReport();
  try {
    const pool = createDatabasePool(); closers.push(() => pool.end());
    const saver = await createCheckpointer(); closers.push(() => saver.end());
    const memory = await createMemory(); closers.push(() => memory.close());
    const information = new InformationService(pool); await information.setup();
    const conversation = new ConversationService(pool); await conversation.setup();
    const services: EvaluationServices = { saver, memory: memory.service, information, conversation,
      cleanup: async (contexts, threads) => {
        if (contexts.some((entry) => !/^eval-[0-9a-f-]{36}-[ab]$/.test(entry.subject.id))) throw new Error("拒绝清理非评估身份。");
        for (const thread of threads) {
          if (!/^eval-[0-9a-f-]{36}$/.test(thread.id)) throw new Error("拒绝清理非评估会话。");
          await saver.deleteThread(checkpointThreadId(thread.id, thread.context));
        }
        for (const context of contexts) {
          const scope = memoryScope(context);
          await pool.query("DELETE FROM public.support_conversation_messages WHERE scope=$1", [scope]);
          await pool.query("DELETE FROM public.support_conversation_requests WHERE scope=$1", [scope]);
          await pool.query("DELETE FROM public.support_information_forms WHERE scope=$1", [scope]);
          await pool.query("DELETE FROM public.support_memory_operations WHERE scope=$1", [scope]);
          await pool.query("DELETE FROM public.support_memories WHERE scope=$1", [scope]);
        }
      } };
    for (const definition of selected) for (let repetition = 1; repetition <= options.repeat; repetition++) {
      const result = await runCase(definition, repetition, model, services);
      report.results.push(result);
      console.log(`${definition.id} #${repetition}: execution=${result.execution}, automatic=${result.automatic}, semantic=needs_review`);
      // 每个样本结束立即保存，避免长评估中断后只留下空目录。
      await saveReport();
    }
  } catch {
    report.runError = "评估初始化或运行中断；未执行的样本没有自动重跑。";
    await saveReport();
    throw new Error("评估未完成。");
  } finally {
    for (const close of closers.reverse()) await close().catch(() => { process.exitCode = 1; report.runError = "评估资源关闭未确认完成。"; console.error(report.runError); });
    if (report.runError) await saveReport();
  }
  if (report.results.some((entry) => entry.automatic !== "pass")) process.exitCode = 1;
  console.log(`报告：${path.join(output, "report.md")}`);
  console.log("退出码 0 仅表示自动检查通过；语义质量仍待人工复核，不代表生产验收通过。");

  async function saveReport() {
    if (baseline !== undefined) report.comparison = compareReports(report, baseline);
    const secrets = [process.env.OPENAI_API_KEY, process.env.LANGSMITH_API_KEY, process.env.DATABASE_URL].filter((entry): entry is string => !!entry);
    const safe = sanitizeArtifact(report, secrets) as BehaviorReport;
    await writeFile(path.join(output, "report.json"), JSON.stringify(safe, null, 2));
    await writeFile(path.join(output, "report.md"), markdownReport(safe));
    await writeFile(path.join(output, "reviews.json"), JSON.stringify(safe.results.map((entry) => ({ id: entry.id, repetition: entry.repetition, status: "pending", note: "", criteria: entry.review })), null, 2));
  }
}

// 参数函数也用于离线验证；导入模块不启动模型/数据库运行。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("评估未完成：请检查参数、基线文件、模型和 PostgreSQL 配置。原始错误未输出。已生成报告若存在，请按执行状态阅读。"); process.exitCode = 2; });
}
