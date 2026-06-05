import type { APIRoute } from "astro";
import { getHostSession } from "../../lib/hostauth.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// クライアント管理（管理者のみ）：プラン／エンタイトルメント／ステータスを手動変更（§13・運用）。
// エンタイトルメントは次回の統合チェックでクライアントに反映、status=suspended で機能停止（データは保持）。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const ses = await getHostSession(env, request);
  if (!ses?.isAdmin) return json({ error: "管理者のみ" }, 403);
  const b = (await request.json().catch(() => ({}))) as { license_id?: string; plan?: string; entitlement?: string; status?: string };
  if (!b.license_id) return json({ error: "license_id が必要" }, 400);

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (b.plan && ["free", "plus", "pro"].includes(b.plan)) { sets.push("plan = ?"); binds.push(b.plan); }
  if (b.entitlement && ["free", "plus", "pro"].includes(b.entitlement)) { sets.push("entitlement = ?"); binds.push(b.entitlement); }
  if (b.status && ["active", "suspended"].includes(b.status)) { sets.push("status = ?"); binds.push(b.status); }
  if (!sets.length) return json({ error: "変更項目がありません（plan/entitlement/status）" }, 400);

  binds.push(b.license_id);
  await env.DB.prepare(`UPDATE licenses SET ${sets.join(", ")} WHERE license_id = ?`).bind(...binds).run();
  return json({ ok: true });
};
