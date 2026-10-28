import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createPool } from "../database.ts";
import { KnowledgeService } from "../service.ts";
import { DocumentService } from "../documents/service.ts";
import { LocalDocumentStorage } from "../documents/storage.ts";
import { QdrantStore,readQdrantConfig } from "../indexing/qdrant.ts";
import { IndexProcessor } from "../indexing/processor.ts";
import { createEmbeddingClient } from "../embeddings/client.ts";
import { RetrievalService } from "../retrieval/service.ts";

export const SESSION_COOKIE = "leeway_knowledge_session";
// 只跨热更新复用连接池；业务类实例跟随模块更新，避免仍调用旧版方法或缺少新增接口。
const shared = globalThis as typeof globalThis & { knowledgePool?: ReturnType<typeof createPool> };
let knowledgeService: KnowledgeService | undefined;
let knowledgeDocuments: DocumentService | undefined;
function pool() { return shared.knowledgePool ??= createPool(); }
export function database() { return pool(); }
export function service(): KnowledgeService {
  return knowledgeService ??= new KnowledgeService(pool());
}
export function documents(): DocumentService {
  return knowledgeDocuments ??= new DocumentService(pool(), new LocalDocumentStorage());
}
export function indexing():IndexProcessor{return new IndexProcessor(pool(),new QdrantStore(readQdrantConfig()));}
export function retrieval():RetrievalService{return new RetrievalService(pool(),createEmbeddingClient(),new QdrantStore(readQdrantConfig()));}
export const currentUser = cache(async () => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? service().user(token) : null;
});
export async function requireUser() {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}
