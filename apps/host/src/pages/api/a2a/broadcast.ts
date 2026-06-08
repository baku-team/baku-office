import type { APIRoute } from "astro";
import { licenseFromToken, groupRelay } from "../../../lib/a2a.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// A2A グループ中継：to 指定で個別、未指定で他の全 active メンバーへ同報。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const b = (await request.json().catch(() => ({}))) as { token?: string; groupId?: string; to?: string; action?: string; args?: Record<string, unknown> };
  const from = await licenseFromToken(env, b.token);
  if (!from) return json({ error: "有効なライセンスが必要" }, 401);
  if (!b.groupId || !b.action) return json({ error: "groupId / action が必要" }, 400);
  const r = await groupRelay(env, from, String(b.groupId), b.to ? String(b.to) : null, String(b.action), b.args ?? {});
  return json(r, r.ok ? 200 : 400);
};
