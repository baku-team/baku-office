import type { APIRoute } from "astro";
import { callerFromToken } from "../../../lib/registry.ts";
import { reportEntry } from "../../../lib/directory.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 公開団体への通報（ライセンス団体のみ）。閾値超で自動 block。
export const POST: APIRoute = async ({ request }) => {
  const b = (await request.json().catch(() => ({}))) as { token?: string; target?: string; reason?: string; detail?: string };
  const caller = await callerFromToken(env, b.token);
  if (!caller) return json({ error: "有効なライセンスが必要" }, 401);
  if (!b.target || !b.reason) return json({ error: "target / reason が必要" }, 400);
  const r = await reportEntry(env, String(b.target), caller.licenseId, String(b.reason), b.detail ? String(b.detail) : undefined);
  return json(r);
};
