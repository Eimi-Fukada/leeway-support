import { Workspace } from "../components/Workspace.tsx";
import { requireUser, service } from "../src/server/runtime.ts";
import { uploadFormats } from "../src/documents/parsers/index.ts";

export const dynamic = "force-dynamic";
export default async function Home() {
  const user = await requireUser();
  return <Workspace user={user} initialBases={await service().list(user.id)} uploadFormats={uploadFormats()}/>;
}
