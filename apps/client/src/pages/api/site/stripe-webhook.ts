import type { APIRoute } from "astro";
import { getApiKey } from "../../../lib/client.ts";
import { nowSec } from "../../../lib/accounting.ts";
import { verifyStripeSig } from "@baku-office/shared"; // §5：署名検証は shared に一本化
import { env } from "cloudflare:workers";

export const prerender = false;

// 会員のStripe連携。連携設定 "stripe_webhook" にWebシークレットがある時のみ有効。
// checkout.session.completed→該当会員(stripe_customer一致)を fee_status=paid、
// customer.subscription.deleted→fee_status=withdrawn に更新する。
export const POST: APIRoute = async ({ request, locals }) => {
  const secret = await getApiKey(env, "stripe_webhook");
  if (!secret) return new Response("Stripe未設定（現金/手動運用）", { status: 400 });

  const payload = await request.text();
  const sig = request.headers.get("stripe-signature") ?? "";
  if (!(await verifyStripeSig(secret, payload, sig))) return new Response("署名不正", { status: 400 });

  let ev: { type?: string; data?: { object?: { customer?: string } } };
  try { ev = JSON.parse(payload); } catch { return new Response("不正なペイロード", { status: 400 }); }
  const customer = ev.data?.object?.customer;
  const now = nowSec();

  if (customer && ev.type === "checkout.session.completed") {
    await env.DB.prepare("UPDATE membership SET fee_status='paid', paid_at=?, status_changed_at=?, updated_at=? WHERE stripe_customer=?")
      .bind(new Date(now * 1000).toISOString(), now, now, customer).run();
  } else if (customer && ev.type === "customer.subscription.deleted") {
    await env.DB.prepare("UPDATE membership SET fee_status='withdrawn', status_changed_at=?, updated_at=? WHERE stripe_customer=?")
      .bind(now, now, customer).run();
  }
  return new Response("ok");
};
