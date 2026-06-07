import type { APIRoute } from "astro";
import { registerApp } from "../../../lib/registry.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// クライアントからのアプリ公開申請（チャットで生成→レビュー→申請）。status=pending で登録、ホスト管理者が承認。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const b = (await request.json().catch(() => ({}))) as { licenseId?: string; app?: { id?: string; name?: string; version?: string; permissions?: string[]; description?: string; category?: string; definition?: unknown } };
  const lic = b.licenseId ?? "";
  const a = b.app ?? {};
  if (!lic || !a.id || !a.name || !a.version) return json({ error: "licenseId・app(id/name/version) が必要" }, 400);
  if (!/^[a-z0-9_-]{2,64}$/i.test(a.id)) return json({ error: "id 形式不正" }, 400);
  // 申請元ライセンスの実在＋有効を確認（なりすまし・スパム抑止）。
  const ok = await env.DB.prepare("SELECT 1 FROM licenses WHERE license_id=? AND status='active' LIMIT 1").bind(lic).first();
  if (!ok) return json({ error: "有効なライセンスが必要" }, 403);
  await registerApp(env, { id: a.id, name: a.name, version: a.version, permissions: a.permissions, description: a.description, category: a.category, definition: a.definition, submittedBy: lic });
  return json({ ok: true, status: "pending" });
};
