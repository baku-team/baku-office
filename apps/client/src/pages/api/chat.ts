import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { cachedEntitlement } from "../../lib/client.ts";
import { atLeast } from "@baku-office/shared";
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

  const b = (await request.json().catch(() => ({}))) as { message?: string; sessionId?: string; model?: string };
  const message = (b.message ?? "").trim();
  if (!message) return json({ error: "メッセージが必要" }, 400);

  // セッション解決（無ければ作成・他人のセッションは使えない）。
  let sessionId = b.sessionId && (await ownedSession(ctx, ses.uid, b.sessionId)) ? b.sessionId : "";
  if (!sessionId) sessionId = await createSession(ctx, ses.uid, b.model);

  const prior = await getMessages(ctx, sessionId);
  await appendMessage(ctx, sessionId, "user", message);
  await ensureTitle(ctx, sessionId, message);

  const model = (["gemini", "claude", "local"].includes(String(b.model)) ? b.model : undefined) as ChatModelId | undefined;
  const reply = await ctx.agent.run({ owner: ses.uid, text: message, role: ses.role, baseUrl: new URL(request.url).origin, history: toTurns(prior), model });
  await appendMessage(ctx, sessionId, "assistant", reply);
  return json({ ok: true, reply, sessionId });
};
