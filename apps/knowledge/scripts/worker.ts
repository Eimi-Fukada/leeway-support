import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createPool } from "../src/database.ts";
import { LocalDocumentStorage } from "../src/documents/storage.ts";
import { DocumentProcessor } from "../src/documents/processor.ts";
import { createEmbeddingClient } from "../src/embeddings/client.ts";
import { EmbeddingProcessor } from "../src/embeddings/processor.ts";
import { QdrantStore,readQdrantConfig } from "../src/indexing/qdrant.ts";
import { IndexProcessor } from "../src/indexing/processor.ts";

const env = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(env)) process.loadEnvFile(env);
if (process.argv.slice(2).some((argument) => argument !== "--once")) throw new Error("仅支持可选 --once 参数。");
const pool = createPool();
const storage = new LocalDocumentStorage(process.env.KNOWLEDGE_STORAGE_DIR ?? fileURLToPath(new URL("../.knowledge-storage/",import.meta.url)));
const processor = new DocumentProcessor(pool, storage);
let embeddings: EmbeddingProcessor;
const stop = new AbortController();
process.once("SIGINT", () => stop.abort()); process.once("SIGTERM", () => stop.abort());
try {
  embeddings = new EmbeddingProcessor(pool,createEmbeddingClient());
  const indexing=new IndexProcessor(pool,new QdrantStore(readQdrantConfig()));
  console.log("文档处理器已启动：解析、分块、向量化、Qdrant 写入与核对。");
  do {
    await processor.recoverInterrupted();
    await embeddings.recoverInterrupted();
    await indexing.recoverInterrupted();
    // 优先消费已有片段；本轮新解析完的文档可以继续向量化，解析与模型调用不共享事务。
    let processed=await indexing.processNext();
    if(!processed){processed=await embeddings.processNext();if(processed)await indexing.processNext();}
    if(!processed){processed=await processor.processNext();if(processed){await embeddings.processNext();await indexing.processNext();}}
    if (process.argv.includes("--once")) break;
    if (!processed) await delay(1000, undefined, { signal: stop.signal }).catch(() => {});
  } while (!stop.signal.aborted);
} catch { console.error("文档处理器停止：请检查数据库、初始化 SQL、原文件、EMBEDDING_* 与 QDRANT_* 配置。"); process.exitCode = 1; }
finally { await pool.end(); }
