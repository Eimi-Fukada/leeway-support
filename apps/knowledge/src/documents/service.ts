import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { AppError } from "../contracts.ts";
import { MAX_LIBRARY_DOCUMENTS, type StoredDocument } from "./contracts.ts";
import { documentName, textPreview, validateDocument } from "./files.ts";
import type { DocumentStorage } from "./storage.ts";
import { processingDetail, processingSummary, type ProcessingRecord } from "./processing.ts";
import { uploadFormats } from "./parsers/index.ts";

type DocumentRow = Omit<StoredDocument, "createdAt" | "status" | "processing"> & ProcessingRecord & { createdAt: Date; storage_key: string; sha256: string };
const columns = 'id,name,kind,size,created_at AS "createdAt",storage_key,sha256,processing_status,processing_failed_stage,processing_error_code,processing_updated_at,processing_attempt';
const view = (row: DocumentRow): StoredDocument => ({ id: row.id, name: row.name, kind: row.kind, size: row.size, createdAt: row.createdAt.toISOString(), status: "stored", processing: processingSummary(row) });
export class DocumentService {
  constructor(private readonly pool: pg.Pool, private readonly storage: DocumentStorage) {}
  async authorize(userId: string, libraryId: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(libraryId)) throw new AppError(404, "知识库不存在或无权访问。");
    const result = await this.pool.query("SELECT id FROM public.knowledge_bases WHERE id=$1 AND owner_id=$2", [libraryId, userId]);
    if (!result.rowCount) throw new AppError(404, "知识库不存在或无权访问。");
  }
  async list(userId: string, libraryId: string): Promise<StoredDocument[]> {
    await this.authorize(userId, libraryId);
    const rows = await this.pool.query<DocumentRow>(`SELECT ${columns} FROM public.knowledge_documents WHERE knowledge_base_id=$1 ORDER BY created_at DESC,id`, [libraryId]);
    return rows.rows.map(view);
  }
  async upload(userId: string, libraryId: string, filename: string, data: Buffer) {
    await this.authorize(userId, libraryId);
    const name = documentName(filename); const kind = await validateDocument(name, data);
    const sha256 = createHash("sha256").update(data).digest("hex");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`knowledge-upload:${libraryId}`]);
      const existing = await client.query<DocumentRow>(`SELECT ${columns} FROM public.knowledge_documents WHERE knowledge_base_id=$1 AND sha256=$2`, [libraryId, sha256]);
      if (existing.rows[0]) {
        let row = existing.rows[0];
        if (row.processing_status === "unsupported" && uploadFormats().some((format) => format.kind === row.kind)) {
          const queued = await client.query<DocumentRow>(`UPDATE public.knowledge_documents SET processing_status='pending',processing_updated_at=now()
            WHERE id=$1 AND processing_status='unsupported' RETURNING ${columns}`, [row.id]);
          row = queued.rows[0] ?? row;
        }
        await client.query("COMMIT"); return { document: view(row), duplicate: true };
      }
      const count = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM public.knowledge_documents WHERE knowledge_base_id=$1", [libraryId]);
      if (count.rows[0]!.count >= MAX_LIBRARY_DOCUMENTS) throw new AppError(409, "当前知识库最多保存 200 个文档。");
      const id = randomUUID(); const key = randomUUID();
      // 先完成原文件写入，再提交可见记录；数据库提交结果不确定时不盲删原文。
      await this.storage.write(key, data);
      const result = await client.query<DocumentRow>(`INSERT INTO public.knowledge_documents(id,knowledge_base_id,name,kind,size,sha256,storage_key,processing_status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${columns}`, [id, libraryId, name, kind, data.length, sha256, key, "pending"]);
      await client.query("COMMIT");
      return { document: view(result.rows[0]!), duplicate: false };
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async processing(userId: string, libraryId: string, documentId: string) {
    await this.authorize(userId, libraryId);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(documentId)) throw new AppError(404, "文档不存在或无权访问。");
    const rows = await this.pool.query<ProcessingRecord>(`SELECT processing_status,processing_failed_stage,processing_error_code,processing_updated_at,processing_attempt,index_target,index_receipt
      FROM public.knowledge_documents WHERE id=$1 AND knowledge_base_id=$2`, [documentId, libraryId]);
    if (!rows.rows[0]) throw new AppError(404, "文档不存在或无权访问。");
    return processingDetail(documentId, rows.rows[0]);
  }
  async retryProcessing(userId: string, libraryId: string, documentId: string, attempt: number) {
    const current = await this.processing(userId, libraryId, documentId);
    const result = await this.pool.query(`UPDATE public.knowledge_documents SET processing_status=CASE WHEN processing_failed_stage='indexing' THEN 'embedded' WHEN processing_failed_stage='embedding' THEN 'chunked' ELSE 'pending' END,processing_failed_stage=NULL,
      processing_error_code=NULL,processing_run_id=NULL,processing_lease_expires_at=NULL,processing_updated_at=now()
      WHERE id=$1 AND knowledge_base_id=$2 AND processing_status='failed' AND processing_attempt=$3
        AND processing_failed_stage IN ('parsing','chunking','embedding','indexing') AND processing_error_code<>'result_unknown' AND kind=ANY($4::text[])
      RETURNING id`, [documentId, libraryId, attempt, uploadFormats().map((format) => format.kind)]);
    if (!result.rowCount && !(["pending","chunked","embedded"].includes(current.status) && current.attempt === attempt)) throw new AppError(409, "处理状态已变化，请刷新后核对；当前不能重试。");
    return this.processing(userId, libraryId, documentId);
  }
  async chunks(userId: string, libraryId: string, documentId: string, offset: number) {
    const state = await this.processing(userId, libraryId, documentId);
    if (!["chunked","embedding","embedded","indexing","ready"].includes(state.status)) throw new AppError(409, "文档尚无完整分块结果。");
    const rows = await this.pool.query(`SELECT c.id,c.ordinal,c.text,c.heading_path AS "headingPath",c.section_index AS "sectionIndex",
      c.start_offset AS "startOffset",c.end_offset AS "endOffset",p.parser_id AS "parserId",p.parser_version AS "parserVersion",p.warnings
      FROM public.knowledge_document_chunks c JOIN public.knowledge_document_contents p ON p.document_id=c.document_id
      JOIN public.knowledge_documents d ON d.id=p.document_id AND d.sha256=p.source_sha256
      WHERE d.id=$1 AND d.knowledge_base_id=$2 ORDER BY c.ordinal LIMIT 21 OFFSET $3`, [documentId, libraryId, offset]);
    return { documentId, offsetBasis: "normalized-text-utf16", chunks: rows.rows.slice(0,20), nextOffset: rows.rows.length>20 ? offset+20 : null };
  }
  async original(userId: string, libraryId: string, documentId: string) {
    await this.authorize(userId, libraryId);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(documentId)) throw new AppError(404, "文档不存在或无权访问。");
    const rows = await this.pool.query<DocumentRow>(`SELECT ${columns} FROM public.knowledge_documents WHERE id=$1 AND knowledge_base_id=$2`, [documentId, libraryId]);
    const row = rows.rows[0]; if (!row) throw new AppError(404, "文档不存在或无权访问。");
    const data = await this.storage.read(row.storage_key);
    if (data.length !== row.size || createHash("sha256").update(data).digest("hex") !== row.sha256) throw new AppError(503, "原文件校验失败，请联系管理员核对存储。");
    return { document: view(row), data };
  }
  async preview(userId: string, libraryId: string, documentId: string) {
    const original = await this.original(userId, libraryId, documentId);
    if (original.document.kind === "pdf") throw new AppError(400, "PDF 请使用原文预览。");
    return textPreview(original.document.kind, original.data);
  }
}
