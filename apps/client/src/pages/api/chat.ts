import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { cachedEntitlement, nowSec } from "../../lib/client.ts";
import { atLeast } from "@baku-office/shared";
import { saveFile } from "../../lib/storage.ts";
import { ownedSession, createSession, getMessages, appendMessage, ensureTitle, toTurns, type ChatModelId } from "../../lib/chat-sessions.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// AIチャット（Plus以上）：セッション履歴＋モデル選択でエージェントを実行（§11）。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const ctx = locals.ctx;
  const ses = await getSession(env, request);
  if (!ses) return json({ error: "ログインが必要" }, 401);
  if (!atLeast(await cachedEntitlement(env), "plus")) return json({ error: "AIチャットは Plus 以上のプランで利用できます" }, 403);

  const b = (await request.json().catch(() => ({}))) as { message?: string; sessionId?: string; model?: string; background?: boolean; image?: { mimeType: string; dataB64: string } };
  const message = (b.message ?? "").trim();
  if (!message && !b.image?.dataB64) return json({ error: "メッセージが必要" }, 400);

  // 画像/PDF添付：storage に保存し file_id をプロンプトへ付加（請求書なら register_invoice で登録できるように）。
  let prompt = message || "(添付ファイルを確認してください)";
  if (b.image?.dataB64 && b.image.mimeType) {
    try {
      const bin = atob(b.image.dataB64);
      const ext = b.image.mimeType.includes("pdf") ? "pdf" : (b.image.mimeType.split("/")[1] || "bin");
      const file = new File([Uint8Array.from(bin, (c) => c.charCodeAt(0))], `upload-${nowSec()}.${ext}`, { type: b.image.mimeType });
      const saved = await saveFile(env, file, ses.uid, ses.ctx);
      prompt = `${prompt}\n\n（添付ファイルを保存しました: file_id=${saved.id}。請求書/領収書なら register_invoice に file_id を渡して登録してください。）`;
    } catch { /* 保存失敗時は通常処理を続ける */ }
  }

  // セッション解決（無ければ作成・他人のセッションは使えない）。
  let sessionId = b.sessionId && (await ownedSession(ctx, ses.uid, b.sessionId)) ? b.sessionId : "";
  if (!sessionId) sessionId = await createSession(ctx, ses.uid, b.model);

  const prior = await getMessages(ctx, sessionId);
  await appendMessage(ctx, sessionId, "user", message || "(画像を添付)");
  await ensureTitle(ctx, sessionId, message || "画像の確認");

  // バックグラウンド実行（Pro 以上）：ジョブに積んで即返す。完了は drain がセッションへ追記。
  if (b.background) {
    if (!atLeast(await cachedEntitlement(env), "pro")) return json({ error: "バックグラウンド実行は Pro 以上で利用できます" }, 403);
    const { enqueueAgentJob } = await import("../../lib/agent-jobs.ts");
    await enqueueAgentJob(ctx, { owner: ses.uid, sessionId, prompt, role: ses.role });
    return json({ ok: true, queued: true, sessionId, reply: "⏳ バックグラウンドで実行中です。完了するとこの会話に結果が追記されます（数分かかる場合があります）。" });
  }

  const model = (["gemini", "claude", "local"].includes(String(b.model)) ? b.model : undefined) as ChatModelId | undefined;
  let reply: string;
  try {
    reply = await ctx.agent.run({ owner: ses.uid, text: prompt, image: b.image, role: ses.role, baseUrl: new URL(request.url).origin, history: toTurns(prior), model });
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    await (await import("../../lib/diag.ts")).logDiag(env, "error", "chat", `agent.run失敗(model=${b.model ?? "auto"}): ${msg}`);
    reply = "⚠️ AIの実行でエラーが発生しました。時間をおいて再度お試しください。別のモデル（Gemini など）もお試しいただけます。";
  }
  await appendMessage(ctx, sessionId, "assistant", reply);
  return json({ ok: true, reply, sessionId });
};
