import type { APIRoute } from "astro";
import { getSession } from "../../../lib/auth.ts";
import { cachedEntitlement } from "../../../lib/client.ts";
import { atLeast } from "@baku-office/shared";
import { a2aHost, groupHost } from "../../../lib/a2a.ts";
import { listActions, createAction, updateAction, deleteAction, getOrgProfile, setOrgProfile, type ActionScope } from "../../../lib/a2a-actions.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// A2A 管理（Pro・管理者）：接続/グループ操作＋公開アクション(CRUD)＋組織プロフィール。
export const POST: APIRoute = async ({ request, locals }) => {
  const ctx = locals.ctx;
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return json({ error: "管理者のみ" }, 403);
  if (!atLeast(await cachedEntitlement(env), "pro")) return json({ error: "A2A は Pro 以上で利用できます" }, 403);
  const b = (await request.json().catch(() => ({}))) as {
    _action?: string; code?: string; label?: string; groupId?: string; name?: string;
    id?: string; kind?: "app" | "decl"; spec?: unknown; scope?: ActionScope; target?: string; enabled?: boolean; profile?: unknown;
  };
  // 1:1 接続
  if (b._action === "create") return json(await a2aHost(env, "create", { label: b.label }));
  if (b._action === "accept") return json(await a2aHost(env, "accept", { code: b.code, label: b.label }));
  if (b._action === "list") return json(await a2aHost(env, "list"));
  if (b._action === "revoke") return json(await a2aHost(env, "revoke", { code: b.code }));
  // グループ
  if (b._action === "group_create") return json(await groupHost(env, "create", { name: b.name }));
  if (b._action === "group_join") return json(await groupHost(env, "join", { groupId: b.groupId, label: b.label }));
  if (b._action === "group_list") return json(await groupHost(env, "list"));
  if (b._action === "group_leave") return json(await groupHost(env, "leave", { groupId: b.groupId }));
  // 公開アクション（CRUD）
  if (b._action === "action_list") return json({ ok: true, actions: await listActions(ctx) });
  if (b._action === "action_create") {
    if (!b.name || !b.kind || !b.scope) return json({ error: "name / kind / scope が必要" }, 400);
    return json({ ok: true, id: await createAction(ctx, { name: String(b.name), kind: b.kind, spec: b.spec, scope: b.scope, target: b.target }) });
  }
  if (b._action === "action_update") { await updateAction(ctx, String(b.id ?? ""), { name: b.name, spec: b.spec, scope: b.scope, target: b.target, enabled: b.enabled }); return json({ ok: true }); }
  if (b._action === "action_delete") { await deleteAction(ctx, String(b.id ?? "")); return json({ ok: true }); }
  // 組織プロフィール
  if (b._action === "profile_get") return json({ ok: true, profile: await getOrgProfile(ctx) });
  if (b._action === "profile_save") return json({ ok: true, profile: await setOrgProfile(ctx, b.profile) });
  return json({ error: "不明な操作" }, 400);
};
