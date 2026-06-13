import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { createCapability, setCapabilityEnabled, deleteCapability } from "../../lib/capabilities.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 任意API（能力レジストリ・高度なオプション・管理者のみ）。
export const POST: APIRoute = async ({ request, locals }) => {
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return json({ error: "管理者のみ" }, 403);
  const b = (await request.json().catch(() => ({}))) as { _action?: string; id?: string; capability?: string; provider?: string; endpoint?: string; model?: string; api_key?: string; enabled?: boolean };

  switch (b._action) {
    case "create":
      if (!b.capability) return json({ error: "capability が必要" }, 400);
      return json({ ok: true, id: await createCapability(env, { capability: b.capability, provider: b.provider, endpoint: b.endpoint, model: b.model, api_key: b.api_key }) });
    case "enable":
      if (b.id) await setCapabilityEnabled(env, b.id, !!b.enabled);
      return json({ ok: true });
    case "delete":
      if (b.id) await deleteCapability(env, b.id);
      return json({ ok: true });
    default:
      return json({ error: "不明な操作" }, 400);
  }
};
