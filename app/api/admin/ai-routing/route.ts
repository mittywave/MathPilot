import { handle, jsonBody } from "../../../../lib/server/ai/admin";
import { readCenter, saveRouting } from "../../../../lib/server/ai/provider-repository";
export async function GET(request: Request) { return handle(request, false, async () => ({ routing: (await readCenter()).routing })); }
export async function PUT(request: Request) { return handle(request, true, async () => ({ routing: await saveRouting(await jsonBody(request)) })); }
