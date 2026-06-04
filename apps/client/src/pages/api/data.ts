import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { audit } from "../../lib/storage.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

const TABLES: Record<string, true> = { transactions: true, files: true, schedules: true, knowledge: true };

// 直接DB操作（§12・組織Google/管理者のみ）：復元・完全削除。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return json({ error: "管理者のみ" }, 403);
  const b = (await request.json().catch(() => ({}))) as { _action?: string; table?: string; id?: string };
  if (!b.table || !TABLES[b.table] || !b.id) return json({ error: "table/id が不正" }, 400);

  if (b._action === "restore") {
    await env.DB.prepare(`UPDATE ${b.table} SET deleted_at=NULL WHERE id=?`).bind(b.id).run();
    await audit(env, ses.uid, `${b.table}.restore`, b.id);
    return json({ ok: true });
  }
  if (b._action === "purge") {
    await env.DB.prepare(`DELETE FROM ${b.table} WHERE id=? AND deleted_at IS NOT NULL`).bind(b.id).run();
    await audit(env, ses.uid, `${b.table}.purge`, b.id);
    return json({ ok: true });
  }
  return json({ error: "不明な操作" }, 400);
};
