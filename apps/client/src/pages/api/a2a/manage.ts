import type { APIRoute } from "astro";
import { getSession } from "../../../lib/auth.ts";
import { cachedEntitlement } from "../../../lib/client.ts";
import { atLeast } from "@baku-office/shared";
import { a2aHost, setExposedActions, groupHost, setGroupExposed } from "../../../lib/a2a.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// A2A 管理（Pro・管理者）：接続の作成/参加/一覧/取消（ホスト中継）＋公開アクションの設定（ローカル）。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return json({ error: "管理者のみ" }, 403);
  if (!atLeast(await cachedEntitlement(env), "pro")) return json({ error: "A2A は Pro 以上で利用できます" }, 403);
  const b = (await request.json().catch(() => ({}))) as { _action?: string; code?: string; label?: string; actions?: string[]; groupId?: string; name?: string };
  // 1:1 接続
  if (b._action === "create") return json(await a2aHost(env, "create", { label: b.label }));
  if (b._action === "accept") return json(await a2aHost(env, "accept", { code: b.code, label: b.label }));
  if (b._action === "list") return json(await a2aHost(env, "list"));
  if (b._action === "revoke") return json(await a2aHost(env, "revoke", { code: b.code }));
  if (b._action === "expose") return json({ ok: true, exposed: await setExposedActions(locals.ctx, Array.isArray(b.actions) ? b.actions : []) });
  // グループ
  if (b._action === "group_create") return json(await groupHost(env, "create", { name: b.name }));
  if (b._action === "group_join") return json(await groupHost(env, "join", { groupId: b.groupId, label: b.label }));
  if (b._action === "group_list") return json(await groupHost(env, "list"));
  if (b._action === "group_leave") return json(await groupHost(env, "leave", { groupId: b.groupId }));
  if (b._action === "group_expose") return json({ ok: true, exposed: await setGroupExposed(locals.ctx, String(b.groupId ?? ""), Array.isArray(b.actions) ? b.actions : []) });
  return json({ error: "不明な操作" }, 400);
};
