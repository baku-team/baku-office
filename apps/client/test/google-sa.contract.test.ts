// サービスアカウント(DWD)用 JWT 署名の契約テスト。
// 生成した RSA 鍵で signJwt → 構造(3部・RS256)・クレーム・署名検証の往復を確認（ネットワーク不要）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { signJwt } from "../src/lib/google-sa.ts";

const b64urlToBytes = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const decodeJson = (seg: string) => JSON.parse(new TextDecoder().decode(b64urlToBytes(seg)));

async function genPem(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let bin = "";
  for (const b of pkcs8) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/(.{64})/g, "$1\n");
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
  return { pem, publicKey: pair.publicKey };
}

test("signJwt：構造・クレーム・署名が検証できる", async () => {
  const { pem, publicKey } = await genPem();
  const claims = { iss: "sa@proj.iam.gserviceaccount.com", sub: "user@example.com", scope: "https://www.googleapis.com/auth/calendar.events", aud: "https://oauth2.googleapis.com/token", iat: 1000, exp: 4600 };
  const jwt = await signJwt(pem, claims);

  const parts = jwt.split(".");
  assert.equal(parts.length, 3, "JWT は header.payload.signature の3部");
  assert.equal(decodeJson(parts[0]).alg, "RS256");
  assert.equal(decodeJson(parts[0]).typ, "JWT");
  assert.deepEqual(decodeJson(parts[1]), claims, "ペイロードがクレームと一致");

  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", publicKey,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  assert.equal(ok, true, "公開鍵で署名が検証できる");
});
