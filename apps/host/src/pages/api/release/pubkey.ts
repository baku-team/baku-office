import type { APIRoute } from "astro";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// リリース署名の公開鍵（Ed25519・公開情報）。クライアントの prebuild-update が tarball 検証に使う。
// ライセンス署名鍵(/api/pubkey)とは別鍵＝リリース鍵漏洩でもライセンス偽造に波及しない。
export const GET: APIRoute = async ({ locals }) => {
  const jwk = locals.runtime.env.RELEASE_PUBLIC_JWK;
  if (!jwk) return json({ error: "release pubkey 未設定" }, 404);
  try { return json(JSON.parse(jwk)); } catch { return json({ error: "release pubkey 不正" }, 500); }
};
