import type { APIRoute } from "astro";
import { getSession, canAccess } from "../../lib/auth.ts";
import { approveItem, rejectItem } from "../../lib/users.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 共有承認（§9）：会計系=accounting/admin、文書系=clerical/admin。
export const POST: APIRoute = async ({ request, locals }) => {
  const ses = await getSession(env, request);
  if (!ses) return json({ error: "ログインが必要" }, 401);
  // Phase1のゲート：会計・文書いずれかの承認権限があれば可（細分化はUI側で表示制御）。
  const allowed = canAccess(ses.role, "review_accounting") || canAccess(ses.role, "review_documents");
  if (!allowed) return json({ error: "承認権限がありません" }, 403);

  const b = (await request.json().catch(() => ({}))) as { _action?: string; id?: string; reason?: string };
  if (!b.id) return json({ error: "id が必要" }, 400);
  if (b._action === "approve") await approveItem(env, b.id, ses.uid);
  else if (b._action === "reject") await rejectItem(env, b.id, ses.uid, b.reason ?? "");
  else return json({ error: "不明な操作" }, 400);
  return json({ ok: true });
};
