import type { APIRoute } from "astro";
import { getApiKey, cachedEntitlement } from "../../../lib/client.ts";
import { runAgent, verifyLineSignature, lineReply, linePush, fetchLineImage } from "../../../lib/agent.ts";
import { dueReminders, markReminderDone } from "../../../lib/agent-tools.ts";

export const prerender = false;

type LineEvent = { type: string; replyToken?: string; source?: { userId?: string }; message?: { type: string; text?: string; id?: string } };

// Zプランのエージェント受け口。署名検証→Z限定→Gemini会話/会計/画像OCR→返信。受信時に期限到来リマインダーも配信。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const body = await request.text();
  const secret = await getApiKey(env, "line_secret");
  const accessToken = await getApiKey(env, "line_token");
  if (!secret || !accessToken) return new Response("ok");
  if (!(await verifyLineSignature(secret, body, request.headers.get("x-line-signature") ?? ""))) return new Response("invalid signature", { status: 401 });

  const entitlement = await cachedEntitlement(env);
  const payload = JSON.parse(body) as { events?: LineEvent[] };

  for (const ev of payload.events ?? []) {
    if (ev.type !== "message" || !ev.replyToken) continue;
    const userId = ev.source?.userId ?? "anon";
    if (entitlement !== "Z") {
      locals.runtime.ctx.waitUntil(lineReply(accessToken, ev.replyToken, "エージェント機能は Z プランで有効になります（管理画面のプラン・課金から）。"));
      continue;
    }
    const work = (async () => {
      let reply: string;
      if (ev.message?.type === "image" && ev.message.id) {
        const img = await fetchLineImage(accessToken, ev.message.id);
        reply = img
          ? await runAgent(env, userId, "この画像（領収書なら record_expense で記録）を処理してください。", img)
          : "画像を取得できませんでした。";
      } else if (ev.message?.type === "text") {
        reply = await runAgent(env, userId, ev.message.text ?? "");
      } else {
        return;
      }
      await lineReply(accessToken, ev.replyToken!, reply);
      // 期限到来リマインダーを push 配信（遅延配信・cron非依存）。
      for (const r of await dueReminders(env, `line:${userId}`)) {
        await linePush(accessToken, userId, `⏰ リマインド：${r.content}`);
        await markReminderDone(env, r.id);
      }
    })();
    locals.runtime.ctx.waitUntil(work);
  }
  return new Response("ok");
};
