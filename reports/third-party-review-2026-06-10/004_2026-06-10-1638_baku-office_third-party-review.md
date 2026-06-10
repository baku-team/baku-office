# 003 baku-office 第三者レビュー報告書（2026-06-10 16:38）

> 本レビューは、今回チェックアウトした以下のコミットのみを根拠とする。過去レビュー文書（reports/001, reports/002, docs/archive/*）は根拠に含めない。
>
> - `baku-office`（モノレポ）: `053fe51`（Merge PR #48 / 2026-06-10 16:04 JST）
> - `baku-office-app`（配布ミラー）: `8642bff`（auto-published from baku-office@main）
>
> 確認方法は各指摘に `path:行` で明示する。実行結果は §6 に記載。

---

## 1. 総合評価

- **総合判定**: 良好（セキュリティ意識が高く、主要リスクの大半に意図的な対策と根拠コメントがある）。ただし**未認証で会計データを全件取得できる経路が1件**残っており、これが解消されるまでは無条件の合格にはしない。
- **本番導入可否**: **条件付き可**。下記 P0-1（CSV エクスポートの認可欠落）を修正すれば、現状の設計・実装水準で本番投入に足る。P0-1 は単一ファイル数行の修正で塞げる。
- **一言での結論**: 「設計思想（クライアント主権・ポータブルコア・承認ゲート）は一貫して堅く、ほとんどの定番リスクは既に塞がれている。残る最大の穴は会計CSVの認可漏れ1点。」

---

## 2. エグゼクティブサマリ

### 最重要リスク

- **会計取引CSVが未認証で取得可能（P0-1）**。`/accounting/export.csv` は当該ルート内で `getSession` 等の認可を一切行わず、当期の全取引（`description` 含む＝PII混入の可能性）を返す。さらに `middleware.ts` のログイン誘導は「パスに `.` を含む」場合を exempt するため、ミドルウェア側のガードも効かない。URL を知る／推測できる第三者が会計明細を吸い出せる。
- **状態変更系 POST に CSRF トークン/Origin 検査が無い（P1-1）**。約35の変更系 JSON API は `SameSite=Lax` Cookie ＋ JSON `content-type` のみに依存。多くのケースで実害は限定的だが、管理者破壊操作・課金・連携などの高リスク操作には多層防御が望ましい。プロンプト例（§12）でも `sameOrigin` 軽量ガードが提案されているが、コード上は未導入（`grep sameOrigin` ヒット0）。
- **MASTER_KEY 単一失陥で全サブ鍵が再導出可能（P1-2）**。AES-GCM（files/api-keys/member-pii）もセッション署名 HMAC も、すべて `MASTER_KEY` から HKDF 派生。鍵が漏れれば全用途が破られる。コード自身が「根本対策は Worker Secret 必須化」と明記しており、本番で KV 自動生成をブロックする等の緩和は入っている。
- **Astro の moderate XSS 勧告が未解消（P2-1）**。`npm audit` 上、`astro <=6.1.9` に `define:vars` の不完全な `</script>` サニタイズ XSS と server-island の暗号化パラメータ再生（GHSA-j687-52p2-xcff / GHSA-xr5h-phrj-8vxv）。修正は `astro@6.4.5`（破壊的）。

### 主な強み

- **IDOR 対策が構造化されている**：`storage.ts` の `scopeClause(ses)` が admin/org/personal 文脈を WHERE 句へ落とし、HTTP 経由は必ず `getFileForSession` を通す。低レベル `getFile`（所有者検査なし）は内部用途限定とコメントで明示し、`fileBelongsTo` で補完。
- **dev/本番のバックドアが fail-closed**：`/api/auth/dev`・`/api/billing/dev-confirm`・`/api/activate`・`/api/token` はいずれも `isDevEnv(env)`（`ENV==="development"`）でガードし、本番では 403。クライアント `login.ts` の org モードも `HOST_BASE_URL || VERIFY_PUBLIC_JWK` で本番無効化。
- **A2A の多層防御**：Ed25519 署名 ＋ exp(60s) ＋ nonce 使い捨て（KV `a2anonce:` TTL120s でリプレイ遮断）＋ `isSafeDeployUrl`（IPリテラル/内部TLD/credentials 付きURL/非https を拒否）＋ `redirect:"manual"`。公開アクションは read 専用・スコープ解決（common ∪ group ∪ conn）。
- **Webhook 署名検証が正しい**：Stripe（HMAC-SHA256、`t` 鮮度±300s、定数時間比較）、LINE（`verifyLineSignature`）とも検証必須。LINE は未会員を組織名簿/ナレッジへ到達させないガードも実装。
- **エージェント承認ゲートが既定 on**：対外/破壊系（`unattended:false`、A2A 系）は `needsApproval` → `createApproval` で pending 化し、`/api/agent-actions`（admin+org）でのみ実行。無人ジョブは子エージェントの対外道具も除外。実費 USD cap（`overBudget`）が**モデル呼び出し前**に効く。
- **公開HTMLの allowlist サニタイザ**：正規表現方式を廃し、タグ走査＋許可タグ/属性/スキーム方式へ移行。実体デコード後にスキーム判定（`java&Tab;script:` 等を遮断）、`target=_blank` に `rel` 補完、CSP と多層防御。
- **外部アプリは「宣言的定義（データ）」**：`fetchAndInstall` は署名検証（ホスト公開鍵）＋ exp 検証の上で `definition` を JSON として保存するのみ。`eval`/`new Function`/動的 `import()` による任意コード実行経路は確認されなかった（`grep` で実行経路なし）。
- **法務開示の自動生成**：`disclosure.ts`／`legal-templates.ts` が現在の連携からサブプロセッサ一覧・Limited Use 開示・越境の可能性・保持日数を動的生成。クライアント主権の説明責任に資する。

---

## 3. 重要度別指摘

### P0: 即修正が必要

#### P0-1. 会計取引CSVエクスポートが未認証（Broken Access Control / PII露出）

- **指摘**: `/accounting/export.csv`（`GET`）はルート内でセッション/ロール検査を行わず、当期の全取引を返す。`middleware.ts` の認可前段も、パスに `.` を含むためバイパスされる。
- **根拠**:
  - `apps/client/src/pages/accounting/export.csv.ts`：先頭から末尾まで `getSession`/`requireOrgAdmin`/`canAccess` のいずれも存在しない（`grep` ヒット0）。`currentPeriod` を取り、`transactions`（`date,wallet,kind,category,amount,description,counter`）を全件 SELECT して CSV を返すのみ。
  - `apps/client/src/middleware.ts`：`const exempt = pathname.startsWith("/activate") || pathname.startsWith("/api/") || pathname.includes(".");` … `/accounting/export.csv` は `.` を含むため exempt＝ログイン誘導も走らない。
- **影響**: 当該クライアント（団体）の Worker URL を知る第三者が、ログインせずに会計明細（摘要に氏名・取引先・支払事由等の PII が入り得る）を取得できる。クライアント主権（団体内に閉じるべき業務データ）の前提を直接破る。`/accounting/index.astro` 等のページ系は各 `.astro` 冒頭で `getSession` しているため、漏れているのは本 CSV ルートに限られる（他に `.` を含む非API ページルートは無い＝`find` で本ファイルのみ）。
- **確認方法**: 本番相当（ログインしていないブラウザ/curl）で `GET https://<client>.workers.dev/accounting/export.csv` を叩き、200＋CSV が返るかを確認。修正後は 401/302 を確認。
- **推奨修正**: ルート先頭で `requireOrgAdmin`（会計は admin か `canAccess(role,"accounting")` 相当）を強制する。あわせて `middleware.ts` の exempt 条件から「`.` を含む全パス」を外し、静的アセットだけを通すよう厳格化する（防御を二重化）。
- **本システムの前提との整合**: 認可をクライアント環境内（D1/セッション）で完結させる修正であり、ホスト集約・中央保存・ベンダー専用機能を増やさない。低コスト（追加サービス不要）。
- **実コード提案**:

```ts
// apps/client/src/pages/accounting/export.csv.ts （先頭の import 直後・本体冒頭に追加）
import { getSession, canAccess } from "../../lib/auth.ts";

export const GET: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  // 会計データの閲覧権限を必須化（admin もしくは accounting ロールのみ）。
  const ses = await getSession(env, request);
  if (!ses || ses.ctx !== "org" || !canAccess(ses.role, "accounting")) {
    return new Response("forbidden", { status: 403 });
  }
  // 既存処理（currentPeriod → SELECT → CSV）はそのまま続ける…
};
```

```ts
// apps/client/src/middleware.ts （exempt を「APIと静的アセットの拡張子」に限定し、.csv等の動的ルートを保護下に戻す）
const STATIC_EXT = /\.(?:css|js|mjs|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|txt|json|xml)$/i;
const exempt =
  pathname.startsWith("/activate") ||
  pathname.startsWith("/api/") ||
  STATIC_EXT.test(pathname); // ← `pathname.includes(".")` をやめる
```

- **後方互換**: ミドルウェア変更は静的アセット配信に影響しないよう拡張子 allowlist 方式。万一漏れる拡張子があればログイン誘導が走るだけで機能破壊は起きない（API は別途 exempt 済み）。
- **テスト追加案**:

```ts
// apps/client/test/accounting-export-authz.contract.test.ts （新規・要点のみ）
import { test } from "node:test";
import assert from "node:assert/strict";
import { GET } from "../src/pages/accounting/export.csv.ts";
// 未ログイン Request を渡し 403 を確認。admin セッション Cookie 付きで 200＋text/csv を確認。
test("export.csv は未認証で 403", async () => {
  const res = await GET({ request: new Request("https://x/accounting/export.csv"), locals: { runtime: { env: testEnv() } } } as any);
  assert.equal(res.status, 403);
});
```

---

### P1: 本番前に修正推奨

#### P1-1. 変更系 API に CSRF トークン/Origin 検査が無い

- **指摘**: 約35の `export const POST` 系 API は認可を Cookie セッションに依存するが、リクエスト元の検査（CSRF トークン or `Origin`/`Sec-Fetch-Site`）が無い。`SameSite=Lax` ＋ JSON `content-type` 要求が事実上の緩和になっているものの、明示的な多層防御が欠けている。
- **根拠**:
  - `grep -rn "sameOrigin|csrf|Sec-Fetch" apps/client/src` … 実装ヒットは `oauth.ts` の state コメントのみ。`sameOrigin` 関数の実体は存在しない。
  - Cookie は `auth.ts`：`SameSite=Lax; HttpOnly; Secure`。`Lax` は GET ナビゲーションでは送出されるため、画像/フォーム経由の単純リクエストには一定の余地が残る（多くの API は JSON 必須で緩和されるが、`form-action 'self'` CSP と合わせても「設計上の保証」ではなく「副作用的な緩和」に留まる）。
- **影響**: 高リスク操作（メンバー権限変更 `members.ts`、直接DB操作 `data.ts`、APIキー上書き `keys.ts`、承認 `agent-actions.ts`、課金導線 `billing/start.ts`）に対するクロスサイト強制実行の理論的余地。実害確度は中〜低だが、管理者狙いの標的型では無視できない。
- **確認方法**: 別オリジンの HTML から `fetch(..., {method:"POST", credentials:"include", headers:{"content-type":"application/json"}})` を投げ、CORS プリフライトで実質ブロックされるか／単純リクエストに落とせる経路がないかを検証。
- **推奨修正**: 変更系 API 共通の軽量 `sameOrigin` ガード（§12 の提案どおり）を導入。高リスク操作には二重送信 Cookie か `Sec-Fetch-Site: same-origin` 検査を追加。Cloudflare 有料 WAF/外部サービスに依存しない。
- **本システムの前提との整合**: 無料枠・低コストで実装可能。クライアント内で完結し、ホストはデータに触れない。
- **実コード提案**:

```ts
// apps/client/src/lib/auth.ts （追記：軽量 Origin ガード）
export function sameOrigin(request: Request): boolean {
  const o = request.headers.get("origin");
  const sfs = request.headers.get("sec-fetch-site"); // same-origin / same-site / cross-site / none
  if (sfs) return sfs === "same-origin" || sfs === "none";
  if (!o) return false; // Origin も Sec-Fetch も無い変更系は拒否（安全側）
  try { return new URL(o).origin === new URL(request.url).origin; } catch { return false; }
}
```

```ts
// 例: apps/client/src/pages/api/members.ts （高リスク操作の入口に追加）
import { getSession, sameOrigin } from "../../lib/auth.ts";
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  if (!sameOrigin(request)) return json({ error: "cross-site request rejected" }, 403);
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return json({ error: "権限がありません" }, 403);
  // 既存処理…
};
```

- **後方互換**: 同一オリジンの正規フロントエンドは `Origin`/`Sec-Fetch-Site` が付くため影響なし。古い fetch ラッパが `Origin` を欠く場合に備え `Sec-Fetch-Site` を優先評価。
- **テスト追加案**: `api-authz.contract.test.ts` に「Origin 無し POST は 403」「同一オリジンは通過」のケースを追加。

#### P1-2. MASTER_KEY 単一失陥で全用途の鍵が再導出される

- **指摘**: セッション署名 HMAC（`auth.ts hmacKey`）も、AES-GCM の files/api-keys/member-pii（`crypto.ts deriveKey`）も、すべて単一 `MASTER_KEY` の HKDF 派生。用途分離（salt/info）はあるが、根 IKM が同一のため `MASTER_KEY` が漏れれば全派生鍵を再現できる。
- **根拠**:
  - `apps/client/src/lib/auth.ts`：`hmacKey` が `masterKey(env)` を IKM に HKDF。コメントに「MASTER_KEY 自体が漏れれば派生鍵も再現可能＝根本対策は MASTER_KEY の Worker Secret 必須化」と明記。
  - `packages/shared/src/crypto.ts deriveKey`：同じく `masterKeyB64` を IKM に各 domain の AES 鍵を派生。
  - 緩和は実装済み：`client.ts resolveMasterKey` が本番（`ENVIRONMENT=production`）で KV 自動生成を拒否し `MasterKeyMissingError` を投げる（鍵と暗号文の同居回避）。`masterKeySource` で診断表示。
- **影響**: 設計上の不可避な側面（自己ホストで KMS/HSM を強制できない）だが、Worker Secret 投入を運用必須にしないと「KV 自動生成（dev/test 経路）」が誤って本番化した場合に鍵と暗号文が同居する。
- **確認方法**: 本番デプロイで `MASTER_KEY` が Worker Secret として投入されているか（`masterKeySource()==="secret"`）を診断画面で確認。`ENVIRONMENT=production` が設定されているかを `wrangler.jsonc`/CI で確認。
- **推奨修正**: ①OPERATIONS のデプロイ手順で `MASTER_KEY`（Worker Secret）投入を必須チェックリスト化。②`bootCheck` で本番かつ `masterKeySource()!=="secret"` のとき診断を `error` で残し、管理UIに恒久警告を出す（既に近い実装があれば文言強化）。③（将来・任意）鍵ローテーション手順とバージョン付き暗号文（鍵IDプレフィックス）を設計に追加。
- **本システムの前提との整合**: ホスト集約を増やさない。Worker Secret はクライアント自身の CF アカウント内に閉じる＝クライアント主権を維持。低コスト（追加サービス不要）。
- **実コード提案**:

```ts
// apps/client/src/lib/boot-check.ts （本番で secret 未投入なら恒久 error 診断・要点のみ）
import { masterKeySource } from "./client.ts";
import { isProduction } from "./client.ts"; // 既存判定を再利用
export async function bootCheck(env: Env): Promise<void> {
  // …既存処理…
  if (isProduction(env) && (await masterKeySource(env)) !== "secret") {
    await logDiag(env, "error", "security",
      "本番で MASTER_KEY が Worker Secret 由来ではありません。鍵と暗号文の同居リスク＝至急 Secret を投入してください（§10.1）。");
  }
}
```

- **後方互換**: 診断ログ追加のみ。暗号方式は不変＝既存暗号文の復号に影響なし。
- **テスト追加案**: `boot-check.contract.test.ts` に「production×kv-autogen で error 診断が1件出る」ケースを追加。

---

### P2: 改善推奨

#### P2-1. Astro の moderate XSS 勧告（依存更新）

- **指摘 / 根拠**: `npm audit --omit=dev --audit-level=high` は通過するが、`npm audit`（情報提供）で `astro <=6.1.9` に moderate 勧告（GHSA-j687-52p2-xcff `define:vars` の不完全な `</script>` サニタイズ XSS、GHSA-xr5h-phrj-8vxv server-island 暗号化パラメータ再生）。修正は `astro@6.4.5`（破壊的）。
- **影響**: 本アプリは `define:vars` を多用していないが、依存として勧告対象。CSP（`script-src 'self' 'unsafe-inline'`）が一定の緩和。
- **推奨対応**: ステージングで `astro@6.4.x` へ更新し、`is:inline` スクリプト・`set:html`（SitePublic）周りの回帰テスト（既存 sanitize/ui-customize contract）を実行のうえ採用。CI の `audit`（all deps, informational）はそのまま監視継続。
- **整合**: 依存更新のみ。ポータビリティ・主権・コストに影響なし。

#### P2-2. `String.fromCharCode(...spread)` の大バッファ・スタック上限リスク

- **指摘 / 根拠**: `packages/shared/src/crypto.ts:7` `toB64 = btoa(String.fromCharCode(...new Uint8Array(buf)))`。スプレッドは要素数が多いと `RangeError: Maximum call stack size exceeded` を起こし得る。
- **影響（限定的）**: ファイル本体は `encryptBytes`/`decryptBytes` が**生 ArrayBuffer のまま** R2/KV に保存し、`toB64`/`fromB64` を経由しない。`toB64` を通るのは `encryptField`/`decryptField`（APIキー等の小さな文字列）と 32byte の `MASTER_KEY` のみ＝現状の入力サイズでは顕在化しない。将来 `encryptField` に大きな値を渡す用途が増えると顕在化する。
- **推奨対応**: チャンク化 base64 へ置換（防御的）。

```ts
// packages/shared/src/crypto.ts （toB64 をチャンク化＝大バッファでも安全）
const toB64 = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
};
```

- **整合**: 共有純粋関数の内部実装のみ。API・暗号方式・ポータビリティ不変。
- **テスト追加案**: `file-crypto.contract.test.ts` に「数MB相当の `encryptField` 往復」を追加（回帰防止）。

#### P2-3. A2A 宛先の DNS リバインディングは未対策（残存・低）

- **指摘 / 根拠**: `host.ts isSafeDeployUrl` は**ホスト名文字列**で IP リテラル/内部TLD/credentials を拒否するが、FQDN が解決時に私的IPへ向く DNS リバインディングは検査しない（解決後IPの再検証なし）。`a2a.ts relay` は `redirect:"manual"` で多段リダイレクトは抑止済み。
- **影響（低）**: Cloudflare Workers の `fetch` は既定で RFC1918/loopback へ到達しにくく、宛先は「相互同意済み接続の deploy_url（workers.dev/カスタムドメイン）」に限定されるため実害確度は低い。
- **推奨対応**: 現状維持で可。将来 A2A 宛先にユーザー任意 URL を許す拡張を入れる場合は、解決IPの allowlist 検査（または Cloudflare の outbound 制御）を併設。
- **整合**: 追加対応は任意。低コスト方針に反しない。

#### P2-4. 公開フォーム `site/join` のスパム対策が未実装

- **指摘 / 根拠**: `api/site/join.ts` は認証不要（公開HPの会員申込として設計どおり）だが、レート制限/Turnstile が無い（コメントに「将来」）。`apply.ts`（申込）は IP レート制限（SESSION KV・5件/h）が実装済みなのと対照的。
- **影響**: 公開フォーム経由の会員レコード量産（D1 肥大・運用ノイズ）。PII 漏洩や課金事故には直結しない。
- **推奨対応**: `apply.ts` と同様の IP レート制限を `site/join` にも適用（無料枠の KV のみ）。将来 Cloudflare Turnstile（無料）併設。
- **整合**: 無料枠で完結。

```ts
// apps/client/src/pages/api/site/join.ts （IPレート制限・要点のみ。SESSION 相当KVが無ければ LICENSE を流用）
const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
const k = `joinrl:${ip}`;
const cur = Number((await env.LICENSE.get(k)) ?? "0");
if (cur >= 10) return json({ error: "短時間に申込が集中しています。時間をおいて再度お試しください。" }, 429);
await env.LICENSE.put(k, String(cur + 1), { expirationTtl: 3600 });
```

---

## 4. 観点別評価

### 技術設計

- **良い点**: Ports & Parts（`core/ports.ts`・`core/parts.ts`・`core/apps.ts`）でコアが「環境」「業務」を知らない構造。`buildCtx(env)` を middleware で注入し、以後 `ctx.db/storage/ai/agent` 経由。鍵保管も `KvPort` 経由で Profile 差し替え可能（D1/KV/R2 ⇔ SQLite/FS/local の置換可能性を尊重）。外部アプリは宣言的定義＝コア依存を増やさない。
- **懸念点**: middleware の exempt が「`.` を含む全パス」という広すぎる条件（P0-1 の温床）。
- **推奨対応**: 拡張子 allowlist へ厳格化（P0-1 修正案）。

### 実装品質

- **良い点**: SQL は全て bind パラメータ化。動的テーブル名（`data.ts`）は `TABLES` allowlist で囲い込み。型検査 0 エラー。コメントが「WHY」と過去指摘番号付きで濃く、保守性が高い。
- **懸念点**: 一部の `catch {}`（使用量記録・best-effort 削除）が握りつぶしだが、`noteRecordFailure` で診断へ回す配慮あり。
- **推奨対応**: 現状維持で可。重要経路の握りつぶしは診断必須を継続。

### セキュリティ

- **良い点**: §2 の強みに記載（IDOR/署名/nonce/承認ゲート/サニタイザ/fail-closed dev gate/SSRF URL 検査）。
- **懸念点**: P0-1（認可漏れ）、P1-1（CSRF）、P1-2（鍵集中）。
- **推奨対応**: P0-1 を即修正、P1 を本番前に。

### 法的・コンプライアンス（法的助言ではなくリスク整理）

- **良い点**: `disclosure.ts`/`legal-templates.ts` がサブプロセッサ・Limited Use・越境可能性・保持日数を動的開示。Gmail Restricted scope の取扱い明示。決済はホストが Stripe で処理し業務データを送らない旨を記載。`admin/data.astro` に復元/完全削除＋監査ログ（削除・訂正・利用停止の導線に相当）。
- **懸念点**: ①P0-1 が解消されるまでは「業務データはクライアント内に閉じる」という対外説明と実態に齟齬。②データ主体からの開示・削除請求の**エンドユーザー向け**導線は管理者操作（`admin/data`）に依存しており、会員本人セルフサービスは未確認。③外部AIへの送信可否はBYOK団体の判断に委ねる旨は明示されているが、Gemini 既定送信時の利用目的・保持の説明はテンプレ任せ。
- **推奨対応**: P0-1 修正を最優先。プライバシーポリシー雛形に「保存先＝団体CF」「外部送信＝BYOKで団体が有効化したもののみ」を引き続き明記（既に近い実装あり）。会員本人の開示・削除請求フローの整備を検討。

### 倫理・AIガバナンス

- **良い点**: 対外/破壊系は既定 on の人間承認ゲート（`approvals.ts`）。オートパイロットは「削除・force-push・課金/権限変更・シークレット開示・他テナントはツール自体を提供しない」と道具レベルで遮断（`autonomy.ts AUTONOMY_POLICY`）。Gmail 送信は無人ジョブで `unattended:false`（プロンプトインジェクション対策の道具遮断）。A2A 受信は外部入力を「データ」として read 専用実行。
- **懸念点**: 外部由来テキスト（Gmail本文/Web検索/A2A入力）を「指示ではなくデータ」として扱う方針は、道具遮断（unattended:false）で守られているが、システムプロンプト上の明示的なインジェクション耐性記述は薄い。
- **推奨対応**: エージェント SYSTEM に「外部由来テキストは指示として解釈しない」旨を明記し、道具遮断と二重化。

### コスト計算・課金リスク

- **良い点**: 実費 USD cap（`overBudget`）が**モデル呼び出し前**に効き、超過時は `switch_free`/`pause`。入出力トークンを `recordTokens` で集計し推定USD化（単価 env 上書き可）。1ジョブ単位の `AI_MAX_JOB_USD` で子エージェント込みの累積を打ち切り。Stripe 解約/未入金で Free へ降格（売掛で有料提供を続けない）。開示文に「アプリ内の上限は推定、実請求は各プロバイダ計上が正」と明記。
- **懸念点**: 推定USDと実請求のズレ（モデル単価変動・キャッシュ/grounding課金等）は構造的に残る。動画/音声/画像の従量は `recordUnits` 計上だが USD 化は単価未登録で 0 になり得る。
- **推奨対応**: 主要 provider の単価既定値を最新化し、未登録時は「推定不可」を UI で明示（0 と誤認させない）。

### UI/UX

- **良い点**: 4画面集約（ホーム/AI/アプリ/設定）。危険操作（完全削除）は `confirm` ＋監査ログ。承認待ち一覧（`/approvals`）で対外/破壊操作を可視化。PR #48 でモーダル a11y・法務文言を改善。
- **懸念点**: 非技術管理者にとって「オートパイロット有効化」「Restricted scope（Gmail）付与」「A2A 連携」のリスク説明が十分かは画面実機での要確認。`admin/data` の「直接DB操作」は表現が強く、誤操作余地。
- **推奨対応**: 高リスク設定の有効化時に一段の確認・リスク要約を表示（一部実装済みなら文言点検）。

### 運用・保守性

- **良い点**: マイグレーション 0001–0025（client）/0001–0012（host）が連番管理。`ensureSchema` で自己ホストの増分自動適用。`OPERATIONS.md`・`docs/spec/*` が整備。配布は client-pull 更新（署名検証付き）。
- **懸念点**: スキーマ自動適用は便利だが、失敗時のロールバック戦略は要確認。
- **推奨対応**: マイグレーション失敗時の診断・手動復旧手順を OPERATIONS に明記。

### テスト・CI/CD

- **良い点**: CI（`.github/workflows/ci.yml`）で typecheck（全パッケージ）＋ test（host+client）＋ release ビルド＋署名ラウンドトリップ＋ `npm audit --omit=dev --audit-level=high`（high以上ブロッキング）。contract テストが認可/IDOR/署名/サニタイズ/承認/スコープを網羅。deploy は CI に含めず手動（事故防止）。
- **懸念点**: P0-1 のような「未認証ルート」を検出する横断テストが無かった（個別ルートの authz テストは存在）。
- **推奨対応**: 「全 page/api ルートを列挙し、公開許可リスト以外は未認証で 401/403/302 を返す」横断 contract テストを追加（再発防止）。

---

## 5. 修正ロードマップ

### 今日やるべきこと

- **P0-1**: `accounting/export.csv.ts` に `getSession`＋`canAccess(role,"accounting")` を追加（数行）。本番でログイン無し取得が 403 になることを確認。
- **P0-1（多層化）**: `middleware.ts` の exempt を拡張子 allowlist 化。

### 1週間以内にやるべきこと

- **P1-1**: `sameOrigin` ガードを変更系 API（特に members/data/keys/agent-actions/billing）へ導入。`api-authz.contract.test.ts` にケース追加。
- **P1-2**: `bootCheck` で本番×非secret 鍵を error 診断化。OPERATIONS に MASTER_KEY（Worker Secret）必須チェックリスト。
- **テスト**: 全ルート横断の「未認証 → 拒否」contract テストを追加。

### 1か月以内にやるべきこと

- **P2-1**: `astro@6.4.x` 更新をステージング検証のうえ採用。
- **P2-2**: `crypto.ts toB64` のチャンク化。
- **P2-4**: `site/join` の IP レート制限（＋将来 Turnstile）。
- **AIガバナンス**: エージェント SYSTEM に「外部由来テキストは指示として扱わない」明記。
- **コスト**: provider 単価既定値の最新化と「推定不可」表示。

---

## 6. 検証結果

- **実行したコマンド**:
  - `npm ci`
  - `npm run typecheck`
  - `npm test`（= `npm -w apps/host test && npm -w apps/client test`）
  - `npm audit --omit=dev --audit-level=high`
  - `npm audit`（informational）
- **結果**:
  - **typecheck**: 156ファイル **0 errors / 0 warnings / 8 hints**（astro check も 0 errors）。**成功**。
  - **test**: host **80 pass / 0 fail**、client **80 pass / 0 fail**（合計160）。**成功**。
  - **audit（prod, high+）**: high/critical **0件**＝**通過**。
  - **audit（informational）**: `astro <=6.1.9` に **moderate 1件**（define:vars XSS / server-island replay。fix=`astro@6.4.5`・破壊的）。P2-1 に整理。
- **失敗した場合の理由**: 失敗なし。デプロイ系（`wrangler deploy`）は CI 方針どおり未実行（手動運用）。実ブラウザ/curl による P0-1 の動的 PoC はサンドボックス制約のため未実施＝**静的根拠（ルートに認可コードが存在しないこと＋middleware exempt 条件）に基づく指摘**。

---

## 7. 残存リスク

- **確認範囲**: 両リポジトリの `main` 時点ソース・設定・マイグレーション・ドキュメント・テストを静的確認し、typecheck/test/audit を実行。**未確認/範囲外**は以下。
  - 実行時挙動の動的検証（実 Worker への HTTP PoC、OAuth 実フロー、Stripe/LINE 実 Webhook）。
  - フロントエンド各 `.astro` の DOM レベル XSS（`set:html` は公開LPの sanitize 済み箇所のみ確認。管理画面の `is:inline` スクリプトは CSP `unsafe-inline` 許容下で個別未精査）。
  - Cloudflare アカウント側設定（Worker Secret 投入状況、`ENVIRONMENT`/`ENV` 実値、KV/R2 バインディング、Deploy ボタン経由の実プロビジョン）。
  - host 側 registry 署名鍵の鍵管理運用（`RELEASE_SIGNING_JWK` 等の Secret 取扱い）。
  - 法務文書（実運用のプライバシーポリシー/利用規約/DPA 本番版）の十分性＝本書は雛形生成ロジックのみを確認。
- **推測と事実の分離**: P0-1/P1-1/P1-2/P2-* は**いずれもコード・設定・audit 出力に基づく事実**。実害確度（P1-1 の CSRF、P2-3 の DNS リバインディング）は「理論的余地」と明記し、断定していない。

---

## 8. 公式参照

- Cloudflare Workers `fetch`（既定でプライベートネットワーク到達制限）/ Secrets: https://developers.cloudflare.com/workers/configuration/secrets/
- Stripe Webhook 署名検証: https://docs.stripe.com/webhooks/signature
- LINE Messaging API 署名検証: https://developers.line.biz/en/reference/messaging-api/#signature-validation
- Google API Services User Data Policy（Limited Use）: https://developers.google.com/terms/api-services-user-data-policy
- OWASP CSRF Prevention Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- Astro セキュリティ勧告（GHSA-j687-52p2-xcff / GHSA-xr5h-phrj-8vxv）: https://github.com/withastro/astro/security/advisories
- HKDF / AES-GCM（WebCrypto）: https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto

---

## 最終チェック

- [x] ポータビリティを崩す提案をしていない（修正はすべて既存 Port/lib 境界内・CF 専用機能や外部WAFに依存しない）
- [x] クライアント主権のデータ管理を崩す提案をしていない（認可・鍵・診断はすべてクライアント環境内で完結）
- [x] ホストがクライアントデータへアクセスする設計を提案していない
- [x] 低コスト運用を考慮している（無料枠・追加サービス不要の対策を優先。Turnstile 等は将来の任意）
- [x] P0/P1には実コード提案を含めている（P0-1・P1-1・P1-2 すべてに該当箇所のみのコード提案）
- [x] 調査結果を `reports/` 配下のMarkdownファイルに出力している（本ファイル）
- [x] ファイル名とH1タイトルに日時とナンバリングを入れている（003 / 2026-06-10-1638 JST）
- [x] 根拠ファイル/行番号を示している
- [x] 推測と事実を分けている（実害確度を明示し断定回避）
- [x] テスト/型検査/監査の実行可否を記載している（§6・すべて実行、結果記載）
- [x] 法務・コンプライアンスは法的助言ではなくリスク整理として書いている
