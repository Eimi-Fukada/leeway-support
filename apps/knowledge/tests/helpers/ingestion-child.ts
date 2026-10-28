import { fileURLToPath } from "node:url";
import { createPool } from "../../src/database.ts";
import { DocumentProcessor } from "../../src/documents/processor.ts";
import { LocalDocumentStorage } from "../../src/documents/storage.ts";
process.loadEnvFile(fileURLToPath(new URL("../../.env",import.meta.url)));
const pool = createPool();
const claimed = await new DocumentProcessor(pool,new LocalDocumentStorage()).claim(process.argv[2]);
process.send?.({ claimed: claimed?.id });
// 父进程在领取已持久化后强制结束此进程，模拟处理器崩溃。
await new Promise(() => {});
