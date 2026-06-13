import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { googleStatus, disconnectGoogle, setGoogleGroups, grantedScopeString, type ScopeGroupId } from "../../lib/google.ts";
import { saveServiceAccount, getServiceAccountInfo, testServiceAccount } from "../../lib/google-sa.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// Google 連携の状態取得／解除＋サービスアカウント(DWD)設定（管理者・org）。OAuth開始は /api/google/start。
export const POST: APIRoute = async ({ request, locals }) => {
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return json({ error: "管理者のみ" }, 403);
  const b = (await request.json().catch(() => ({}))) as { _action?: string; keyJson?: string; subject?: string; groups?: string[] };
  if (b._action === "disconnect") {
    await disconnectGoogle(env);
    return json({ ok: true });
  }
  if (b._action === "status") {
    const info = await getServiceAccountInfo(env);
    return json({ ok: true, ...(await googleStatus(env)), sa: info });
  }
  // サービスアカウント＋ドメイン全体の委任(DWD)の設定。鍵JSON・代理ユーザー・付与グループを保存。
  if (b._action === "connect_sa") {
    const res = await saveServiceAccount(env, String(b.keyJson ?? ""), String(b.subject ?? ""));
    if (!res.ok) return json({ error: res.error ?? "保存に失敗しました" }, 400);
    await setGoogleGroups(env, (Array.isArray(b.groups) ? b.groups : []) as ScopeGroupId[]);
    return json({ ok: true, sa: await getServiceAccountInfo(env) });
  }
  // 接続テスト：実際にDWDでアクセストークンを発行して確認（管理コンソールの委任承認後に押す）。
  if (b._action === "test_sa") {
    const res = await testServiceAccount(env, await grantedScopeString(env));
    return res.ok ? json({ ok: true }) : json({ error: res.error ?? "接続できませんでした" }, 400);
  }
  return json({ error: "不明な操作" }, 400);
};
