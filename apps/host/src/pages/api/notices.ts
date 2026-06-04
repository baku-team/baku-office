import type { APIRoute } from "astro";
import { randomId } from "@baku-office/shared";
import { nowSec } from "../../lib/host.ts";
import { getHostSession } from "../../lib/hostauth.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// お知らせ・通知配信（§13.1）。管理者セッション、または ADMIN_KEY ヘッダ で保護。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const ses = await getHostSession(env, request);
  const byKey = env.ADMIN_KEY && request.headers.get("x-admin-key") === env.ADMIN_KEY;
  if (!ses?.isAdmin && !byKey) return json({ error: "forbidden" }, 403);
  const b = (await request.json().catch(() => ({}))) as { _action?: string; id?: string; severity?: string; body?: string };

  if (b._action === "deactivate" && b.id) {
    await env.DB.prepare("UPDATE notices SET active=0 WHERE id=?").bind(b.id).run();
    return json({ ok: true });
  }
  if (!b.body || !["info", "important", "critical"].includes(b.severity ?? "")) return json({ error: "severity と body が必要" }, 400);
  const id = randomId();
  await env.DB.prepare("INSERT INTO notices (id,severity,body,active,created_at) VALUES (?,?,?,1,?)")
    .bind(id, b.severity, b.body, nowSec())
    .run();
  return json({ ok: true, id });
};
