import type { APIRoute } from "astro";
import { signingJwk } from "../../lib/host.ts";

export const prerender = false;

// ライセンス署名の検証鍵（公開鍵）を返す公開エンドポイント。秘密鍵 d は返さない。
// クライアントはこれを取得して中継ログイン等の署名検証に使う（VERIFY_PUBLIC_JWK の secret 投入を不要にする）。
export const GET: APIRoute = async ({ locals }) => {
  const env = locals.runtime.env;
  try {
    const jwk = signingJwk(env);
    return new Response(JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x }), {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
    });
  } catch {
    return new Response(JSON.stringify({ error: "署名鍵が未設定です" }), { status: 503, headers: { "content-type": "application/json" } });
  }
};
