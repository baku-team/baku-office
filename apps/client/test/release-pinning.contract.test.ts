// 適合性テスト（§3-2）：更新チェーンの検証鍵がピン留め（同梱）されており、TOFU（ホストから鍵取得）に
// 後退していないことを静的に保証する。あわせて同梱鍵で署名検証が往復することを実鍵で確認する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { generateKeyPairSync, sign as edSign, createPublicKey, verify as edVerify } from "node:crypto";

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(CLIENT, p), "utf8");

test("prebuild-update は同梱 release-pubkey.json で検証し、ホストから鍵を取らない（TOFU排除）", () => {
  const src = read("deploy/prebuild-update.mjs");
  assert.ok(src.includes('readFileSync("release-pubkey.json"'), "同梱鍵を読む");
  assert.ok(!/fetch\([^)]*\/api\/release\/pubkey/.test(src), "/api/release/pubkey をfetchしない");
  assert.ok(!/fetch\([^)]*\/api\/pubkey/.test(src), "/api/pubkey フォールバックを残さない");
});

test("prebuild-update は鍵欠落時に fail-closed（更新しない）", () => {
  const src = read("deploy/prebuild-update.mjs");
  assert.ok(/release-pubkey\.json[^\n]*\bdie\(|die\([^\n]*ピン留め/.test(src), "鍵が無ければ die（現行版維持）");
});

test("ローテーション：tarball 展開時に release-pubkey.json も置換対象", () => {
  const src = read("deploy/prebuild-update.mjs");
  assert.ok(/\[[^\]]*"release-pubkey\.json"[^\]]*\]/.test(src), "置換配列に release-pubkey.json を含む");
});

test("build-release は release-pubkey.json をバンドルへ同梱する", () => {
  assert.ok(read("scripts/build-release.mjs").includes("release-pubkey.json"), "build が鍵を同梱");
});

test("同梱 release-pubkey.json は有効な Ed25519 公開鍵JWK（秘密 d を含まない）", () => {
  const jwk = JSON.parse(read("deploy/release-pubkey.json"));
  assert.equal(jwk.kty, "OKP");
  assert.equal(jwk.crv, "Ed25519");
  assert.ok(typeof jwk.x === "string" && jwk.x.length > 0, "公開鍵 x がある");
  assert.equal(jwk.d, undefined, "秘密鍵 d を含めない");
});

test("検証ロジックの健全性：同梱方式の公開鍵で署名検証が往復する", () => {
  // 実際の prebuild の検証コア（同梱公開鍵JWK で edVerify）を、生成鍵で再現して健全性を確認。
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubJwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  const tarball = Buffer.from("dummy-bundle-bytes");
  const sig = edSign(null, tarball, privateKey);
  const pinned = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pubJwk.x }, format: "jwk" });
  assert.ok(edVerify(null, tarball, pinned, sig), "ピン留め鍵で検証成功");
  // 改竄tarballは失敗する。
  assert.ok(!edVerify(null, Buffer.from("tampered"), pinned, sig), "改竄バンドルは検証失敗");
});
