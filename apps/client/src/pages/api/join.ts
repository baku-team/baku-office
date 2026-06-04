import type { APIRoute } from "astro";
import { joinWithInvite } from "../../lib/users.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 招待コードで参加（§6.3）。dev：local（loginId/password）。本番：LINE/Discordログイン。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const b = (await request.json().catch(() => ({}))) as { code?: string; name?: string; loginId?: string; password?: string };
  if (!b.code || !b.name || !b.loginId || !b.password) return json({ error: "code,name,loginId,password が必要" }, 400);
  const r = await joinWithInvite(env, b.code, b.name, { type: "local", externalId: b.loginId, password: b.password });
  return json(r, r.ok ? 200 : 400);
};
