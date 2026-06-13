import type { APIRoute } from "astro";
import { registerApp, callerFromToken, getApp, BUILTIN_APP_IDS } from "../../../lib/registry.ts";
import { recordAudit } from "../../../lib/host.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// クライアントからのアプリ公開申請（チャットで生成→レビュー→申請）。status=pending で登録、ホスト管理者が承認。
// 認証は署名ライセンストークン（他の registry/a2a と同方式）。WHY: 生 licenseId 受理だと ID を1件知るだけで
// 第三者が任意 definition/permissions を pending 登録できる（なりすまし）。
export const POST: APIRoute = async ({ request, locals }) => {
  const b = (await request.json().catch(() => ({}))) as { token?: string; app?: { id?: string; name?: string; version?: string; permissions?: string[]; description?: string; category?: string; definition?: unknown } };
  const caller = await callerFromToken(env, b.token);
  if (!caller) return json({ error: "有効なライセンスが必要" }, 401);
  const a = b.app ?? {};
  if (!a.id || !a.name || !a.version) return json({ error: "app(id/name/version) が必要" }, 400);
  if (!/^[a-z0-9_-]{2,64}$/i.test(a.id)) return json({ error: "id 形式不正" }, 400);
  // 予約 id（標準同梱）は申請不可。WHY: builtin id を submit して定義/権限を乗っ取らせない。
  if (BUILTIN_APP_IDS.includes(a.id.toLowerCase())) return json({ error: "予約済みの id です" }, 409);
  // 所有権：既存アプリの提供者が別ライセンスなら拒否（他者アプリのスカッシュ／所有権横取りを防ぐ）。
  const existing = await getApp(env, a.id);
  if (existing?.submitted_by && existing.submitted_by !== caller.licenseId) {
    return json({ error: "この id は別の提供者が登録済みです" }, 409);
  }
  await registerApp(env, { id: a.id, name: a.name, version: a.version, permissions: a.permissions, description: a.description, category: a.category, definition: a.definition, submittedBy: caller.licenseId });
  await recordAudit(env, caller.licenseId, "app.submit", a.id, a.version);
  return json({ ok: true, status: "pending" });
};
