import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { listNotifications, countUnread, markNotificationsRead } from "../../lib/notifications.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// アプリ内通知の取得（GET）／既読化（POST { _action:"read", id? }）。owner=ログインユーザーの uid（組織管理者は "org"）。
export const GET: APIRoute = async ({ request, locals }) => {
  const ses = await getSession(locals.runtime.env, request);
  if (!ses) return json({ error: "ログインが必要" }, 401);
  const items = await listNotifications(locals.ctx, ses.uid, { limit: 30 });
  const unread = await countUnread(locals.ctx, ses.uid);
  return json({ ok: true, items, unread });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const ses = await getSession(locals.runtime.env, request);
  if (!ses) return json({ error: "ログインが必要" }, 401);
  const b = (await request.json().catch(() => ({}))) as { _action?: string; id?: string };
  if (b._action === "read") {
    await markNotificationsRead(locals.ctx, ses.uid, b.id);
    return json({ ok: true, unread: await countUnread(locals.ctx, ses.uid) });
  }
  return json({ error: "unknown action" }, 400);
};
