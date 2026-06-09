import type { APIRoute } from "astro";
import { getHostSession } from "../../lib/hostauth.ts";
import { recordAudit } from "../../lib/host.ts";
import { approve, reject } from "../../lib/nonprofit.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// NonProfit 審査（ホスト管理者のみ）。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const ses = await getHostSession(env, request);
  if (!ses?.isAdmin) return json({ error: "管理者のみ" }, 403);
  const b = (await request.json().catch(() => ({}))) as { _action?: string; license_id?: string; reason?: string };
  if (!b.license_id) return json({ error: "license_id が必要" }, 400);
  if (b._action === "approve") { await approve(env, b.license_id); await recordAudit(env, ses.email, "nonprofit.approve", b.license_id, null); return json({ ok: true }); }
  if (b._action === "reject") { await reject(env, b.license_id, String(b.reason ?? "")); await recordAudit(env, ses.email, "nonprofit.reject", b.license_id, String(b.reason ?? "")); return json({ ok: true }); }
  return json({ error: "不明な操作" }, 400);
};
