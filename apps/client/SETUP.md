# baku-office クライアントアプリ セットアップ

クライアントアプリ（`baku-office-app`）＝顧客の単一Worker（Astro静的＋API同居）。
本番は **Deploy to Cloudflare**（公開配布リポ）で顧客が自己ホスト。本書は**開発/検証**用の手順。
運用全体の流れは [../../OPERATIONS.md](../../OPERATIONS.md)、配備設計は [../../ARCHITECTURE.md](../../ARCHITECTURE.md)。

## 前提
- Node 22 / Cloudflare アカウント（無料枠でOK・MEDIAはKVのためカード不要）。
- ルートで `npm install`（npm workspaces）。
- 当社の開発・運用ターゲットは **env.production（baku-llc・`*.baku-027.workers.dev`）**。`wrangler.jsonc` の top-level（コメント上「amber-links 動作確認」）は現在不使用。**本番系コマンドは `--env production` を付ける**（付けないと top-level 構成に向く）。

## リソース作成（初回）
```bash
cd apps/client
npx wrangler d1 create baku-office-app-db          # → wrangler.jsonc の database_id へ
npx wrangler kv namespace create baku-office-app-LICENSE   # → LICENSE id
npx wrangler kv namespace create baku-office-app-MEDIA     # → MEDIA id
# wrangler.jsonc の各 id / SESSION（LICENSEと同IDで可）を設定
```
> ※検証では同一アカウントのため host への呼び出しは Service Binding（`HOST`）を使用。
> 本番（別アカウント自己ホスト）は `HOST_BASE_URL`（ホストのカスタムドメイン）でURL fetch。

## シークレット
```bash
npx wrangler secret put MASTER_KEY          # AES-256-GCM（API鍵・PII暗号化）。32バイト乱数のbase64
npx wrangler secret put VERIFY_PUBLIC_JWK   # 当社配布の公開検証鍵（ホストの /admin/pubkey）
npx wrangler secret put INTERNAL_KEY        # /api/cron/drain 保護（外部スケジューラ用）
# GOOGLE_CLIENT_ID/SECRET：組織ログイン＋Google Workspace連携（gmail/calendar/meet）で使用。
#   Workspace連携（Pro以上）を使うテナントでは実質必須。本番は `wrangler secret put GOOGLE_CLIENT_ID --env production`
# 任意：LINE_LOGIN_*/DISCORD_*（個人ログイン）
# 連携設定(Gemini/LINE/Claude キー)は CFダッシュボード不要・管理画面の「連携設定」から暗号化保存
```
> 本番シークレットは `--env production` 付きで投入：`npx wrangler secret put <NAME> --env production`
> 未設定のOAuthは dev ログインに自動フォールバック（組織=即管理者／個人=ID・PASS）。

## デプロイ
```bash
# 本番（env.production・baku-llc / baku-office-app）
cd apps/client && npx wrangler deploy --env production   # astro build は事前に: npm -w apps/client run build
# 注意：npm run deploy は `astro build && wrangler deploy` で --env が付かない＝top-level 構成に出る。
#       env.production へ反映するには上記のとおり手動で --env production を指定する。
```
- **D1スキーマは初回リクエストで自動適用**（`src/lib/migrate.ts`／`schema_migrations`＋KV `schema_version` ゲート。現 SCHEMA_VERSION=20）。**手動の `wrangler d1 migrations apply` は使わない**（このアプリは wrangler の `d1_migrations` ではなく独自の `schema_migrations` で管理）。
  - 緊急の確認用に1本だけ当てたい場合のみ：`npx wrangler d1 execute baku-office-app-db --remote --env production --file migrations/<n>.sql`（通常は不要）

## 動作確認（要点）
- 初回アクセス→ライセンス未保持なら `/activate` へ。`…/activate?license_id=…` で取得。
- `/login`→組織/個人ログイン、`/accounting` 入出金、`/settings/keys` キー保存（検証→暗号化）。
- Zプラン＋LINEキー時：`…/api/line/webhook` を LINE Messaging API に設定。
- リマインダー/要約/動画ジョブ：外部スケジューラから `POST /api/cron/drain`（`x-internal-key: INTERNAL_KEY`・`content-type: application/json`）。

## 配布（本番）
```bash
npm -w apps/client run release    # release/ に難読化バンドル＋migrations＋wrangler.jsonc
```
- 通常は CI（`.github/workflows/publish-client.yml`）が `apps/client` 変更を公開配布リポ `baku-office-app` へ自動公開（要 `PUBLISH_TOKEN`）。
- 顧客は Deploy ボタン／フォーク同期で受領。

## トラブルシュート
| 症状 | 対処 |
| --- | --- |
| host への呼び出しが失敗（同一アカウント） | workers.dev同士の直fetchはCF遮断（1042）。`HOST` Service Binding を使う／別アカウントはカスタムドメイン |
| アップロードが大きすぎ | 標準モード上限（既定25MB・高度なオプションで1〜25調整）。超過はR2（高度モード） |
| 重い処理でエラー | CF無料枠の制限。`/diagnostics`＋高度なオプションの **Workers Paid** 案内へ |
| `MASTER_KEY 未設定` | 暗号化に必須。`wrangler secret put MASTER_KEY` |
