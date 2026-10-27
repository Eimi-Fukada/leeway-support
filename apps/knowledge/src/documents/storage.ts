import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AppError } from "../contracts.ts";

export interface DocumentStorage {
  write(key: string, data: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}
// 实际共享需求出现后可替换成私有 OSS/S3；服务端始终先鉴权，再按内部 key 访问。
export class LocalDocumentStorage implements DocumentStorage {
  private readonly root: string;
  constructor(root = process.env.KNOWLEDGE_STORAGE_DIR ?? ".knowledge-storage") {
    // 原文件来自运行期私有卷，不应被 Next 静态追踪进部署产物。
    this.root = resolve(/* turbopackIgnore: true */ root);
  }
  private path(key: string) {
    if (!/^[a-f0-9-]{36}$/.test(key)) throw new Error("无效存储引用。");
    return join(this.root, `${key}.blob`);
  }
  async write(key: string, data: Buffer) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await writeFile(this.path(key), data, { flag: "wx", mode: 0o600 });
  }
  async read(key: string) {
    try { return await readFile(this.path(key)); }
    catch { throw new AppError(503, "原文件暂时无法读取，请检查文件存储。"); }
  }
  async remove(key: string) { await unlink(this.path(key)); }
}
