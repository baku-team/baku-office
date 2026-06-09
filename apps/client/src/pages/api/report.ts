import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { submitFeedback } from "../../lib/reports.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 利用者からの不具合/要望リクエスト（手動）。ログインユーザーのみ。ホストへ送信して自己修復ログへ集積。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const ses = await getSession(env, request);
  if (!ses) return json({ error: "ログインが必要です" }, 401);
  const b = (await request.json().catch(() => ({}))) as { title?: string; message?: string };
  const r = await submitFeedback(env, { title: b.title, message: String(b.message ?? "") });
  if (!r.ok) return json({ error: r.error }, 400);
  return json({ ok: true });
};
