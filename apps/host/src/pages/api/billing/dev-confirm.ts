import type { APIRoute } from "astro";
import { activateEntitlement, stripeEnabled } from "../../../lib/billing.ts";
import { isDevEnv } from "../../../lib/hostauth.ts";
import type { Plan } from "@baku-office/shared";
import { env } from "cloudflare:workers";

export const prerender = false;

// dev専用：Stripe未設定時に入金確認をシミュレートしてエンタイトルメント昇格（§2.3）。
// P0-2: ENV=development のときだけ有効。本番（ENV未設定/!=development）は Stripe 設定有無に関わらず 403＝fail-closed。
// WHY: 本番で Stripe secret 未投入のまま公開されると、無認証 GET でライセンスID既知者が昇格できてしまうため。
export const GET: APIRoute = async ({ url, locals }) => {
  if (!isDevEnv(env)) return new Response("本番ではdev-confirmは無効（Stripe Webhookで昇格）", { status: 403 });
  if (stripeEnabled(env)) return new Response("Stripe設定時はdev-confirmは無効（Stripe Webhookで昇格）", { status: 403 });
  const licenseId = url.searchParams.get("license_id");
  const plan = url.searchParams.get("plan") as Plan | null;
  const ret = url.searchParams.get("return");
  if (!licenseId || !plan || !["plus", "pro"].includes(plan)) return new Response("license_id と plan(plus/pro) が必要", { status: 400 });
  await activateEntitlement(env, licenseId, plan);
  if (ret) return Response.redirect(ret, 302);
  return new Response(`✅ [dev] ${plan} に昇格しました（入金確認シミュレート）。クライアントに戻ってください。`);
};
