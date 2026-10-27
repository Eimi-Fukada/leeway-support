import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { AppError, knowledgeInputSchema, loginSchema, type KnowledgeBase, type User } from "./contracts.ts";
import { verifyPassword } from "./password.ts";

export const SESSION_SECONDS = 60 * 60 * 24 * 7;
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
type UserRow = User & { password_hash: string };
type KnowledgeRow = Omit<KnowledgeBase, "createdAt"> & { createdAt: Date };

export class KnowledgeService {
  constructor(private readonly pool: pg.Pool) {}

  async login(input: unknown): Promise<{ user: User; token: string }> {
    const parsed = loginSchema.safeParse(input);
    if (!parsed.success) throw new AppError(400, "请填写有效的账号和密码。");
    const found = await this.pool.query<UserRow>("SELECT id,username,password_hash FROM public.knowledge_users WHERE username=$1 AND active=true", [parsed.data.username]);
    const row = found.rows[0];
    // 账号不存在也进行同成本校验，返回相同提示。
    const dummy = "scrypt:32768:8:3:00000000000000000000000000000000:" + "0".repeat(64);
    const valid = await verifyPassword(parsed.data.password, row?.password_hash ?? dummy);
    if (!row || !valid) throw new AppError(401, "账号或密码不正确。");
    const token = randomBytes(32).toString("hex");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM public.knowledge_sessions WHERE expires_at<=now()");
      await client.query(`INSERT INTO public.knowledge_sessions(token_hash,user_id,expires_at)
        VALUES($1,$2,now()+interval '7 days')`, [digest(token), row.id]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
    return { user: { id: row.id, username: row.username }, token };
  }

  async user(token?: string): Promise<User | null> {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const result = await this.pool.query<User>(`SELECT u.id,u.username FROM public.knowledge_sessions s
      JOIN public.knowledge_users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true`, [digest(token)]);
    return result.rows[0] ?? null;
  }

  async logout(token?: string): Promise<void> {
    if (token && /^[a-f0-9]{64}$/.test(token))
      await this.pool.query("DELETE FROM public.knowledge_sessions WHERE token_hash=$1", [digest(token)]);
  }

  async list(userId: string): Promise<KnowledgeBase[]> {
    const rows = await this.pool.query<KnowledgeRow>(`SELECT b.id,b.name,b.description,b.created_at AS "createdAt",
      (SELECT count(*)::int FROM public.knowledge_documents d WHERE d.knowledge_base_id=b.id) AS "documentCount"
      FROM public.knowledge_bases b WHERE b.owner_id=$1 ORDER BY b.created_at DESC,b.id`, [userId]);
    return rows.rows.map((row: KnowledgeRow) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  }

  async create(userId: string, input: unknown): Promise<KnowledgeBase> {
    const parsed = knowledgeInputSchema.safeParse(input);
    if (!parsed.success) throw new AppError(400, parsed.error.issues[0]?.code === "unrecognized_keys"
      ? "提交内容包含无效字段。" : parsed.error.issues[0]?.message ?? "请检查知识库信息。");
    try {
      const result = await this.pool.query<KnowledgeRow>(`INSERT INTO public.knowledge_bases(id,owner_id,name,description)
        VALUES($1,$2,$3,$4) RETURNING id,name,description,created_at AS "createdAt"`,
      [randomUUID(), userId, parsed.data.name, parsed.data.description]);
      const row = result.rows[0]!;
      return { ...row, createdAt: row.createdAt.toISOString() };
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && error.code === "23505")
        throw new AppError(409, "已有同名知识库，请换一个名称。");
      throw error;
    }
  }
}
