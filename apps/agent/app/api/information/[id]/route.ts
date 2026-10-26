import { getSupportRuntime } from "../../../../src/server/runtime.ts";
import { json, localRequestError } from "../../../../src/server/request.ts";
import { memoryScope, checkpointThreadId } from "../../../../src/support-context.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const rejected = localRequestError(request);
  if (rejected) return rejected;
  try {
    const { id } = await params;
    const thread = new URL(request.url).searchParams.get("thread") ?? "";
    if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[A-Za-z0-9_-]{1,128}$/.test(thread)) throw new Error();
    const { support, information } = await getSupportRuntime();
    return json(await information.get(memoryScope(support), checkpointThreadId(thread, support), id));
  } catch { return json({ error: "表单不可用" }, 404); }
}
