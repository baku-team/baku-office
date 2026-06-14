// 第2層更新の「日和見ローダ」（deploy仕様§3.2）：
//   再ビルド時だけ最新バンドルを取りに行く。初回や障害時は同梱版をそのまま使う（＝壊さない）。
//   手順：①同梱 VERSION を読む ②HOST/api/release/latest を取得 ③latest>同梱 のときだけ tarball 取得
//        ④【同梱】release-pubkey.json の Ed25519 公開鍵で署名検証 ⑤検証OK→server/client/migrations/release-pubkey.json を置換
//        検証NG／取得失敗／鍵欠落→何もしない（同梱版のまま・fail-closed）。続く wrangler deploy が同一プロジェクトへ反映。
// ホストへは何も送らない（pull のみ＝原則1）。失敗は常に「現行版維持」へフォールバック（原則3）。
//
// §3-2（更新チェーンのトラストアンカー）：検証鍵は配布バンドルに同梱した release-pubkey.json に【ピン留め】する。
//   WHY: 鍵をホストから取得すると tarball/署名/鍵が同一ホスト由来＝ホスト侵害で悪性バンドルが全顧客に展開され得た（TOFU）。
//   ピン留めにより信頼アンカーは「初回 Deploy で取り込んだ配布物」1点に集約され、以後の更新はホストを信頼せず検証できる。
//   鍵ローテーション：新バンドルに新 release-pubkey.json を同梱し【旧鍵で署名】して配る→検証OK後に鍵も置換＝次回から新鍵。
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { createPublicKey, verify as edVerify } from "node:crypto";

const die = (msg) => { if (msg) console.log("[update] skip:", msg); process.exit(0); };

// 同梱バージョン。
let bundled;
try { bundled = readFileSync("VERSION", "utf8").trim(); } catch { die("VERSION 無し"); }

// ホストURL：report.json（個別リポ）優先、無ければ wrangler.jsonc の HOST_BASE_URL。
let host;
try { host = String(JSON.parse(readFileSync("report.json", "utf8")).host || "").replace(/\/$/, ""); } catch {}
if (!host) {
  try {
    const w = readFileSync("wrangler.jsonc", "utf8").replace(/\/\/.*$/gm, "");
    host = (JSON.parse(w).vars?.HOST_BASE_URL || "").replace(/\/$/, "");
  } catch {}
}
if (!host) die("HOST 不明");

const cmp = (a, b) => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
};

try {
  const latest = await (await fetch(host + "/api/release/latest")).json();
  if (!latest?.version || !latest?.tarballUrl || !latest?.sig) die("最新情報が未配備");
  if (cmp(latest.version, bundled) <= 0) die("同梱が最新（" + bundled + "）");

  const tarball = Buffer.from(await (await fetch(latest.tarballUrl)).arrayBuffer());
  // リリース署名の検証鍵は【同梱】release-pubkey.json に固定（§3-2）。ネットワークからは取得しない＝ホスト侵害で鍵を差し替えられない。
  // 鍵が無い/壊れている場合は検証不能なので更新を行わない（fail-closed＝現行版維持）。
  let jwk;
  try { jwk = JSON.parse(readFileSync("release-pubkey.json", "utf8")); } catch { die("release-pubkey.json 無し/不正＝検証鍵がピン留めされていないため更新しない"); }
  if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x) die("release-pubkey.json が Ed25519 公開鍵JWK でない");
  const pub = createPublicKey({ key: jwk, format: "jwk" });
  const sig = Buffer.from(latest.sig, "base64");
  if (!edVerify(null, tarball, pub, sig)) die("署名検証NG（同梱鍵と不一致）");

  // 検証OK：tarball を展開し、コード/アセット/マイグレーション＋検証鍵のみ置換（D1/KV/R2 設定には触れない）。
  // release-pubkey.json も置換＝鍵ローテーションを更新で運ぶ（旧鍵で署名された新バンドルが新鍵を運ぶ）。
  const tmp = ".update-tmp";
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  writeFileSync(tmp + "/bundle.tgz", tarball);
  execSync(`tar -xzf ${tmp}/bundle.tgz -C ${tmp}`, { stdio: "ignore" });
  // v13（@astrojs/cloudflare 13）配布構成：コードは server/、静的アセットは client/。
  // 旧 _worker.js/_astro はもう生成されないため、ここを置換対象から外すと自動更新がコードを差し替えられない。
  for (const p of ["server", "client", "migrations", "release-pubkey.json"]) {
    const src = `${tmp}/${p}`;
    if (existsSync(src)) { rmSync(p, { recursive: true, force: true }); execSync(`cp -R ${src} ${p}`, { stdio: "ignore" }); }
  }
  if (existsSync(tmp + "/VERSION")) writeFileSync("VERSION", latest.version + "\n");
  rmSync(tmp, { recursive: true, force: true });
  console.log("[update] applied:", bundled, "->", latest.version);
} catch (e) {
  die("取得/検証エラー: " + (e?.message || e));
}
