import type { APIRoute } from "astro";
import { openidConfiguration } from "../../lib/oidc-idp.ts";

export const prerender = false;

// OIDC discovery（無認証で公開）。Google の WIF/STS が issuer から自動取得する。
// issuer はこの Worker の公開 origin。WIF プロバイダの issuer-uri と一致させること（スクリプト P4）。
export const GET: APIRoute = async ({ url }) => {
  const body = JSON.stringify(openidConfiguration(url.origin));
  return new Response(body, {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
  });
};
