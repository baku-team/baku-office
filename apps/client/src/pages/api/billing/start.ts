import type { APIRoute } from "astro";
import { getSession } from "../../../lib/auth.ts";
import { getLicenseId, hostFetch } from "../../../lib/client.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// アップグレード開始：licenseId を server-side で添えて host の checkout を呼ぶ（§2.4）。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return json({ error: "管理者のみ" }, 403);
  const b = (await request.json().catch(() => ({}))) as { plan?: string };
  if (!["plus", "pro"].includes(b.plan ?? "")) return json({ error: "plan(plus/pro)が必要" }, 400);
  const licenseId = await getLicenseId(env);
  if (!licenseId) return json({ error: "ライセンス未取得" }, 400);

  // 決済後の戻り先＝このクライアントの /billing。host の Checkout success/cancel に使う。
  const returnUrl = new URL(request.url).origin + "/billing";
  const r = await hostFetch(env, "/api/billing/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ licenseId, plan: b.plan, returnUrl }),
  });
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; url?: string; mode?: string; error?: string };
  return json(j, r.ok ? 200 : 400);
};
