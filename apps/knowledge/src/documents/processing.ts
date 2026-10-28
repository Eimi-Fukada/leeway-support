import type { IndexReceipt,IndexTarget } from "../indexing/qdrant.ts";

export const PROCESSING_STAGES = ["parsing", "chunking", "embedding", "indexing"] as const;
export type ProcessingStage = typeof PROCESSING_STAGES[number];
export type ProcessingStatus = "pending" | ProcessingStage | "chunked" | "embedded" | "ready" | "failed" | "unsupported";
export type StepStatus = "pending" | "running" | "completed" | "failed" | "unsupported";
export const PROCESSING_LABELS: Record<ProcessingStatus, string> = {
  pending: "待处理", parsing: "文本解析中", chunking: "分块中", embedding: "向量化中",
  indexing: "索引写入中", chunked: "等待向量化", embedded: "等待索引写入", ready: "可检索", failed: "处理失败", unsupported: "仅原文预览",
};
export const PROCESSING_STEP_LABELS: Record<ProcessingStage | "ready", string> = {
  parsing: "文本解析", chunking: "文本分块", embedding: "向量化", indexing: "索引写入", ready: "检索就绪",
};
export const STEP_STATUS_LABELS: Record<StepStatus, string> = {
  pending: "未开始", running: "处理中", completed: "已完成", failed: "失败", unsupported: "暂不支持",
};
const ERROR_MESSAGES = {
  empty_text: "文档没有可提取的文本，请确认正文不是空白或纯图片。",
  text_too_large: "解析后的文本过长，请拆分文件后上传。",
  read_failed: "原文件暂时无法读取，请检查文件存储。",
  parse_failed: "文本解析失败，请检查文件编码和内容。",
  chunk_failed: "文本分块失败，请核对文档内容。",
  embedding_failed: "向量化服务暂不可用，请稍后核对。",
  index_failed: "索引写入失败，请检查向量存储服务。",
  interrupted: "处理已中断，需要核对后继续。",
  result_unknown: "处理结果尚未确认，需要核对后继续。",
} as const;
export type ProcessingErrorCode = keyof typeof ERROR_MESSAGES;
export interface ProcessingSummary { status: ProcessingStatus; updatedAt: string }
export interface ProcessingDetail extends ProcessingSummary {
  documentId: string;
  steps: Array<{ stage: ProcessingStage | "ready"; status: StepStatus }>;
  error: string | null;
  // 只读状态查询不会启动后台执行器。
  executionEnabled: boolean;
  attempt: number;
  canRetry: boolean;
  canReconcile: boolean;
  index: {collection:string;generationId:string;verifiedAt:string}|null;
}
export interface ProcessingRecord {
  processing_status: ProcessingStatus;
  processing_failed_stage: ProcessingStage | null;
  processing_error_code: ProcessingErrorCode | null;
  processing_updated_at: Date;
  processing_attempt: number;
  index_target?:IndexTarget|null;
  index_receipt?:IndexReceipt|null;
}

export function processingSummary(record: ProcessingRecord): ProcessingSummary {
  return { status: record.processing_status, updatedAt: record.processing_updated_at.toISOString() };
}

export function processingDetail(documentId: string, record: ProcessingRecord): ProcessingDetail {
  const status = record.processing_status;
  const current = status === "embedded" ? 3 : status === "chunked" ? 2 : PROCESSING_STAGES.indexOf(status === "failed" ? record.processing_failed_stage! : status as ProcessingStage);
  const steps = PROCESSING_STAGES.map((stage, index): { stage: ProcessingStage | "ready"; status: StepStatus } => {
    let stepStatus: StepStatus = "pending";
    if (status === "unsupported") stepStatus = "unsupported";
    else if (status === "ready" || (current >= 0 && index < current)) stepStatus = "completed";
    else if (index === current && status !== "chunked" && status !== "embedded") stepStatus = status === "failed" ? "failed" : "running";
    return { stage, status: stepStatus };
  });
  steps.push({ stage: "ready", status: status === "ready" ? "completed" : status === "unsupported" ? "unsupported" : "pending" });
  return {
    documentId, ...processingSummary(record), executionEnabled: true, attempt: record.processing_attempt,
    canRetry: status === "failed" && record.processing_error_code !== "result_unknown",
    canReconcile: status === "failed" && record.processing_failed_stage === "indexing",
    index: status==='ready' && record.index_receipt ? {collection:record.index_receipt.collection,generationId:record.index_receipt.generationId,verifiedAt:record.index_receipt.verifiedAt}:null,
    steps,
    error: status === "failed" ? ERROR_MESSAGES[record.processing_error_code!] ?? "处理失败，请联系管理员核对。" : null,
  };
}

export function isProcessing(status: ProcessingStatus): boolean {
  return PROCESSING_STAGES.some((stage) => stage === status);
}

