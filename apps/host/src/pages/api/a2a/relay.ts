import type { APIRoute } from "astro";
import { licenseFromToken, relay } from "../../../lib/a2a.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// A2A 中継：from（トークンのライセンス）→ to へ、署名つきで相手 client の inbound を呼ぶ。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const b = (await request.json().catch(() => ({}))) as { token?: string; to?: string; action?: string; args?: Record<string, unknown> };
  const from = await licenseFromToken(env, b.token);
  if (!from) return json({ error: "有効なライセンスが必要" }, 401);
  if (!b.to || !b.action) return json({ error: "to / action が必要" }, 400);
  const r = await relay(env, from, String(b.to), String(b.action), b.args ?? {});
  return json(r, r.ok ? 200 : 400);
};
