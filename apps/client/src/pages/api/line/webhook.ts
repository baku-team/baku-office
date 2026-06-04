import type { APIRoute } from "astro";
import { getApiKey, cachedEntitlement } from "../../../lib/client.ts";
import { runAgent, verifyLineSignature, lineReply } from "../../../lib/agent.ts";

export const prerender = false;

type LineEvent = { type: string; replyToken?: string; source?: { userId?: string }; message?: { type: string; text?: string } };

// Zプランのエージェント受け口（設計書§2・付録B：既存エージェント→内部APIマッピング）。
// LINE署名検証 → entitlement=Z かつ LINEキー設定時のみ稼働 → Gemini会話/会計記録 → 返信。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const body = await request.text();
  const secret = await getApiKey(env, "line_secret");
  const accessToken = await getApiKey(env, "line_token");

  // LINEキー未設定なら 200 で黙って終了（Webhook検証を壊さない）。
  if (!secret || !accessToken) return new Response("ok");
  const sig = request.headers.get("x-line-signature") ?? "";
  if (!(await verifyLineSignature(secret, body, sig))) return new Response("invalid signature", { status: 401 });

  const entitlement = await cachedEntitlement(env);
  const payload = JSON.parse(body) as { events?: LineEvent[] };

  for (const ev of payload.events ?? []) {
    if (ev.type !== "message" || ev.message?.type !== "text" || !ev.replyToken) continue;
    const userId = ev.source?.userId ?? "anon";
    if (entitlement !== "Z") {
      await lineReply(accessToken, ev.replyToken, "エージェント機能は Z プランで有効になります（管理画面のプラン・課金から）。");
      continue;
    }
    // LINEは5秒ACK。重い処理は waitUntil に逃がし即200。
    const reply = runAgent(env, userId, ev.message.text ?? "").then((t) => lineReply(accessToken, ev.replyToken!, t));
    locals.runtime.ctx.waitUntil(reply);
  }
  return new Response("ok");
};
