import type { APIRoute } from "astro";
import { importVerifyKey, verifyEnvelope, payloadOf, type Envelope } from "@baku-office/shared";
import { getVerifyJwk, nowSec } from "../../../lib/client.ts";
import { getExposedActions } from "../../../lib/a2a.ts";
import { logDiag } from "../../../lib/diag.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// A2A 受信：ホスト署名を検証し、公開を許可したアクションだけを ctx.apps.call で実行（権限検査つき）。
// 相手データへ直アクセスは不可。生 env・破壊操作・未公開アクションには到達しない。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const ctx = locals.ctx;
  const envlp = (await request.json().catch(() => null)) as Envelope | null;
  if (!envlp || typeof envlp.body !== "string" || typeof envlp.sig !== "string") return json({ ok: false, error: "形式不正" }, 400);

  // ホスト署名の検証（VERIFY_PUBLIC_JWK／ホスト公開鍵）。
  const jwk = await getVerifyJwk(env);
  if (!jwk) return json({ ok: false, error: "検証鍵が未設定" }, 503);
  if (!(await verifyEnvelope(await importVerifyKey(jwk), envlp))) return json({ ok: false, error: "署名検証に失敗" }, 401);

  const p = payloadOf(envlp) as { from?: string; appId?: string; action?: string; args?: Record<string, unknown>; exp?: number };
  if (!p || typeof p.exp !== "number" || p.exp < nowSec()) return json({ ok: false, error: "期限切れ" }, 401);
  const appId = String(p.appId ?? ""); const action = String(p.action ?? "");
  if (!appId || !action) return json({ ok: false, error: "appId/action が必要" }, 400);

  // 公開を許可したアクションのみ実行（団体側の allowlist）。
  const exposed = await getExposedActions(ctx);
  if (!exposed.includes(`${appId}.${action}`)) {
    await logDiag(env, "warn", "other", `A2A 未公開アクション拒否: ${appId}.${action}（from ${p.from ?? "?"}）`);
    return json({ ok: false, error: "このアクションは公開されていません" }, 403);
  }

  try {
    const result = await ctx.apps.call(appId, action, p.args ?? {}); // caller 無し＝外部許可（allowlist で統制）
    await logDiag(env, "info", "other", `A2A 実行: ${appId}.${action}（from ${p.from ?? "?"}）`);
    return json({ ok: true, result });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message ?? "実行に失敗" }, 400);
  }
};
