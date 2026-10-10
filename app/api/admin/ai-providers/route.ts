import { handle, jsonBody } from "../../../../lib/server/ai/admin";
import { publicCenter, readCenter, saveProvider } from "../../../../lib/server/ai/provider-repository";
import { environmentSummary } from "../../../../lib/server/ai/routing";
export async function GET(request: Request) { return handle(request, false, async () => ({ ...publicCenter(await readCenter()), environmentFallback: environmentSummary() })); }
export async function POST(request: Request) { return handle(request, true, async () => ({ provider: await saveProvider(null, await jsonBody(request)) })); }
