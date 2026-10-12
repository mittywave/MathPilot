import { requireSameOrigin, requireUser } from "../../../lib/server/auth";
import { createTypesetRecord, listTypesetRecords } from "../../../lib/server/typeset-records";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    return Response.json({ records: await listTypesetRecords(user) });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "历史记录读取失败" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    return Response.json({ record: await createTypesetRecord(user, await request.json().catch(() => ({}))) }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "历史记录保存失败" }, { status: 500 });
  }
}
