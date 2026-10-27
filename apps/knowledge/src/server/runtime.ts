import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createPool } from "../database.ts";
import { KnowledgeService } from "../service.ts";
import { DocumentService } from "../documents/service.ts";
import { LocalDocumentStorage } from "../documents/storage.ts";

export const SESSION_COOKIE = "leeway_knowledge_session";
const shared = globalThis as typeof globalThis & { knowledgeService?: KnowledgeService; knowledgeDocuments?: DocumentService };
export function service(): KnowledgeService {
  return shared.knowledgeService ??= new KnowledgeService(createPool());
}
export function documents(): DocumentService {
  return shared.knowledgeDocuments ??= new DocumentService(createPool(), new LocalDocumentStorage());
}
export const currentUser = cache(async () => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? service().user(token) : null;
});
export async function requireUser() {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}
