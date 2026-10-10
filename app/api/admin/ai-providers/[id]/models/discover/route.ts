import { handle, jsonBody, type IdContext } from "../../../../../../../lib/server/ai/admin";
import { limitProbe } from "../../../../../../../lib/server/ai/provider-repository";
import { discoverModels } from "../../../../../../../lib/server/ai/probes";
export async function POST(request: Request, ctx: IdContext) { return handle(request, true, async (userId) => { await limitProbe(userId); return discoverModels((await ctx.params).id, (await jsonBody(request)).fingerprint, request.signal); }); }
