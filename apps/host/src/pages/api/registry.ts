import type { APIRoute } from "astro";
import { getHostSession } from "../../lib/hostauth.ts";
import { listApps, registerApp, setAppStatus, usageByApp, hostSetListed } from "../../lib/registry.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// アプリ・レジストリ中枢の管理（ホスト管理者のみ）。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const ses = await getHostSession(env, request);
  if (!ses?.isAdmin) return json({ error: "管理者のみ" }, 403);
  const b = (await request.json().catch(() => ({}))) as { _action?: string; id?: string; name?: string; version?: string; repoUrl?: string; publisher?: string; category?: string; permissions?: string[]; description?: string; status?: string; listed?: boolean; minEntitlement?: string };

  if (b._action === "register") {
    if (!b.id || !b.name || !b.version) return json({ error: "id・name・version が必要" }, 400);
    await registerApp(env, { id: b.id, name: b.name, version: b.version, repoUrl: b.repoUrl, publisher: b.publisher, category: b.category, permissions: b.permissions, description: b.description });
    return json({ ok: true });
  }
  if (b._action === "status") {
    if (!b.id || !["pending", "approved", "blocked"].includes(String(b.status))) return json({ error: "id・status(pending/approved/blocked) が必要" }, 400);
    await setAppStatus(env, b.id, b.status as "pending" | "approved" | "blocked");
    return json({ ok: true });
  }
  if (b._action === "set_listed") {
    if (!b.id) return json({ error: "id が必要" }, 400);
    await hostSetListed(env, b.id, !!b.listed, b.minEntitlement);
    return json({ ok: true });
  }
  if (b._action === "list") {
    return json({ ok: true, apps: await listApps(env), usage: await usageByApp(env) });
  }
  return json({ error: "不明な操作" }, 400);
};
