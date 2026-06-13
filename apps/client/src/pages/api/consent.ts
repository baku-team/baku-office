import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { recordConsent, CONSENT_VERSION } from "../../lib/consent.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 規約同意の記録（団体管理者のみ）。CSRF は middleware の sameOrigin ガードで担保済み。
export const POST: APIRoute = async ({ request, locals }) => {
  const ses = await getSession(env, request);
  if (!ses || ses.ctx !== "org" || ses.role !== "admin") return json({ error: "権限がありません" }, 403);
  await recordConsent(env);
  return json({ ok: true, version: CONSENT_VERSION });
};
