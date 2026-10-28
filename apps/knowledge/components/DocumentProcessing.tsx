import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { StoredDocument } from "../src/documents/contracts.ts";
import { PROCESSING_LABELS, PROCESSING_STEP_LABELS, STEP_STATUS_LABELS, isProcessing, type ProcessingDetail, type ProcessingSummary } from "../src/documents/processing.ts";
import { Icon } from "./Icons.tsx";

export function DocumentProcessing({ libraryId, document, onClose, onUpdate }: {
  libraryId: string; document: StoredDocument; onClose: () => void;
  onUpdate: (documentId: string, processing: ProcessingSummary) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const [detail, setDetail] = useState<ProcessingDetail>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const retryAbort = useRef<AbortController | null>(null);
  const endpoint = `/api/knowledge-bases/${libraryId}/documents/${document.id}/processing`;
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => () => retryAbort.current?.abort(), []);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true); setError("");
    async function read() {
      try {
        const response = await fetch(endpoint, { signal: abort.signal, cache: "no-store" });
        if (abort.signal.aborted) return;
        if (response.status === 401) { router.replace("/login"); router.refresh(); return; }
        const body: ProcessingDetail & { error?: string } = await response.json();
        if (abort.signal.aborted) return;
        if (!response.ok) throw new Error(body.error ?? "暂时无法读取处理进度。");
        setDetail(body);
        onUpdate(body.documentId, { status: body.status, updatedAt: body.updatedAt });
        // 完成后不轮询；关闭弹窗/切换文档时中止请求。串行请求防止旧响应覆盖新状态。
        if (isProcessing(body.status) || (["pending","chunked","embedded"].includes(body.status) && body.executionEnabled)) {
          timer = setTimeout(() => void read(), 2500);
        }
      } catch (cause: unknown) {
        if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "暂时无法读取处理进度。");
      } finally { if (!abort.signal.aborted) setLoading(false); }
    }
    void read();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [endpoint, refresh, onUpdate, router]);
  const status = detail?.status ?? document.processing.status;
  async function retry(reconcile=false) {
    if (!detail || !(reconcile?detail.canReconcile:detail.canRetry) || retrying) return;
    const controller = new AbortController(); retryAbort.current = controller;
    setRetrying(true); setError("");
    try {
      const response = await fetch(`${endpoint}/${reconcile?'reconcile':'retry'}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ attempt: detail.attempt }), signal: controller.signal });
      if (controller.signal.aborted) return;
      if (response.status === 401) { router.replace("/login"); router.refresh(); return; }
      const body: ProcessingDetail = await response.json();
      if (!response.ok) throw new Error(body.error ?? "重试未确认，请刷新状态核对。");
      setDetail(body); onUpdate(body.documentId, { status: body.status, updatedAt: body.updatedAt }); setRefresh((value) => value+1);
    } catch (cause: unknown) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "重试未确认，请刷新状态核对。"); }
    finally { if (!controller.signal.aborted) setRetrying(false); }
  }
  return <dialog ref={dialog} className="processing-dialog" aria-labelledby="processing-title" onClose={onClose}>
    <header><div><span className="document-kicker">文档处理进度</span><h2 id="processing-title">{document.name}</h2></div>
      <button type="button" className="icon-button" aria-label="关闭处理进度" onClick={() => dialog.current?.close()}><Icon name="close"/></button></header>
    <div className="processing-content">
      <div className="processing-summary"><span className={`processing-badge ${status}`}>{PROCESSING_LABELS[status]}</span><span>原文件已保存，可预览</span></div>
      {loading && !detail && <p className="muted" role="status">正在读取处理进度…</p>}
      {error && <div className="processing-error"><p className="error" role="alert">{error}{detail && " 以下为上次读取的状态。"}</p><button type="button" className="secondary-button" onClick={() => setRefresh((value: number) => value + 1)}>重新读取</button></div>}
      {detail && <>
        <ol className="processing-steps" aria-label="入库处理步骤" aria-live="polite">{detail.steps.map((step) => <li key={step.stage} className={step.status} aria-current={step.status === "running" ? "step" : undefined}>
          <span className="processing-marker" aria-hidden="true">{step.status === "completed" ? "✓" : step.status === "failed" ? "!" : ""}</span>
          <div><strong>{PROCESSING_STEP_LABELS[step.stage]}</strong><span>{STEP_STATUS_LABELS[step.status]}</span></div>
        </li>)}</ol>
        {detail.error && <p className="processing-failure" role="alert">{detail.error}</p>}
        {detail.canReconcile && <button type="button" className="secondary-button" disabled={retrying} onClick={() => void retry(true)}>{retrying?"正在核对…":"核对索引结果"}</button>}
        {detail.canRetry && <button type="button" className="secondary-button" disabled={retrying} onClick={() => void retry()}>{retrying ? "正在提交…" : detail.steps.some(step=>step.stage==='indexing' && step.status==='failed') ? "重试索引写入" : detail.steps.some(step=>step.stage==='embedding' && step.status==='failed') ? "重试向量化" : "重试解析与分块"}</button>}
        {detail.status === "pending" && <p className="processing-note">原文件已保存，等待解析。处理开始后会自动更新步骤状态。</p>}
        {detail.status === "chunked" && <p className="processing-note">全文解析与分块已完成，等待向量化。处理器运行后会继续执行。</p>}
        {detail.status === "embedded" && <p className="processing-note">向量已生成并保存，等待写入向量数据库。处理器运行后会继续执行。</p>}
        {detail.status === "unsupported" && <p className="processing-note">此格式当前仅支持原文预览，暂不参与知识检索。</p>}
        {detail.status === "ready" && <p className="processing-note">本次文档的向量和来源已在向量数据库中核对完成。</p>}
        <p className="processing-updated">状态更新时间：<time dateTime={detail.updatedAt}>{new Date(detail.updatedAt).toLocaleString("zh-CN")}</time></p>
      </>}
    </div>
    <footer><span>处理状态由服务端记录</span><button type="button" className="secondary-button" disabled={loading} onClick={() => setRefresh((value: number) => value + 1)}>刷新状态</button></footer>
  </dialog>;
}
