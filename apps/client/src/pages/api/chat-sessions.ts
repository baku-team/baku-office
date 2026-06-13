import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { listSessions, createSession, deleteSession, getMessages, ownedSession } from "../../lib/chat-sessions.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// チャットのセッション一覧/メッセージ取得（GET）と 作成/削除（POST）。owner スコープ。
export const GET: APIRoute = async ({ request, url, locals }) => {
  const ses = await getSession(env, request);
  if (!ses) return json({ error: "ログインが必要" }, 401);
  const id = url.searchParams.get("id");
  if (id) {
    if (!(await ownedSession(locals.ctx, ses.uid, id))) return json({ error: "not found" }, 404);
    return json({ ok: true, messages: await getMessages(locals.ctx, id) });
  }
  return json({ ok: true, sessions: await listSessions(locals.ctx, ses.uid) });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const ses = await getSession(env, request);
  if (!ses) return json({ error: "ログインが必要" }, 401);
  const b = (await request.json().catch(() => ({}))) as { _action?: string; id?: string; model?: string };
  if (b._action === "create") return json({ ok: true, id: await createSession(locals.ctx, ses.uid, b.model) });
  if (b._action === "delete") { await deleteSession(locals.ctx, ses.uid, String(b.id ?? "")); return json({ ok: true }); }
  return json({ error: "不明な操作" }, 400);
};
