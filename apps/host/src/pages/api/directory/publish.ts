import type { APIRoute } from "astro";
import { atLeast } from "@baku-office/shared";
import { callerFromToken } from "../../../lib/registry.ts";
import { publishEntry, unpublishEntry } from "../../../lib/directory.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 公開ディレクトリへの掲載（本人 license のみ・Plus 以上）。client が profile/embedding/verification を生成して送る。
export const POST: APIRoute = async ({ request }) => {
  const b = (await request.json().catch(() => ({}))) as { token?: string; _action?: string; orgName?: string; profile?: unknown; embedding?: number[] | null; verification?: unknown; listed?: boolean };
  const caller = await callerFromToken(env, b.token);
  if (!caller) return json({ error: "有効なライセンスが必要" }, 401);
  if (!atLeast(caller.entitlement, "plus")) return json({ error: "公開は Plus 以上で利用できます" }, 402);

  if (b._action === "unpublish") { await unpublishEntry(env, caller.licenseId); return json({ ok: true }); }

  if (!b.orgName) return json({ error: "団体名が必要" }, 400);
  const r = await publishEntry(env, caller.licenseId, {
    orgName: String(b.orgName),
    profile: (b.profile ?? {}) as Record<string, unknown>,
    embedding: Array.isArray(b.embedding) ? b.embedding.slice(0, 1024) : null,
    verification: (b.verification ?? {}) as Record<string, unknown>,
    listed: b.listed !== false,
  });
  return json(r);
};
