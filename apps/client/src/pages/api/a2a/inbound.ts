import type { APIRoute } from "astro";
import { importVerifyKey, verifyEnvelope, payloadOf, type Envelope } from "@baku-office/shared";
import { getVerifyJwk, nowSec } from "../../../lib/client.ts";
import { resolveAction, runResolvedAction } from "../../../lib/a2a-actions.ts";
import { logDiag } from "../../../lib/diag.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// A2A 受信：ホスト署名を検証し、公開アクション（名前＋スコープ）を解決して read 専用で実行。
// 公開アクション定義(a2a_actions)に無い／スコープ外は拒否。相手データへ直アクセスは不可。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const ctx = locals.ctx;
  const envlp = (await request.json().catch(() => null)) as Envelope | null;
  if (!envlp || typeof envlp.body !== "string" || typeof envlp.sig !== "string") return json({ ok: false, error: "形式不正" }, 400);

  // ホスト署名の検証（VERIFY_PUBLIC_JWK／ホスト公開鍵）。
  const jwk = await getVerifyJwk(env);
  if (!jwk) return json({ ok: false, error: "検証鍵が未設定" }, 503);
  if (!(await verifyEnvelope(await importVerifyKey(jwk), envlp))) return json({ ok: false, error: "署名検証に失敗" }, 401);

  const p = payloadOf(envlp) as { from?: string; groupId?: string; action?: string; args?: Record<string, unknown>; exp?: number; nonce?: string };
  if (!p || typeof p.exp !== "number" || p.exp < nowSec()) return json({ ok: false, error: "期限切れ" }, 401);
  // リプレイ防止：署名は exp(60秒) 窓内なら再送可だったため nonce を使い捨て化（脅威モデル⑦＝署名＋nonce）。
  const nonce = typeof p.nonce === "string" ? p.nonce : "";
  if (!nonce) return json({ ok: false, error: "nonce が必要" }, 401);
  const nk = "a2anonce:" + nonce;
  if (await env.LICENSE.get(nk)) return json({ ok: false, error: "リプレイ検出（使用済み nonce）" }, 409);
  await env.LICENSE.put(nk, "1", { expirationTtl: 120 });
  const name = String(p.action ?? "");
  if (!name) return json({ ok: false, error: "action が必要" }, 400);
  const groupId = p.groupId ? String(p.groupId) : "";

  // 公開アクションを名前＋スコープで解決（common ∪ group:target=groupId ∪ conn:target=from）。
  const row = await resolveAction(ctx, name, { groupId: groupId || undefined, from: p.from });
  if (!row) {
    await logDiag(env, "warn", "other", `A2A 未公開/対象外アクション拒否: ${name}（from ${p.from ?? "?"}${groupId ? ` / group ${groupId}` : ""}）`);
    return json({ ok: false, error: "このアクションは公開されていません" }, 403);
  }

  try {
    const result = await runResolvedAction(ctx, row, p.args ?? {}); // read専用・スコープ統制
    await logDiag(env, "info", "other", `A2A 実行: ${name}（from ${p.from ?? "?"}${groupId ? ` / group ${groupId}` : ""}）`);
    return json({ ok: true, result });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message ?? "実行に失敗" }, 400);
  }
};
