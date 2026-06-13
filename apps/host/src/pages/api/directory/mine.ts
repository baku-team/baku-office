import type { APIRoute } from "astro";
import { callerFromToken } from "../../../lib/registry.ts";
import { getEntry } from "../../../lib/directory.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 本人の掲載状況（listed/trust/verification）取得。公開設定UIの状態表示用。
export const POST: APIRoute = async ({ request }) => {
  const b = (await request.json().catch(() => ({}))) as { token?: string };
  const caller = await callerFromToken(env, b.token);
  if (!caller) return json({ error: "有効なライセンスが必要" }, 401);
  const entry = await getEntry(env, caller.licenseId);
  return json({ ok: true, entry: entry ? { listed: entry.listed, blocked: entry.blocked, trust_score: entry.trust_score, verification: entry.verification, updated_at: entry.updated_at } : null });
};
