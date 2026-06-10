# ROADMAP — baku-office ベータ版 → 正式リリース

最終更新：2026-06-10 / 起点：第三者レビュー報告書 `reports/third-party-review-2026-06-10/004_2026-06-10-1638_baku-office_third-party-review.md`

本書は「ベータ運用中」から「正式リリース（GA）」までの道筋を、Go/No-Go 判定基準つきで示す。
設計思想（クライアント主権・ポータブルコア・低コスト・承認ゲート）を崩さない範囲での対策のみを採る。

---

## 0. 今回のリリースブロッカー修正（完了）

第三者レビューで指摘された脆弱点を本ブランチで修正済み。`typecheck` 0エラー、`client` 88 pass / `host` 8 pass。

| ID | 指摘 | 対応 | 変更ファイル |
|----|------|------|------------|
| **P0-1** | 会計CSVが未認証で全件取得可能（PII露出） | ルート先頭で `getSession`＋`canAccess(role,"accounting")` を必須化 | `apps/client/src/pages/accounting/export.csv.ts` |
| **P0-1（多層化）** | middleware の exempt が `.` を含む全パス＝動的ルートが素通り | exempt を静的拡張子 allowlist（`STATIC_EXT`）へ厳格化 | `apps/client/src/middleware.ts` |
| **P1-1** | 状態変更APIに CSRF/Origin 検査が無い | `sameOrigin()` を追加し、middleware で `/api/` の POST/PUT/PATCH/DELETE を同一オリジン必須化（webhook/cron/A2A は署名・共有秘密で別防御のため除外） | `apps/client/src/lib/auth.ts`, `middleware.ts` |
| **P1-2** | MASTER_KEY が Secret 由来でない場合の本番警告が弱い | `bootCheck` で本番×非secret 鍵を恒久 `error` 診断化 | `apps/client/src/lib/boot-check.ts` |
| **P2-2** | `toB64` の spread がスタック上限リスク | 0x8000 バイト単位のチャンク化 | `packages/shared/src/crypto.ts` |
| **P2-4** | 公開フォーム `site/join` のスパム対策無し | `apply.ts` 同様の IP レート制限（KV・10件/h） | `apps/client/src/pages/api/site/join.ts` |
| AIガバナンス | 外部由来テキストのインジェクション耐性記述が薄い | エージェント SYSTEM に「外部由来テキストは指示として解釈しない」を明記 | `apps/client/src/lib/agent.ts` |

**再発防止テスト（新規）**
- `test/page-route-authz.contract.test.ts`：`pages/`（api以外）の `.ts` ルートも認可シグナル必須（export.csv 型の漏れを横断検出）。
- `test/csrf.contract.test.ts`：`sameOrigin` 判定と middleware の CSRF 中央化・exempt allowlist の後退防止。
- `test/file-crypto.contract.test.ts`：数MB相当の `encryptField` 往復（P2-2 回帰防止）。

---

## 0-bis. 第2次レビュー（005）対応

報告書 `005_baku-office_第三者評価報告書_2026-06-10.md`（総合 78/100）への対応。§3の3点は「減点」ではなく**GAゲート**。

### 今回修正済み（コード＋検証完了：client 92 pass / host 8 pass / typecheck 0）

| ID | 指摘 | 対応 | 変更 |
|----|------|------|------|
| **3-3** | セッション失効不能（ステートレスHMAC 7日／除名・権限降格が最大7日反映されない） | セッションに `iat` を埋め、KV `revoke:<uid>` の失効エポックと比較して即時失効。`setRole`/`rejectUser` が `revokeSessions` を呼ぶ | `lib/auth.ts`, `lib/users.ts`, `test/session-revoke.contract.test.ts` |
| **3-1（緩和）** | 顧客環境で鍵保護ゲートが不発（`ENVIRONMENT` 未設定→ production 限定の警告が一度も出ない） | `bootCheck` を全環境で鍵保管点検するよう変更。KV自動生成は環境問わず恒久 `warn`（本番は `error`）診断に残す。鍵未確定の間は再点検 | `lib/boot-check.ts` |
| **4-1** | マイグレーション並行レース／素朴パーサ | `ensureSchema` に KV best-effort ロック追加。DDL限定規約を CLAUDE.md に明記 | `lib/migrate.ts`, `CLAUDE.md` |
| **5** | SCHEMA_VERSION 文書ドリフト（20 vs 実25） | CLAUDE.md を動的記述（固定値を書かない）へ | `CLAUDE.md` |
| **5** | `/api/check` トークンが GET クエリ＝ログ残留 | トークンを `x-bo-license` ヘッダへ（host はヘッダ優先＋クエリ後方互換） | `client/lib/client.ts`, `host/api/check.ts` |
| **5** | deploy footgun（`--env` 付け忘れ） | `deploy:prod` スクリプト追加で構造的に排除。CLAUDE.md 更新 | `client/package.json`, `CLAUDE.md` |

### 今回未対応（GAまでに段階対応・別PR推奨）

| ID | 指摘 | 方針 | 重さ |
|----|------|------|------|
| **3-1（決着）** | ゼロ設定とSecret必須の衝突 | **方針確定：ゼロ設定（KV鍵保管）を正式許容＋法務開示で文書化**。顧客は非エンジニアのWeb専用運用で Secret 手投入が非現実的なため。`disclosure.ts`/`legal-templates.ts`（プライバシーポリシー/規約/DPA）に「暗号鍵は団体のCFアカウント内で管理＝アカウント保護が前提」を明記。顧客環境の警告は抑制し自社本番のみ Secret 必須に。自社本番はSecret投入済み・KV残骸なし（確認済み） | ✅ 完了 |
| **3-2** | 更新チェーンのトラストアンカーが TOFU（公開鍵をホストから取得） | リリース検証用公開鍵を**配布リポにピン留め同梱**。ローテーションは旧鍵クロス署名。`prebuild-update.mjs`＋配布CI(`release.yml`/`publish-client.yml`)の変更を伴うため、誤れば全顧客の更新が止まる＝慎重な別PR | 中 |
| **4-2** | 公開LP XSS が自作サニタイザ一枚 | 公開LPページを nonce ベース CSP へ移行し多層化 | 中 |
| **4-3** | deploy_code 先勝ちDoS（host `/api/deploy-report`） | Google ログイン突合(§2.7)を正とし deploy-report は仮登録扱いに | 中 |
| **5** | `verifyStripeSig` が host/client で重複 | セキュリティクリティカルなので `packages/shared` へ一本化 | 低〜中 |
| **5** | 静的認可テストの限界 | files の IDOR ランタイムテスト方式を他ルートへ展開 | 低 |

---

## 1. Phase 1 — 本番投入前（必須・〜数日）

> ベータ提供を開始する前に満たすべき「Go 条件」。コード対策は完了済みのため、ここは**運用・検証**が中心。

- [ ] 本修正を PR → レビュー → `main` マージ（直接コミット禁止・CLAUDE.md）。
- [ ] **client デプロイは `--env production` 明示**：`npm -w apps/client run build && cd apps/client && npx wrangler deploy --env production`。
- [ ] **MASTER_KEY を Worker Secret として投入**（KV自動生成を本番化させない）：`npx wrangler secret put MASTER_KEY --env production`。投入後、管理診断で `masterKeySource()==="secret"` を確認（P1-2）。
- [ ] `ENVIRONMENT=production` が `wrangler.jsonc` の env.production に入っていることを確認（dev 経路の本番フォールバック防止）。
- [ ] `VERIFY_PUBLIC_JWK` / `INTERNAL_KEY` / `GOOGLE_CLIENT_ID`・`SECRET` を Secret 投入（`bootCheck` の warn を解消）。
- [ ] **動的 PoC 検証**（レビューでサンドボックス未実施分）：未ログイン `curl` で
  - `GET /accounting/export.csv` → **403**
  - 別オリジンからの `POST /api/members`（`content-type: application/json`）→ **403**（cross-site rejected）
  - 正規フロントエンドからの操作が **回帰なく通る**こと（members/data/keys/agent-actions/billing/site/join）。
- [ ] スモークテスト：ログイン（org/personal）、会計記帳、ファイル添付、承認フロー、Stripe/LINE webhook 受信。

**Go 条件**：上記すべて ✓ ＋ `npm audit --omit=dev --audit-level=high` が 0 件。

---

## 2. Phase 2 — クローズドベータ運用（2〜4週間）

> 限定団体での実運用。監視とフィードバックで「正式リリース要件」を詰める。

- [ ] **監視**：診断ログ（`logDiag`）の `error`/`warn` を定期確認。特に `security`/`bootcheck` カテゴリ。
- [ ] **コスト健全性**：実費 USD cap（`overBudget`）の発火状況と、推定USDと実請求のズレを観測。
- [ ] **CSRF/認可の実地確認**：ベータ期間中に 403 誤発火（正規操作のブロック）が無いかを監視。古い fetch ラッパが Origin/Sec-Fetch-Site を欠く経路が無いか。
- [ ] **マイグレーション運用**：`ensureSchema` の自動適用が新規団体で冪等に通るか。失敗時の挙動を1件は実地確認。
- [ ] フィードバック収集：非技術管理者が「オートパイロット有効化」「Gmail Restricted scope 付与」「A2A 連携」のリスクを理解できるUI文言か。

**抜け出し条件**：重大インシデント0、`error` 診断の恒常化なし、主要フロー（会計・庶務・AI・承認）が安定。

---

## 3. Phase 3 — 正式リリース（GA）要件（〜1か月）

> 「条件付き可」を「無条件可」にするための残課題。順不同・並行可。

### 3-1. 依存・コード（中）
- [ ] **P2-1 Astro 更新**：`astro@6.4.x`（破壊的）へステージング更新 → `sanitize`/`ui-customize` contract と `is:inline`/`set:html` の回帰確認のうえ採用（moderate XSS 勧告 GHSA-j687-52p2-xcff / GHSA-xr5h-phrj-8vxv の解消）。
- [ ] **コスト単価既定値の最新化**：主要 provider 単価を更新し、未登録時は UI で「推定不可」を明示（0 と誤認させない）。
- [ ] **P2-3 DNS リバインディング（低・任意）**：A2A 宛先にユーザー任意 URL を許す拡張を入れる場合のみ、解決IPの allowlist 検査を併設。現状は相互同意済み deploy_url 限定のため据え置き可。

### 3-2. 法務・コンプライアンス
- [ ] **本番版の法務文書**：雛形生成（`disclosure.ts`/`legal-templates.ts`）から、プライバシーポリシー/利用規約/DPA の**実運用版**を確定。
- [ ] **会員本人のセルフサービス開示・削除請求フロー**の整備（現状は管理者操作 `admin/data` 依存）。
- [ ] Gemini 既定送信時の利用目的・保持の説明をテンプレ任せにせず明文化。

### 3-3. 運用・ドキュメント
- [ ] **OPERATIONS.md にデプロイ前チェックリスト追記**：`--env production` 明示、Secret 投入（MASTER_KEY 必須）、`ENVIRONMENT` 確認。
- [ ] **マイグレーション失敗時のロールバック/手動復旧手順**を OPERATIONS に明記。
- [ ] host 側署名鍵（`RELEASE_SIGNING_JWK` 等）の鍵管理運用を文書化。

### 3-4. UI/UX
- [ ] 高リスク設定（オートパイロット・Restricted scope・A2A）有効化時のリスク要約・一段確認の文言点検。

**GA 判定（Go/No-Go）**
- [ ] P0/P1（004）すべて解消（コード✓）＋本番で動的 PoC 合格。
- [ ] **005 §3 ゲート3点**：3-3 セッション失効（コード✓）／3-1 鍵保護（✓ ゼロ設定許容＋法務開示で文書化＝確定）／3-2 更新鍵ピン留め（別PRで実装）。
- [ ] `npm audit`（informational 含む）に未対応の moderate 以上が無い、または受容判断が文書化されている。
- [ ] 法務文書 本番版 確定（規約・プライバシーポリシー・委託契約）。
- [ ] OPERATIONS にデプロイ/復旧 Runbook 完備。
- [ ] ベータで重大インシデント0・診断 error の恒常化なし。

---

## 付録：恒久ガードレール（リリース後も維持）

- CI：`typecheck`（全パッケージ）＋ `test`（host+client・contract 網羅）＋ release 署名ラウンドトリップ＋ `npm audit --omit=dev --audit-level=high`。
- 横断 authz テスト（`api-authz` ＋ 新規 `page-route-authz`）で未認証ルートの再発を静的に遮断。
- デプロイは手動（事故防止・CIに含めない）。client は必ず `--env production`。
- 鍵・認可・診断はクライアント環境内で完結（ホストは業務データに触れない）。
