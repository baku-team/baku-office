import type { APIRoute } from "astro";
import { getHostSession } from "../../lib/hostauth.ts";
import { recordAudit } from "../../lib/host.ts";
import { listApps, registerApp, setAppStatus, usageByApp, hostSetListed, deleteApp, revokeApp, unrevokeApp, setBuiltinEnabled } from "../../lib/registry.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// アプリ・レジストリ中枢の管理（ホスト管理者のみ）。
export const POST: APIRoute = async ({ request, locals }) => {
  const ses = await getHostSession(env, request);
  if (!ses?.isAdmin) return json({ error: "管理者のみ" }, 403);
  const b = (await request.json().catch(() => ({}))) as { _action?: string; id?: string; name?: string; version?: string; repoUrl?: string; publisher?: string; category?: string; permissions?: string[]; description?: string; status?: string; listed?: boolean; minEntitlement?: string; kind?: string; reason?: string; enabled?: boolean };

  if (b._action === "register") {
    if (!b.id || !b.name || !b.version) return json({ error: "id・name・version が必要" }, 400);
    await registerApp(env, { id: b.id, name: b.name, version: b.version, repoUrl: b.repoUrl, publisher: b.publisher, category: b.category, permissions: b.permissions, description: b.description });
    return json({ ok: true });
  }
  if (b._action === "status") {
    if (!b.id || !["pending", "approved", "blocked"].includes(String(b.status))) return json({ error: "id・status(pending/approved/blocked) が必要" }, 400);
    await setAppStatus(env, b.id, b.status as "pending" | "approved" | "blocked");
    await recordAudit(env, ses.email, "app.status", b.id, String(b.status));
    return json({ ok: true });
  }
  if (b._action === "set_listed") {
    if (!b.id) return json({ error: "id が必要" }, 400);
    await hostSetListed(env, b.id, !!b.listed, b.minEntitlement);
    await recordAudit(env, ses.email, "app.set_listed", b.id, `listed=${!!b.listed} min=${b.minEntitlement ?? "-"}`);
    return json({ ok: true });
  }
  // ストアアプリの削除（墓標＋利用0で物理削除）。全クライアントから撤去。
  if (b._action === "delete") {
    if (!b.id) return json({ error: "id が必要" }, 400);
    await deleteApp(env, b.id, b.reason);
    await recordAudit(env, ses.email, "app.delete", b.id, b.reason ?? null);
    return json({ ok: true });
  }
  // 未登録/登録済みアプリの撤去（公開停止 blocked / 削除 deleted）と復帰（unrevoke）。
  if (b._action === "revoke") {
    if (!b.id || !["blocked", "deleted"].includes(String(b.kind))) return json({ error: "id・kind(blocked/deleted) が必要" }, 400);
    await revokeApp(env, b.id, b.kind as "blocked" | "deleted", b.reason);
    await recordAudit(env, ses.email, "app.revoke", b.id, `${b.kind} ${b.reason ?? ""}`.trim());
    return json({ ok: true });
  }
  if (b._action === "unrevoke") {
    if (!b.id) return json({ error: "id が必要" }, 400);
    await unrevokeApp(env, b.id);
    await recordAudit(env, ses.email, "app.unrevoke", b.id, null);
    return json({ ok: true });
  }
  // 標準同梱アプリの登録（enabled=true）/除外（enabled=false）。
  if (b._action === "builtin_set") {
    if (!b.id) return json({ error: "id が必要" }, 400);
    const r = await setBuiltinEnabled(env, b.id, !!b.enabled);
    if (!r.ok) return json({ error: r.error }, 400);
    await recordAudit(env, ses.email, "builtin.set", b.id, `enabled=${!!b.enabled}`);
    return json({ ok: true });
  }
  if (b._action === "list") {
    return json({ ok: true, apps: await listApps(env), usage: await usageByApp(env) });
  }
  return json({ error: "不明な操作" }, 400);
};
