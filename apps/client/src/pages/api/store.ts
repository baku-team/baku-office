import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { storeCatalog, setListed, rateApp, listReviews, myApps } from "../../lib/store.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// ストア中継（クライアント）：閲覧/評価は会員、掲載設定は管理者。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const ses = await getSession(env, request);
  if (!ses) return json({ error: "ログインが必要" }, 401);
  const b = (await request.json().catch(() => ({}))) as { _action?: string; appId?: string; listed?: boolean; minEntitlement?: string; rating?: number; body?: string };
  if (b._action === "catalog") return json({ ok: true, apps: await storeCatalog(env) });
  if (b._action === "mine") { if (ses.role !== "admin" || ses.ctx !== "org") return json({ error: "管理者のみ" }, 403); return json({ ok: true, apps: await myApps(env) }); }
  if (b._action === "reviews") return json({ ok: true, reviews: await listReviews(env, String(b.appId ?? "")) });
  if (b._action === "rate") return json(await rateApp(env, String(b.appId ?? ""), Number(b.rating) || 0, b.body));
  if (b._action === "set_listed") {
    if (ses.role !== "admin" || ses.ctx !== "org") return json({ error: "管理者のみ" }, 403);
    return json(await setListed(env, String(b.appId ?? ""), !!b.listed, String(b.minEntitlement ?? "free")));
  }
  return json({ error: "不明な操作" }, 400);
};
