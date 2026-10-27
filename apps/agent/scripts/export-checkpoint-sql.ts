import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// 仅用于导出/校验锁定 SDK 的官方 SQL，不在生产请求中导入其内部模块。
export async function checkpointSql(): Promise<string> {
  const entry = import.meta.resolve("@langchain/langgraph-checkpoint-postgres");
  const manifest: { version: string } = JSON.parse(await readFile(new URL("../package.json", entry), "utf8"));
  const { getMigrations }: { getMigrations: (schema: string) => string[] } = await import(new URL("./migrations.js", entry).href);
  const migrations = getMigrations("public");
  let sql = `-- Generated from @langchain/langgraph-checkpoint-postgres ${manifest.version} getMigrations(public).\n` +
    "-- Do not edit by hand. Regenerate and review after SDK upgrades.\n" +
    "-- This file manages its own transaction; do not wrap it in another transaction.\n" +
    "BEGIN;\nSELECT pg_advisory_xact_lock(461992306);\n";
  for (const [version, migration] of migrations.entries()) {
    sql += `\n-- Official migration ${version}\n${migration}\n`;
    if (version === 0) sql += `DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.checkpoint_migrations WHERE v > ${migrations.length - 1}) THEN
    RAISE EXCEPTION 'Checkpoint database is newer than this SQL snapshot; use the matching SDK.';
  END IF;
END $$;\n`;
    sql += `INSERT INTO public.checkpoint_migrations(v) VALUES (${version}) ON CONFLICT(v) DO NOTHING;\n`;
  }
  return sql + "\nCOMMIT;\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await writeFile(new URL("../sql/010_langgraph_checkpoint.sql", import.meta.url), await checkpointSql());
  console.log("已导出当前 SDK 的 public checkpoint SQL；未连接数据库。");
}
