import { handle, type IdContext } from "../../../../../../lib/server/ai/admin";
import { diagnostics } from "../../../../../../lib/server/ai/provider-repository";
export async function GET(request: Request, ctx: IdContext) { return handle(request, false, async () => ({ diagnostics: await diagnostics((await ctx.params).id) })); }
