# baku-office 操作フロー（ホスト側／クライアント側）

本書は実装済みシステムの**操作手順**をまとめたもの。設計の根拠は `integrated_design_package_v1.0.md`、技術構成は `ARCHITECTURE.md` を参照。

- **ホスト（当社・株式会社貘）**：申込受付・ライセンス発行・配信・通知・課金。`baku-office-portal`。
- **クライアント（利用団体）**：自分のCloudflareでアプリを自己ホストし、会計・庶務に利用。`baku-office-app`。
- 表記：🟢=通常運用 ／ 🧪=dev（API未設定時の代替動作）。

---

## 全体の流れ（俯瞰）

```
[ホスト] 申込受付 → ライセンス発行 → 個別Deployリンク送付
                                   │
[クライアント] Deployボタンで自分のCFへ展開 → 初回起動で自動アクティベート
                                   │
        無料(Free)で利用開始 → 連携設定(Gemini/LINE/Claude) → 必要ならPlus/Proへ課金
                                   │
        会計・名簿・ファイル・議事録・LINEエージェント・高度なオプション
[ホスト] クライアント管理で稼働監視 / お知らせ配信 / 入金確認(課金)
```

---

## クライアントの3つの流れ（明確化）

### 流れ① 申込 → 開始（オンボーディング）

| # | 主体 | 操作 |
| --- | --- | --- |
| 1 | クライアント | `/apply`（申込専用Worker）で団体名・連絡先を入力→送信（**プラン選択はなし＝全員 Free で開始**・IPレート制限あり）。 |
| 2 | ホスト（自動） | customers/licenses を作成（**`plan=free`・`status=active`**・`deploy_code`=nonce）。GitHub連携時は**団体ごとの throwaway 公開リポ**を生成し `report.json`（licenseId/deployCode/host URL）を焼き込み。失敗時は共有リポにフォールバック。 |
| 3 | ホスト（自動） | **Deploy to Cloudflare リンク**（`deploy.workers.cloudflare.com/?url=<repo>`）を返す。 |
| 4 | クライアント | Deployボタンで**自分のCFアカウント**へ展開（D1/KV/Worker は顧客保有）。以後 push で自動再ビルド。 |
| 5 | クライアント | 初回起動でライセンス未保持を検知→当社アクティベート画面へ。**申込時と同じGoogleアカウント**でログイン。 |
| 6 | ホスト⇄クライアント（自動） | ホストが Ed25519 **署名relay**（`{sub,email,name,exp}`）を返却→クライアントが公開鍵で検証→`activate-by-email` が署名を**再検証**しライセンストークン発行→KV保存＋`deploy_url`記録。**認証キーの手入力は不要**。 |
| 7 | クライアント | 初回ログイン者＝**組織最上位管理者**として束縛。会計/名簿/ファイル等を **Free で利用開始**。連携設定で Gemini/LINE/Claude キーを登録。 |
| 8 | クライアント | **アップグレードは導入後に管理画面で**：`/billing` から Plus/Pro を選び Stripe Checkout。カード=即時昇格、振込/コンビニ=入金確認(Webhook署名検証)で昇格。入金前は free 相当（プロビジョナル）。 |

→ 詳細手順は [A. ホスト側](#a-ホスト側の操作)／[B. クライアント側](#b-クライアント側の操作)、配備の内部仕様は [baku-office_deploy-update_spec.md](baku-office_deploy-update_spec.md)。

### 流れ② UI変更（共通ベース＋上書き・3層）

| 層 | 変えるもの | 誰が・いつ | どこで |
| --- | --- | --- | --- |
| 第1層 テーマ | ブランド名・ロゴ・配色 | 管理者・実行時（コード不要） | 高度なオプション →「見た目（テーマ）」（`ui_theme`） |
| 第2層 構成 | ナビ表示/ラベル/並び・**有効パーツ** | 管理者・実行時（コード不要） | 高度なオプション →「ナビ表示」「有効パーツ」（`nav_overrides`/`enabled_parts`）。無効パーツは画面・道具ごと消える |
| 第3層 画面・部品 | 画面の差し替え・部分注入 | 開発/納品・配布時 | 配布バンドルに `src/overrides/<slot>.astro`（部分＝Slot注入）／`src/pages/<page>.astro`（全面置換）を同梱→デプロイ |

- 判断指針：まず**第1・2層（管理画面の設定）**で足りるか → 足りなければ**第3層（追加ファイル）**。ベース（共通画面）は未編集のままなので上流更新を取り込んでも上書きは保たれる。

### 流れ③ パーツ（＝再利用可能アプリ）の開発・納品

> **パーツ＝アプリ**。`Part` は `id`/`name`/`version` を持つ再利用可能な業務アプリで、次の3性質を満たす：
> - **再利用**：特定団体専用ではなく、**複数団体で共有**できる（各団体は「有効パーツ」で ON/OFF）。
> - **更新の波及**：アプリ更新（`version` 上げ）をコア正本に入れると、**CI配布→導入している全団体に波及**（upstream同期＋自動マイグレーション）。
> - **派生**：既存アプリをコピーし `id` を変えて改変＝**新アプリ**（`derivedFrom` に派生元を記録）。元アプリの更新とは独立。

**開発（開発者）**

1. **設計**：機能を Part 単位に分解（道具 `agentTools`／ナビ `menu`／データ操作）。コアは編集しない。
2. **実装**：`src/parts/<id>.ts` に `Part` を定義。データは必ず **`ctx.db`（SqlStore）経由**＝CF/Node 両対応。認可は `requiredRole`。画面が要れば `src/pages/<id>.astro`。
3. **登録**：`src/parts/index.ts` に `registerPart(<id>Part)` を**1行追加**（コア未編集）。
4. **スキーマ**：新テーブルは `apps/client/migrations/NNNN_*.sql` を追記（前進・追加のみ・冪等／初回リクエストで自動適用）。id は衝突回避で命名。
5. **テスト**：`apps/client/test/<id>.contract.test.ts` に **Node+SQLite 契約テスト**を追加（道具/データが CF非依存で動くこと）。`npm -w apps/client run test`。

**納品（配布）**

- **標準（全顧客共通）**：コア正本（`apps/client`）にマージ → CI が配布バンドルを公開 → 顧客は upstream 同期/再Deploy で受領 → **自動マイグレーション**。各顧客は「有効パーツ」で ON/OFF。
- **個別（特定団体のみ）**：当該団体の配布バンドル（throwaway リポ）にそのパーツ＋必要画面/override を**追加同梱**して納品。コア本体は触らないため共通更新と両立。
- **検収**：`npm -w apps/client run typecheck` / `test` / `build` を通す。プラン・ロールゲートと有効パーツ設定の反映を確認。

→ 開発の設計指針は [ARCHITECTURE.md](ARCHITECTURE.md)／[baku-office_portable-core_architecture.md](baku-office_portable-core_architecture.md)。

---

## A. ホスト側の操作

### A-0. 初期セットアップ（最初の一度）
1. ホストポータルをデプロイ：`apps/host` を当社CFアカウントへ。
   - `npm -w apps/host run deploy`（`astro build && wrangler deploy`）。
2. シークレット登録（`wrangler secret put -c apps/host/wrangler.jsonc`）：
   - `SIGNING_JWK`（ライセンス署名鍵・Ed25519。将来KMS）
   - `ADMIN_KEY`（API保護・任意）
   - 🟢 `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`（スタッフGoogleログイン）
   - 🟢 `HOST_ADMIN_EMAILS`（管理者のGoogleメール・カンマ区切り）
   - 🟢 課金：`STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PRICE_Y` / `STRIPE_PRICE_Z`
3. D1 作成＋スキーマ適用：`wrangler d1 execute baku-office-portal-db --remote --file apps/host/migrations/0001_host.sql`。
4. クライアント配布鍵：ホストの署名鍵に対応する**公開検証鍵**を取得し、クライアント側に渡す（`GET /admin/pubkey`）。

### A-1. スタッフログイン
- `/login` → 🟢「Googleでログイン」（`HOST_ADMIN_EMAILS` の管理者のみ操作可）／🧪「管理者としてログイン（dev）」。
- 以降 `/clients`・`/notices` は管理者のみ。

### A-2. 団体の申込受付 → ライセンス発行
1. `/apply` で団体情報（団体名・代表者・連絡先）とプラン（Free/Plus/Pro・旧 X/Y/Z）を入力 →「申し込む」。
2. **Free** はその場でライセンス即発行（無料）。**Plus/Pro** は入金確認まで free 相当（プロビジョナル）。
3. 画面に出る**初期アクティベーションURL**（`…/activate?license_id=…`）を団体へ送付。
   - ※ クライアントの**個別Deployリンク**もあわせて案内（§C-1）。

### A-3. クライアント管理（監視）
- `/clients`：団体一覧（団体名・プラン・エンタイトルメント・稼働バージョン・最終受信）。
- 各クライアントは統合チェック（`/api/check`）で自動的に最終受信/バージョンを更新。

### A-4. お知らせ配信
- `/notices` で info／important／critical を発行・停止。
- クライアントは統合チェックで受信し表示（critical は確認モーダル）。

### A-5. 課金・入金確認
- 🟢 Stripe 接続時：カード=即時、振込/コンビニ=入金確認(Webhook `/api/billing/webhook`)でエンタイトルメント昇格。
- 🧪 Stripe 未接続時：クライアントの課金画面の「デモで支払った」操作（`/api/billing/dev-confirm`）で昇格をシミュレート。
- 解約/未入金は期末に無料(X)へ復帰（データはロック/削除しない）。

### A-6. バージョン更新の配布
- `apps/client` を更新して main へ push → **CI（`publish-client.yml`）が公開配布リポ `baku-office-app` を自動更新**。
  - 事前に private リポへ `PUBLISH_TOKEN`（配布リポ書込PAT）を登録。
- 顧客はフォーク同期で受領（§C-7）。DBスキーマは顧客側で自動適用（§C補足）。

---

## B. ホスト側：テナント別配信（多数顧客・別アカウント運用）

別アカウントの顧客を多数捌く場合（`scripts/admin.mjs` をホストWorkerに対して実行）：
1. `node scripts/admin.mjs pubkey` … 顧客へ渡す公開検証鍵。
2. `node scripts/admin.mjs tenant <id> <顧客クライアントURL> <provisionKey>` … 台帳登録。
3. `node scripts/admin.mjs config v1 <id>` / `lease 30 <id>` … 署名→顧客の `/provision` へ配信。
   - もしくは `setup-tenant.sh <id> <url>` で一括（台帳登録＋初期配信＋顧客へ渡す3値出力）。
- 顧客は受け取った `VERIFY_PUBLIC_JWK`／`PROVISION_KEY`／`TENANT_ID` を自分のWorkerに登録。
- ※同一CFアカウント内は Service Binding、別アカウントはカスタムドメインURLで配信（workers.dev同士の直fetchはCFが遮断＝1042）。

---

## C. クライアント側の操作

### C-1. 配備（Deploy to Cloudflare）
1. 団体専用Googleアカウントを用意（引継ぎ容易）。
2. 当社の**個別Deployリンク**（公開配布リポ `baku-office-app` 対象）を開く → Cloudflareに Google でサインイン。
3. Cloudflareが**自分のGitHubへ複製**し、**D1/KVを自動作成**してデプロイ（単一Worker）。
   - 🧪 開発検証は `npm -w apps/client run deploy`（当社アカウントへ）でも可。

### C-2. 初回アクティベーション（認証キー入力なし）
- デプロイ後に初めてアプリを開くと、ライセンス未保持を検知し**自動でアクティベーション**へ。
- 🟢 申込時と同じGoogleで認証 → 署名済みライセンストークンを取得・保存（§4）。
- 🧪 dev：案内された `…/activate?license_id=…` を開くと取得。
- 以後 `/` ホームでプラン状態・残高サマリー・お知らせを表示。

### C-3. ログイン（組織／個人）
- `/login`：
  - **組織（管理者）**：🟢 Googleでログイン（最上位）／🧪 dev管理者。
  - **個人（メンバー）**：🟢 LINE/Discordログイン／🧪 ID・パスワード。招待が必要（§C-5）。

### C-4. 連携設定（APIキー）— `/settings/keys`
- Gemini（AI/無料スタック）、LINE（チャネルシークレット＋アクセストークン）、Claude（上位・任意）を入力。
- 保存時に**検証→暗号化保存**（CFダッシュボード不要）。結果はトーストで表示。
- LINEエージェント利用時：表示される **Webhook URL（`…/api/line/webhook`）** を LINE Messaging API に設定。

### C-5. 人・ロール管理（招待＋承認）— `/settings/members`（管理者）
1.「招待コードを発行」（ロール指定・1週間/1回）→ `/join?code=…` を本人へ。
2. 本人が `/join` で氏名・役職・ログイン情報を登録 → **承認待ち(pending)**。
3. 管理者が一覧から**承認**→active（却下/無効化も可）。ロールは行で変更。
- ロール：admin（全権）／accounting（経理）／clerical（庶務）／other（個別）／member（個人のみ）。

### C-6. 日常業務
- **会計** `/accounting`：入出金登録（収入/支出/振替）、出納帳（累計残高）、収支計算書、予実、CSV出力。
- **名簿**：人・ロール管理（PIIは暗号化保存・表示時復号）。
- **ファイル** `/files`：アップロード/一覧/DL/削除（標準=KV・既定25MB／高度=R2）。
- **予定** `/schedule`・**議事録** `/minutes`：作成・一覧。
- **共有承認** `/review`（会計/庶務/管理者）：個人→組織の共有を承認（領収書は会計取引ドラフトを自動生成）／却下。
- **個人** `/personal`（個人ログイン時）：領収書・メモ・タスク・予定を記録→「組織へ共有」で申請。

### C-7. LINEエージェント（Proプラン）
- Pro＋LINEキー設定時、LINE公式アカウントに話しかけると応答（要 entitlement=pro）。**発話者は登録済み active 会員に限定**（非会員は案内のみ・名簿照会は admin/会計/庶務のみ）。
- できること：会話、支出/領収書の記録、メモ、リマインダー、ナレッジ保存/検索、メンバー検索、（Geminiキー）web検索・音声文字起こし・大PDF要約、（Claudeキー）資料生成/スキル実行、（任意API）画像/音声/動画生成。道具は各パーツが提供（有効パーツのみ）。
- **オフライン運用（任意）**：外部キーを使わず `LOCAL_AI_BASE_URL`（OpenAI互換のローカルLLM）を設定すると、外部送信ゼロでエージェントが動く（Profile C）。
- 画像/ファイル/音声を送ると自動で OCR/要約/文字起こし。重い処理が無料枠制限に達した場合は **Workers Paid 案内**を返信。

### C-8. プラン・課金 — `/billing`（管理者）
- 現プラン表示。アップグレード（Free→Plus→Pro）。
- 🟢 Stripe決済へ遷移／🧪「【デモ】支払った」で昇格。入金確認でエンタイトルメントが上がり機能解放。

### C-9. 高度なオプション — `/settings/advanced`（管理者・従量課金系＋カスタマイズを集約）
- **見た目（テーマ）**：ブランド名・ロゴ・配色を団体ごとに上書き（共通画面はそのまま）。
- **ナビ表示**：メニューに出す機能を選択（表示/非表示）。
- **有効パーツ**：使う業務機能（会計/メモ/リマインダー/ナレッジ/名簿…）を選択。
- **ストレージ上限**：標準モードの1ファイル上限（1〜25MB）。
- **任意API**：画像生成/音声合成/動画生成/embed/カスタムをBYOKで追加→**管理者がレビューして有効化**→AI/エージェントが参照・実行。
- **Agent Skills**：SKILL.md を登録（instruction/code）→有効化→「〇〇スキルで…」で実行（要Claude）。
- **Workers Paid 案内**：無料枠の制限に当たる場合の有料プラン切替手順。

### C-10. 診断・サポート — `/diagnostics`
- エラーログ閲覧。CF無料枠の制限を検知すると**ホームにバナー＋Workers Paid 案内**。

### C補足. 更新の受け取り
- 当社が新バージョンを公開 → **自分の複製を upstream 同期**（Workers Builds が自動再デプロイ）。
- **DBスキーマは初回リクエストで自動適用**（手作業不要・既存データは保持）。
- カスタム（スキル/任意API/設定）は顧客データとして残り、共通更新で**上書きされない**。

---

## クイックリファレンス

| 役割 | URL（例） | 主な操作 |
| --- | --- | --- |
| ホスト | `/login` `/apply` `/clients` `/notices` | スタッフログイン・申込・監視・配信 |
| ホストAPI | `/api/apply` `/api/activate` `/api/token` `/api/check` `/api/billing/*` `/api/notices` | 発行・アクティベート・統合チェック・課金・通知 |
| クライアント | `/` `/accounting` `/files` `/schedule` `/minutes` `/review` `/personal` `/billing` `/settings/keys` `/settings/advanced` `/diagnostics` | 日常業務・設定 |
| クライアントAPI | `/api/line/webhook` `/api/cron/drain` `/provision` | エージェント・リマインダー/ジョブ処理・配信受信 |

- 外部スケジューラ（cron-job.org等）→ `POST /api/cron/drain`（`x-internal-key: INTERNAL_KEY`・`content-type: application/json`）でリマインダー配信・要約/動画ジョブを進行。
