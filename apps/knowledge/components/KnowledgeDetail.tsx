import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import type { KnowledgeBase } from "../src/contracts.ts";
import { Icon } from "./Icons.tsx";
import { KnowledgeChat } from "./KnowledgeChat.tsx";
import { MAX_FILE_BYTES, type StoredDocument } from "../src/documents/contracts.ts";
import type { UploadFormat } from "../src/documents/parsers/types.ts";
import { DocumentPreview } from "./DocumentPreview.tsx";
import { DocumentProcessing } from "./DocumentProcessing.tsx";
import { PROCESSING_LABELS, isProcessing, type ProcessingSummary } from "../src/documents/processing.ts";

interface UploadItem { id: string; name: string; status: "uploading" | "failed"; error?: string }
function fileSize(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// 文件管理与真实问答各自维护状态，问答通过当前库的鉴权 BFF 调用原 Agent。
export function KnowledgeDetail({ base, bases, uploadFormats }: { base: KnowledgeBase; bases: KnowledgeBase[]; uploadFormats: UploadFormat[] }) {
  const router = useRouter();
  const picker = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<StoredDocument[]>([]);
  const [queue, setQueue] = useState<UploadItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [preview, setPreview] = useState<StoredDocument>();
  const [processingDocument, setProcessingDocument] = useState<StoredDocument>();
  const updateProcessing = useCallback((documentId: string, processing: ProcessingSummary) => {
    setFiles((previous: StoredDocument[]) => previous.map((file) => file.id === documentId ? { ...file, processing } : file));
  }, []);
  const uploads = useRef<AbortController | null>(null);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"documents" | "question">("documents");
  const visibleFiles = files.filter((file: StoredDocument) => file.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const busy = queue.some((item: UploadItem) => item.status === "uploading");
  const hasActiveProcessing = files.some((file) => isProcessing(file.processing.status) || ["pending","chunked","embedded"].includes(file.processing.status));
  const endpoint = `/api/knowledge-bases/${base.id}/documents`;
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true); setLoadError("");
    async function readList() { await fetch(endpoint, { signal: abort.signal, cache: "no-store" }).then(async (response) => {
      if (response.status === 401) { router.replace("/login"); router.refresh(); return; }
      const body: { documents?: StoredDocument[]; error?: string } = await response.json();
      if (abort.signal.aborted) return;
      if (!response.ok || !body.documents) throw new Error(body.error ?? "无法读取文件列表。");
      setFiles(body.documents);
      if (body.documents.some((file) => isProcessing(file.processing.status) || ["pending","chunked","embedded"].includes(file.processing.status))) timer = setTimeout(() => void readList(), 3000);
    }).catch((cause: unknown) => { if (!abort.signal.aborted) setLoadError(cause instanceof Error ? cause.message : "无法读取文件列表。"); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); }); }
    void readList();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [endpoint, refresh, router, hasActiveProcessing]);
  useEffect(() => () => uploads.current?.abort(), []);
  async function chooseFiles(event: ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (!chosen.length || busy) return;
    const accepted = uploadFormats.flatMap((format) => format.extensions);
    if (chosen.some((file) => !accepted.some((extension) => file.name.toLowerCase().endsWith(extension)))) { setNotice(`暂时支持 ${uploadFormats.map((format) => format.label).join("、")} 文件。`); return; }
    if (chosen.length > 10) { setNotice("每次最多选择 10 个文件，请分批上传。"); return; }
    const controller = new AbortController(); uploads.current = controller; setNotice("");
    const batch = chosen.map((file: File) => ({ id: crypto.randomUUID(), file }));
    setQueue((previous: UploadItem[]) => [...previous.filter((item: UploadItem) => item.status !== "failed"), ...batch.map((item): UploadItem => ({ id: item.id, name: item.file.name, status: "uploading" }))]);
    for (const item of batch) {
      if (controller.signal.aborted) break;
      try {
        if (item.file.size > MAX_FILE_BYTES) throw new Error("每个文件最多 10 MB。");
        const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(item.file.name) }, body: item.file, signal: controller.signal });
        const body: { document?: StoredDocument; duplicate?: boolean; error?: string } = await response.json();
        if (response.status === 401) { router.replace("/login"); router.refresh(); break; }
        if (!response.ok || !body.document) throw new Error(body.error ?? "上传未确认，请刷新列表核对。");
        const stored = body.document;
        setFiles((previous: StoredDocument[]) => previous.some((file: StoredDocument) => file.id === stored.id) ? previous : [stored, ...previous]);
        setQueue((previous: UploadItem[]) => previous.filter((entry: UploadItem) => entry.id !== item.id));
        setNotice(body.duplicate ? `「${item.file.name}」的内容已存在，已保留原文件。` : `已上传「${stored.name}」，原文件可预览。`);
      } catch (cause) {
        if (controller.signal.aborted) break;
        setQueue((previous: UploadItem[]) => previous.map((entry: UploadItem) => entry.id === item.id ? { ...entry, status: "failed", error: cause instanceof Error ? cause.message : "上传未确认，请刷新列表核对。" } : entry));
      }
    }
  }
  return <div className="knowledge-detail" data-view={view}>
    <div className="detail-mobile-toolbar"><Link href="/" className="icon-button" aria-label="返回全部知识库"><Icon name="back" size={19}/></Link>
      <select aria-label="切换知识库" value={base.id} onChange={(event: ChangeEvent<HTMLSelectElement>) => router.push(`/knowledge-bases/${event.currentTarget.value}`)}>{bases.map((item: KnowledgeBase) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
    <div className="detail-view-tabs" aria-label="详情区域"><button type="button" aria-pressed={view === "documents"} onClick={() => setView("documents")}><Icon name="file" size={17}/>文档</button><button type="button" aria-pressed={view === "question"} onClick={() => setView("question")}><Icon name="chat" size={17}/>库内问答</button></div>
    <section className="document-panel" aria-labelledby="current-library-title">
      <header className="document-heading"><img src="/brand-icon.svg" width={60} height={60} alt=""/><div><span className="document-kicker">我的知识库</span><h1 id="current-library-title">{base.name}</h1></div></header>
      <p className="document-description">{base.description || "在这里收集资料，围绕同一份知识展开对话。"}</p>
      <div className="document-toolbar"><h2>文件列表 <span>{files.length}</span></h2><button type="button" className="icon-button" aria-label="上传文档" disabled={busy || loading || !!loadError} onClick={() => picker.current?.click()}><Icon name="upload" size={18}/></button></div>
      <input type="file" ref={picker} className="visually-hidden" tabIndex={-1} aria-label="上传本地文件" accept={uploadFormats.flatMap((format) => format.extensions).join(",")} multiple onChange={(event: ChangeEvent<HTMLInputElement>) => void chooseFiles(event)}/>
      {files.length > 0 && <div className="file-preview-tools"><label className="file-search"><Icon name="search" size={16}/><input value={search} onChange={(event: ChangeEvent<HTMLInputElement>) => setSearch(event.currentTarget.value)} placeholder="搜索文件" aria-label="搜索文件"/></label><p className="preview-note"><span/>点击文件预览原文，点击状态查看处理步骤。</p></div>}
      {notice && <p className="upload-notice" role="status">{notice}</p>}
      {!!queue.length && <ul className="upload-queue" aria-live="polite">{queue.map((item: UploadItem) => <li key={item.id} className={item.status}><strong>{item.name}</strong><span>{item.status === "uploading" ? "正在上传…" : item.error}</span>{item.status === "failed" && <button className="icon-button" type="button" aria-label={`关闭上传提示：${item.name}`} onClick={() => setQueue((previous: UploadItem[]) => previous.filter((entry: UploadItem) => entry.id !== item.id))}><Icon name="close" size={14}/></button>}</li>)}</ul>}
      <div className="document-list">
        {loading ? <p className="file-no-results" role="status">正在读取文件列表…</p> : loadError ? <div className="document-load-error"><p className="error" role="alert">{loadError}</p><button className="secondary-button" onClick={() => setRefresh((value: number) => value + 1)}>重新读取</button></div> : files.length === 0 ? <div className="document-empty"><div className="document-empty-icon"><Icon name="file" size={32}/><span>+</span></div><h3>还没有添加资料</h3><p>让产品说明、常见问题和使用指南<br/>在这里井井有条。</p><button type="button" className="secondary-button" disabled={busy} onClick={() => picker.current?.click()}><Icon name="plus" size={16}/>上传文件</button><span className="document-formats">{uploadFormats.map((format) => format.label).join(" · ")}</span><p className="empty-preview-note">每文件最多 10 MB · 保存后可预览原文</p></div>
        : visibleFiles.length === 0 ? <p className="file-no-results">没有找到匹配的文件。</p>
        : <ul className="file-rows">{visibleFiles.map((file: StoredDocument) => <li key={file.id} className="document-row"><button type="button" className="file-preview-button" aria-label={`预览：${file.name}`} onClick={() => setPreview(file)}><span className="file-symbol"><Icon name="file" size={22}/></span><span className="file-info"><strong title={file.name}>{file.name}</strong><span>{fileSize(file.size)}<i/>原文已保存</span></span><Icon name="eye" size={17}/></button><button type="button" className={`processing-status-button ${file.processing.status}`} aria-label={`查看处理进度：${file.name}，${PROCESSING_LABELS[file.processing.status]}`} aria-haspopup="dialog" onClick={() => setProcessingDocument(file)}><span aria-hidden="true"/>{PROCESSING_LABELS[file.processing.status]}<Icon name="arrow" size={13}/></button></li>)}</ul>}
      </div><footer className="document-footer"><Icon name="lock" size={13}/><span>资料与问答围绕当前知识库展开</span></footer>
    </section>
    <KnowledgeChat key={base.id} baseId={base.id} name={base.name}/>
    {preview && <DocumentPreview key={preview.id} document={preview} libraryId={base.id} onClose={() => setPreview(undefined)}/>}
    {processingDocument && <DocumentProcessing key={processingDocument.id} document={processingDocument} libraryId={base.id} onClose={() => { setProcessingDocument(undefined); setRefresh((value) => value+1); }} onUpdate={updateProcessing}/>}
  </div>;
}
