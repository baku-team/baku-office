import type { APIRoute } from "astro";
import { getApiKey } from "../../../lib/client.ts";
import { nowSec } from "../../../lib/accounting.ts";

export const prerender = false;

// 会員のStripe連携。連携設定 "stripe_webhook" にWebシークレットがある時のみ有効。
// checkout.session.completed→該当会員(stripe_customer一致)を fee_status=paid、
// customer.subscription.deleted→fee_status=withdrawn に更新する。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
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

// Stripe Webhook 署名検証（HMAC-SHA256・t=タイムスタンプ,v1=署名）。t の鮮度（±5分）も検証。比較は定数時間。
async function verifyStripeSig(secret: string, payload: string, header: string, toleranceSec = 300): Promise<boolean> {
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=")));
  const t = parts["t"];
  const v1 = parts["v1"];
  if (!t || !v1) return false;
  const ts = Number(t);
  if (!Number.isFinite(ts) || Math.abs(nowSec() - ts) > toleranceSec) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  const hex = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== v1.length) return false;
  let r = 0;
  for (let i = 0; i < hex.length; i++) r |= hex.charCodeAt(i) ^ v1.charCodeAt(i);
  return r === 0;
}
