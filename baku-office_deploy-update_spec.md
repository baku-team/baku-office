# baku-office 設置・有効化・更新 統一仕様（クライアント無操作寄せ版）

> 対象リポジトリ：`baku-team/baku-office`（モノレポ）／ `baku-team/baku-office-app`（配布バンドル）
> 本書は、申込からデプロイ・有効化・更新までを一本化した設計／実装ハンドオフ。
> 正本仕様は [integrated_design_package_v1.0.md]、脅威モデルは [04_threat-model.md]、運用は [OPERATIONS.md]。

---

## 0. 設計を貫く3原則（すべての判断はここに従う）

1. **ホストはクライアントの情報に直接アクセスしない。**
   当社（ホスト）の役割は「署名付き成果物の公開」と「通知」だけ。クライアントの CF トークン・
   GitHub トークン・Deploy Hook を一切保持しない。デプロイ／再ビルドは**常にクライアント起点**。
2. **クライアント操作は簡潔に。**
   初回デプロイは入力ゼロ（ボタン1回）。更新はアプリ内1タップ（案①）か通知リンク先で1クリック（案②）。
   CF ダッシュボードの探索・貼り付けは、案①を選んだ人の初回1回だけに限定する。
3. **破壊的な動作はしない。**
   既存の D1/KV/R2 を再プロビジョニングしない（＝Deploy ボタン再実行を禁止）。更新は同一プロジェクトの
   再ビルドのみ。マイグレーションは前進・追加のみ。署名検証に失敗したら現行版を維持。ロールバック可能。

---

## 1. 全体フロー

```
[申込] 申込画面で団体情報入力
   │  ホストが licenseId と deploy_code(使い捨てnonce) を発行
   │  ホストが GitHub API で団体ごと公開リポ baku-team/app-<id> を生成（report.json を焼き込み）
   ▼
[初回デプロイ] クライアントが個別リポの Deploy ボタンを1回押すだけ（入力ゼロ）
   │  CF がクライアントの GitHub へ複製 → D1/KV を自動プロビジョニング → 自分のCFへデプロイ
   │  deploy 工程：①日和見ローダ（後述）②URL を deploy.log から抽出し {code,url} をホストへ直接POST
   ▼
[自動点灯] ホストが deploy_code から license を引き当て deploy_url を保存
   │  申込画面がポーリングして「▶ あなたのアプリを開く」を自動表示
   ▼
[有効化] アプリを開き Google ログイン（申込メールと突合）。secret 入力なし
   │  （初回ログイン時、既存の activate-by-email が deploy_url も記録＝二重の捕捉経路）
   ▼
[運用] 第1層更新はランタイム自動。第2層更新は通知→クライアントが1操作で再ビルド（案①/②）
   ▼
[解約] ホストが個別リポを削除（throwaway）。クライアントのCF内データには触れない
```

---

## 2. 初回オンボーディング

### 2.1 GitHub アカウント（維持・丁寧な事前案内で歩留まり改善）

GitHub 維持。離脱要因は登録時の Arkose（FunCaptcha）と IP 評価なので、申込ページの「事前準備」に明記する：

> 「**通常の自宅Wi-Fiまたはスマホ回線で、広告ブロッカー／プライバシー拡張を一時的にオフにし、
> シークレットウィンドウやVPNは使わずに**登録してください。確認パズルは1〜2回出ますが落ち着いて回せば通ります。」

GitLab への横移動は不可（同じ Arkose に加え、登録・ネームスペース作成で電話番号/クレカ確認が入り、
非技術者にはむしろ離脱要因）。

### 2.2 団体ごと公開リポの自動生成（throwaway・入力ゼロの土台）

入力ゼロを成立させるため、相関値をユーザーに打たせず**リポに焼き込む**。焼き込むのは licenseId 本体では
なく**使い捨て `deploy_code`（nonce）**のみ（公開リポでの露出を最小化）。

準備（一度きり）：
- `baku-team/baku-office-app` を GitHub の **Template repository** 化。
- ホスト secret **`GITHUB_TOKEN`**（baku-team org の repo 作成＝Administration:write・Contents:write）。

`apps/apply/src/pages/api/apply.ts`（追記）：

```ts
import { randomId } from "@baku-office/shared";
// …license 作成後…
const deployCode = randomId();
await env.DB.prepare("UPDATE licenses SET deploy_code = ? WHERE license_id = ?")
  .bind(deployCode, licenseId).run();

let deployRepo = "baku-team/baku-office-app"; // 生成失敗時のフォールバック（共有リポ）
try { deployRepo = await provisionRepo(env, licenseId, deployCode); } // → "baku-team/app-<id>"
catch (e) { console.error("provision failed, fallback to shared repo", e); }

const deployUrl = "https://deploy.workers.cloudflare.com/?url=https://github.com/" + deployRepo;
return json({ ok: true, licenseId, deployUrl });
```

`apps/host/src/lib/github.ts`（新規）：

```ts
const GH = "https://api.github.com";
const h = (env: Env) => ({ Authorization: `Bearer ${env.GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json", "User-Agent": "baku-office-provisioner",
  "X-GitHub-Api-Version": "2022-11-28" });

export async function provisionRepo(env: Env, licenseId: string, code: string): Promise<string> {
  const owner = "baku-team", name = "app-" + licenseId;
  const gen = await fetch(`${GH}/repos/${owner}/baku-office-app/generate`, {
    method: "POST", headers: h(env),
    body: JSON.stringify({ owner, name, private: false, description: "baku-office (auto)" }) });
  if (!gen.ok) throw new Error("generate " + gen.status);
  const content = btoa(unescape(encodeURIComponent(
    JSON.stringify({ code, host: env.HOST_BASE_URL }))));
  for (let i = 0; i < 5; i++) {
    const put = await fetch(`${GH}/repos/${owner}/${name}/contents/report.json`, {
      method: "PUT", headers: h(env),
      body: JSON.stringify({ message: "add report.json", content }) });
    if (put.ok) return `${owner}/${name}`;
    await new Promise(s => setTimeout(s, 1500));
  }
  throw new Error("put report.json failed");
}

export async function deleteRepo(env: Env, licenseId: string) { // throwaway 用
  await fetch(`${GH}/repos/baku-team/app-${licenseId}`, { method: "DELETE", headers: h(env) });
}
```

`licenses.deploy_code` 列を追加（host マイグレーション）：

```sql
ALTER TABLE licenses ADD COLUMN deploy_code TEXT;
CREATE INDEX IF NOT EXISTS idx_licenses_deploy_code ON licenses (deploy_code);
```

### 2.3 リポ運用方針：throwaway（恒久保持しない）

- 個別リポは**初回 Deploy の複製元としてのみ**使う。クライアントの複製は独立リポ（CF は fork ではなく
  clone を作る）なので、複製後は個別リポを消してもクライアントの稼働・更新は壊れない。
- 削除タイミング：`deploy_url` 受領後に `deleteRepo` ／ 7日以上未報告の残骸を定期スイープ ／ 解約時。
- 根拠（N スケール）：公開リポは無料・無制限でストレージ課金対象外＝**金額は N に依存せずほぼ0**。
  効くのは(a)作成レート（二次制限 80/分・500/時 ≒ 250申込/時上限・現実速度では非問題）、
  (b)一括 fan-out（数千で重く・しかも clone≠fork でクライアント稼働Workerには届かず無効）、
  (c)大量均一リポのスパム検知（件数より生成パターンの問題）。
  → **throwaway で常時 N を小さく保ち、更新を host-repo fan-out に依存させない**のが最も安全。

### 2.4 配布バンドル側の追加（apps/client / baku-office-app）

現状 `baku-office-app` は自己完結バンドル（`_worker.js/`・`_astro/`・`migrations/`・`wrangler.jsonc`）で
`package.json` 無し＝既定 `npx wrangler deploy`。ここに deploy スクリプトと2本のスクリプトを足す
（`build-release.mjs` で生成。`report.json` は焼き込まない＝ホストが個別注入）。

`scripts/build-release.mjs`（追記）:

```js
writeFileSync(join(out, "package.json"), JSON.stringify({
  private: true,
  scripts: { deploy: "node prebuild-update.mjs; npx wrangler deploy 2>&1 | tee deploy.log; node postdeploy.mjs" },
}, null, 2));
copyFileSync(join(root, "deploy", "prebuild-update.mjs"), join(out, "prebuild-update.mjs"));
copyFileSync(join(root, "deploy", "postdeploy.mjs"),     join(out, "postdeploy.mjs"));
writeFileSync(join(out, "VERSION"), pkgVersion + "\n"); // 例: リリースのバージョン
```

`deploy/postdeploy.mjs`（初回の自動点灯用・URLをホストへ直接報告）:

```js
import { readFileSync } from "node:fs";
let code, host, url;
try { const r = JSON.parse(readFileSync("report.json","utf8")); code=r.code; host=String(r.host||"").replace(/\/$/,""); }
catch { process.exit(0); } // report.json 無し（共有リポ）→ 初回ログイン時の捕捉(②)に委ねる
try { url = (readFileSync("deploy.log","utf8").match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)||[])[0]; } catch {}
if (!code || !host || !url) process.exit(0);
for (let i=0;i<6;i++){ try{ if((await fetch(host+"/api/deploy-report",{method:"POST",
  headers:{"content-type":"application/json"},body:JSON.stringify({code,url})})).ok) break; }catch{}
  await new Promise(s=>setTimeout(s,10000)); } // 初回 523/伝播を吸収
```

### 2.5 ホスト側の受け口（apps/host）

`deploy-report.ts`（新規・first-write-wins）:

```ts
export const POST = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const { code = "", url = "" } = await request.json().catch(() => ({}));
  if (!code || !/^https:\/\/[a-z0-9.-]+\.workers\.dev$/i.test(url)) return json({error:"bad"},400);
  const lic = await env.DB.prepare(
    "SELECT license_id AS id, deploy_url AS u FROM licenses WHERE deploy_code=? AND status='active' LIMIT 1")
    .bind(code).first();
  if (!lic) return json({error:"unknown"},404);
  if (!lic.u) await env.DB.prepare("UPDATE licenses SET deploy_url=?, last_seen=? WHERE license_id=?")
    .bind(url, nowSec(), lic.id).run(); // 確定済みなら上書きしない（偽報告レース緩和）
  return json({ok:true});
};
```

`deploy-status.ts`（新規・申込画面ポーリング先）:

```ts
export const GET = async ({ url, locals }) => {
  const id = (url.searchParams.get("license") ?? "").trim();
  if (!id) return json({error:"license required"},400);
  const row = await locals.runtime.env.DB
    .prepare("SELECT deploy_url AS u FROM licenses WHERE license_id=? LIMIT 1").bind(id).first();
  return json({ ready: !!row?.u, url: row?.u ?? null });
};
```

### 2.6 申込画面（apps/apply/index.astro）

URL/コード入力欄は撤去。API が返した個別リポの Deploy ボタン＋ポーリング点灯のみ。

```js
out.innerHTML = `
  <h2>✅ 申込完了</h2><h2>アプリを導入</h2>
  <p>下のボタンを押すだけで導入できます（入力は不要です）。</p>
  <a href="${j.deployUrl}" target="_blank" rel="noreferrer">
    <img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare" height="36"></a>
  <div id="appbox"><span class="spin"></span> 設置中…（1〜3分）</div>
  <details><summary>1分以上出ないとき</summary>Cloudflare 完了画面の <code>…workers.dev</code> リンクを押してください。</details>`;
const tick = async () => {
  try { const s = await (await fetch("/api/deploy-status?license="+encodeURIComponent(j.licenseId))).json();
    if (s.ready) { document.getElementById("appbox").innerHTML =
      `<a class="btn" href="${s.url}/" target="_blank" rel="noreferrer">▶ あなたのアプリを開く</a>`; return; }
  } catch {} setTimeout(tick, 5000); };
setTimeout(tick, 8000);
```

### 2.7 フォールバック（原則3に沿った多重防御）

- 個別リポ生成失敗 → 共有リポ Deploy（自動点灯なしでも導入は完了）。
- report 失敗 → ① CF 完了画面の `*.workers.dev` リンク ＋ ② 初回 Google ログイン時に
  既存 `activate-by-email` が `deploy_url` を記録。
- 有効化は終始「アプリを開く → Google ログイン（メール突合）」。LICENSE_ID 等の入力は不要。

---

## 3. 更新フロー（2層モデル）

### 3.1 第1層：ランタイム配信（再デプロイ不要・操作ゼロ）

設定・テンプレート・フィーチャーフラグなど可変部分を、worker が実行時にホストから取得する形に寄せる
（既存の license/pubkey/ログイン中継/`ensureSchema` の延長）。クライアントが pull するだけなので
**ホストはデータに触れず**、再デプロイも操作も不要。更新の大半をここに吸収し、第2層の頻度を下げる。

### 3.2 第2層：バンドル更新（_worker.js のコード変更・まれ）

「フォーク」は技術的には「**同一プロジェクトを最新で再ビルドする**」に置き換わる（現行 Deploy ボタンは
clone でフォーク関係を持たず GitHub の Sync fork は使えない）。データ保全のため**Deploy ボタンの再実行は
禁止**（再プロビジョニング＝D1/KV 孤立）。

**自己完結バンドルを維持したまま、再ビルド時だけ最新を取りに行く「日和見ローダ」**：

`deploy/prebuild-update.mjs`（疑似コード）:

```js
// 1. 同梱 VERSION を読む
// 2. HOST_BASE_URL/api/release/latest → { version, tarballUrl, sig(Ed25519) } を取得
// 3. latest > 同梱 のときだけ: tarball を取得 → HOST/api/pubkey の公開鍵で署名検証
//    検証OK → 作業ディレクトリへ展開（_worker.js/・_astro/・migrations/ を最新に置換）
//    検証NG または 取得失敗 → 何もしない（＝同梱バンドルのまま）＝壊さない
// 4. 続く `wrangler deploy` が、同一プロジェクト（D1/KV/R2 バインド維持）へデプロイ
// 5. 初回リクエストで ensureSchema が「追加のみ」マイグレーションを冪等適用
```

- 初回デプロイは同梱版を使う（ホスト障害時も確実）。以降の再ビルドだけ最新を拾う。
- 「ビルド時取得＝ホストがコード系譜を握る」点は原則1（データ非アクセス）には**抵触しない**
  （クライアントが pull するだけ）。①クライアント起点の同意、②署名検証、③再現可能ビルドでの
  第三者検証、で「監査可能な署名済みコードしか乗らない」まで縛る。

### 3.3 トリガ：案①と案②の共存（クライアントがやりやすい方を選ぶ）

更新フローは共通で、**トリガだけ**が違う。アプリは「フック登録済みか」で自動的に出し分ける。

通知（共通）：ホストが署名付きリリースを公開し `api/check` の応答に `latest_version` を載せる →
worker が同梱 VERSION と比較 → 新しければ既存のホスト通知UIで「新バージョン vX があります【更新】」表示。

【更新】押下時の分岐：

```
if (アプリKVに deployHook が保存済み) {   // 案①
   アプリが自分のフックへ POST → 同一プロジェクト再ビルド → 日和見ローダが最新を取得
   「更新中…数分で反映されます」
} else {                                  // 案②
   ガイドパネル表示：通知リンク（深いリンク）でCFの Deployments を開き
   「Create deployment / Retry」を1回押す案内＋スクショ（日和見ローダが最新を取得）
   併せて「次回から1タップにする → 自動更新を設定」（案①へ誘導）も提示
}
```

クライアントは「一度だけCFを触って以後1タップ（案①）」か「設定ゼロで更新時のみ1クリック（案②）」を、
自分の都合で選べる。どちらも原則1〜3を満たす（フックはクライアント側にのみ存在＝ホストは再ビルドを
起こせない／同一プロジェクト再ビルドで非破壊）。

### 3.4 案①：初回フック取得のクライアント手順（一度きり・任意）

伝え方：「**一度きり・任意・2〜3分。済ませると次回から更新がアプリ内ボタン1つで完了**」。

- フェーズA（アプリ内）：設定→自動更新→【自動更新を有効にする】→ ウィザード（スクショ＋
  【Cloudflareの設定を開く】ボタン）。
- フェーズB（CF・誘導）：深いリンク `https://dash.cloudflare.com/?to=/:account/workers/services/view/baku-office/production/settings`
  で自分の Worker 設定に着地（複数アカウント時のみ最初に選択）→ スクショどおり
  「設定→ビルド(Builds)→Deploy Hooks」→「作成」→ 名前任意・ブランチ=本番(main) → 生成URLをコピー。
- フェーズC（アプリ内）：URLを1回貼付 → 形式検証 → アプリKVに**暗号化保存**（MASTER_KEY）→
  「✅ 自動更新を有効にしました」。テスト発火はしない（次回更新時に使用）。

実装の勘所：`?to=/:account/...` の深いリンク（正確なパスは要最終確認、外しても着地するよう
「Workers & Pages を開く」も併置）／注釈付きスクショ2〜3枚／貼付欄＋バリデーション／明確な成功表示／
「あとで」で閉じられスキップ可能。
重要：**フックURLはアプリKV内だけに保存し、ホストへは送らない**（原則1の強い担保）。

### 3.5 案②：手動再ビルドのクライアント手順（設定ゼロ）

- 設定不要。更新時、通知の【更新】→ ガイドパネルの深いリンクで自分の Worker の Deployments を開く →
  「Create deployment / Retry」を1回押す → 日和見ローダが最新を取得して同一プロジェクトへ再デプロイ。
- まれな第2層更新なら、初回設定ゼロで都度1クリックのこちらが総コスト最小なことも。

---

## 4. 破壊防止ガードレール（原則3の明文化）

- **Deploy ボタン再実行を禁止**：再プロビジョニング＝D1/KV 孤立。UI・通知・案内のどこにも
  「最初からやり直す」導線を出さず、必ずアプリ内【更新】／既存プロジェクトの再ビルドへ誘導。
- **マイグレーションは前進・追加のみ**：`ensureSchema` 冪等。DROP・破壊的 ALTER を配布しない。
- **署名検証失敗＝現行版維持**：日和見ローダは検証NG/取得失敗時に何も置換せず、旧版が動き続ける。
- **ロールバック可能**：CF のバージョン履歴で復帰。必要なら直前の署名済み版をピンして戻す。
- **デプロイは D1/KV/R2 のデータに触れない**：再ビルドはコード差し替えのみ。

---

## 5. ホスト無アクセスの担保（原則1の明文化）

- ホストが持つ／行うのは「署名付きリリースの公開」「`api/check` での版通知」「（初回のみ）
  `deploy_report` 受領」だけ。
- ホストは**クライアントの CF トークン・GitHub トークン・Deploy Hook を一切保持しない**。
- すべての再ビルドはクライアント起点。ホストから再ビルドや口座操作を起こす経路は構造的に存在しない。
- ホストが知る顧客側の値は `deploy_url`（公開URL）等の非業務データのみ。業務データは
  クライアントの CF 内のみに存在。

---

## 6. 実装対象ファイル一覧（チェックリスト）

**準備（一度きり）**
- [ ] `baku-team/baku-office-app` を Template repository 化
- [ ] host secret `GITHUB_TOKEN`（repo 作成＋Contents 書込）
- [ ] ホスト署名鍵（Ed25519）でのリリース署名運用・`api/pubkey` 配布（既存鍵を流用可）

**apps/host**
- [ ] `migrate_deploy_code.sql`（`licenses.deploy_code`）
- [ ] `src/lib/github.ts`（`provisionRepo` / `deleteRepo`）
- [ ] `src/pages/api/deploy-report.ts`（first-write-wins）
- [ ] `src/pages/api/deploy-status.ts`
- [ ] `src/pages/api/release/latest.ts`（version・tarballUrl・署名を返す）
- [ ] `api/check` に `latest_version` を追加
- [ ] 解約／無効化ジョブ：個別リポ `deleteRepo`・未報告残骸の定期スイープ

**apps/apply**
- [ ] `src/pages/api/apply.ts`（`deploy_code` 発行・`provisionRepo`・`deployUrl` 返却）
- [ ] `src/pages/index.astro`（入力撤去・個別リポ Deploy ボタン＋ポーリング点灯）

**apps/client（baku-office-app への出力）**
- [ ] `scripts/build-release.mjs`（`package.json`・`prebuild-update.mjs`・`postdeploy.mjs`・`VERSION` 生成）
- [ ] `deploy/prebuild-update.mjs`（日和見ローダ＋署名検証）
- [ ] `deploy/postdeploy.mjs`（初回 URL 報告）
- [ ] 配布マイグレーションは「追加のみ」を CI で検査（DROP/破壊的 ALTER を弾く lint）
- [ ] アプリ内「自動更新」ウィザード（案①フック取得・暗号化保存・スクショ）
- [ ] アプリ内【更新】ボタン（フック有→自己再ビルド／フック無→案②ガイド）
- [ ] 版通知UI（`api/check` の `latest_version` と同梱 `VERSION` の比較表示）

**検証**
- [ ] 入力ゼロで申込画面に設置URLが自動点灯／生成失敗時は共有リポにフォールバック
- [ ] 案①：初回フック取得後、通知→アプリ内1タップで再ビルド→最新が乗る／データ保持
- [ ] 案②：設定ゼロで通知→Deployments の Retry 1回→最新が乗る／データ保持
- [ ] Deploy ボタン再実行を誘導する導線がどこにも無い
- [ ] 署名検証NGで現行版が維持される／追加のみマイグレーションが冪等適用される
- [ ] フックURLがホストへ送信されないこと（原則1）

---

## 7. 決定事項・残課題

**決定済み**
- GitHub 維持＋事前準備案内で歩留まり改善（GitLab 不採用）。
- 入力ゼロの初回デプロイ＝団体ごと公開リポ（throwaway）＋ report.json の使い捨て nonce。
- 更新は2層モデル。第2層は署名付き日和見ローダ＋同一プロジェクト再ビルド。
- トリガは案①（フック・1タップ）／案②（設定ゼロ・手動1クリック）を**共存**させ、クライアントが選ぶ。

**残課題（要確認・最終化）**
- `?to=/:account/...` の Deploy Hooks までの正確なパス（着地フォールバック併置で実害は回避済み）。
- リリース tarball の配布先（R2 公開バケット等）と署名フォーマット確定。
- 第1層に寄せる可変領域の線引き（どこまでランタイム配信にするか）。
- throwaway 削除のタイミング微調整（deploy_url 受領後即時 / TTL スイープ / 解約時）。
