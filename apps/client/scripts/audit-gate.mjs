// 本番依存の脆弱性ゲート（CI）。`npm audit --omit=dev` の high/critical を検出し、
// **許可リスト(GHSA)に無いものが1件でもあれば失敗**させる（新規の high/critical は引き続きブロック）。
//
// なぜ許可リストか：現状の high はすべて astro/vite/esbuild（ビルドツールチェーン）由来。
//   - esbuild/vite の脆弱性はビルド時のみ＝デプロイされる Worker 成果物には含まれない。
//   - astro の define:vars XSS（GHSA-j687-52p2-xcff 等）は astro 6 で修正だが major 更新のため別対応。
//     本リポでは該当する利用者入力の埋め込み（schedule.astro の eventsJson）を `<`→\\u003c 退避で
//     構造的に無害化済み（脱出不能）。
// 恒久対応：astro 6 へ更新したら本許可リストは縮小・撤去する。
//
// 使い方: node apps/client/scripts/audit-gate.mjs <許可GHSA...>
import { execSync } from "node:child_process";

const allow = new Set(process.argv.slice(2));

let report;
try {
  const out = execSync("npm audit --omit=dev --json", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  report = JSON.parse(out);
} catch (e) {
  // 脆弱性があると npm audit は非0終了するが、stdout には JSON が出る。
  try {
    report = JSON.parse((e.stdout ?? "").toString() || "{}");
  } catch {
    console.error("npm audit の JSON 解析に失敗しました。");
    process.exit(2);
  }
}

const ghsaOf = (url) => (typeof url === "string" ? url.match(/GHSA-[\w-]+/)?.[0] ?? null : null);
const offenders = [];
const allowedHits = new Set();

for (const [pkg, v] of Object.entries(report.vulnerabilities ?? {})) {
  for (const a of v.via ?? []) {
    if (typeof a !== "object") continue; // 推移的依存（文字列）は根本パッケージ側で評価される。
    const sev = a.severity ?? v.severity;
    if (sev !== "high" && sev !== "critical") continue;
    const ghsa = ghsaOf(a.url);
    if (ghsa && allow.has(ghsa)) { allowedHits.add(ghsa); continue; }
    offenders.push(`${pkg}: ${ghsa ?? a.title ?? "(不明)"} [${sev}]`);
  }
}

if (offenders.length) {
  console.error("✘ 許可リストに無い high/critical 脆弱性があります：");
  for (const o of [...new Set(offenders)]) console.error("  - " + o);
  console.error("\n対応：依存を更新するか、ビルド時のみ/対策済みであることを確認のうえ許可GHSAに追加してください。");
  process.exit(1);
}

const unused = [...allow].filter((g) => !allowedHits.has(g));
if (unused.length) console.log("（注）許可リスト中、今回ヒットしなかったGHSA（更新で解消済みかも）：" + unused.join(", "));
console.log("✓ 本番依存の high/critical は許可リスト内のみ（または無し）。監査ゲート通過。");
