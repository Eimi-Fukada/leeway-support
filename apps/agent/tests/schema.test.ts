import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { checkpointSql } from "../scripts/export-checkpoint-sql.ts";

test("checkpoint 手动 SQL 与当前锁定 SDK 的官方迁移完全一致，升级后需显式重新导出", async () => {
  const saved = await readFile(new URL("../sql/010_langgraph_checkpoint.sql", import.meta.url), "utf8");
  assert.equal(saved.replaceAll("\r\n", "\n"), await checkpointSql());
});
