import type { APIRoute } from "astro";
import { atLeast } from "@baku-office/shared";
import { callerFromToken } from "../../../lib/registry.ts";
import { relayPublic } from "../../../lib/a2a.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 招待なし公開中継：from（トークン・Plus以上）→ 公開団体 to の公開アクション/問い合わせ。
export const POST: APIRoute = async ({ request }) => {
  const b = (await request.json().catch(() => ({}))) as { token?: string; to?: string; action?: string; args?: Record<string, unknown> };
  const caller = await callerFromToken(env, b.token);
  if (!caller) return json({ error: "有効なライセンスが必要" }, 401);
  if (!atLeast(caller.entitlement, "plus")) return json({ error: "公開連絡は Plus 以上で利用できます" }, 402);
  if (!b.to || !b.action) return json({ error: "to / action が必要" }, 400);
  const r = await relayPublic(env, caller.licenseId, String(b.to), String(b.action), b.args ?? {});
  return json(r, r.ok ? 200 : 400);
};
