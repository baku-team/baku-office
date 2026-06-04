// 秘密鍵JWK(stdin・1行JSON)から公開鍵JWK(x のみ)を取り出してstdoutへ。
// クライアント側の検証鍵 VERIFY_PUBLIC_JWK に使う（秘密鍵 d は出力しない）。
// 使い方： node scripts/genkey.mjs | node scripts/pubkey.mjs
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const jwk = JSON.parse(raw.trim());
process.stdout.write(JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x }));
