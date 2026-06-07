// 第2層更新の「日和見ローダ」（deploy仕様§3.2）：
//   再ビルド時だけ最新バンドルを取りに行く。初回や障害時は同梱版をそのまま使う（＝壊さない）。
//   手順：①同梱 VERSION を読む ②HOST/api/release/latest を取得 ③latest>同梱 のときだけ tarball 取得
//        ④HOST/api/pubkey の Ed25519 公開鍵で署名検証 ⑤検証OK→_worker.js/_astro/migrations を置換
//        検証NG／取得失敗→何もしない（同梱版のまま）。続く wrangler deploy が同一プロジェクトへ反映。
// ホストへは何も送らない（pull のみ＝原則1）。失敗は常に「現行版維持」へフォールバック（原則3）。
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
  // リリース署名の検証鍵（ライセンス鍵とは別鍵）。未提供時は後方互換で /api/pubkey にフォールバック。
  let jwk;
  try { const rp = await fetch(host + "/api/release/pubkey"); if (rp.ok) jwk = await rp.json(); } catch {}
  if (!jwk || !jwk.x) jwk = await (await fetch(host + "/api/pubkey")).json(); // {kty:'OKP',crv:'Ed25519',x:'...'}
  const pub = createPublicKey({ key: jwk, format: "jwk" });
  const sig = Buffer.from(latest.sig, "base64");
  if (!edVerify(null, tarball, pub, sig)) die("署名検証NG");

  // 検証OK：tarball を展開し、コード/アセット/マイグレーションのみ置換（D1/KV/R2 設定には触れない）。
  const tmp = ".update-tmp";
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  writeFileSync(tmp + "/bundle.tgz", tarball);
  execSync(`tar -xzf ${tmp}/bundle.tgz -C ${tmp}`, { stdio: "ignore" });
  for (const p of ["_worker.js", "_astro", "migrations"]) {
    const src = `${tmp}/${p}`;
    if (existsSync(src)) { rmSync(p, { recursive: true, force: true }); execSync(`cp -R ${src} ${p}`, { stdio: "ignore" }); }
  }
  if (existsSync(tmp + "/VERSION")) writeFileSync("VERSION", latest.version + "\n");
  rmSync(tmp, { recursive: true, force: true });
  console.log("[update] applied:", bundled, "->", latest.version);
} catch (e) {
  die("取得/検証エラー: " + (e?.message || e));
}
