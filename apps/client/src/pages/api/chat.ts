import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { cachedEntitlement } from "../../lib/client.ts";
import { runAgent } from "../../lib/agent.ts";
import { atLeast } from "@baku-office/shared";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// AIチャット（Plus以上）：集計・DB/ファイル検索・文書作成をエージェントのツールループで実行（§11）。
// owner=session.uid＝Webユーザーの個人スコープ。Gemini未設定時は runAgent が案内文を返す。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const ses = await getSession(env, request);
  if (!ses) return json({ error: "ログインが必要" }, 401);
  if (!atLeast(await cachedEntitlement(env), "plus")) return json({ error: "AIチャットは Plus 以上のプランで利用できます" }, 403);

  const b = (await request.json().catch(() => ({}))) as { message?: string };
  const message = (b.message ?? "").trim();
  if (!message) return json({ error: "メッセージが必要" }, 400);

  const reply = await runAgent(env, ses.uid, message, undefined, new URL(request.url).origin);
  return json({ ok: true, reply });
};
