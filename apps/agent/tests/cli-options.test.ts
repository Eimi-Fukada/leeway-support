import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCliOptions } from "../src/cli-options.ts";

test("解析新会话、恢复会话及 pnpm 参数分隔符", () => {
  assert.deepEqual(parseCliOptions([]), { debug: false, threadId: undefined });
  assert.deepEqual(parseCliOptions(["--", "--thread", "saved-123", "--debug"]), {
    debug: true, threadId: "saved-123",
  });
});

test("拒绝缺失、重复、非法和未知参数", () => {
  for (const args of [["--thread"], ["--thread", ""], ["--thread", "a", "--thread", "b"], ["--thread", "a/b"], ["--unknown"]]) {
    assert.throws(() => parseCliOptions(args), /启动参数无效/);
  }
});
