import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { parserForKind, uploadFormats } from "./parsers/index.ts";
import type { ParsedDocument } from "./parsers/types.ts";
import { CHUNK_CONFIG, chunkDocument, type DocumentChunk } from "./chunker.ts";
import type { DocumentKind } from "./contracts.ts";
import type { DocumentStorage } from "./storage.ts";
import type { ProcessingErrorCode } from "./processing.ts";
import { TextParseError } from "./text.ts";

interface ClaimedDocument { id: string; kind: DocumentKind; sha256: string; size: number; storage_key: string; processing_run_id: string }
export class DocumentProcessor {
  constructor(private readonly pool: pg.Pool, private readonly storage: DocumentStorage, private readonly timeoutMs = 60_000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>120_000) throw new Error("Invalid parsing timeout");
  }

  async recoverInterrupted(documentId?: string): Promise<void> {
    // 过期只标记中断，不自动重新执行；旧进程的 run_id 随即失去写入权。
    await this.pool.query(`UPDATE public.knowledge_documents SET processing_status='failed',processing_failed_stage=processing_status,
      processing_error_code='interrupted',processing_run_id=NULL,processing_lease_expires_at=NULL,processing_updated_at=now()
      WHERE processing_status IN ('parsing','chunking') AND (processing_lease_expires_at<=now() OR processing_lease_expires_at IS NULL)
        AND ($1::uuid IS NULL OR id=$1)`, [documentId ?? null]);
  }
  async claim(documentId?: string): Promise<ClaimedDocument | null> {
    const result = await this.pool.query<ClaimedDocument>(`UPDATE public.knowledge_documents SET processing_status='parsing',
      processing_run_id=$1,processing_lease_expires_at=now()+interval '2 minutes',processing_attempt=processing_attempt+1,processing_updated_at=now()
      WHERE id=(SELECT id FROM public.knowledge_documents WHERE processing_status IN ('pending','unsupported') AND kind=ANY($2::text[])
        AND ($3::uuid IS NULL OR id=$3) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id,kind,sha256,size,storage_key,processing_run_id`, [randomUUID(), uploadFormats().map((format) => format.kind), documentId ?? null]);
    return result.rows[0] ?? null;
  }
  async heartbeat(document: ClaimedDocument): Promise<boolean> {
    const result = await this.pool.query(`UPDATE public.knowledge_documents SET processing_lease_expires_at=now()+interval '2 minutes'
      WHERE id=$1 AND processing_run_id=$2 AND processing_status IN ('parsing','chunking') AND processing_lease_expires_at>now()`, [document.id, document.processing_run_id]);
    return result.rowCount === 1;
  }
  async finish(document: ClaimedDocument, parsed: ParsedDocument, chunks: DocumentChunk[]): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owned = await client.query(`SELECT id FROM public.knowledge_documents WHERE id=$1 AND processing_run_id=$2
        AND processing_status='chunking' AND processing_lease_expires_at>now() FOR UPDATE`, [document.id, document.processing_run_id]);
      if (!owned.rowCount) { await client.query("ROLLBACK"); return false; }
      await client.query("DELETE FROM public.knowledge_document_contents WHERE document_id=$1", [document.id]);
      await client.query(`INSERT INTO public.knowledge_document_contents(document_id,source_sha256,parser_id,parser_version,text,sections,warnings,splitter_config)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [document.id,document.sha256,parsed.parserId,parsed.parserVersion,parsed.text,JSON.stringify(parsed.sections),JSON.stringify(parsed.warnings),JSON.stringify(CHUNK_CONFIG)]);
      await client.query(`INSERT INTO public.knowledge_document_chunks(id,document_id,ordinal,text,heading_path,section_index,start_offset,end_offset,content_sha256)
        SELECT x.id,$1,x.ordinal,x.text,x.heading_path,x.section_index,x.start_offset,x.end_offset,x.content_sha256
        FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,ordinal integer,text text,heading_path jsonb,section_index integer,start_offset integer,end_offset integer,content_sha256 text)`,
      [document.id, JSON.stringify(chunks.map((chunk) => ({id:chunk.id,ordinal:chunk.ordinal,text:chunk.text,heading_path:chunk.headingPath,section_index:chunk.section,start_offset:chunk.start,end_offset:chunk.end,content_sha256:chunk.hash})))]);
      await client.query(`UPDATE public.knowledge_documents SET processing_status='chunked',processing_run_id=NULL,
        processing_lease_expires_at=NULL,processing_updated_at=now() WHERE id=$1 AND processing_run_id=$2`, [document.id,document.processing_run_id]);
      await client.query("COMMIT"); return true;
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async processNext(documentId?: string): Promise<boolean> {
    const document = await this.claim(documentId);
    if (!document) return false;
    let failure: ProcessingErrorCode = "read_failed";
    let stage: "parsing" | "chunking" = "parsing";
    let leaseLost = false; let heartbeatBusy = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timer = setInterval(() => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      void this.heartbeat(document).then((owned) => { if (!owned) leaseLost = true; }).catch(() => { leaseLost = true; }).finally(() => { heartbeatBusy = false; });
    }, 10_000);
    const work = async () => {
      const data = await this.storage.read(document.storage_key);
      if (leaseLost) return;
      if (data.length !== document.size || createHash("sha256").update(data).digest("hex") !== document.sha256) throw new Error("Source integrity mismatch");
      failure = "parse_failed";
      const parsed = await parserForKind(document.kind).parse(data);
      if (leaseLost) return;
      const transitioned = await this.pool.query(`UPDATE public.knowledge_documents SET processing_status='chunking',processing_updated_at=now()
        WHERE id=$1 AND processing_run_id=$2 AND processing_status='parsing' AND processing_lease_expires_at>now()`, [document.id,document.processing_run_id]);
      if (leaseLost || !transitioned.rowCount) return;
      stage = "chunking"; failure = "chunk_failed";
      const chunks = await chunkDocument(document.id, parsed);
      if (!leaseLost) await this.finish(document, parsed, chunks);
    };
    try {
      await Promise.race([work(), new Promise<never>((_resolve,reject) => {
        deadline = setTimeout(() => { leaseLost = true; failure = "interrupted"; reject(new Error("Parsing deadline exceeded")); },this.timeoutMs);
      })]);
    } catch (error) {
      if (error instanceof TextParseError) failure = error.code;
      // 数据库 COMMIT 结果不明确时，不覆盖已经提交的 chunked；只有仍持有当前轮次才记录失败。
      await this.pool.query(`UPDATE public.knowledge_documents SET processing_status='failed',processing_failed_stage=$3,
        processing_error_code=$4,processing_run_id=NULL,processing_lease_expires_at=NULL,processing_updated_at=now()
        WHERE id=$1 AND processing_run_id=$2 AND processing_status IN ('parsing','chunking')`, [document.id,document.processing_run_id,stage,failure]);
    } finally { clearInterval(timer); clearTimeout(deadline); }
    return true;
  }
}
