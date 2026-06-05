import type { APIRoute } from "astro";
import { activateEntitlement, stripeEnabled } from "../../../lib/billing.ts";
import type { Plan } from "@baku-office/shared";

export const prerender = false;

// dev専用：Stripe未設定時に入金確認をシミュレートしてエンタイトルメント昇格（§2.3）。
// 本番（Stripe設定済み）では無効＝403。
export const GET: APIRoute = async ({ url, locals }) => {
  const env = locals.runtime.env;
  if (stripeEnabled(env)) return new Response("本番ではdev-confirmは無効（Stripe Webhookで昇格）", { status: 403 });
  const licenseId = url.searchParams.get("license_id");
  const plan = url.searchParams.get("plan") as Plan | null;
  const ret = url.searchParams.get("return");
  if (!licenseId || !plan || !["plus", "pro"].includes(plan)) return new Response("license_id と plan(plus/pro) が必要", { status: 400 });
  await activateEntitlement(env, licenseId, plan);
  if (ret) return Response.redirect(ret, 302);
  return new Response(`✅ [dev] ${plan} に昇格しました（入金確認シミュレート）。クライアントに戻ってください。`);
};
