import type { APIRoute } from "astro";
import { oidcJwks } from "../../lib/oidc-idp.ts";
import { env } from "cloudflare:workers";

export const prerender = false;

// 公開 JWKS（無認証）。Google STS が自署名 OIDC JWT の署名検証に使う公開鍵を返す。
// 鍵未生成なら oidcJwks が遅延生成する（初回 discovery 取得時に確実に鍵が存在する）。
export const GET: APIRoute = async () => {
  const body = JSON.stringify(await oidcJwks(env));
  return new Response(body, {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
  });
};
