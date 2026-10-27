import { notFound } from "next/navigation";
import { Workspace } from "../../../components/Workspace.tsx";
import { requireUser, service } from "../../../src/server/runtime.ts";

export const dynamic = "force-dynamic";
export default async function KnowledgePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const bases = await service().list(user.id);
  if (!bases.some((base) => base.id === id)) notFound();
  return <Workspace user={user} initialBases={bases} selectedBaseId={id}/>;
}
