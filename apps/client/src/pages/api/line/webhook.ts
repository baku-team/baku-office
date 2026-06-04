import type { APIRoute } from "astro";
import { getApiKey, cachedEntitlement } from "../../../lib/client.ts";
import { runAgent, verifyLineSignature, lineReply, linePush, fetchLineImage } from "../../../lib/agent.ts";
import { dueReminders, markReminderDone } from "../../../lib/agent-tools.ts";
import { saveFile } from "../../../lib/storage.ts";
import { enqueueSummary, transcribeAudio } from "../../../lib/media-ai.ts";
import { randomId } from "@baku-office/shared";
import { nowSec } from "../../../lib/accounting.ts";
import { logDiag, looksLikeLimit, PAID_HINT } from "../../../lib/diag.ts";

export const prerender = false;

type LineEvent = { type: string; replyToken?: string; source?: { userId?: string }; message?: { type: string; text?: string; id?: string; fileName?: string } };

// Zプランのエージェント受け口。text/image/file/audio を処理。各AI機能は対応キー設定時のみ実行。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const origin = new URL(request.url).origin;
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
    const reply = ev.replyToken;
    if (entitlement !== "Z") {
      locals.runtime.ctx.waitUntil(lineReply(accessToken, reply, "エージェント機能は Z プランで有効になります（管理画面のプラン・課金から）。"));
      continue;
    }
    const m = ev.message!;
    const work = (async () => {
      let out: string;
      try {
      if (m.type === "image" && m.id) {
        const img = await fetchLineImage(accessToken, m.id);
        out = img ? await runAgent(env, userId, "この画像（領収書なら record_expense で記録）を処理してください。", img, origin) : "画像を取得できませんでした。";
      } else if (m.type === "file" && m.id) {
        // ファイル（PDF等）→ KV/R2保存 → 要約ジョブ投入（drainでGemini要約）。
        const content = await fetchLineContent(accessToken, m.id);
        if (!content) { out = "ファイルを取得できませんでした。"; }
        else {
          const file = new File([content.buf], m.fileName ?? "document", { type: content.mime });
          const saved = await saveFile(env, file, `line:${userId}`).catch(() => null);
          if (!saved) out = "ファイル保存に失敗しました（標準モードは5MBまで）。";
          else { await enqueueSummary(env, `line:${userId}`, saved.id, m.fileName ?? "document"); out = "📄 資料を受け取りました。要約して『資料』に保存します（少し後に反映）。"; }
        }
      } else if (m.type === "audio" && m.id) {
        const content = await fetchLineContent(accessToken, m.id);
        const text = content ? await transcribeAudio(env, content.buf, content.mime) : null;
        if (!text) out = "音声を認識できませんでした（Gemini未設定の可能性）。";
        else {
          await env.DB.prepare("INSERT INTO knowledge (id,title,body,file_ref,tags,created_by,created_at) VALUES (?,?,?,?,?,?,?)")
            .bind(randomId(), `[議事録] ${new Date().toISOString().slice(0, 10)}`, text.slice(0, 100000), null, "議事録", `line:${userId}`, nowSec()).run();
          out = "🎤 文字起こし・議事録化しました（議事録に保存）。\n\n" + text.slice(0, 1500);
        }
      } else if (m.type === "text") {
        out = await runAgent(env, userId, m.text ?? "", undefined, origin);
      } else return;
      await lineReply(accessToken, reply, out);
      for (const r of await dueReminders(env, `line:${userId}`)) { await linePush(accessToken, userId, `⏰ リマインド：${r.content}`); await markReminderDone(env, r.id); }
      } catch (e) {
        // CF制限（CPU時間・waitUntil等）に達した可能性。診断記録＋利用者にWorkers Paid案内。
        const msg = (e as Error).message ?? String(e);
        const limit = looksLikeLimit(msg);
        await logDiag(env, "error", limit ? "limit" : "ai", `agent webhook: ${msg}`);
        await lineReply(accessToken, reply, limit ? "処理が混み合い完了できませんでした。\n" + PAID_HINT : "処理中にエラーが発生しました。時間をおいて再度お試しください。").catch(() => {});
      }
    })();
    locals.runtime.ctx.waitUntil(work);
  }
  return new Response("ok");
};

// LINEメッセージ本体（ファイル/音声）取得。
async function fetchLineContent(accessToken: string, messageId: string): Promise<{ buf: ArrayBuffer; mime: string } | null> {
  const r = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!r.ok) return null;
  return { buf: await r.arrayBuffer(), mime: r.headers.get("content-type") ?? "application/octet-stream" };
}
