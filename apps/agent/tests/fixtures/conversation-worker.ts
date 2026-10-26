import assert from "node:assert/strict";
import { AIMessage, fakeModel } from "langchain";
import { createCheckpointer } from "../../src/config/checkpoint.ts";
import { createDatabasePool } from "../../src/config/database.ts";
import { ConversationService } from "../../src/conversations/service.ts";
import { conversationSnapshot } from "../../src/conversations/execution.ts";
import { InformationService } from "../../src/interactions/service.ts";
import { createSupportAgent } from "../../src/agent/agent.ts";
import { runSupportAgent } from "../../src/agent/run.ts";
import { localSupportContext, checkpointThreadId, memoryScope } from "../../src/support-context.ts";

async function main() {
  const [phase, user, threadId] = process.argv.slice(2);
  if (!user?.startsWith("integration-history-") || !threadId || !["execute", "reconcile"].includes(phase ?? "")) throw new Error();
  const context = localSupportContext(user); const scope = memoryScope(context); const thread = checkpointThreadId(threadId, context);
  const pool = createDatabasePool(); const saver = await createCheckpointer();
  try {
    const information = new InformationService(pool); await information.setup();
    const journal = new ConversationService(pool); await journal.setup();
    const model = fakeModel().respond(new AIMessage("跨进程的完成答案"));
    const agent = createSupportAgent(model, saver, {}, {}, undefined, information);
    if (phase === "execute") {
      journal.finish = async () => { throw new Error("simulate journal failure"); };
      await assert.rejects(runSupportAgent(agent, "原问题", undefined, threadId, context, { service: information, conversation: journal, requestId: "persistent" }));
      assert.equal(model.calls.length, 1);
    } else {
      const snapshot = await information.withThread(scope, thread, () => conversationSnapshot(agent, information, journal, scope, thread, true));
      assert.equal(snapshot.status, "completed");
      assert.equal(snapshot.messages.at(-1)!.content, "跨进程的完成答案");
      const result = await runSupportAgent(agent, "原问题", undefined, threadId, context, { service: information, conversation: journal, requestId: "persistent" });
      assert.equal(result.answer, "跨进程的完成答案");
      assert.equal(model.calls.length, 0);
    }
    console.log("conversation-worker-ok");
  } finally { await saver.end(); await pool.end(); }
}
main().catch(() => { console.error("conversation-worker-failed"); process.exitCode = 1; });
