import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Next chunk 位置与源码不同；Web 使用应用 cwd，CLI/测试使用源码相对的应用目录。
const root = process.env.NEXT_RUNTIME ? process.cwd() : fileURLToPath(new URL("../../", import.meta.url));
export const supportSchemaFiles = ["001_long_term_memory.sql", "002_information_forms.sql", "003_conversations.sql", "004_knowledge_runs.sql"] as const;
export type SupportSchemaFile = typeof supportSchemaFiles[number];

export function readSupportSchema(file: SupportSchemaFile): Promise<string> {
  // 各路径静态列出，Next 能将这些 SQL 追踪到服务端部署产物中。
  switch (file) {
    case "001_long_term_memory.sql": return readFile(join(root, "sql/001_long_term_memory.sql"), "utf8");
    case "002_information_forms.sql": return readFile(join(root, "sql/002_information_forms.sql"), "utf8");
    case "003_conversations.sql": return readFile(join(root, "sql/003_conversations.sql"), "utf8");
    case "004_knowledge_runs.sql": return readFile(join(root, "sql/004_knowledge_runs.sql"), "utf8");
  }
}
