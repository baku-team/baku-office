import type { APIRoute } from "astro";
import { licenseFromToken, createGroup, joinGroup, listGroups, leaveGroup } from "../../../lib/a2a.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// A2A グループの作成/参加/一覧/脱退（client のライセンストークンで認証）。
export const POST: APIRoute = async ({ request, locals }) => {
  const b = (await request.json().catch(() => ({}))) as { _action?: string; token?: string; groupId?: string; name?: string; label?: string };
  const license = await licenseFromToken(env, b.token);
  if (!license) return json({ error: "有効なライセンスが必要" }, 401);
  if (b._action === "create") return json({ ok: true, groupId: await createGroup(env, license, b.name) });
  if (b._action === "join") return json(await joinGroup(env, String(b.groupId ?? ""), license, b.label));
  if (b._action === "list") return json({ ok: true, groups: await listGroups(env, license) });
  if (b._action === "leave") { await leaveGroup(env, String(b.groupId ?? ""), license); return json({ ok: true }); }
  return json({ error: "不明な操作" }, 400);
};
