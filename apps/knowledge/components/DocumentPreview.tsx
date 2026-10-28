import { useEffect, useRef, useState } from "react";
import type { StoredDocument, TextPreview } from "../src/documents/contracts.ts";
import { Icon } from "./Icons.tsx";

export function DocumentPreview({ libraryId, document, onClose }: { libraryId: string; document: StoredDocument; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [preview, setPreview] = useState<TextPreview>();
  const [error, setError] = useState("");
  const url = `/api/knowledge-bases/${libraryId}/documents/${document.id}`;
  useEffect(() => {
    dialog.current?.showModal();
    if (document.kind === "pdf") return;
    const abort = new AbortController();
    void fetch(`${url}/preview`, { signal: abort.signal }).then(async (response) => {
      const data: TextPreview & { error?: string } = await response.json();
      if (!response.ok) throw new Error(data.error ?? "暂时无法预览。");
      setPreview(data);
    }).catch((cause: unknown) => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "暂时无法预览。"); });
    return () => abort.abort();
  }, [url, document.kind]);
  return <dialog ref={dialog} className="document-preview" aria-labelledby="preview-title" onClose={onClose}>
    <header><div><span className="document-kicker">原文预览 · {document.kind.toUpperCase()}</span><h2 id="preview-title">{document.name}</h2></div><div className="preview-actions"><a href={`${url}/original?download=1`} className="secondary-button">下载原文</a><button type="button" className="icon-button" aria-label="关闭预览" onClick={() => dialog.current?.close()}><Icon name="close"/></button></div></header>
    <div className="document-preview-content">{document.kind === "pdf" ? <><iframe title={`PDF 预览：${document.name}`} src={`${url}/original#toolbar=1`} referrerPolicy="no-referrer"/><p className="preview-footnote">如浏览器不支持 PDF 预览，可下载原文查看。</p></>
      : error ? <p className="error" role="alert">{error}</p> : !preview ? <p className="muted" role="status">正在读取原文…</p>
      : <><pre>{preview.text || "（文件没有可展示的文本内容）"}</pre>{preview.truncated && <p className="preview-footnote">内容较长，仅显示前 100,000 字符，可下载查看全文。</p>}</>}
    </div><footer>原文件已保存{document.kind === "docx" && " · Word 以纯文本展示"}</footer>
  </dialog>;
}
