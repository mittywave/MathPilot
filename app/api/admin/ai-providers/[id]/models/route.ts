import { handle, jsonBody, type IdContext } from "../../../../../../lib/server/ai/admin";
import { deleteModel, saveManualModel } from "../../../../../../lib/server/ai/provider-repository";
export async function POST(request: Request, ctx: IdContext) { return handle(request, true, async () => ({ model: await saveManualModel((await ctx.params).id, await jsonBody(request)) })); }
export async function DELETE(request: Request, ctx: IdContext) { return handle(request, true, async () => { await deleteModel((await ctx.params).id, await jsonBody(request)); return { deleted: true }; }); }
