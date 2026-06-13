import type { APIRoute } from "astro";
import { licenseFromToken, createConnection, acceptConnection, listConnections, revokeConnection, establishFromPublic } from "../../../lib/a2a.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// A2A 接続の作成/参加/一覧/取消（client のライセンストークンで認証）。
export const POST: APIRoute = async ({ request, locals }) => {
  const b = (await request.json().catch(() => ({}))) as { _action?: string; token?: string; code?: string; label?: string; partner?: string };
  const license = await licenseFromToken(env, b.token);
  if (!license) return json({ error: "有効なライセンスが必要" }, 401);
  if (b._action === "create") return json({ ok: true, code: await createConnection(env, license, b.label) });
  if (b._action === "establish_public") return json(await establishFromPublic(env, license, String(b.partner ?? "")));
  if (b._action === "accept") return json(await acceptConnection(env, String(b.code ?? ""), license, b.label));
  if (b._action === "list") return json({ ok: true, connections: await listConnections(env, license) });
  if (b._action === "revoke") { await revokeConnection(env, String(b.code ?? ""), license); return json({ ok: true }); }
  return json({ error: "不明な操作" }, 400);
};
