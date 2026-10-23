import assert from "node:assert/strict";
import { test } from "node:test";
import { createCheckpointer } from "../src/config/checkpoint.ts";

test("无效的数据库配置在连接前拒绝，错误不回显输入", async () => {
  for (const value of ["", "invalid-secret", "https://user:secret@localhost/db", "postgresql://localhost/"]) {
    await assert.rejects(createCheckpointer(value), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /数据库配置/);
      assert.doesNotMatch(error.message, /invalid-secret|user:secret/);
      return true;
    });
  }
});
