import type { APIRoute } from "astro";
import { callerFromToken, storeCatalog, setListed, rateApp, listReviews, myApps } from "../../../lib/registry.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// ストア（クライアント中継）：カタログ閲覧・掲載設定（提供者）・評価・レビュー一覧。token 認証。
export const POST: APIRoute = async ({ request, locals }) => {
  const b = (await request.json().catch(() => ({}))) as { _action?: string; token?: string; appId?: string; listed?: boolean; minEntitlement?: string; rating?: number; body?: string };
  const caller = await callerFromToken(env, b.token);
  if (!caller) return json({ error: "有効なライセンスが必要" }, 401);
  if (b._action === "catalog" || !b._action) return json({ ok: true, apps: await storeCatalog(env, caller.entitlement) });
  if (b._action === "mine") return json({ ok: true, apps: await myApps(env, caller.licenseId) });
  if (b._action === "set_listed") return json(await setListed(env, String(b.appId ?? ""), caller.licenseId, !!b.listed, b.minEntitlement));
  if (b._action === "rate") return json(await rateApp(env, String(b.appId ?? ""), caller.licenseId, Number(b.rating) || 0, b.body));
  if (b._action === "reviews") return json({ ok: true, reviews: await listReviews(env, String(b.appId ?? "")) });
  return json({ error: "不明な操作" }, 400);
};
