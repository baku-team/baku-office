import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 第2層更新の最新リリース情報（deploy仕様§3.2）：日和見ローダが参照。
//   { version, tarballUrl, sig } を返す。sig は tarball を RELEASE 署名鍵(Ed25519)で署名（base64）。
//   検証鍵は /api/release/pubkey。恒久運用では CI が /api/release/publish で PORTAL KV に登録する。
//   KV 未設定時は env(後方互換)→version のみ にフォールバック（ローダは「取得失敗→現行版維持」で非破壊）。
export const GET: APIRoute = async ({ locals }) => {
  let rel: { version?: string; tarballUrl?: string; sig?: string } = {};
  try { const raw = await env.PORTAL.get("release_latest"); if (raw) rel = JSON.parse(raw); } catch { /* fallback */ }
  return json({
    version: rel.version ?? env.LATEST_VERSION ?? "0.0.0",
    tarballUrl: rel.tarballUrl ?? env.RELEASE_TARBALL_URL ?? null,
    sig: rel.sig ?? env.RELEASE_SIG ?? null,
  });
};
