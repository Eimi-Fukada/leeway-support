// 仅查询 PostgreSQL catalog；不执行初始化 SQL，也不维护迁移历史。
export interface StatusClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export type TableCheck = {
  name: string;
  file: string;
  // 使用 PostgreSQL typname；! 表示 NOT NULL，未标记表示允许 NULL。
  columns: Record<string, string>;
  constraints: string[];
  indexes?: string[];
};
export type TableStatus = { name: string; file: string; issues: string[] };

export async function inspectDatabase(client: StatusClient, checks: readonly TableCheck[], schema = "public"): Promise<TableStatus[]> {
  // 独立客户端上开启只读快照，数据库本身也会拒绝 DDL/业务写入。
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const names = checks.map((check) => check.name);
    const tables = await client.query<{ name: string }>(`SELECT c.relname AS name FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND c.relkind IN ('r','p')`, [schema, names]);
    const columns = await client.query<{ table_name: string; name: string; type: string; not_null: boolean }>(
      `SELECT c.relname AS table_name,a.attname AS name,t.typname AS type,a.attnotnull AS not_null
       FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
       WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND a.attnum>0 AND NOT a.attisdropped`, [schema, names]);
    const constraints = await client.query<{ table_name: string; name: string }>(
      `SELECT c.relname AS table_name,k.conname AS name FROM pg_catalog.pg_constraint k
       JOIN pg_catalog.pg_class c ON c.oid=k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND k.convalidated`, [schema, names]);
    const indexes = await client.query<{ table_name: string; name: string }>(
      `SELECT c.relname AS table_name,i.relname AS name FROM pg_catalog.pg_index x
       JOIN pg_catalog.pg_class c ON c.oid=x.indrelid JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid
       JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND x.indisvalid AND x.indisready`, [schema, names]);
    const statuses = checks.map((check): TableStatus => {
      const issues: string[] = [];
      if (!tables.rows.some((table) => table.name === check.name)) issues.push("缺少表");
      else {
        for (const [name, expected] of Object.entries(check.columns)) {
          const actual = columns.rows.find((column) => column.table_name === check.name && column.name === name);
          if (!actual) issues.push(`缺少字段 ${name}`);
          else {
            if (actual.type !== expected.replace(/!$/, "")) issues.push(`字段 ${name} 类型应为 ${expected.replace(/!$/, "")}`);
            if (actual.not_null !== expected.endsWith("!")) issues.push(`字段 ${name} 可空性不符`);
          }
        }
        for (const name of check.constraints) {
          if (!constraints.rows.some((constraint) => constraint.table_name === check.name && constraint.name === name)) issues.push(`缺少有效约束 ${name}`);
        }
        for (const name of check.indexes ?? []) {
          if (!indexes.rows.some((index) => index.table_name === check.name && index.name === name)) issues.push(`缺少有效索引 ${name}`);
        }
      }
      return { name: check.name, file: check.file, issues };
    });
    await client.query("COMMIT");
    return statuses;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export function printDatabaseStatus(label: string, statuses: readonly TableStatus[]): boolean {
  console.log(`${label}数据库结构检查（只读）`);
  for (const status of statuses) {
    console.log(`${status.issues.length ? "[缺失/不符]" : "[正常]"} ${status.name} → sql/${status.file}`);
    for (const issue of status.issues) console.log(`  ${issue}`);
  }
  const ready = statuses.every((status) => status.issues.length === 0);
  console.log(ready ? "当前检查项均符合要求。" : "请核对以上 SQL；本命令没有修复或初始化数据库。");
  console.log("本命令不记录 SQL 执行历史，不比较默认值、约束/索引表达式或业务数据。");
  return ready;
}
