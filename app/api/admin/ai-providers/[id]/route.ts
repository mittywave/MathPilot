import { handle, jsonBody, type IdContext } from "../../../../../lib/server/ai/admin";
import { deleteProvider, findProvider, readCenter, saveProvider } from "../../../../../lib/server/ai/provider-repository";
export async function GET(request: Request, ctx: IdContext) { return handle(request, false, async () => ({ provider: findProvider(await readCenter(), (await ctx.params).id) })); }
export async function PATCH(request: Request, ctx: IdContext) { return handle(request, true, async () => ({ provider: await saveProvider((await ctx.params).id, await jsonBody(request)) })); }
export async function DELETE(request: Request, ctx: IdContext) { return handle(request, true, async () => { const body = await jsonBody(request); await deleteProvider((await ctx.params).id, Number(body.expectedRevision)); return { deleted: true }; }); }
