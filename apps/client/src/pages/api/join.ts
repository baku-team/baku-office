import type { APIRoute } from "astro";
import { joinWithInvite } from "../../lib/users.ts";

export const prerender = false;
const json = (o: unknown, s = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", ...headers } });

// 招待コードで参加（§6.3）。OAuth経由（pending_oauth Cookie）= LINE/Discord、なければ local(id/pass)。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const b = (await request.json().catch(() => ({}))) as { code?: string; name?: string; loginId?: string; password?: string };
  if (!b.code || !b.name) return json({ error: "code と name が必要" }, 400);

  // OAuth identity の引き継ぎ。
  const pendRaw = /pending_oauth=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  if (pendRaw) {
    try {
      const pend = JSON.parse(atob(pendRaw)) as { provider: "line" | "discord"; externalId: string };
      const r = await joinWithInvite(env, b.code, b.name, { type: pend.provider, externalId: pend.externalId });
      return json(r, r.ok ? 200 : 400, { "set-cookie": "pending_oauth=; Path=/; Max-Age=0" });
    } catch {
      /* fallthrough to local */
    }
  }

  if (!b.loginId || !b.password) return json({ error: "loginId と password が必要（または LINE/Discord でログインしてから参加）" }, 400);
  const r = await joinWithInvite(env, b.code, b.name, { type: "local", externalId: b.loginId, password: b.password });
  return json(r, r.ok ? 200 : 400);
};
