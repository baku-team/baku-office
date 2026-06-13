import type { APIRoute } from "astro";
import { createCheckout, stripeEnabled } from "../../../lib/billing.ts";
import { isDevEnv } from "../../../lib/hostauth.ts";
import type { Plan } from "@baku-office/shared";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// アップグレード起点（§2.4）：licenseId＋plan → Stripe Checkout URL。
// Stripe未設定のdevでは dev-confirm URL（入金シミュレート）を返す。
export const POST: APIRoute = async ({ request, locals }) => {
  const b = (await request.json().catch(() => ({}))) as { licenseId?: string; plan?: Plan; returnUrl?: string };
  if (!b.licenseId || !["plus", "pro"].includes(b.plan ?? "")) return json({ error: "licenseId と plan(plus/pro) が必要" }, 400);

  const lic = await env.DB.prepare("SELECT license_id FROM licenses WHERE license_id=? AND status='active'").bind(b.licenseId).first();
  if (!lic) return json({ error: "ライセンス無効" }, 400);

  const ret = b.returnUrl ?? "";
  if (stripeEnabled(env)) {
    // 戻り先：成功は ?upgraded=1 付き、キャンセルは素の戻りURL。returnUrl 未指定時のみ最終フォールバック。
    const base = /^https?:\/\//.test(ret) ? ret : "https://example.com/billing";
    const success = base + (base.includes("?") ? "&" : "?") + "upgraded=1";
    const url = await createCheckout(env, b.licenseId, b.plan as Plan, success, base);
    if (!url) return json({ error: "Stripe Checkout 生成に失敗" }, 502);
    return json({ ok: true, url, mode: "stripe" });
  }
  // P0-2: Stripe未設定で dev URL を返すのは ENV=development のときだけ。
  // 本番で Stripe 未設定なら fail-closed（無認証昇格URLを発行しない）。
  if (!isDevEnv(env)) return json({ error: "課金が未設定です（管理者へ連絡してください）" }, 503);
  // dev：入金シミュレートURL。
  const url = `${new URL(request.url).origin}/api/billing/dev-confirm?license_id=${b.licenseId}&plan=${b.plan}&return=${encodeURIComponent(ret)}`;
  return json({ ok: true, url, mode: "dev" });
};
