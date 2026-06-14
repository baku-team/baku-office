// 契約テスト（キーレスWIF P1）：Worker の OIDC IdP 化。
// discovery 構造・JWKS(RSA n/e/kid)・自署名 OIDC JWT が公開鍵で検証できることを往復で確認（ネットワーク不要）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateMasterKey } from "@baku-office/shared";
import { ensureOidcKey, oidcJwks, openidConfiguration, signOidcJwt } from "../src/lib/oidc-idp.ts";

// インメモリ KV ＋ MASTER_KEY の最小 env。saveApiKey/getApiKey（暗号化）と kvPut が動く。
function fakeEnv() {
  const kv = new Map<string, string>();
  const LICENSE = {
    get: async (k: string) => (kv.has(k) ? kv.get(k)! : null),
    put: async (k: string, v: string) => { kv.set(k, v); },
    delete: async (k: string) => { kv.delete(k); },
    list: async () => ({ keys: [] as { name: string }[] }),
  };
  return { LICENSE, MASTER_KEY: generateMasterKey() } as never;
}

const b64urlToBytes = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const decodeJson = (seg: string) => JSON.parse(new TextDecoder().decode(b64urlToBytes(seg)));

test("openidConfiguration：issuer/jwks_uri/RS256 を含み末尾スラッシュを正規化", () => {
  const c = openidConfiguration("https://t.example.com/");
  assert.equal(c.issuer, "https://t.example.com");
  assert.equal(c.jwks_uri, "https://t.example.com/.well-known/jwks.json");
  assert.deepEqual(c.id_token_signing_alg_values_supported, ["RS256"]);
});

test("ensureOidcKey：鍵を遅延生成し、再呼び出しで同一 kid（永続）", async () => {
  const env = fakeEnv();
  const a = await ensureOidcKey(env);
  const b = await ensureOidcKey(env);
  assert.equal(a.kid, b.kid, "再呼び出しで同じ鍵（kid）を返す");
  assert.ok(a.kid.length > 0);
});

test("oidcJwks：公開鍵 JWK が RSA で n/e/kid/alg を持つ", async () => {
  const env = fakeEnv();
  const { keys } = await oidcJwks(env);
  assert.equal(keys.length, 1);
  const jwk = keys[0];
  assert.equal(jwk.kty, "RSA");
  assert.equal(jwk.alg, "RS256");
  assert.equal(jwk.use, "sig");
  assert.ok(jwk.n && jwk.e && jwk.kid, "n/e/kid を持つ");
  assert.equal((jwk as { d?: string }).d, undefined, "秘密成分 d を含まない");
});

test("signOidcJwt：自署名 JWT が JWKS の公開鍵で検証でき、kid が一致", async () => {
  const env = fakeEnv();
  const claims = { iss: "https://t.example.com", sub: "baku-office", aud: "https://iam.googleapis.com/x", iat: 1000, exp: 1300 };
  const jwt = await signOidcJwt(env, claims);
  const [h, p, s] = jwt.split(".");
  assert.equal(decodeJson(h).alg, "RS256");
  assert.deepEqual(decodeJson(p), claims, "ペイロードがクレームと一致");

  const { keys } = await oidcJwks(env);
  assert.equal(decodeJson(h).kid, keys[0].kid, "header.kid が JWKS の kid と一致");
  const pub = await crypto.subtle.importKey("jwk", keys[0] as JsonWebKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pub, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`));
  assert.equal(ok, true, "公開鍵で署名検証できる");
});
