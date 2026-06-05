import type { APIRoute } from "astro";
import { createMember } from "../../../lib/membership.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 公開HPの会員申込（認証不要）。会員管理に未払いで追加（現金/手動運用の既定）。
// 公開フォームを show_join のページが出している前提。スパム対策（レート/Turnstile）は将来。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const b = (await request.json().catch(() => ({}))) as { name?: string; contact?: string };
  const name = (b.name ?? "").trim();
  if (!name) return json({ error: "お名前が必要です" }, 400);
  if (name.length > 100) return json({ error: "入力が長すぎます" }, 400);
  await createMember(env, { name, contact: (b.contact ?? "").slice(0, 200), fee_status: "unpaid", extra: "公開フォームからの申込" });
  return json({ ok: true });
};
