import type { APIRoute } from "astro";
import { verifyStripeSig, activateEntitlement } from "../../../lib/billing.ts";
import type { Plan } from "@baku-office/shared";

export const prerender = false;

// Stripe Webhook（§2.3：入金確認でエンタイトルメント昇格）。署名検証必須。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  if (!env.STRIPE_WEBHOOK_SECRET) return new Response("webhook未設定", { status: 400 });
  const payload = await request.text();
  const sig = request.headers.get("stripe-signature") ?? "";
  if (!(await verifyStripeSig(env.STRIPE_WEBHOOK_SECRET, payload, sig))) return new Response("署名不正", { status: 400 });

  const evt = JSON.parse(payload) as { type: string; data: { object: { client_reference_id?: string; metadata?: Record<string, string> } } };
  const o = evt.data.object;
  const licenseId = o.client_reference_id ?? o.metadata?.license_id;
  if (!licenseId) return new Response("ok");
  // 昇格：checkout.session.completed（カード即時）／invoice.paid（振込・更新）。
  if (evt.type === "checkout.session.completed" || evt.type === "invoice.paid") {
    await activateEntitlement(env, licenseId, (o.metadata?.plan as Plan) ?? "plus");
  } else if (evt.type === "customer.subscription.deleted") {
    // 解約：無料(Free)へダウングレード（データは保持・§2.4）。
    await activateEntitlement(env, licenseId, "free");
  }
  return new Response("ok");
};
