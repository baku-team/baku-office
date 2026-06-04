// Ed25519 開発鍵を生成し、秘密鍵JWK(JSON1行)をstdoutに出力。
// 使い方（鍵を画面に出さずsecret登録）：
//   node scripts/genkey.mjs | npx wrangler secret put SIGNING_JWK
const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
process.stdout.write(JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d }));
