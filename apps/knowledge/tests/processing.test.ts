import test from "node:test";
import assert from "node:assert/strict";
import { processingDetail, type ProcessingRecord } from "../src/documents/processing.ts";

const record: ProcessingRecord = { processing_status: "pending", processing_failed_stage: null, processing_error_code: null, processing_updated_at: new Date("2026-10-27T08:00:00Z"), processing_attempt: 0 };
test("待处理文档所有步骤未开始，允许执行器领取但不虚报运行或可检索", () => {
  const detail = processingDetail("document", record);
  assert.equal(detail.status, "pending");
  assert.equal(detail.executionEnabled, true);
  assert.deepEqual(detail.steps.map((step) => step.status), ["pending", "pending", "pending", "pending", "pending"]);
  assert.equal(detail.updatedAt, "2026-10-27T08:00:00.000Z");
});
test("分块结束仅前两步完成，等待向量化不虚报已向量化或可检索", () => {
  const detail = processingDetail("document", { ...record, processing_status: "chunked" });
  assert.deepEqual(detail.steps.map((step) => step.status), ["completed", "completed", "pending", "pending", "pending"]);
});
test("向量完成停在等待索引写入，失败仅允许重试嵌入，不绕过索引结果核对",()=>{
  assert.deepEqual(processingDetail("document",{...record,processing_status:"embedded"}).steps.map(step=>step.status),["completed","completed","completed","pending","pending"]);
  assert.equal(processingDetail("document",{...record,processing_status:"failed",processing_failed_stage:"embedding",processing_error_code:"embedding_failed"}).canRetry,true);
  assert.equal(processingDetail("document",{...record,processing_status:"failed",processing_failed_stage:"indexing",processing_error_code:"result_unknown"}).canRetry,false);
  assert.equal(processingDetail("document",{...record,processing_status:"failed",processing_failed_stage:"indexing",processing_error_code:"result_unknown"}).canReconcile,true);
});
test("持久的执行阶段保留先后顺序，向量化完成前不会显示索引完成", () => {
  const detail = processingDetail("document", { ...record, processing_status: "embedding" });
  assert.deepEqual(detail.steps.map((step) => step.status), ["completed", "completed", "running", "pending", "pending"]);
});
test("失败只标记实际失败步骤，后续步骤不伪报完成，错误只输出安全提示", () => {
  const detail = processingDetail("document", { ...record, processing_status: "failed", processing_failed_stage: "indexing", processing_error_code: "result_unknown" });
  assert.deepEqual(detail.steps.map((step) => step.status), ["completed", "completed", "completed", "failed", "pending"]);
  assert.match(detail.error!, /尚未确认/);
  assert.ok(!JSON.stringify(detail).includes("processing_error_code"));
});
test("仅明确就绪才全部完成，不支持的格式不呈现正在解析", () => {
  assert.ok(processingDetail("document", { ...record, processing_status: "ready" }).steps.every((step) => step.status === "completed"));
  assert.ok(processingDetail("document", { ...record, processing_status: "unsupported" }).steps.every((step) => step.status === "unsupported"));
});
