# baku-office セットアップ・運用ガイド

LINE上で動くClaudeエージェント（会話・履歴・モデル自動切替・Web検索・メモ/タスク・画像/書類保存・リマインダー・署名config/ライセンス）の立ち上げと運用手順。

> ℹ️ **命名について**：本ガイド/スクリプト/テンプレートは新名 **baku-office**（client=`baku-office`／host=`baku-office-host`／D1=`baku-office-db`）で記述。**現在テスト稼働中のインスタンスは旧名 `cf-line-agent-e2e`/`cf-line-agent-host`/`cf-line-agent-db`**（移行前）で、稼働中の `wrangler.client.toml`/`wrangler.host.toml` はその旧名のまま。新規セットアップは baku-office 名で作成される。

---

## 1. これは何ができるか

| 機能 | 内容 |
|---|---|
| 会話 | LINE → 署名検証 → Claude(Sonnet) → 返信。会話履歴あり（KV・直近5往復） |
| モデル自動切替 | 難易度をHaikuが分類し simple=Haiku / normal=Sonnet / hard=Opus |
| Web検索 | Anthropic公式 web_search（必要時のみ） |
| メモ・タスク | 「〜メモして」「#3削除」「検索して」「完了にして」を会話の文脈で実行（D1） |
| 画像・書類 | 送信で保存（R2）、「画像見せて」「書類出して」で呼び出し |
| リマインダー | 「明日9時に〜リマインド」→ Cron巡回でLINE Push通知 |
| 人格切替/停止 | 署名config（人格v1/v2）＋ライセンス（paid_through）で制御 |

固定コマンドは不要で、すべて自然な会話からClaudeがツールで判断します。

---

## 2. 前提アカウント（自分で用意・手動）

| 必要なもの | 取得先 | 備考 |
|---|---|---|
| Cloudflare アカウント | dash.cloudflare.com | **R2有効化にカード登録が必要** |
| LINE公式アカウント＋Messaging APIチャネル | LINE Official Account Manager → Messaging API有効化 → LINE Developers Console | チャネルシークレット／アクセストークン |
| Anthropic APIキー | console.anthropic.com | 従量課金（BYOK） |

> ⚠️ R2はカード登録が必須（非営利顧客の障壁）。カード不要構成への再設計は今後の課題。

### 用意する値（setup.sh実行中に入力）
- Anthropic API Key
- LINE Channel Secret
- LINE Channel Access Token（long-lived）

---

## 3. 立ち上げ（自動・ホスト/クライアント分離）

> 📦 **ストレージ方針**：メディア本体は **MEDIA=KV（カード不要・無料）が既定**。R2 は任意の上位（Paid・大容量/高速）で、使う場合のみ `wrangler.client.toml` の `MEDIA_R2` を有効化（カード登録）。
>
> 🔑 **役割分離（2Worker）**：**クライアント**（`baku-office`＝LINE/会話/データ・検証のみ）と **ホスト**（`baku-office-host`＝署名・配信専用）を別Workerでデプロイ。同一CFアカウントで可。
>
> 📡 **配信は push**：ホスト `/admin` が lease/config に署名→クライアント `/provision` へ HTTP push。クライアントは署名検証してから自分のKVへ保存。共有KVを使わずデータ分離を維持（ホストは顧客データを持たない）。

```bash
cd worker
# client → host の順で実行（ラッパー）
bash setup.sh

# 個別に実行する場合：
bash setup-client.sh   # 顧客Worker：KV/D1・BYOK・LINE・デプロイ・Webhook（鍵は持たない）
bash setup-host.sh     # ホストWorkerを別途deploy・鍵発行・検証鍵/配信鍵をクライアントへ配布・初期lease/config配信
```

**setup-client.sh（クライアント側）**
1. `npm install` ／ `wrangler login`
2. `wrangler.client.toml` 生成（KV HISTORY / KV MEDIA / D1 の ID を自動挿入）
3. KV×2・D1 作成、`schema.sql` 適用（現行フル構成。既存DB引継ぎ時のみ `migrate_*.sql` を個別適用）
4. 初回デプロイ→公開URL確定→`PUBLIC_BASE_URL` を埋めて再デプロイ
5. クライアント秘密情報：`ANTHROPIC_API_KEY`／`LINE_CHANNEL_SECRET`／`LINE_CHANNEL_ACCESS_TOKEN`（任意 `GEMINI_API_KEY`／`GOOGLE_CLIENT_ID/SECRET`／`DEV_USER_IDS`）、`INTERNAL_KEY` 自動生成。**署名鍵 `SIGNING_JWK` は置かない**
6. LINE Webhook URL 自動設定。`VERIFY_PUBLIC_JWK`／`PROVISION_KEY` は host 側が配布・登録（client では触らない）

**setup-host.sh（ホスト側／先に client を実行しておく）**
1. **`TENANTS` KV 作成** → `wrangler.host.toml` 生成（`CLIENT_BASE_URL`＝クライアントURL・`TENANTS` id・Service Binding）→ **ホストWorker `baku-office-host` をデプロイ**
2. Ed25519 鍵ペア・`PROVISION_KEY`・`ADMIN_KEY` 発行 → ホストへ `SIGNING_JWK`/`ADMIN_KEY`/`PROVISION_KEY` 登録
3. **クライアントへ `VERIFY_PUBLIC_JWK`（公開）/`PROVISION_KEY` を配布登録**（`-c wrangler.client.toml`）
4. `admin.mjs` で初期 `config v1` と `lease 30` を署名→**クライアント `/provision` へ配信**
5. 出力の `ADMIN_KEY`／公開検証鍵を控える（別アカウント構成では公開鍵＋配信鍵だけを顧客へ渡す）

> ID自動抽出に失敗した場合は貼り付けを促されます（wrangler出力からコピー）。

### 完了後の手動確認（LINE Developers Console → Messaging API設定）
- 「Webhookの利用」**ON**
- 「応答メッセージ」**OFF**（自動応答との衝突回避）

---

## 4. 動作確認（LINEで送信）

> 🔐 **認証ゲート（fail-closed）**：通常アカウントは **ホスト発行の有効な lease＋config が無いと「未承認」応答で動きません**。先に `setup-host.sh`（または `admin.mjs config v1` ＋ `lease 30`）で発行してください。発行前にテストしたい場合は、自分の LINE userId を `DEV_USER_IDS` に入れて**開発バイパス**で確認できます（lease 切れデモは dev でないアカウントで）。

| 送る例 | 期待 |
|---|---|
| 「こんにちは」 | 応答（末尾 `—(model: simple…)`） |
| 「クイックソートをTSで実装して」 | hard→Opus |
| 「最新ニュース調べて」 | Web検索（検索:◯回） |
| 「15時に歯医者ってメモして」 | 保存 |
| 「一覧」 | `#3 🖼 画像` `#2 📝 …` |
| 「#2を完了にして」 | ✅化 |
| 画像送信 →「画像見せて」 | 画像が再表示 |
| 「3分後にテストってリマインドして」 | 3分後にPush通知 |

---

## 5. 運用コマンド

`<KEY>` は setup.sh が表示した `ADMIN_KEY`。

> admin はホストWorkerに対して実行：`ADMIN_KEY=<KEY> WORKER_URL=https://baku-office-host... node scripts/admin.mjs ...`

```bash
# ライセンス（paid_through）self宛
node scripts/admin.mjs lease 30      # 30日有効化
node scripts/admin.mjs lease -1      # 期限切れ＝停止デモ
# 人格config
node scripts/admin.mjs config v2     # 関西弁
node scripts/admin.mjs config v1     # 丁寧
# 実行例
ADMIN_KEY=<KEY> WORKER_URL=<HOST_URL> node scripts/admin.mjs lease 30

# --- 多テナント（多数顧客） ---
node scripts/admin.mjs pubkey                                  # 顧客へ配る公開検証鍵
node scripts/admin.mjs tenant acme https://acme.example.com PROVKEY  # 台帳登録
node scripts/admin.mjs tenants                                 # テナント一覧
node scripts/admin.mjs lease 30 acme                           # acmeに30日リース→配信
node scripts/admin.mjs config v1 acme                          # acmeにconfig→配信
# 顧客1社のオンボードを一括：
ADMIN_KEY=<KEY> WORKER_URL=<HOST_URL> bash setup-tenant.sh acme https://acme.example.com

# 再デプロイ（コード変更後）
npx wrangler deploy
# secret更新
npx wrangler secret put ANTHROPIC_API_KEY
# ログ監視
npx wrangler tail --format pretty

# D1マイグレーション（スキーマ変更を含むコードをdeployしたら必ず remote へ適用）
npx wrangler d1 execute baku-office-db --remote --file migrate_<name>.sql
# 適用確認
npx wrangler d1 execute baku-office-db --remote --command "SELECT name FROM sqlite_master WHERE type='table';"
```

> ⚠️ **要注意**：本リポジトリに migration runner は無く、`migrate_*.sql` は **remote D1 へ手動適用**する。未適用だと `recentHistory` 等が例外を投げ、**LINEが無言で無反応**になる（`wrangler tail` に `D1_ERROR: no such table/column` が出る）。「反応しない」障害はまずこれを疑う。

> 💾 **バックアップ**：データはクライアント側（KV/D1）に保有＝**バックアップは顧客の自己責任**（当社一括バックアップはしない）。退避補助の専用ツールは今後提供予定（未実装）。当面は `wrangler d1 export` / KV の取り出しで各自取得。
>
> 🔒 **未了の本番ゲート（課題保留）**：`SIGNING_JWK`/`ADMIN_KEY` は現状ホストの素のWorker Secret。本番前に **KMS署名・FIDO2・admin JIT(Cloudflare Access)** を入れること（PROGRESS 11-1）。

---

## 6. ファイル構成

| パス | 役割 |
|---|---|
| `src/index.ts` | 本体（Webhook・ツールループ・Cron・admin・配信 `/provision`。Webhook冪等化／認証ゲート／検証鍵分離込み） |
| `src/crypto.ts` | Ed25519署名/検証（署名バイト列を `{body,sig}` で搬送・KMS分離耐性） |
| `src/license.ts` | 署名config・ライセンス・能力レジストリ |
| `schema.sql` / `migrate_*.sql` | D1スキーマ／移行 |
| `scripts/genkey.mjs` | 署名鍵ペア生成（秘密JWK出力） |
| `scripts/pubkey.mjs` | 秘密JWK→公開検証鍵(x のみ)抽出 |
| `scripts/admin.mjs` | lease/config/tenant/tenants/pubkey（ホスト側・`WORKER_URL`＝ホストURL） |
| `setup-client.sh` | **クライアント**Worker構築（検証のみ・署名鍵なし。他アカウントは検証鍵/配信鍵/TENANT_IDを入力） |
| `setup-host.sh` | **ホスト**Worker構築（別deploy・鍵発行・検証鍵/配信鍵配布・self初期配信） |
| `setup-tenant.sh` | **テナント追加**（ホスト側オンボード：台帳登録＋初期配信＋顧客へ渡す3値出力） |
| `setup.sh` | client→host を続けて実行するラッパー |
| `wrangler.client.toml.example` | クライアント設定テンプレート |
| `wrangler.host.toml.example` | ホスト設定テンプレート（`baku-office-host`・Service Binding＋TENANTS KV） |

### secret 一覧（`wrangler secret list`）
- **クライアント**（`baku-office`）：`ANTHROPIC_API_KEY` / `LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN` / `VERIFY_PUBLIC_JWK`（公開検証鍵）／`PROVISION_KEY`（配信受信）／`INTERNAL_KEY`。任意：`GEMINI_API_KEY`／`GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET`／`DEV_USER_IDS`（**開発バイパス**）／`TENANT_ID`（多テナント時・lease.tenant一致を必須化）
- **ホスト**（`baku-office-host`）：`SIGNING_JWK`（**秘密・署名のみ。本番はKMS**）／`ADMIN_KEY`／`PROVISION_KEY`（self宛配信送信）。var：`CLIENT_BASE_URL`（self配信先）。binding：`CLIENT`（self用Service Binding）／`TENANTS` KV（多テナント台帳）
- ⚠️ **クライアントWorkerに `SIGNING_JWK` を置かない**のが分離の要。単一Worker/devでは `CLIENT`/`CLIENT_BASE_URL` 未設定＝admin がローカルKVへ直書き（従来動作）。

### バインディング
KV `HISTORY`（履歴/要約/lease/config/mode/seen等）／ KV `MEDIA`（画像・書類本体＝**カード不要の無料既定**）／ D1 `DB`（notes・history・summary_jobs 等の構造化データ）。
※ R2 `MEDIA_R2` は任意（Paid契約者向け・大容量/高速。バインディングがあれば優先）。

---

## 7. トラブルシュート（既知）

| 症状 | 対処 |
|---|---|
| `Authentication error [code: 10000]` | wrangler 3系が原因。**v4必須**（`npm i -D wrangler@4`） |
| `Please enable R2 [code: 10042]` | ダッシュボードでR2有効化（カード登録） |
| `secret delete` でエラー | 引数は**値でなく名前**（`ANTHROPIC_API_KEY`等）。基本は`put`で上書き |
| キーをコマンドに貼って露出 | 発行元で**再発行**（特にLINEアクセストークン） |
| ローカル `wrangler dev` が落ちる | macのworkerdソケットバグ。**実CFでテスト**（本番は正常） |
| 「一覧」でツールを呼ばない | プロンプトでツール必須を明示済み。再デプロイで反映 |
| 配信が `ok:false`／`[deliver] -> 404: error code: 1042` | 同一 workers.dev 上の Worker 間 直fetch は CF が遮断。**ホストtomlに Service Binding**（`[[services]] binding=CLIENT service=baku-office`）を入れて再デプロイ。別アカウントは `CLIENT_BASE_URL` をカスタムドメインに |
| 配信が `ok:false`（403/400） | 403=`PROVISION_KEY` 不一致（host/client同値に）。400=署名不一致（client `VERIFY_PUBLIC_JWK` が host `SIGNING_JWK` の公開鍵と一致しているか） |

---

## 8. 本番化に向けた課題（個人テストの割り切り）

- **署名鍵がWorker内**（`SIGNING_JWK`）→ 本番は **KMS署名のみ**
- **`/admin` が `ADMIN_KEY` のみ**で保護 → 本番は **承認サーバ分離＋JIT**
- **R2公開バケット**（URL知れば閲覧可）→ 本番は **署名URL**
- **R2カード障壁** → カード不要構成（D1＋KV）への再設計

詳細は [../PROGRESS.md](../PROGRESS.md)・[../03_multitenant-saas-architecture.md](../03_multitenant-saas-architecture.md) を参照。
