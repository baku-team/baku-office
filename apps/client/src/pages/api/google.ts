import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { googleStatus, disconnectGoogle } from "../../lib/google.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// Google 連携の状態取得／解除（管理者・org）。連携の開始は /api/google/start。
export const POST: APIRoute = async ({ request, locals }) => {
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return json({ error: "管理者のみ" }, 403);
  const b = (await request.json().catch(() => ({}))) as { _action?: string };
  if (b._action === "disconnect") {
    await disconnectGoogle(env);
    return json({ ok: true });
  }
  if (b._action === "status") {
    return json({ ok: true, ...(await googleStatus(env)) });
  }
  return json({ error: "不明な操作" }, 400);
};
