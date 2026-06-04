import type { APIRoute } from "astro";
import { createCheckout, stripeEnabled } from "../../../lib/billing.ts";
import type { Plan } from "@baku-office/shared";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// アップグレード起点（§2.4）：licenseId＋plan → Stripe Checkout URL。
// Stripe未設定のdevでは dev-confirm URL（入金シミュレート）を返す。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const b = (await request.json().catch(() => ({}))) as { licenseId?: string; plan?: Plan; returnUrl?: string };
  if (!b.licenseId || !["Y", "Z"].includes(b.plan ?? "")) return json({ error: "licenseId と plan(Y/Z) が必要" }, 400);

  const lic = await env.DB.prepare("SELECT license_id FROM licenses WHERE license_id=? AND status='active'").bind(b.licenseId).first();
  if (!lic) return json({ error: "ライセンス無効" }, 400);

  const ret = b.returnUrl ?? "";
  if (stripeEnabled(env)) {
    const url = await createCheckout(env, b.licenseId, b.plan as Plan, ret || "https://example.com/ok", ret || "https://example.com/cancel");
    if (!url) return json({ error: "Stripe Checkout 生成に失敗" }, 502);
    return json({ ok: true, url, mode: "stripe" });
  }
  // dev：入金シミュレートURL（本番ではこの分岐は無効）。
  const url = `${new URL(request.url).origin}/api/billing/dev-confirm?license_id=${b.licenseId}&plan=${b.plan}&return=${encodeURIComponent(ret)}`;
  return json({ ok: true, url, mode: "dev" });
};
