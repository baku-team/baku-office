import type { APIRoute } from "astro";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 第2層更新の最新リリース情報（deploy仕様§3.2）：日和見ローダが参照。
//   { version, tarballUrl, sig } を返す。sig は tarball を SIGNING_JWK で署名した Ed25519 署名（base64）。
//   検証鍵は /api/pubkey（既存）。tarball 配布先・署名生成はリリース運用で env に設定（§7 残課題）。
// 値が揃わない場合は version のみ返す＝ローダは「取得失敗→現行版維持」にフォールバック（非破壊）。
export const GET: APIRoute = async ({ locals }) => {
  const env = locals.runtime.env;
  return json({
    version: env.LATEST_VERSION ?? "0.0.0",
    tarballUrl: env.RELEASE_TARBALL_URL ?? null,
    sig: env.RELEASE_SIG ?? null,
  });
};
