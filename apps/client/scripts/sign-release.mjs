// リリース成果物（tarball）を RELEASE 署名鍵(Ed25519)で署名し base64 を出力。
// 検証側：クライアント prebuild-update.mjs が /api/release/pubkey で edVerify(null, tarball, pub, sig)。
// 鍵はライセンス署名鍵(SIGNING_JWK)とは別。CIシークレット RELEASE_SIGNING_JWK（{kty,crv,x,d}）から読む。
import { readFileSync } from "node:fs";
import { sign as edSign, createPrivateKey } from "node:crypto";

const file = process.argv[2] || "bundle.tgz";
let jwk;
try { jwk = JSON.parse(process.env.RELEASE_SIGNING_JWK || "{}"); } catch { console.error("RELEASE_SIGNING_JWK の JSON が不正"); process.exit(1); }
if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.d) { console.error("RELEASE_SIGNING_JWK が Ed25519 秘密鍵JWK でない"); process.exit(1); }

const priv = createPrivateKey({ key: jwk, format: "jwk" });
const sig = edSign(null, readFileSync(file), priv).toString("base64");
process.stdout.write(sig);
