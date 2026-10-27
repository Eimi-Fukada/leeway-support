import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { AppError } from "../contracts.ts";
import { MAX_LIBRARY_DOCUMENTS, type StoredDocument } from "./contracts.ts";
import { documentName, textPreview, validateDocument } from "./files.ts";
import type { DocumentStorage } from "./storage.ts";

type DocumentRow = Omit<StoredDocument, "createdAt" | "status"> & { createdAt: Date; storage_key: string; sha256: string };
const columns = 'id,name,kind,size,created_at AS "createdAt",storage_key,sha256';
const view = (row: DocumentRow): StoredDocument => ({ id: row.id, name: row.name, kind: row.kind, size: row.size, createdAt: row.createdAt.toISOString(), status: "stored" });
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
      if (existing.rows[0]) { await client.query("COMMIT"); return { document: view(existing.rows[0]), duplicate: true }; }
      const count = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM public.knowledge_documents WHERE knowledge_base_id=$1", [libraryId]);
      if (count.rows[0]!.count >= MAX_LIBRARY_DOCUMENTS) throw new AppError(409, "当前知识库最多保存 200 个文档。");
      const id = randomUUID(); const key = randomUUID();
      // 先完成原文件写入，再提交可见记录；数据库提交结果不确定时不盲删原文。
      await this.storage.write(key, data);
      const result = await client.query<DocumentRow>(`INSERT INTO public.knowledge_documents(id,knowledge_base_id,name,kind,size,sha256,storage_key)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${columns}`, [id, libraryId, name, kind, data.length, sha256, key]);
      await client.query("COMMIT");
      return { document: view(result.rows[0]!), duplicate: false };
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
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
