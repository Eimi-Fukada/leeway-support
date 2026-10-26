import test from "node:test";
import assert from "node:assert/strict";
import { localRequestError, json } from "../src/server/request.ts";

function request(host: string, origin?: string) {
  return new Request("http://127.0.0.1:3100/api/conversation?thread=test", {
    headers: { host, ...(origin ? { origin } : {}) },
  });
}

test("Next API 保留本机入口限制：同源与无 Origin 的本机请求通过，外部 Host/Origin 拒绝", () => {
  assert.equal(localRequestError(request("127.0.0.1:3100")), undefined);
  assert.equal(localRequestError(request("127.0.0.1:3100", "http://127.0.0.1:3100")), undefined);
  assert.equal(localRequestError(request("attacker.example", "http://127.0.0.1:3100"))?.status, 403);
  assert.equal(localRequestError(request("127.0.0.1:3100", "https://attacker.example"))?.status, 403);
  assert.equal(localRequestError(request("127.0.0.1:3100", "null"))?.status, 403);
});

test("Next API 的成功和错误 JSON 都禁止缓存", async () => {
  for (const status of [200, 409, 503]) {
    const response = json({ status }, status);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { status });
  }
});
