import type { APIRoute } from "astro";
import { verifyStripeSig, activateEntitlement } from "../../../lib/billing.ts";
import type { Plan } from "@baku-office/shared";
import { env } from "cloudflare:workers";

export const prerender = false;

// Stripe Webhook（§2.3：入金確認でエンタイトルメント昇格）。署名検証必須。
export const POST: APIRoute = async ({ request, locals }) => {
  if (!env.STRIPE_WEBHOOK_SECRET) return new Response("webhook未設定", { status: 400 });
  const payload = await request.text();
  const sig = request.headers.get("stripe-signature") ?? "";
  if (!(await verifyStripeSig(env.STRIPE_WEBHOOK_SECRET, payload, sig))) return new Response("署名不正", { status: 400 });

  const evt = JSON.parse(payload) as { type: string; data: { object: { client_reference_id?: string; metadata?: Record<string, string>; status?: string } } };
  const o = evt.data.object;
  const licenseId = o.client_reference_id ?? o.metadata?.license_id;
  if (!licenseId) return new Response("ok");
  // 昇格：checkout.session.completed（カード即時）／invoice.paid（振込・更新）。
  if (evt.type === "checkout.session.completed" || evt.type === "invoice.paid") {
    await activateEntitlement(env, licenseId, (o.metadata?.plan as Plan) ?? "plus");
  } else if (evt.type === "customer.subscription.deleted") {
    // 解約：無料(Free)へダウングレード（データは保持・§2.4）。
    await activateEntitlement(env, licenseId, "free");
  } else if (evt.type === "customer.subscription.updated") {
    // 未入金・更新失敗：Stripe のリトライ猶予を経て past_due/unpaid 等に遷移した時点で Free へ降格
    // （売掛で有料機能を提供し続けない）。復帰は invoice.paid で再昇格。
    if (o.status && ["past_due", "unpaid", "incomplete_expired", "canceled"].includes(o.status)) {
      await activateEntitlement(env, licenseId, "free");
    }
  }
  return new Response("ok");
};
