import type { APIRoute } from "astro";
import { getApiKey } from "../../../lib/client.ts";

export const prerender = false;

// 会員のStripe連携（骨組み）。希望者のみ本番キー投入時に実装を有効化する。
// 想定：checkout.session.completed→会員を追加/支払済、customer.subscription.deleted→退会(削除)。
// クライアントのStripe Webシークレットは連携設定 "stripe_webhook" を想定。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const secret = await getApiKey(env, "stripe_webhook");
  if (!secret) return new Response("Stripe未設定（現金/手動運用）", { status: 400 });

  // TODO（本番キー投入時）：
  //  1) verifyStripeSig(secret, payload, header) で署名検証
  //  2) checkout.session.completed → membership に追加 or fee_status=paid（metadata に会員情報）
  //  3) customer.subscription.deleted → 該当会員を fee_status=withdrawn または削除
  await request.text();
  return new Response("ok");
};
