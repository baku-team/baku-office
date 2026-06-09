// 課金（設計書§2）。Stripe Checkout（カード＝即時／振込・コンビニ＝入金確認）→ Webhookでエンタイトルメント昇格。
// 入金確認まではプロビジョナル（free相当）。Stripe未設定のdevでは dev-confirm で昇格をシミュレート。
import { nowSec } from "./host.ts";
import type { Plan, Entitlement } from "@baku-office/shared";

export function stripeEnabled(env: Env): boolean {
  return !!env.STRIPE_SECRET_KEY;
}

// Stripe Checkout セッション作成（REST直叩き・SDK不要）。
export async function createCheckout(env: Env, licenseId: string, plan: Plan, successUrl: string, cancelUrl: string): Promise<string | null> {
  const price = plan === "pro" ? env.STRIPE_PRICE_PRO : env.STRIPE_PRICE_PLUS;
  if (!env.STRIPE_SECRET_KEY || !price) return null;
  const body = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price]": price,
    "line_items[0][quantity]": "1",
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: licenseId,
    "metadata[license_id]": licenseId,
    "metadata[plan]": plan,
    // サブスク本体にも license_id を載せる＝subscription.deleted/invoice 等のイベントから団体を特定できる（解約ダウングレード用）。
    "subscription_data[metadata][license_id]": licenseId,
    "subscription_data[metadata][plan]": plan,
    // 日本：カード＋コンビニ＋銀行振込（仮想口座）。口座振替は非対応（付録B）。
    "payment_method_types[0]": "card",
  });
  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    console.log("[stripe-checkout]", r.status, (await r.text()).slice(0, 200));
    return null;
  }
  return ((await r.json()) as { url?: string }).url ?? null;
}

// エンタイトルメント昇格（入金確認時）。plan を実体化（free→plus→pro）。
// nonprofit（全機能無料・rank最上位）が付与済みの団体は Stripe 入金で降格上書きしない（plan のみ更新）。
// WHY: nonprofit×課金が混在する団体で webhook 着信ごとに資格が nonprofit↔plan で揺れるのを防ぐ。
export async function activateEntitlement(env: Env, licenseId: string, plan: Plan): Promise<void> {
  const cur = await env.DB.prepare("SELECT entitlement FROM licenses WHERE license_id=?").bind(licenseId).first<{ entitlement: string }>();
  if (cur?.entitlement === "nonprofit") {
    await env.DB.prepare("UPDATE licenses SET plan=?, last_seen=? WHERE license_id=?").bind(plan, nowSec(), licenseId).run();
    return;
  }
  const ent: Entitlement = plan === "free" ? "free" : plan;
  await env.DB.prepare("UPDATE licenses SET plan=?, entitlement=?, last_seen=? WHERE license_id=?")
    .bind(plan, ent, nowSec(), licenseId)
    .run();
}

// Stripe Webhook 署名検証（HMAC-SHA256・t=タイムスタンプ,v1=署名）。
// t の鮮度（既定±5分）も検証してリプレイを防ぐ。比較は定数時間。
export async function verifyStripeSig(secret: string, payload: string, header: string, toleranceSec = 300): Promise<boolean> {
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=")));
  const t = parts["t"];
  const v1 = parts["v1"];
  if (!t || !v1) return false;
  const ts = Number(t);
  if (!Number.isFinite(ts) || Math.abs(nowSec() - ts) > toleranceSec) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  const hex = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqualHex(hex, v1);
}

// 定数時間のhex比較（タイミング攻撃対策）。
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
