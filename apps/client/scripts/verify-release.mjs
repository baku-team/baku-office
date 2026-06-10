// リリース整合ガード（§3-2・CI 必須チェック）。
// 配布バンドルに同梱した release-pubkey.json が、実際の署名鍵 RELEASE_SIGNING_JWK の公開部分と一致し、
// かつ tarball の署名がその同梱鍵で検証できることを確認する。
// WHY: ピン留め鍵と署名鍵が不一致だと、顧客側 prebuild が fail-closed で「全更新が永久に止まる」。
//      公開前に必ず CI で弾く（不一致なら exit 1）。
import { readFileSync } from "node:fs";
import { createPublicKey, verify as edVerify } from "node:crypto";

const [tarballPath, sigB64] = process.argv.slice(2);
if (!tarballPath || !sigB64) { console.error("usage: verify-release.mjs <tarball> <sigBase64>"); process.exit(1); }

let priv;
try { priv = JSON.parse(process.env.RELEASE_SIGNING_JWK || "{}"); } catch { console.error("RELEASE_SIGNING_JWK の JSON が不正"); process.exit(1); }
if (priv.kty !== "OKP" || priv.crv !== "Ed25519" || !priv.d || !priv.x) { console.error("RELEASE_SIGNING_JWK が Ed25519 秘密鍵JWK でない"); process.exit(1); }

let pinned;
try { pinned = JSON.parse(readFileSync("apps/client/release/release-pubkey.json", "utf8")); } catch { console.error("同梱 release-pubkey.json が読めない（build-release が同梱したか確認）"); process.exit(1); }

// (a) ピン留め公開鍵が署名鍵の公開部分（x）と一致するか。
if (pinned.kty !== "OKP" || pinned.crv !== "Ed25519" || pinned.x !== priv.x) {
  console.error("同梱 release-pubkey.json が RELEASE_SIGNING_JWK の公開部分と不一致＝顧客側で全更新が止まる。deploy/release-pubkey.json を署名鍵に合わせて更新せよ。");
  process.exit(1);
}

// (b) 同梱鍵で署名を検証（ラウンドトリップ）。
const pub = createPublicKey({ key: pinned, format: "jwk" });
if (!edVerify(null, readFileSync(tarballPath), pub, Buffer.from(sigB64, "base64"))) {
  console.error("ラウンドトリップ検証NG：同梱鍵で署名を検証できない。");
  process.exit(1);
}
console.log("release-pubkey ピン留め整合OK（公開鍵一致＋署名検証成功）");
